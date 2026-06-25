// Package topology derives the cable-map view model (nodes, cable tables, LAGs, port
// occupancy, LLDP cross-check) from the EDA toponode/topolink/interface resources.
//
// This is a faithful Go port of the TypeScript backend's buildTopology (eda.ts). The
// JSON it emits is the contract the React frontend consumes (see src/api.ts); field
// names and the load-bearing string literals ("interSwitch"/"edge", "ok"/"mismatch"/
// "none", the "lag-" prefix, role values) must match exactly.
//
// BuildTopology is pure and takes projected inputs (Raw*), so it is unit-testable without
// EDK/Kubernetes. The eda package maps EDK typed CRs + unstructured interfaces into these.
package topology

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// The output contract structs (Node, Edge, Row, LagInfo, Breakout, Topology) live in contract.go —
// the single source of truth that generates src/topology.gen.ts.

// ---- projected inputs (the few CRD fields we read) -------------------------------

type LinkEnd struct {
	Node              string
	Interface         string
	InterfaceResource string
}

type LinkEntry struct {
	Type   string
	Local  LinkEnd
	Remote LinkEnd
}

// RawNode is a toponode projection. Platform falls back to StatusPlatform.
type RawNode struct {
	Name            string
	Namespace       string
	Labels          map[string]string
	Platform        string                 // spec.platform
	OperatingSystem string                 // spec.operatingSystem
	StatusPlatform  string                 // status.platform
	Version         string                 // status.version, falling back to spec.version
	StatusVersion   string                 // status.version
	Raw             map[string]interface{} // the full TopoNode CR (managedFields/resourceVersion stripped)
}

// RawLink is a topolink projection.
type RawLink struct {
	Name  string
	Links []LinkEntry
}

type IfMember struct {
	Node      string
	Interface string
}

type IfNeighbor struct {
	Node      string
	Interface string
}

type IfStatusMember struct {
	Node          string
	Interface     string // EDA-normalised name (ethernet-1-a-1-1)
	NodeInterface string // node-native name (1/1/c1/1) — the form LLDP neighbours are reported in
	Neighbors     []IfNeighbor
}

// RawIface is an interfaces.eda.nokia.com/Interface projection.
type RawIface struct {
	Name          string
	Labels        map[string]string
	Description   string           // spec.description
	Type          string           // spec.type ("LAG" on a port-channel)
	LagType       string           // spec.lag.type ("LACP"/"Static")
	LagMode       string           // spec.lag.multihoming.mode
	Members       []IfMember       // spec.members
	StatusMembers []IfStatusMember // status.members (carry LLDP neighbours)
}

// RawBreakout is an interfaces.eda.nokia.com/Breakout projection: which parent ports on which nodes
// are split into how many channels.
type RawBreakout struct {
	Name          string
	Nodes         []string // spec.nodes (TopoNode refs)
	NodeSelectors []string // spec.nodeSelectors (label selectors)
	Interfaces    []string // spec.interfaces (normalised parent port names)
	Channels      int      // spec.channels
	Speed         string   // spec.speed
}

// ---- helpers (ports, labels, normalisation) --------------------------------------

// front-panel cage index = the <port> in ethernet-<card>-<port>[-<channel>]: the 2nd number, i.e.
// the first "<num><sep><num>" match. A 3rd number is a breakout channel, not a cage, so it must not
// be captured.
var portIndexRE = regexp.MustCompile(`\d+\D+(\d+)`)
var srosConnectorRE = regexp.MustCompile(`(?i)(?:^|[/_-])c(\d+)(?:[/_-]|$)`)

func portIndex(iface string) (int, bool) {
	if m := srosConnectorRE.FindStringSubmatch(iface); m != nil {
		n, err := strconv.Atoi(m[1])
		return n, err == nil
	}
	m := portIndexRE.FindStringSubmatch(iface)
	if m == nil {
		return 0, false
	}
	n := 0
	for _, c := range m[1] {
		n = n*10 + int(c-'0')
	}
	return n, true
}

// the interface name exactly as EDA returns it (e.g. ethernet-1-1).
func portLabel(iface string) string { return iface }

// LLDP reports ethernet-1/32; topolinks/members use ethernet-1-32. Normalise to compare.
func normIf(s string) string { return strings.ReplaceAll(s, "/", "-") }

var rolePrefixRE = regexp.MustCompile(`^(edge|local-lag|mh-lag|esi-lag|isl-lag|lag)-`)

