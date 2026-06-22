package topology

import (
	"encoding/json"
	"os"
	"reflect"
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

// Covers the load-bearing derivations: LLDP ok/mismatch/none, peer label, lag- gate,
// LAG isl/multihomed/lacp classification, occupancy, and edge emission.
func TestBuildTopology(t *testing.T) {
	nodes := []RawNode{
		{Name: "leaf1", Labels: map[string]string{"eda.nokia.com/role": "leaf"}, Platform: "7220 IXR-D3L", OperatingSystem: "srl"},
		{Name: "leaf2", Labels: map[string]string{"eda.nokia.com/role": "leaf"}},
		{Name: "spine1", Labels: map[string]string{"eda.nokia.com/role": "spine"}, StatusPlatform: "7220 IXR-D5"},
	}
	ifaces := []RawIface{
		{Name: "ethernet-1-49", Description: "to spine1"}, // desc keyed by interface name
		{
			Name: "lag-1", Type: "LAG", LagType: "LACP", LagMode: "AllActive",
			Labels:  map[string]string{"eda.nokia.com/role": "InterSwitch"},
			Members: []IfMember{{Node: "leaf1", Interface: "ethernet-1-49"}, {Node: "leaf2", Interface: "ethernet-1-49"}},
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
	}

	topo := BuildTopology(nodes, links, ifaces)

	// node projection + platform fallback
	if topo.Nodes[2].Platform != "7220 IXR-D5" {
		t.Errorf("spine1 platform fallback: got %q", topo.Nodes[2].Platform)
	}

	leaf1 := topo.Tables["leaf1"]
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
		t.Errorf("e1-50 lag should be empty for isl-lag- prefix, got %q", r.Lag)
	}
	if r, _ := findRow(leaf1, "ethernet-1-10"); r.Type != "edge" || r.Peer != "server-a" || r.LldpStatus != "none" {
		t.Errorf("edge row: type=%q peer=%q lldp=%q", r.Type, r.Peer, r.LldpStatus)
	}

	// occupancy: encountered ports on leaf1
	gotOcc := map[int]bool{}
	for _, i := range topo.Occupied["leaf1"] {
		gotOcc[i] = true
	}
	for _, want := range []int{49, 50, 10} {
		if !gotOcc[want] {
			t.Errorf("occupied[leaf1] missing %d (got %v)", want, topo.Occupied["leaf1"])
		}
	}

	// LAG classification
	lag := topo.Lags["lag-1"]
	if !lag.Lacp || !lag.Isl || !lag.Multihomed || lag.Mode != "AllActive" {
		t.Errorf("lag-1 classification: %+v", lag)
	}
	if len(lag.Nodes) != 2 {
		t.Errorf("lag-1 nodes: got %v", lag.Nodes)
	}

	// edges: only interSwitch links with both endpoints known
	if len(topo.Links) != 2 {
		t.Errorf("edges: got %d want 2", len(topo.Links))
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
