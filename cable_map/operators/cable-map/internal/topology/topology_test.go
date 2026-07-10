package topology

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func findRow(rows []Row, label string) (Row, bool) {
	for _, r := range rows {
		if r.Label == label {
			return r, true
		}
	}
	return Row{}, false
}

func nodeByName(t Topology, name string) Node {
	for _, n := range t.Nodes {
		if n.Name == name {
			return n
		}
	}
	return Node{}
}

// Covers the load-bearing derivations: LLDP ok/mismatch/none, peer label, LAG resource
// detection, LAG isl/multihomed/lacp classification, occupancy, and edge emission.
func TestBuildTopology(t *testing.T) {
	nodes := []RawNode{
		{Name: "leaf1", Labels: map[string]string{"eda.nokia.com/role": "leaf"}, Platform: "7220 IXR-D3L", OperatingSystem: "srl"},
		{Name: "leaf2", Labels: map[string]string{"eda.nokia.com/role": "leaf"}},
		{Name: "spine1", Labels: map[string]string{"eda.nokia.com/role": "spine"}, StatusPlatform: "7220 IXR-D5"},
	}
	ifaces := []RawIface{
		// desc resolves via spec.members (node|interface); the CR name never matches the port label
		{Name: "leaf1-ethernet-1-49", Description: "to spine1", Members: []IfMember{{Node: "leaf1", Interface: "ethernet-1-49"}}},
		// desc fallback via the endpoint's interfaceResource when no member-keyed desc exists
		{Name: "isl-lag-x", Description: "cross-link"},
		{
			Name: "lag-1", Type: "LAG", LagType: "LACP", LagMode: "AllActive",
			Labels:  map[string]string{"eda.nokia.com/role": "InterSwitch"},
			Members: []IfMember{{Node: "leaf1", Interface: "ethernet-1-49"}, {Node: "leaf2", Interface: "ethernet-1-49"}},
		},
		{
			Name: "lag1-l1-l2-eth-1-1", Type: "LAG", LagType: "LACP", LagMode: "AllActive",
			Labels:  map[string]string{"eda.nokia.com/role": "edge"},
			Members: []IfMember{{Node: "leaf1", Interface: "ethernet-1-11"}, {Node: "leaf2", Interface: "ethernet-1-11"}},
		},
		{StatusMembers: []IfStatusMember{
			{Node: "leaf1", Interface: "ethernet-1/49", Neighbors: []IfNeighbor{{Node: "spine1", Interface: "ethernet-1/1"}}},
			{Node: "leaf1", Interface: "ethernet-1/50", Neighbors: []IfNeighbor{{Node: "spine1", Interface: "ethernet-1/9"}}},
		}},
	}
	links := []RawLink{
		{Name: "leaf1-spine1-isl-1", Links: []LinkEntry{{
			Type:   "interSwitch",
			Local:  LinkEnd{Node: "leaf1", Interface: "ethernet-1-49", InterfaceResource: "lag-1"},
			Remote: LinkEnd{Node: "spine1", Interface: "ethernet-1-1"},
		}}},
		{Name: "leaf1-spine1-isl-2", Links: []LinkEntry{{
			Type:   "interSwitch",
			Local:  LinkEnd{Node: "leaf1", Interface: "ethernet-1-50", InterfaceResource: "isl-lag-x"},
			Remote: LinkEnd{Node: "spine1", Interface: "ethernet-1-2"},
		}}},
		{Name: "leaf1-edge-server-a", Links: []LinkEntry{{
			Type:  "edge",
			Local: LinkEnd{Node: "leaf1", Interface: "ethernet-1-10"},
		}}},
		{Name: "lag1-l1-l2-eth-1-1", Links: []LinkEntry{
			{
				Type:  "edge",
				Local: LinkEnd{Node: "leaf1", Interface: "ethernet-1-11", InterfaceResource: "lag1-l1-l2-eth-1-1"},
			},
			{
				Type:  "edge",
				Local: LinkEnd{Node: "leaf2", Interface: "ethernet-1-11", InterfaceResource: "lag1-l1-l2-eth-1-1"},
			},
		}},
	}

	breakouts := []RawBreakout{
		{Name: "bo-1", Nodes: []string{"leaf1"}, Interfaces: []string{"ethernet-1-49"}, Channels: 4, Speed: "100G"},
		{Name: "bo-sel", NodeSelectors: []string{"eda.nokia.com/role=spine"}, Interfaces: []string{"ethernet-1/2"}, Channels: 2, Speed: "200G"},
	}
	topo := BuildTopology(nodes, links, ifaces, breakouts, nil)

	// node projection + platform fallback
	if topo.Nodes[2].Platform != "7220 IXR-D5" {
		t.Errorf("spine1 platform fallback: got %q", topo.Nodes[2].Platform)
	}

	// no grouping streamed -> role-derived tier fallback
	if got := nodeByName(topo, "spine1").Tier; got != 3 {
		t.Errorf("spine1 fallback tier: got %d want 3", got)
	}
	if got := nodeByName(topo, "leaf1").Tier; got != 4 {
		t.Errorf("leaf1 fallback tier: got %d want 4", got)
	}

	// breakout: direct node ref -> cage 49 (parent ethernet-1-49) split into 4x100G, folded onto the node
	if b, ok := nodeByName(topo, "leaf1").Breakouts["49"]; !ok || b.Channels != 4 || b.Speed != "100G" {
		t.Errorf("leaf1 breakout cage 49: got %+v ok=%v", b, ok)
	}

	// labels: collected across nodes, distinct values sorted
	if got := topo.Labels["eda.nokia.com/role"]; len(got) != 2 || got[0] != "leaf" || got[1] != "spine" {
		t.Errorf("collected role labels: got %v want [leaf spine]", got)
	}

	leaf1 := nodeByName(topo, "leaf1").Table
	if r, ok := findRow(leaf1, "ethernet-1-49"); !ok {
		t.Fatal("missing ethernet-1-49 row")
	} else {
		if r.LldpStatus != "ok" {
			t.Errorf("e1-49 lldpStatus: got %q want ok", r.LldpStatus)
		}
		if r.LldpPeer != "spine1 ethernet-1-1" {
			t.Errorf("e1-49 lldpPeer: got %q", r.LldpPeer)
		}
		if r.Lag != "lag-1" {
			t.Errorf("e1-49 lag: got %q want lag-1", r.Lag)
		}
		if r.Desc != "to spine1" {
			t.Errorf("e1-49 desc: got %q", r.Desc)
		}
	}
	if r, _ := findRow(leaf1, "ethernet-1-50"); r.LldpStatus != "mismatch" {
		t.Errorf("e1-50 lldpStatus: got %q want mismatch", r.LldpStatus)
	} else if r.Lag != "" {
		t.Errorf("e1-50 lag should be empty when interface resource is not a typed LAG, got %q", r.Lag)
	} else if r.Desc != "cross-link" {
		t.Errorf("e1-50 desc via interfaceResource: got %q want cross-link", r.Desc)
	}
	if r, _ := findRow(leaf1, "ethernet-1-10"); r.Type != "edge" || r.Peer != "server-a" || r.LldpStatus != "none" {
		t.Errorf("edge row: type=%q peer=%q lldp=%q", r.Type, r.Peer, r.LldpStatus)
	}
	if r, _ := findRow(leaf1, "ethernet-1-11"); r.Lag != "lag1-l1-l2-eth-1-1" {
		t.Errorf("non-prefixed edge lag: got %q want lag1-l1-l2-eth-1-1", r.Lag)
	}
	if r, _ := findRow(nodeByName(topo, "leaf2").Table, "ethernet-1-11"); r.Lag != "lag1-l1-l2-eth-1-1" {
		t.Errorf("remote non-prefixed edge lag: got %q want lag1-l1-l2-eth-1-1", r.Lag)
	}

	// LAG classification
	lag := topo.Lags["lag-1"]
	if !lag.Lacp || !lag.Isl || !lag.Multihomed || lag.Mode != "AllActive" {
		t.Errorf("lag-1 classification: %+v", lag)
	}
	if len(lag.Nodes) != 2 {
		t.Errorf("lag-1 nodes: got %v", lag.Nodes)
	}
	edgeLag := topo.Lags["lag1-l1-l2-eth-1-1"]
	if !edgeLag.Lacp || edgeLag.Isl || !edgeLag.Multihomed || edgeLag.Mode != "AllActive" {
		t.Errorf("non-prefixed edge lag classification: %+v", edgeLag)
	}

	// edges: only interSwitch links with both endpoints known
	if len(topo.Links) != 2 {
		t.Errorf("edges: got %d want 2", len(topo.Links))
	}
}

