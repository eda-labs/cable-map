package server

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

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
	bin        string
	renderSlot chan struct{}
	once       sync.Once
	fontsDir   string
	initErr    error
}

type pdfRenderProgress struct {
	Phase         string
	Detail        string
	Percent       *int
	Indeterminate bool
}

func newPDFEngine() *pdfEngine {
	bin := os.Getenv("TYPST_BIN")
	if bin == "" {
		bin = "typst"
	}
	return &pdfEngine{bin: bin, renderSlot: make(chan struct{}, 1)}
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
	return e.renderWithProgress(ctx, nodes, stencilDir, remote, stencils, nil)
}

func (e *pdfEngine) renderWithProgress(ctx context.Context, nodes []topology.Node, stencilDir string, remote, stencils map[string]string, progress func(pdfRenderProgress)) ([]byte, error) {
	// Typst can consume multiple GiB for thousand-node documents. Serialize renders so concurrent
	// users cannot multiply that peak and OOM the pod while their job records are still in memory.
	select {
	case e.renderSlot <- struct{}{}:
		defer func() { <-e.renderSlot }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	reportPDFProgress(progress, "Preparing PDF", "", intPtr(0), false)
	fontsDir, err := e.fonts()
	if err != nil {
		return nil, fmt.Errorf("font setup: %w", err)
	}
	reportPDFProgress(progress, "Preparing assets", "Fonts ready", intPtr(5), false)
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
	reportPDFProgress(progress, "Preparing assets", "Template ready", intPtr(10), false)

	type pdfNode struct {
		Name     string     `json:"name"`
		Platform string     `json:"platform"`
		Panel    string     `json:"panel"` // SVG filename in `work`, or "" if no stencil
		Rows     [][]string `json:"rows"`
		Mismatch []bool     `json:"mismatch"` // per row: LLDP saw a neighbour other than the cabled one
	}
	data := struct {
		Nodes []pdfNode `json:"nodes"`
	}{}

	totalNodes := len(nodes)
	panelByHash := map[string]string{} // coloured-panel content hash -> filename
	plans := map[string]*stencilPlan{} // stencil filename -> precomputed plan (nil if missing)
	slottedByName := map[string]bool{} // stencil filename -> slotted cage ids
	for i, n := range nodes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		panel := ""
		svgName := n.Platform
		if s := stencils[n.Name]; s != "" {
			svgName = s
		}
		plan, planned := plans[svgName]
		if !planned {
			if svgBytes, err := os.ReadFile(filepath.Join(stencilDir, svgName+".svg")); err == nil {
				plan = planStencil(svgBytes)
				slottedByName[svgName] = svgSlotted(svgBytes)
			}
			plans[svgName] = plan
		}
		if plan != nil {
			occupied := map[string]bool{}
			for _, r := range n.Table {
				if !linkUp(r) {
					continue // a cabled port whose link isn't up stays uncoloured (grey)
				}
				if c := cageKey(r.Label, slottedByName[svgName]); c != "" {
					occupied[c] = true
				}
			}
			// Nodes that share a stencil and cabled-cage set produce byte-identical panels; write
			// each distinct one once so Typst parses it a single time and embeds one shared resource.
			coloured := plan.colour(occupied)
			sum := sha256.Sum256(coloured)
			key := hex.EncodeToString(sum[:12])
			if panel = panelByHash[key]; panel == "" {
				panel = "panel-" + key + ".svg"
				if err := os.WriteFile(filepath.Join(work, panel), coloured, 0o644); err != nil {
					return nil, err
				}
				panelByHash[key] = panel
			}
		}
		data.Nodes = append(data.Nodes, pdfNode{Name: n.Name, Platform: n.Platform, Panel: panel, Rows: tableRows(n, remote), Mismatch: lldpMismatches(n)})
		reportPDFProgress(progress, "Rendering panels", fmt.Sprintf("%d / %d nodes", i+1, totalNodes), intPtr(10+((i+1)*60)/totalNodes), false)
	}

	jb, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(work, "data.json"), jb, 0o644); err != nil {
		return nil, err
	}
	reportPDFProgress(progress, "Writing PDF data", "", intPtr(75), false)

	out := filepath.Join(work, "out.pdf")
	reportPDFProgress(progress, "Rendering PDF", "Typst compile", nil, true)
	cmd := exec.CommandContext(ctx, e.bin, "compile",
		filepath.Join(work, "template.typ"), out, "--font-path", fontsDir, "--root", work)
	if outp, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("typst compile failed: %w: %s", err, strings.TrimSpace(string(outp)))
	}
	if !pdfCompressEnabled() { // qpdf recompression trades render time for ~13% size — opt-in
		return os.ReadFile(out)
	}
	reportPDFProgress(progress, "Compressing PDF", "", intPtr(95), true)
	return e.compress(ctx, out)
}

