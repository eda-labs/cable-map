package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"cable-map.eda.labs/cable-map/operators/cable-map/internal/topology"
)

// Render assets: the Typst template, the logo, and the fonts.
//
//go:embed pdfassets
var pdfAssets embed.FS

const occupiedColour = "#00A87E" // fill for a cabled cage

// ---- engine ---------------------------------------------------------------------

// pdfEngine shells out to `typst`. Fonts are extracted once to a temp dir (--font-path); the
// template + per-request data are written per render.
type pdfEngine struct {
	bin      string
	once     sync.Once
	fontsDir string
	initErr  error
}

func newPDFEngine() *pdfEngine {
	bin := os.Getenv("TYPST_BIN")
	if bin == "" {
		bin = "typst"
	}
	return &pdfEngine{bin: bin}
}

func (e *pdfEngine) fonts() (string, error) {
	e.once.Do(func() {
		dir, err := os.MkdirTemp("", "cable-map-fonts-")
		if err != nil {
			e.initErr = err
			return
		}
		for _, f := range []string{"NokiaPureText_Lt.ttf", "NokiaPureText_Bd.ttf"} {
			b, err := pdfAssets.ReadFile("pdfassets/" + f)
			if err != nil {
				e.initErr = err
				return
			}
			if err := os.WriteFile(filepath.Join(dir, f), b, 0o644); err != nil {
				e.initErr = err
				return
			}
		}
		e.fontsDir = dir
	})
	return e.fontsDir, e.initErr
}

func (e *pdfEngine) close() {
	if e.fontsDir != "" {
		_ = os.RemoveAll(e.fontsDir)
	}
}

// render produces the multi-page PDF (one page per node) from the topology nodes. stencils maps a
// node name to its resolved front-panel filename (modular chassis render a card-derived composite,
// not <platform>.svg); a node absent from the map falls back to its platform.
func (e *pdfEngine) render(ctx context.Context, nodes []topology.Node, stencilDir string, remote, stencils map[string]string) ([]byte, error) {
	fontsDir, err := e.fonts()
	if err != nil {
		return nil, fmt.Errorf("font setup: %w", err)
	}
	work, err := os.MkdirTemp("", "cable-map-pdf-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)

	for _, f := range []string{"template.typ", "eda.svg"} {
		b, err := pdfAssets.ReadFile("pdfassets/" + f)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(work, f), b, 0o644); err != nil {
			return nil, err
		}
	}

	type pdfNode struct {
		Name     string     `json:"name"`
		Platform string     `json:"platform"`
		Panel    string     `json:"panel"` // SVG filename in `work`, or "" if no stencil
		Rows     [][]string `json:"rows"`
	}
	data := struct {
		Nodes []pdfNode `json:"nodes"`
	}{}

	for i, n := range nodes {
		panel := ""
		svgName := n.Platform
		if s := stencils[n.Name]; s != "" {
			svgName = s
		}
		if svgBytes, err := os.ReadFile(filepath.Join(stencilDir, svgName+".svg")); err == nil {
			slotted := svgSlotted(svgBytes)
			occupied := map[string]bool{}
			for _, r := range n.Table {
				if c := cageKey(r.Label, slotted); c != "" {
					occupied[c] = true
				}
			}
			panel = fmt.Sprintf("panel-%d.svg", i)
			if err := os.WriteFile(filepath.Join(work, panel), colourPanel(svgBytes, occupied), 0o644); err != nil {
				return nil, err
			}
		}
		data.Nodes = append(data.Nodes, pdfNode{Name: n.Name, Platform: n.Platform, Panel: panel, Rows: tableRows(n, remote)})
	}

	jb, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(work, "data.json"), jb, 0o644); err != nil {
		return nil, err
	}

	out := filepath.Join(work, "out.pdf")
	cmd := exec.CommandContext(ctx, e.bin, "compile",
		filepath.Join(work, "template.typ"), out, "--font-path", fontsDir, "--root", work)
	if outp, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("typst compile failed: %w: %s", err, strings.TrimSpace(string(outp)))
	}
	return os.ReadFile(out)
}

// ---- data shaping ---------------------------------------------------------------

