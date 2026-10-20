package server

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"cable-map.eda.labs/cable-map/operators/cable-map/internal/topology"
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

func TestPDFTableRowsIncludeOperationalState(t *testing.T) {
	node := topology.Node{
		Name: "leaf1",
		Table: []topology.Row{{
			Label:            "ethernet-1-1",
			Desc:             "to spine1",
			RemoteNode:       "spine1",
			RemotePort:       "ethernet-1-2",
			Type:             "interSwitch",
			OperationalState: "Down",
			LldpPeer:         "spine1 ethernet-1-2",
		}},
	}

	got := tableRows(node, nil)
	want := [][]string{{
		"ethernet-1-1", "to spine1", "ISL", "spine1", "ethernet-1-2", "Down", "spine1 ethernet-1-2",
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("PDF table rows = %#v, want %#v", got, want)
	}
}

func TestPDFJobPublishesProgressAndReadyResult(t *testing.T) {
	store := newPDFJobStore()
	job := store.create("cable_map.pdf")
	events, unsub := job.subscribe()
	defer unsub()

	if event := <-events; event.Status != pdfJobRunning || event.Phase != "Queued" {
		t.Fatalf("initial event = %#v, want queued running event", event)
	}

	job.update(pdfJobEvent{Status: pdfJobRunning, Phase: "Rendering panels", Detail: "1 / 2 nodes", Percent: intPtr(40)})
	if event := <-events; event.Phase != "Rendering panels" || event.Percent == nil || *event.Percent != 40 {
		t.Fatalf("progress event = %#v, want rendering panels at 40%%", event)
	}

	job.ready([]byte("%PDF"))
	if event := <-events; event.Status != pdfJobReady || event.Percent == nil || *event.Percent != 100 {
		t.Fatalf("ready event = %#v, want ready at 100%%", event)
	}
	if _, ok := <-events; ok {
		t.Fatal("events channel stayed open after ready")
	}

	pdf, filename, event := job.result()
	if string(pdf) != "%PDF" || filename != "cable_map.pdf" || event.Status != pdfJobReady {
		t.Fatalf("result = %q %q %#v, want ready PDF result", pdf, filename, event)
	}
}

func TestPDFJobStoreExpiresTerminalJobs(t *testing.T) {
	store := newPDFJobStore()
	job := store.create("cable_map.pdf")
	job.ready([]byte("%PDF"))
	job.mu.Lock()
	job.expiresAt = time.Now().Add(-time.Second)
	job.mu.Unlock()

	if _, ok := store.get(job.id); ok {
		t.Fatal("expired PDF job was not cleaned up")
	}
}

func TestRunningPDFJobDoesNotExpire(t *testing.T) {
	store := newPDFJobStore()
	job := store.create("cable_map.pdf")

	if job.expired(time.Now().Add(24 * time.Hour)) {
		t.Fatal("running PDF job expired")
	}
	if got, ok := store.get(job.id); !ok || got != job {
		t.Fatal("running PDF job was removed from the store")
	}
}

func TestPDFFilenameIncludesNamespaceAndUTCTimestamp(t *testing.T) {
	now := time.Date(2026, time.July, 28, 16, 35, 22, 0, time.FixedZone("CEST", 2*60*60))
	got := pdfFilenameAt(" tenant/a ", now)
	want := "cable_map_tenant_a_2026-07-28_14-35-22Z.pdf"
	if got != want {
		t.Fatalf("pdf filename = %q, want %q", got, want)
	}
}

func TestSelectPDFNodesPreservesRequestedOrder(t *testing.T) {
	topo := topology.Topology{Nodes: []topology.Node{
		{Name: "leaf-a"},
		{Name: "leaf-b"},
		{Name: "leaf-c"},
	}}

	nodes := selectPDFNodes(topo, []string{"leaf-c", "missing", "leaf-a"})
	if len(nodes) != 2 || nodes[0].Name != "leaf-c" || nodes[1].Name != "leaf-a" {
		t.Fatalf("selected nodes = %#v, want leaf-c then leaf-a", nodes)
	}
}

func TestLinkUp(t *testing.T) {
	for state, want := range map[string]bool{"Up": true, "up": true, "Down": false, "Degraded": false, "Unknown": false, "N/A": false, "": false} {
		if got := linkUp(topology.Row{OperationalState: state}); got != want {
			t.Errorf("linkUp(%q) = %v, want %v", state, got, want)
		}
	}
}

func TestLLDPMismatchesFlagsRows(t *testing.T) {
	node := topology.Node{Table: []topology.Row{{LldpStatus: "ok"}, {LldpStatus: "mismatch"}, {LldpStatus: "none"}}}
	if got, want := lldpMismatches(node), []bool{false, true, false}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lldpMismatches = %v, want %v", got, want)
	}
}
