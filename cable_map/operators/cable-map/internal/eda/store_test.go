package eda

import (
	"errors"
	"testing"

	edav1 "eda.dev/edk/api/v1"
	"eda.dev/edk/pkg/utils/jspath"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// projNode/projLink decode via the EDK typed structs; assert the field mapping matches the CR shape.
func TestProjNode(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "leaf1", "namespace": "eda", "labels": map[string]any{"eda.nokia.com/role": "leaf"}},
		"spec":     map[string]any{"platform": "7220 IXR-D3L", "operatingSystem": "srl"},
		"status":   map[string]any{"version": "24.7.1", "platform": "7220 IXR-D3L-status"},
	}}
	got := projNode("", u)
	if got.Name != "leaf1" || got.Namespace != "eda" || got.Labels["eda.nokia.com/role"] != "leaf" {
		t.Errorf("metadata: %+v", got)
	}
	if got.Platform != "7220 IXR-D3L" || got.OperatingSystem != "srl" || got.Version != "24.7.1" || got.StatusPlatform != "7220 IXR-D3L-status" {
		t.Errorf("spec/status: %+v", got)
	}
}

func TestProjNodeVersionFallback(t *testing.T) {
	// no status.version -> falls back to spec.version
	u := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "n"},
		"spec":     map[string]any{"version": "spec-ver"},
	}}
	if got := projNode("", u); got.Version != "spec-ver" {
		t.Errorf("version fallback: got %q want spec-ver", got.Version)
	}
}

func TestProjNodeNamespaceFallback(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "n"},
	}}
	got := projNode("eda-system", u)
	if got.Namespace != "eda-system" {
		t.Errorf("namespace fallback: got %q want eda-system", got.Namespace)
	}
	if md, ok := got.Raw["metadata"].(map[string]interface{}); !ok || md["namespace"] != "eda-system" {
		t.Errorf("raw namespace fallback: %#v", got.Raw["metadata"])
	}
}

func TestProjLink(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "leaf1-spine1-isl-1"},
		"spec": map[string]any{"links": []any{
			map[string]any{
				"type":   "interSwitch",
				"local":  map[string]any{"node": "leaf1", "interface": "ethernet-1-1", "interfaceResource": "ir-a"},
				"remote": map[string]any{"node": "spine1", "interface": "ethernet-1-1"},
			},
		}},
	}}
	got := projLink(u)
	if got.Name != "leaf1-spine1-isl-1" || len(got.Links) != 1 {
		t.Fatalf("link: %+v", got)
	}
	l := got.Links[0]
	if l.Type != "interSwitch" || l.Local.Node != "leaf1" || l.Local.Interface != "ethernet-1-1" || l.Local.InterfaceResource != "ir-a" || l.Remote.Node != "spine1" {
		t.Errorf("link entry: %+v", l)
	}
}

func TestProjIfaceIncludesMemberOperationalState(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "leaf1-ethernet-1-1"},
		"status": map[string]any{"members": []any{
			map[string]any{
				"node":             "leaf1",
				"interface":        "ethernet-1-1",
				"nodeInterface":    "ethernet-1/1",
				"operationalState": "Degraded",
				"neighbors": []any{
					map[string]any{"node": "spine1", "interface": "ethernet-1/2"},
				},
			},
		}},
	}}

	got := projIface(u)
	if len(got.StatusMembers) != 1 {
		t.Fatalf("status members: %+v", got.StatusMembers)
	}
	member := got.StatusMembers[0]
	if member.Node != "leaf1" || member.Interface != "ethernet-1-1" || member.NodeInterface != "ethernet-1/1" || member.OperationalState != "Degraded" {
		t.Errorf("status member: %+v", member)
	}
	if len(member.Neighbors) != 1 || member.Neighbors[0].Node != "spine1" || member.Neighbors[0].Interface != "ethernet-1/2" {
		t.Errorf("neighbors: %+v", member.Neighbors)
	}
}