// tableRows builds the cable-matrix cells: type label + LAG suffix, edge-remote overrides, peer
// fallback, em dash for empty.
func tableRows(n topology.Node, remote map[string]string) [][]string {
	rows := make([][]string, 0, len(n.Table))
	for _, r := range n.Table {
		typ := r.Type
		if typ == "interSwitch" {
			typ = "ISL"
		}
		if r.Lag != "" {
			typ += " (LAG)"
		}
		rn, rp := r.RemoteNode, r.RemotePort
		if r.Type == "edge" {
			if v := remote[n.Name+" "+r.Label+" node"]; v != "" {
				rn = v
			}
			if v := remote[n.Name+" "+r.Label+" port"]; v != "" {
				rp = v
			}
		}
		if rn == "" && r.Peer != "" {
			rn = r.Peer
		}
		rows = append(rows, []string{r.Label, dash(r.Desc), typ, dash(rn), dash(rp), dash(r.LldpPeer)})
	}
	return rows
}

func dash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

// ---- stencil / cage logic ----

var (
	reNum       = regexp.MustCompile(`\d+`)
	reSrosConn  = regexp.MustCompile(`(?i)(?:^|[/_-])c(\d+)(?:[/_-]|$)`)
	reDataPort  = regexp.MustCompile(`data-port="([^"]*)"`)
	rePathCage  = regexp.MustCompile(`<path\b[^>]*\bdata-port="([^"]+)"[^>]*>`)
	reFillAttr  = regexp.MustCompile(`\s+fill="[^"]*"`)
	reFillStyle = regexp.MustCompile(`fill\s*:[^;"]*;?`)
)

// cageKey maps an EDA/SROS interface name to its front-panel cage id (port "12" or slotted "1-12").
func cageKey(label string, slotted bool) string {
	ns := reNum.FindAllString(label, -1)
	if len(ns) == 0 {
		return ""
	}
	port := ""
	if m := reSrosConn.FindStringSubmatch(label); m != nil {
		port = m[1]
	}
	if port == "" {
		if len(ns) >= 2 {
			port = ns[1]
		} else {
			port = ns[0]
		}
	}
	if slotted {
		if len(ns) >= 2 {
			return ns[0] + "-" + port
		}
		return port
	}
	return port
}

// svgSlotted reports whether cage ids are per-slot ("<slot>-<port>").
func svgSlotted(svg []byte) bool {
	for _, m := range reDataPort.FindAllSubmatch(svg, -1) {
		if strings.Contains(string(m[1]), "-") {
			return true
		}
	}
	return false
}

// colourPanel fills the occupied cages.
func colourPanel(svg []byte, occupied map[string]bool) []byte {
	return rePathCage.ReplaceAllFunc(svg, func(tag []byte) []byte {
		m := rePathCage.FindSubmatch(tag)
		if m == nil || !occupied[string(m[1])] {
			return tag
		}
		t := reFillAttr.ReplaceAll(tag, nil)
		t = reFillStyle.ReplaceAll(t, nil)
		fill := "fill:" + occupiedColour + ";fill-opacity:1"
		if strings.Contains(string(t), `style="`) {
			return []byte(strings.Replace(string(t), `style="`, `style="`+fill+`;`, 1))
		}
		return []byte(strings.Replace(string(t), "<path", `<path style="`+fill+`"`, 1))
	})
}

// ---- handler --------------------------------------------------------------------

// pdf renders the selected nodes (or all) to one PDF.
func (s *Server) pdf(w http.ResponseWriter, r *http.Request) {
	topo, ok, errMsg := s.store.Snapshot(nsFilter(r))
	if !ok {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": errMsg})
		return
	}

	byName := make(map[string]topology.Node, len(topo.Nodes))
	for _, n := range topo.Nodes {
		byName[n.Name] = n
	}

	nodesParam := strings.TrimSpace(r.URL.Query().Get("nodes"))
	var nodes []topology.Node
	if nodesParam != "" {
		for _, name := range strings.Split(nodesParam, ",") {
			if name = strings.TrimSpace(name); name != "" {
				if n, ok := byName[name]; ok {
					nodes = append(nodes, n)
				}
			}
		}
	} else {
		nodes = topo.Nodes
	}
	if len(nodes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no nodes to render"})
		return
	}

	remote := map[string]string{}
	if rp := r.URL.Query().Get("remote"); rp != "" {
		_ = json.Unmarshal([]byte(rp), &remote)
	}
	stencils := map[string]string{}
	if sp := r.URL.Query().Get("stencils"); sp != "" {
		_ = json.Unmarshal([]byte(sp), &stencils)
	}

	pdf, err := s.engine.render(r.Context(), nodes, stencilDir(), remote, stencils)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	name := "cable-map"
	if nodesParam != "" {
		name += "-" + strings.ReplaceAll(nodesParam, ",", "_")
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s.pdf"`, name))
	_, _ = w.Write(pdf)
}
