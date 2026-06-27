package server

import (
	"context"
	"fmt"
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
)

const (
	pdfRenderTimeout      = 30 * time.Second
	defaultPDFConcurrency = 4
)

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
func (p *pdfRenderer) render(reqCtx context.Context, target string) ([]byte, error) {
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
				WithMarginTop(0.5).WithMarginBottom(0.5).
				WithMarginLeft(0.5).WithMarginRight(0.5).
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
	nodes := strings.TrimSpace(r.URL.Query().Get("nodes"))
	params := url.Values{}
	if nodes != "" {
		params.Set("nodes", nodes)
	}
	if ns := strings.TrimSpace(r.URL.Query().Get("ns")); ns != "" {
		params.Set("ns", ns)
	}
	if remote := r.URL.Query().Get("remote"); remote != "" {
		params.Set("remote", remote)
	}
	q := ""
	if len(params) > 0 {
		q = "?" + params.Encode()
	}
	target := fmt.Sprintf("http://127.0.0.1:%s/print%s", s.port, q)

	buf, err := s.renderer.render(r.Context(), target)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	name := "cable-map"
	if nodes != "" {
		name += "-" + strings.ReplaceAll(nodes, ",", "_")
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s.pdf"`, name))
	w.Write(buf)
}