// Tiers come from the cluster's TopologyGrouping: selectors are evaluated in order
// (first match wins), selector strings OR together, no nodeSelector = catch-all, and
// the bootstrap "role" grouping is preferred when several groupings exist.
func TestTopologyGroupingTiers(t *testing.T) {
	nodes := []RawNode{
		{Name: "bb1", Labels: map[string]string{"eda.nokia.com/role": "backbone"}},
		{Name: "ss1", Labels: map[string]string{"eda.nokia.com/role": "superspine"}},
		{Name: "spine1", Labels: map[string]string{"eda.nokia.com/role": "spine"}},
		{Name: "leaf1", Labels: map[string]string{"eda.nokia.com/role": "leaf"}},
		{Name: "bl1", Labels: map[string]string{"eda.nokia.com/role": "borderleaf"}},
		{Name: "dcgw1", Labels: map[string]string{"eda.nokia.com/role": "dcgw"}},
		{Name: "srv1", Labels: map[string]string{"eda.nokia.com/role": "server"}},
	}
	role := RawGrouping{Name: "role", Selectors: []RawTierSelector{
		{Tier: 1, NodeSelectors: []string{"eda.nokia.com/role=backbone"}},
		{Tier: 2, NodeSelectors: []string{"eda.nokia.com/role=superspine"}},
		{Tier: 3, NodeSelectors: []string{"eda.nokia.com/role=spine"}},
		{Tier: 4, NodeSelectors: []string{"eda.nokia.com/role=leaf", "eda.nokia.com/role=borderleaf"}},
		{Tier: 4}, // live role grouping catch-all (e.g. dcgw)
	}}
	other := RawGrouping{Name: "alt", Selectors: []RawTierSelector{{Tier: 9}}}

	topo := BuildTopology(nodes, nil, nil, nil, []RawGrouping{other, role})
	want := map[string]int{"bb1": 1, "ss1": 2, "spine1": 3, "leaf1": 4, "bl1": 4, "dcgw1": 4, "srv1": 4}
	for name, tier := range want {
		if got := nodeByName(topo, name).Tier; got != tier {
			t.Errorf("%s tier: got %d want %d", name, got, tier)
		}
	}

	// without the "role" grouping the first (name-sorted) grouping applies
	topo = BuildTopology(nodes, nil, nil, nil, []RawGrouping{other})
	if got := nodeByName(topo, "leaf1").Tier; got != 9 {
		t.Errorf("alt grouping catch-all tier: got %d want 9", got)
	}
}

