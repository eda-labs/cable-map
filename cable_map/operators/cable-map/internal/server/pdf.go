package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
	"github.com/pdfcpu/pdfcpu/pkg/api"
)

const (
	pdfRenderTimeout      = 30 * time.Second
	defaultPDFConcurrency = 4
)

// Chrome renders the PDF footer in an isolated context with none of the page's fonts/CSS, so the
// NokiaPureText woff2 is inlined as a data-URI @font-face (read once from the embedded dist).
var pdfFooterFontFace = sync.OnceValue(func() string {
	b, err := readDistFont("NokiaPureText_Lt")
	if err != nil || len(b) == 0 {
		return "" // fall back to the template's sans-serif
	}
	return `<style>@font-face{font-family:'NokiaPureText';src:url(data:font/woff2;base64,` +
		base64.StdEncoding.EncodeToString(b) + `) format('woff2');}</style>`
})

func readDistFont(prefix string) ([]byte, error) {
	d := distRoot()
	entries, err := fs.ReadDir(d, "assets")
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) && strings.HasSuffix(e.Name(), ".woff2") {
			return fs.ReadFile(d, "assets/"+e.Name())
		}
	}
	return nil, fmt.Errorf("font %s*.woff2 not found in dist", prefix)
}

// pdfFooter is Chrome's per-page footer for one node's PDF: node name (left), page number (right), one
// line in the bottom margin, in NokiaPureText at the table's text size. The PDF is rendered one node
// at a time (name baked in here) and the per-node PDFs merged — Chrome can't vary the name per page.
func pdfFooter(node string) string {
	return pdfFooterFontFace() +
		`<div style="width:100%;font-size:13px;color:#888;font-family:'NokiaPureText',sans-serif;padding:0 10mm;">` +
		`<span style="float:left;">` + html.EscapeString(node) + `</span>` +
		`<span style="float:right;"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
}

// pdfRenderer keeps one warm headless-Chrome process and renders each request in its own tab, so
// requests skip Chrome's ~1-2s cold start and several PDFs render concurrently in parallel tabs. A
// semaphore bounds concurrent renders so memory stays in check (override with PDF_CONCURRENCY).
type pdfRenderer struct {
	sem chan struct{}

	mu         sync.Mutex
	browserCtx context.Context
	stop       context.CancelFunc // tears down the browser + its allocator
}

func newPDFRenderer() *pdfRenderer {
	n := defaultPDFConcurrency
	if v, err := strconv.Atoi(os.Getenv("PDF_CONCURRENCY")); err == nil && v > 0 {
		n = v
	}
	if n > 8 {
		n = 8
	}
	return &pdfRenderer{sem: make(chan struct{}, n)}
}

// browser returns a live shared browser context, launching (or relaunching after a crash) Chrome on
// demand. It's tied to context.Background() so the browser outlives individual requests.
func (p *pdfRenderer) browser() (context.Context, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.browserCtx != nil && p.browserCtx.Err() == nil {
		return p.browserCtx, nil
	}
	if p.stop != nil {
		p.stop()
	}
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true), // tiny /dev/shm crashes Chromium in containers
	)
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	if err := chromedp.Run(browserCtx); err != nil { // start Chrome now so a launch failure surfaces here
		cancelBrowser()
		cancelAlloc()
		return nil, err
	}
	p.browserCtx = browserCtx
	p.stop = func() { cancelBrowser(); cancelAlloc() }
	return browserCtx, nil
}

func (p *pdfRenderer) reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stop != nil {
		p.stop()
		p.stop = nil
	}
	p.browserCtx = nil
}

func (p *pdfRenderer) close() { p.reset() }

// render loads target in a fresh tab off the shared browser and returns the printed PDF. Concurrency
// is bounded by the semaphore; the tab is aborted if the client disconnects or the render times out.
func (p *pdfRenderer) render(reqCtx context.Context, target, footer string) ([]byte, error) {
	select {
	case p.sem <- struct{}{}:
		defer func() { <-p.sem }()
	case <-reqCtx.Done():
		return nil, reqCtx.Err()
	}

	browserCtx, err := p.browser()
	if err != nil {
		return nil, err
	}
	tabCtx, cancelTab := chromedp.NewContext(browserCtx)
	defer cancelTab()
	stopOnDisconnect := context.AfterFunc(reqCtx, cancelTab)
	defer stopOnDisconnect()
	tabCtx, cancelTimeout := context.WithTimeout(tabCtx, pdfRenderTimeout)
	defer cancelTimeout()

	// The loopback /print render hits this same server directly (127.0.0.1, no proxy), so it needs
	// no auth — EDA already authorised the /pdf request that triggered it.
	var buf []byte
	err = chromedp.Run(tabCtx,
		chromedp.Navigate(target),
		// Print.tsx sets data-print-ready="1" once /api/topology has loaded.
		chromedp.WaitReady(`[data-print-ready="1"]`, chromedp.ByQuery),
		// Embed NokiaPureText rather than the fallback font.
		chromedp.ActionFunc(func(ctx context.Context) error {
			var ready bool
			return chromedp.Evaluate(`document.fonts.ready.then(() => true)`, &ready,
				func(ep *runtime.EvaluateParams) *runtime.EvaluateParams { return ep.WithAwaitPromise(true) },
			).Do(ctx)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			var e error
			buf, _, e = page.PrintToPDF().
				WithPrintBackground(true).
				WithPreferCSSPageSize(true). // honour print.css `@page { size: A4 landscape }`
				WithDisplayHeaderFooter(true).
				WithHeaderTemplate("<span></span>"). // suppress Chrome's default title/date header
				WithFooterTemplate(footer).
				WithMarginTop(0.4).WithMarginBottom(0.4). // default A4 print margins (~1cm), print-safe
				WithMarginLeft(0.4).WithMarginRight(0.4).
				Do(ctx)
			return e
		}),
	)
	if err != nil {
		if browserCtx.Err() != nil { // shared browser died → drop it so the next render relaunches
			p.reset()
		}
		return nil, err
	}
	return buf, nil
}

// pdf renders the SPA's /print page to a PDF with the pooled headless Chrome. It drives the app's own
// loopback /print route, so it depends on this server serving /print + /api/topology + the
// front-panel SVGs/fonts. Requires Chromium in the runtime image.
func (s *Server) pdf(w http.ResponseWriter, r *http.Request) {
	ns := strings.TrimSpace(r.URL.Query().Get("ns"))
	remote := r.URL.Query().Get("remote")
	nodesParam := strings.TrimSpace(r.URL.Query().Get("nodes"))

	var nodeList []string
	if nodesParam != "" {
		for _, n := range strings.Split(nodesParam, ",") {
			if n = strings.TrimSpace(n); n != "" {
				nodeList = append(nodeList, n)
			}
		}
	} else if topo, ok, _ := s.store.Snapshot(nsFilter(r)); ok {
		for _, n := range topo.Nodes {
			nodeList = append(nodeList, n.Name)
		}
	}
	if len(nodeList) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no nodes to render"})
		return
	}

	// One node per PDF (its name baked into the footer), rendered concurrently within the renderer's
	// semaphore, then merged in order — Chrome's footer can't vary the node name per page in one render.
	pdfs := make([][]byte, len(nodeList))
	errs := make([]error, len(nodeList))
	var wg sync.WaitGroup
	for i, node := range nodeList {
		wg.Add(1)
		go func(i int, node string) {
			defer wg.Done()
			params := url.Values{}
			params.Set("nodes", node)
			if ns != "" {
				params.Set("ns", ns)
			}
			if remote != "" {
				params.Set("remote", remote)
			}
			target := fmt.Sprintf("http://127.0.0.1:%s/print?%s", s.port, params.Encode())
			pdfs[i], errs[i] = s.renderer.render(r.Context(), target, pdfFooter(node))
		}(i, node)
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": e.Error()})
			return
		}
	}

	merged, err := mergePDFs(pdfs)
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
	w.Write(merged)
}

// mergePDFs concatenates the per-node PDFs into one document (a single node is returned as-is).
func mergePDFs(pdfs [][]byte) ([]byte, error) {
	if len(pdfs) == 1 {
		return pdfs[0], nil
	}
	rs := make([]io.ReadSeeker, len(pdfs))
	for i, b := range pdfs {
		rs[i] = bytes.NewReader(b)
	}
	var out bytes.Buffer
	if err := api.MergeRaw(rs, &out, false, nil); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
