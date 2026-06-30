package server

import (
	"strings"
	"testing"
)

func TestColourPanelRaisesOccupiedCages(t *testing.T) {
	svg := []byte(`<svg><path id="cage-1" data-port="1" style="fill:#ddd;fill-opacity:1;stroke:#000"/><path style="fill:#000"/><text data-added="1">c1</text></svg>`)
	out := string(colourPanel(svg, map[string]bool{"1": true}))

	if got := strings.Count(out, occupiedColour); got != 2 {
		t.Fatalf("green fill count = %d, want 2 in original and raised cage: %s", got, out)
	}
	if got := strings.Count(out, `data-port="1"`); got != 2 {
		t.Fatalf("data-port count = %d, want original plus raised copy: %s", got, out)
	}
	if got := strings.Count(out, `id="cage-1"`); got != 1 {
		t.Fatalf("duplicate should not keep source id, id count = %d: %s", got, out)
	}
	if strings.LastIndex(out, `data-port="1"`) > strings.Index(out, `<text data-added="1">`) {
		t.Fatalf("raised cage should be inserted before added labels: %s", out)
	}
}

func TestColourPanelSupportsSingleQuotedDataPorts(t *testing.T) {
	svg := []byte(`<svg><path data-port='2' style='fill:#ddd;fill-opacity:1'/></svg>`)
	out := string(colourPanel(svg, map[string]bool{"2": true}))

	if !strings.Contains(out, "fill:"+occupiedColour+";fill-opacity:1") {
		t.Fatalf("occupied single-quoted cage was not colored: %s", out)
	}
}
