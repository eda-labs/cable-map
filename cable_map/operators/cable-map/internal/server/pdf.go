package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/chromedp/cdproto/network"
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
		network.Enable(),
		chromedp.ActionFunc(func(ctx context.Context) error {
			if s.auth == nil || !s.auth.enabled() {
				return nil
			}
			c, err := r.Cookie(sessionCookieName)
			if err != nil || c.Value == "" {
				return fmt.Errorf("missing authenticated session")
			}
			if err := network.SetCookie(sessionCookieName, c.Value).
				WithURL(fmt.Sprintf("http://127.0.0.1:%s/", s.port)).
				WithPath("/").
				WithHTTPOnly(true).
				Do(ctx); err != nil {
				return err
			}
			return nil
		}),
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
				WithPreferCSSPageSize(true). // honour print.css `@page { size: A4 landscape }`
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