func TestProjGrouping(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "role", "namespace": "eda-system"},
		"spec": map[string]any{"tierSelectors": []any{
			map[string]any{"tier": int64(2), "nodeSelector": []any{"eda.nokia.com/role=superspine"}},
			map[string]any{"tier": float64(4), "nodeSelector": []any{"eda.nokia.com/role=leaf", "eda.nokia.com/role=borderleaf"}},
			map[string]any{"tier": int64(4)}, // catch-all
		}},
	}}
	got := projGrouping(u)
	if got.Name != "role" || len(got.Selectors) != 3 {
		t.Fatalf("grouping: %+v", got)
	}
	if got.Selectors[0].Tier != 2 || len(got.Selectors[0].NodeSelectors) != 1 {
		t.Errorf("selector 0: %+v", got.Selectors[0])
	}
	if got.Selectors[1].Tier != 4 || len(got.Selectors[1].NodeSelectors) != 2 {
		t.Errorf("selector 1 (float tier, OR selectors): %+v", got.Selectors[1])
	}
	if got.Selectors[2].Tier != 4 || len(got.Selectors[2].NodeSelectors) != 0 {
		t.Errorf("selector 2 (catch-all): %+v", got.Selectors[2])
	}
}

func TestTopoNodeLookup(t *testing.T) {
	s := &Store{caches: map[string]map[string]*unstructured.Unstructured{
		edav1.KTopoNodeGVK.Kind: {
			"eda-system|leaf1": topoNode("leaf1", "eda-system"),
			"tenant-a|leaf1":   topoNode("leaf1", "tenant-a"),
			"tenant-a|leaf2":   topoNode("leaf2", ""),
		},
	}}

	got, err := s.TopoNode("leaf1", "eda-system")
	if err != nil {
		t.Fatalf("namespaced lookup: %v", err)
	}
	if got.GetNamespace() != "eda-system" || got.GetName() != "leaf1" {
		t.Fatalf("namespaced lookup got %s/%s", got.GetNamespace(), got.GetName())
	}

	if _, err := s.TopoNode("leaf1", ""); !errors.Is(err, ErrTopoNodeAmbiguous) {
		t.Fatalf("ambiguous lookup err=%v, want %v", err, ErrTopoNodeAmbiguous)
	}

	got, err = s.TopoNode("leaf2", "tenant-a")
	if err != nil {
		t.Fatalf("namespace fallback lookup: %v", err)
	}
	if got.GetNamespace() != "tenant-a" {
		t.Fatalf("fallback namespace got %q", got.GetNamespace())
	}
	got.SetName("changed")

	got, err = s.TopoNode("leaf2", "tenant-a")
	if err != nil {
		t.Fatalf("lookup after mutating returned copy: %v", err)
	}
	if got.GetName() != "leaf2" {
		t.Fatalf("store returned mutable cache object, name=%q", got.GetName())
	}
}

func TestDashboardStatusLocked(t *testing.T) {
	if _, err := jspath.NewFromString(dashboardStatusJsPath); err != nil {
		t.Fatalf("dashboard status jspath is invalid: %v", err)
	}

	s := &Store{
		caches: map[string]map[string]*unstructured.Unstructured{
			edav1.KTopoNodeGVK.Kind: {
				"eda|leaf1": topoNode("leaf1", "eda"),
				"eda|leaf2": topoNode("leaf2", "eda"),
			},
			edav1.KTopoLinkGVK.Kind: {},
			"Interface":             {},
			"Breakout":              {},
		},
		anySynced: true,
	}
	got := s.dashboardStatusLocked()
	if got.ID != "cable-map" || got.Service != "Cable Map" || got.Open != "View" || got.URL != "/core/httpproxy/v1/cable-map/" {
		t.Fatalf("identity/open fields: %+v", got)
	}
	if got.Status != "Reachable / Ready" || got.HTTP != "Reachable" || got.Data != "Ready" {
		t.Fatalf("status fields: %+v", got)
	}
	if got.Namespaces != 1 || got.Nodes != 2 || got.Links != 0 || got.LAGs != 0 {
		t.Fatalf("counts: %+v", got)
	}

	s.lastErr = "stream unavailable"
	got = s.dashboardStatusLocked()
	if got.Data != "Degraded" || got.Status != "Reachable / Degraded" || got.Details != "stream unavailable" {
		t.Fatalf("degraded status: %+v", got)
	}
}

func topoNode(name, namespace string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": edav1.KTopoNodeGVK.GroupVersion().String(),
		"kind":       edav1.KTopoNodeGVK.Kind,
		"metadata": map[string]interface{}{
			"name": name,
		},
	}}
	if namespace != "" {
		u.SetNamespace(namespace)
	}
	return u
}
