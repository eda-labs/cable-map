package eda

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// projNode/projLink decode via the EDK typed structs; assert the field mapping matches the CR shape.
func TestProjNode(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "leaf1", "namespace": "eda", "labels": map[string]any{"eda.nokia.com/role": "leaf"}},
		"spec":     map[string]any{"platform": "7220 IXR-D3L", "operatingSystem": "srl"},
		"status":   map[string]any{"version": "24.7.1", "platform": "7220 IXR-D3L-status"},
	}}
	got := projNode(u)
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
	if got := projNode(u); got.Version != "spec-ver" {
		t.Errorf("version fallback: got %q want spec-ver", got.Version)
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
