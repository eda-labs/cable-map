package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

// pdf renders the SPA's /print page to a PDF with headless Chrome (chromedp), the Go
// equivalent of the old Puppeteer path. It drives the app's own loopback /print route, so
// it depends on this server serving /print + /api/topology + the front-panel SVGs/fonts.
// Requires Chromium in the runtime image.
func (s *Server) pdf(w http.ResponseWriter, r *http.Request) {
	nodes := strings.TrimSpace(r.URL.Query().Get("nodes"))
	q := ""
	if nodes != "" {
		q = "?nodes=" + url.QueryEscape(nodes)
	}
	target := fmt.Sprintf("http://127.0.0.1:%s/print%s", s.port, q)

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true), // tiny /dev/shm crashes Chromium in containers
	)
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(r.Context(), opts...)
	defer cancelAlloc()
	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()
	ctx, cancelTimeout := context.WithTimeout(ctx, 30*time.Second)
	defer cancelTimeout()

	var buf []byte
	err := chromedp.Run(ctx,
		chromedp.Navigate(target),
		// Print.tsx sets data-print-ready="1" once /api/topology has loaded.
		chromedp.WaitReady(`[data-print-ready="1"]`, chromedp.ByQuery),
		// Embed NokiaPureText rather than the fallback font.
		chromedp.ActionFunc(func(ctx context.Context) error {
			var ready bool
			return chromedp.Evaluate(`document.fonts.ready.then(() => true)`, &ready,
				func(p *runtime.EvaluateParams) *runtime.EvaluateParams { return p.WithAwaitPromise(true) },
			).Do(ctx)
		}),
		chromedp.ActionFunc(func(ctx context.Context) error {
			var err error
			buf, _, err = page.PrintToPDF().
				WithPrintBackground(true).
				WithLandscape(true).
				WithPaperWidth(11.69).WithPaperHeight(8.27). // A4 landscape (inches)
				WithMarginTop(0.5).WithMarginBottom(0.5).
				WithMarginLeft(0.5).WithMarginRight(0.5).
				Do(ctx)
			return err
		}),
	)
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