// Cable tables come out in natural port order (digit runs compared numerically), for the
// drawer, xlsx, and PDF exports alike.
func TestTableNaturalOrder(t *testing.T) {
	nodes := []RawNode{{Name: "leaf1", Labels: map[string]string{"eda.nokia.com/role": "leaf"}}}
	mkLink := func(iface string) RawLink {
		return RawLink{Name: "leaf1-edge-" + iface, Links: []LinkEntry{{
			Type: "edge", Local: LinkEnd{Node: "leaf1", Interface: iface},
		}}}
	}
	links := []RawLink{
		mkLink("ethernet-1-10"), mkLink("ethernet-1-2"), mkLink("ethernet-1-1-4"),
		mkLink("ethernet-1-1-2"), mkLink("ethernet-1-1"), mkLink("ethernet-2-1"),
		mkLink("1/1/c12/1"), mkLink("1/1/c2/1"),
	}
	topo := BuildTopology(nodes, links, nil, nil, nil)
	got := make([]string, 0, len(topo.Nodes[0].Table))
	for _, r := range topo.Nodes[0].Table {
		got = append(got, r.Label)
	}
	want := []string{"1/1/c2/1", "1/1/c12/1", "ethernet-1-1", "ethernet-1-1-2", "ethernet-1-1-4", "ethernet-1-2", "ethernet-1-10", "ethernet-2-1"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("natural order:\n got %v\nwant %v", got, want)
	}
}