// peerLabel strips known node-name prefixes and the link-role token from a topolink name
// to get a compact endpoint label, e.g.
//
//	"leaf1-leaf2-mh-lag-server-d" -> "server-d", "leaf1-edge-server-a" -> "server-a".
func peerLabel(linkName string, nodes map[string]struct{}) string {
	s := linkName
	for changed := true; changed; {
		changed = false
		for n := range nodes {
			if strings.HasPrefix(s, n+"-") {
				s = s[len(n)+1:]
				changed = true
				break
			}
		}
	}
	if out := rolePrefixRE.ReplaceAllString(s, ""); out != "" {
		return out
	}
	return linkName
}

// ---- the build ------------------------------------------------------------------

// BuildTopology folds raw toponode/topolink/interface projections into the view model.
func BuildTopology(nodes []RawNode, links []RawLink, ifaces []RawIface, breakouts []RawBreakout) Topology {
	descOf := map[string]string{}
	lags := map[string]LagInfo{}
	// node|interface -> neighbours LLDP saw on that physical port
	lldpByPort := map[string][]LagMember{} // reuse {Node,Port} pair shape
	// node|interface(EDA name) -> node-native port name. LLDP reports neighbours in the node-native
	// form (1/1/c1/1), but topolink endpoints use the EDA name (ethernet-1-a-1-1); this resolves the
	// expected remote to its native name so the match is native-vs-native (no naming guesswork).
	nativeOf := map[string]string{}

	for _, f := range ifaces {
		if f.Description != "" {
			descOf[f.Name] = f.Description
		}
		for _, m := range f.StatusMembers {
			if m.Node != "" && m.Interface != "" && m.NodeInterface != "" {
				nativeOf[m.Node+"|"+m.Interface] = m.NodeInterface
			}
			var nbrs []LagMember
			for _, n := range m.Neighbors {
				if n.Node != "" {
					nbrs = append(nbrs, LagMember{Node: n.Node, Port: normIf(n.Interface)})
				}
			}
			if m.Node != "" && m.Interface != "" && len(nbrs) > 0 {
				lldpByPort[m.Node+"|"+normIf(m.Interface)] = nbrs
			}
		}
		if f.Type == "LAG" {
			members := make([]LagMember, 0, len(f.Members))
			seen := map[string]struct{}{}
			memberNodes := []string{}
			for _, m := range f.Members {
				members = append(members, LagMember{Node: m.Node, Port: portLabel(m.Interface)})
				if m.Node != "" {
					if _, ok := seen[m.Node]; !ok {
						seen[m.Node] = struct{}{}
						memberNodes = append(memberNodes, m.Node)
					}
				}
			}
			lags[f.Name] = LagInfo{
				Name:       f.Name,
				Lacp:       f.LagType == "LACP",
				Isl:        f.Labels["eda.nokia.com/role"] == "InterSwitch",
				Multihomed: len(memberNodes) > 1,
				Mode:       f.LagMode,
				Members:    members,
				Nodes:      memberNodes,
			}
		}
	}

	outNodes := make([]Node, 0, len(nodes))
	known := map[string]struct{}{}
	labelSets := map[string]map[string]struct{}{} // key -> set of values, collected across all nodes
	for _, n := range nodes {
		platform := n.Platform
		if platform == "" {
			platform = n.StatusPlatform
		}
		version := n.Version
		if n.StatusVersion != "" {
			version = n.StatusVersion
		}
		outNodes = append(outNodes, Node{
			Name:      n.Name,
			Platform:  platform,
			OS:        n.OperatingSystem,
			Role:      n.Labels["eda.nokia.com/role"],
			Namespace: n.Namespace,
			Version:   version,
			Labels:    n.Labels,
			Raw:       n.Raw,
		})
		known[n.Name] = struct{}{}
		for k, v := range n.Labels {
			if labelSets[k] == nil {
				labelSets[k] = map[string]struct{}{}
			}
			labelSets[k][v] = struct{}{}
		}
	}
	labels := make(map[string][]string, len(labelSets))
	for k, vs := range labelSets {
		vals := make([]string, 0, len(vs))
		for v := range vs {
			vals = append(vals, v)
		}
		sort.Strings(vals)
		labels[k] = vals
	}

	edges := []Edge{}
	tables := map[string][]Row{}

	add := func(node, port string, remote LinkEnd, typ, linkName, iface string) {
		if node == "" {
			return
		}
		row := Row{
			Label:      portLabel(port),
			Desc:       descOf[portLabel(port)],
			RemoteNode: remote.Node,
			Type:       typ,
		}
		if remote.Interface != "" {
			row.RemotePort = portLabel(remote.Interface)
		}
		if iface != "" {
			if _, ok := lags[iface]; ok {
				row.Lag = iface
			}
		}
		if typ == "edge" && remote.Node == "" {
			row.Peer = peerLabel(linkName, known)
		}
		observed := lldpByPort[node+"|"+normIf(port)]
		if len(observed) > 0 {
			peers := make([]string, len(observed))
			for i, o := range observed {
				peers[i] = o.Node + " " + o.Port
			}
			row.LldpPeer = strings.Join(peers, ", ")
			if typ == "interSwitch" && remote.Node != "" {
				// match against the remote port's node-native name (the form LLDP reports), falling
				// back to the EDA name when the interface state hasn't been seen yet.
				expRemote := nativeOf[remote.Node+"|"+remote.Interface]
				if expRemote == "" {
					expRemote = remote.Interface
				}
				expNode, expPort := remote.Node, normIf(expRemote)
				row.LldpStatus = "mismatch"
				for _, o := range observed {
					if o.Node == expNode && o.Port == expPort {
						row.LldpStatus = "ok"
						break
					}
				}
			} else {
				row.LldpStatus = "ok"
			}
		} else {
			row.LldpStatus = "none"
		}
		tables[node] = append(tables[node], row)
	}

	for _, l := range links {
		for _, e := range l.Links {
			add(e.Local.Node, e.Local.Interface, e.Remote, e.Type, l.Name, e.Local.InterfaceResource)
			add(e.Remote.Node, e.Remote.Interface, e.Local, e.Type, l.Name, e.Remote.InterfaceResource)
			if e.Local.Node != "" && e.Remote.Node != "" {
				_, lok := known[e.Local.Node]
				_, rok := known[e.Remote.Node]
				if lok && rok {
					edges = append(edges, Edge{
						ID:         l.Name,
						Source:     e.Local.Node,
						Target:     e.Remote.Node,
						SourcePort: portLabel(e.Local.Interface),
						TargetPort: portLabel(e.Remote.Interface),
						Type:       e.Type,
					})
				}
			}
		}
	}

	// breakouts: resolve each Breakout CR's target nodes (direct refs + label-selected) and parent
	// ports into per-node cage entries, so the UI can render a broken-out cage as N channels.
	nodeLabels := make(map[string]map[string]string, len(nodes))
	for _, n := range nodes {
		nodeLabels[n.Name] = n.Labels
	}
	bo := map[string]map[string]Breakout{}
	for _, br := range breakouts {
		if br.Channels <= 0 || len(br.Interfaces) == 0 {
			continue
		}
		b := Breakout{Channels: br.Channels, Speed: br.Speed}
		targets := map[string]struct{}{}
		for _, n := range br.Nodes {
			targets[n] = struct{}{}
		}
		for name, labels := range nodeLabels {
			for _, sel := range br.NodeSelectors {
				if matchSelector(sel, labels) {
					targets[name] = struct{}{}
					break
				}
			}
		}
		for node := range targets {
			for _, iface := range br.Interfaces {
				if idx, ok := portIndex(iface); ok {
					if bo[node] == nil {
						bo[node] = map[string]Breakout{}
					}
					bo[node][strconv.Itoa(idx)] = b
				}
			}
		}
	}

	// attach each node's cable table + breakouts to its node
	for i := range outNodes {
		t := tables[outNodes[i].Name]
		if t == nil {
			t = []Row{}
		}
		outNodes[i].Table = t
		outNodes[i].Breakouts = bo[outNodes[i].Name]
	}

	return Topology{
		Nodes:  outNodes,
		Links:  edges,
		Lags:   lags,
		Labels: labels,
	}
}

// matchSelector matches a comma-separated "key=value" label selector against a node's labels.
func matchSelector(sel string, labels map[string]string) bool {
	for _, term := range strings.Split(sel, ",") {
		term = strings.TrimSpace(term)
		if term == "" {
			continue
		}
		kv := strings.SplitN(term, "=", 2)
		if len(kv) != 2 || labels[strings.TrimSpace(kv[0])] != strings.TrimSpace(kv[1]) {
			return false
		}
	}
	return true
}