// pdfCompressEnabled gates the lossless qpdf pass (PDF_COMPRESS=1). Off by default: it adds
// noticeable time to large exports and only improves file size.
func pdfCompressEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PDF_COMPRESS"))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// compress losslessly shrinks the Typst PDF with qpdf — object streams plus max-level flate
// recompression. Best-effort: if qpdf is absent (e.g. local dev) or fails, the original PDF is
// returned unchanged, so output stays 1:1 either way.
func (e *pdfEngine) compress(ctx context.Context, pdf string) ([]byte, error) {
	bin := os.Getenv("QPDF_BIN")
	if bin == "" {
		bin = "qpdf"
	}
	if _, err := exec.LookPath(bin); err != nil {
		return os.ReadFile(pdf)
	}
	small := pdf + ".min"
	cmd := exec.CommandContext(ctx, bin,
		"--object-streams=generate", "--recompress-flate", "--compression-level=9", pdf, small)
	err := cmd.Run()
	code := -1
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	// qpdf exit 0 = success, 3 = warnings only (output still written); both are usable.
	if err == nil || code == 3 {
		if b, rerr := os.ReadFile(small); rerr == nil {
			return b, nil
		}
	}
	return os.ReadFile(pdf)
}

func reportPDFProgress(progress func(pdfRenderProgress), phase, detail string, percent *int, indeterminate bool) {
	if progress == nil {
		return
	}
	progress(pdfRenderProgress{Phase: phase, Detail: detail, Percent: percent, Indeterminate: indeterminate})
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
		rows = append(rows, []string{r.Label, dash(r.Desc), typ, dash(rn), dash(rp), dash(r.OperationalState), dash(r.LldpPeer)})
	}
	return rows
}

func lldpMismatches(n topology.Node) []bool {
	out := make([]bool, len(n.Table))
	for i, r := range n.Table {
		out[i] = r.LldpStatus == "mismatch"
	}
	return out
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
	reDataPort  = regexp.MustCompile(`\bdata-port=(?:"([^"]*)"|'([^']*)')`)
	rePathCage  = regexp.MustCompile(`<path\b[^>]*\bdata-port=(?:"([^"]+)"|'([^']+)')[^>]*>`)
	reFillAttr  = regexp.MustCompile(`\s+fill=(?:"[^"]*"|'[^']*')`)
	reFillStyle = regexp.MustCompile(`fill\s*:[^;"']*;?`)
	reIDAttr    = regexp.MustCompile(`\s+id=(?:"[^"]*"|'[^']*')`)
	reTag       = regexp.MustCompile(`</?([A-Za-z][A-Za-z0-9_:.-]*)(?:\s[^<>]*)?>`)
	reTextAdded = regexp.MustCompile(`^<text\b[^>]*\bdata-added=(?:"[^"]*"|'[^']*')[^>]*>`)
	reSelfClose = regexp.MustCompile(`/\s*>$`)
)

// linkUp reports whether EDA says the row's physical port is up.
func linkUp(r topology.Row) bool {
	return strings.EqualFold(r.OperationalState, "up")
}

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
		if strings.Contains(portAttrBytes(m), "-") {
			return true
		}
	}
	return false
}

// stencilPlan is a stencil's occupancy-independent structure, computed once per platform so that
// colouring a node's panel doesn't re-scan the (identical-per-platform) ~500KB SVG every time.
// cages are every data-port cage (recoloured in place when occupied); raises are the green copies
// lifted above the pins, each at a precomputed insert position — both filtered by occupancy per node.
type stencilPlan struct {
	svg    []byte
	cages  []cageSpan  // sorted by start
	raises []raiseSpan // sorted by pos (stable in document order)
}

type cageSpan struct {
	start, end int
	port       string
}

type raiseSpan struct {
	pos  int // byte offset in svg to insert the raised copy
	port string
	copy []byte // the original cage tag with its id stripped (greened per node)
}

// planStencil precomputes the cage spans and raise insert points for one stencil SVG.
func planStencil(svg []byte) *stencilPlan {
	var cages []cageSpan
	for _, m := range rePathCage.FindAllSubmatchIndex(svg, -1) {
		port := ""
		if m[2] >= 0 {
			port = string(svg[m[2]:m[3]])
		} else if m[4] >= 0 {
			port = string(svg[m[4]:m[5]])
		}
		cages = append(cages, cageSpan{start: m[0], end: m[1], port: port})
	}
	return &stencilPlan{svg: svg, cages: cages, raises: computeRaises(svg)}
}

type raiseFrame struct {
	name    string
	labelAt int
	cands   []raiseSpan
}