// Ensures the Go structs can losslessly represent the frontend contract: unmarshal the
// golden Topology, re-marshal, and confirm the JSON is structurally identical.
func TestContractRoundTrip(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden-topology.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var topo Topology
	if err := json.Unmarshal(raw, &topo); err != nil {
		t.Fatalf("unmarshal into Topology: %v", err)
	}
	remarshaled, err := json.Marshal(topo)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var a, b any
	if err := json.Unmarshal(raw, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(remarshaled, &b); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Errorf("round-trip differs from golden contract.\nThis means the Go structs drop or add a field vs the frontend's expected JSON.\ngolden=%s\n   got=%s", raw, remarshaled)
	}
}

func TestGoldenTopologyFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden-topology.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var topo Topology
	if err := json.Unmarshal(raw, &topo); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}

	rows := 0
	for _, node := range topo.Nodes {
		rows += len(node.Table)
	}
	if len(topo.Nodes) != 100 {
		t.Fatalf("golden topology nodes = %d, want 100", len(topo.Nodes))
	}
	if len(topo.Links) < 600 {
		t.Fatalf("golden topology links = %d, want at least 600", len(topo.Links))
	}
	if rows < 1500 {
		t.Fatalf("golden topology table rows = %d, want at least 1500", rows)
	}

	breakoutNodes := 0
	eightChannelBreakoutNodes := 0
	breakoutRows := 0
	for _, node := range topo.Nodes {
		if len(node.Breakouts) == 0 {
			continue
		}
		breakoutNodes++
		if b := node.Breakouts["8"]; b.Channels != 4 && b.Channels != 8 {
			t.Fatalf("%s breakout cage 8 = %+v, want 4 or 8 channels", node.Name, b)
		} else if b.Channels == 8 {
			eightChannelBreakoutNodes++
		}
		for _, row := range node.Table {
			if row.Label == "ethernet-1-8" {
				t.Fatalf("%s uses breakout cage 8 but also has parent ethernet-1-8 row", node.Name)
			}
			if strings.HasPrefix(row.Label, "ethernet-1-8-") && row.Lag != "" {
				breakoutRows++
			}
		}
	}
	if breakoutNodes == 0 {
		t.Fatal("golden topology has no breakout nodes")
	}
	if eightChannelBreakoutNodes == 0 {
		t.Fatal("golden topology has no 8-channel breakout nodes")
	}
	if breakoutRows == 0 {
		t.Fatal("golden topology has no LAG rows on breakout channels")
	}

	mhLags := 0
	breakoutMHLags := 0
	for _, lag := range topo.Lags {
		if !lag.Multihomed || lag.Isl {
			continue
		}
		mhLags++
		for _, member := range lag.Members {
			if strings.HasPrefix(member.Port, "ethernet-1-8-") {
				breakoutMHLags++
				break
			}
		}
	}
	if mhLags == 0 {
		t.Fatal("golden topology has no multihomed endpoint LAGs")
	}
	if breakoutMHLags == 0 {
		t.Fatal("golden topology has no multihomed endpoint LAGs on breakout channels")
	}
}
