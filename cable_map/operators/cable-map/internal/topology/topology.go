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
	"strings"
)

// ---- output contract (mirror of src/api.ts) --------------------------------------

type Node struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
	OS       string `json:"os"`
	Role     string `json:"role"`
}

type Edge struct {
	ID         string `json:"id"`
	Source     string `json:"source"`
	Target     string `json:"target"`
	SourcePort string `json:"sourcePort"`
	TargetPort string `json:"targetPort"`
	Type       string `json:"type"`
}

// LldpStatus is one of "ok", "mismatch", "none". Always emitted (no omitempty).
type Row struct {
	Label      string `json:"label"`
	Desc       string `json:"desc"`
	RemoteNode string `json:"remoteNode"`
	RemotePort string `json:"remotePort"`
	Type       string `json:"type"`
	Lag        string `json:"lag,omitempty"`  // LAG resource name (lag-…) when bundled
	Peer       string `json:"peer,omitempty"` // endpoint label for edge links with no remote node
	LldpStatus string `json:"lldpStatus"`
	LldpPeer   string `json:"lldpPeer,omitempty"` // "node port[, node port]"
}

type LagMember struct {
	Node string `json:"node"`
	Port string `json:"port"`
}

// LagInfo mirrors eda.ts: `multihomed` (members span >1 node) is the real ESI/MH test,
// not the presence of an esi stanza (EDA stamps esi:auto on every generated LAG).
type LagInfo struct {
	Name       string      `json:"name"`
	Lacp       bool        `json:"lacp"`
	Isl        bool        `json:"isl"`
	Multihomed bool        `json:"multihomed"`
	Mode       string      `json:"mode"`
	Members    []LagMember `json:"members"`
	Nodes      []string    `json:"nodes"`
}

type Topology struct {
	Nodes    []Node             `json:"nodes"`
	Links    []Edge             `json:"links"`
	Tables   map[string][]Row   `json:"tables"`
	Occupied map[string][]int   `json:"occupied"`
	Lags     map[string]LagInfo `json:"lags"`
}

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
	Labels          map[string]string
	Platform        string // spec.platform
	OperatingSystem string // spec.operatingSystem
	StatusPlatform  string // status.platform
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
	Node      string
	Interface string
	Neighbors []IfNeighbor
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

// ---- helpers (ports, labels, normalisation) --------------------------------------

// last two numbers in an interface name: slot, port -> port index.
var portIndexRE = regexp.MustCompile(`\d+\D+(\d+)\s*$`)

func portIndex(iface string) (int, bool) {
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
//   "leaf1-leaf2-mh-lag-server-d" -> "server-d", "leaf1-edge-server-a" -> "server-a".
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
func BuildTopology(nodes []RawNode, links []RawLink, ifaces []RawIface) Topology {
	descOf := map[string]string{}
	lags := map[string]LagInfo{}
	// node|interface -> neighbours LLDP saw on that physical port
	lldpByPort := map[string][]LagMember{} // reuse {Node,Port} pair shape

	for _, f := range ifaces {
		if f.Description != "" {
			descOf[f.Name] = f.Description
		}
		for _, m := range f.StatusMembers {
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
	for _, n := range nodes {
		platform := n.Platform
		if platform == "" {
			platform = n.StatusPlatform
		}
		outNodes = append(outNodes, Node{
			ID:       n.Name,
			Name:     n.Name,
			Platform: platform,
			OS:       n.OperatingSystem,
			Role:     n.Labels["eda.nokia.com/role"],
		})
		known[n.Name] = struct{}{}
	}

	edges := []Edge{}
	tables := map[string][]Row{}
	occupied := map[string][]int{}
	occSeen := map[string]map[int]struct{}{}

	addOcc := func(node string, idx int) {
		set := occSeen[node]
		if set == nil {
			set = map[int]struct{}{}
			occSeen[node] = set
		}
		if _, ok := set[idx]; ok {
			return
		}
		set[idx] = struct{}{}
		occupied[node] = append(occupied[node], idx)
	}

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
		if iface != "" && strings.HasPrefix(iface, "lag-") {
			row.Lag = iface
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
				expNode, expPort := remote.Node, normIf(remote.Interface)
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
		if idx, ok := portIndex(port); ok && idx != 0 {
			addOcc(node, idx)
		}
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

	return Topology{
		Nodes:    outNodes,
		Links:    edges,
		Tables:   tables,
		Occupied: occupied,
		Lags:     lags,
	}
}