// computeRaises mirrors the old raise-occupied-cages structure pass, but for every cage (not just
// occupied ones), recording each raised copy's insert position. Occupancy is applied per node.
func computeRaises(svg []byte) []raiseSpan {
	text := string(svg)
	var stack []raiseFrame
	var raises []raiseSpan
	for _, m := range reTag.FindAllStringSubmatchIndex(text, -1) {
		tag := text[m[0]:m[1]]
		name := strings.ToLower(text[m[2]:m[3]])
		if strings.HasPrefix(tag, "</") {
			i := -1
			for j := len(stack) - 1; j >= 0; j-- {
				if stack[j].name == name {
					i = j
					break
				}
			}
			if i < 0 {
				continue
			}
			frame := stack[i]
			stack = append(stack[:i], stack[i+1:]...)
			insertAt := frame.labelAt
			if insertAt < 0 {
				insertAt = m[0]
			}
			for _, c := range frame.cands {
				c.pos = insertAt
				raises = append(raises, c)
			}
			continue
		}
		if len(stack) > 0 && name == "text" && stack[len(stack)-1].labelAt < 0 && reTextAdded.MatchString(tag) {
			stack[len(stack)-1].labelAt = m[0]
		}
		if len(stack) > 0 && name == "path" && reSelfClose.MatchString(tag) {
			if port := tagPort(tag); port != "" {
				top := &stack[len(stack)-1]
				top.cands = append(top.cands, raiseSpan{port: port, copy: reIDAttr.ReplaceAll([]byte(tag), nil)})
			}
		}
		if !reSelfClose.MatchString(tag) {
			stack = append(stack, raiseFrame{name: name, labelAt: -1})
		}
	}
	sort.SliceStable(raises, func(a, b int) bool { return raises[a].pos < raises[b].pos })
	return raises
}

// colour assembles a node's panel: occupied cages recoloured green in place, plus their raised
// green copies inserted at the precomputed points — a single forward pass over the base SVG, no
// per-node regex scanning. Output is byte-identical to the old scan-per-node colourPanel.
func (p *stencilPlan) colour(occupied map[string]bool) []byte {
	svg := p.svg
	out := make([]byte, 0, len(svg)+512)
	cursor, ci, ri := 0, 0, 0
	for ci < len(p.cages) || ri < len(p.raises) {
		for ri < len(p.raises) && !occupied[p.raises[ri].port] {
			ri++
		}
		rp, cp := 1<<62, 1<<62
		if ri < len(p.raises) {
			rp = p.raises[ri].pos
		}
		if ci < len(p.cages) {
			cp = p.cages[ci].start
		}
		if rp == 1<<62 && cp == 1<<62 {
			break
		}
		if rp <= cp {
			out = append(out, svg[cursor:rp]...)
			cursor = rp
			out = append(out, colourCageTag(p.raises[ri].copy)...)
			ri++
		} else {
			c := p.cages[ci]
			out = append(out, svg[cursor:c.start]...)
			if occupied[c.port] {
				out = append(out, colourCageTag(svg[c.start:c.end])...)
			} else {
				out = append(out, svg[c.start:c.end]...)
			}
			cursor = c.end
			ci++
		}
	}
	return append(out, svg[cursor:]...)
}

// colourPanel fills the occupied cages. Single-shot callers plan inline; the renderer caches the
// plan per platform (planStencil) so the expensive scan happens once, not once per node.
func colourPanel(svg []byte, occupied map[string]bool) []byte {
	return planStencil(svg).colour(occupied)
}

func tagPort(tag string) string {
	return portAttr(reDataPort.FindStringSubmatch(tag))
}

func portAttr(match []string) string {
	if len(match) > 1 && match[1] != "" {
		return match[1]
	}
	if len(match) > 2 {
		return match[2]
	}
	return ""
}

func portAttrBytes(match [][]byte) string {
	if len(match) > 1 && len(match[1]) > 0 {
		return string(match[1])
	}
	if len(match) > 2 {
		return string(match[2])
	}
	return ""
}

func colourCageTag(tag []byte) []byte {
	t := reFillAttr.ReplaceAll(tag, nil)
	t = reFillStyle.ReplaceAll(t, nil)
	fill := "fill:" + occupiedColour + ";fill-opacity:1"
	text := string(t)
	if strings.Contains(text, `style="`) {
		return []byte(strings.Replace(text, `style="`, `style="`+fill+`;`, 1))
	}
	if strings.Contains(text, `style='`) {
		return []byte(strings.Replace(text, `style='`, `style='`+fill+`;`, 1))
	}
	return []byte(strings.Replace(text, "<path", `<path style="`+fill+`"`, 1))
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

	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, pdfFilename(r.URL.Query().Get("ns"))))
	_, _ = w.Write(pdf)
}

func pdfFilename(namespace string) string {
	return pdfFilenameAt(namespace, time.Now())
}

func pdfFilenameAt(namespace string, now time.Time) string {
	name := "cable_map"
	if ns := safeFilenamePart(namespace); ns != "" {
		name += "_" + ns
	}
	return name + "_" + now.UTC().Format("2006-01-02_15-04-05Z") + ".pdf"
}

func safeFilenamePart(s string) string {
	var b strings.Builder
	lastUnderscore := false
	for _, r := range strings.TrimSpace(s) {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-'
		if ok {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore && b.Len() > 0 {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	return strings.Trim(b.String(), "_")
}
