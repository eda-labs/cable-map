// Package server exposes the cable-map HTTP surface: the JSON/SSE topology API the React
// frontend consumes and the embedded SPA itself. It is a faithful port of the old Express
// server (server.ts) so the unchanged frontend keeps working against the Go backend.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"cable-map.eda.labs/cable-map/operators/cable-map/internal/eda"

	"sigs.k8s.io/yaml"
)

type Server struct {
	store *eda.Store
	port  string
	spa   http.Handler
	auth  *authManager
}

func New(store *eda.Store, port string) *Server {
	return &Server{store: store, port: port, spa: spaHandler(distRoot()), auth: newAuthManager()}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.healthz)
	mux.HandleFunc("/oauth/login", s.auth.handleLogin)
	mux.HandleFunc("/oauth/callback", s.auth.handleCallback)
	mux.HandleFunc("/oauth/logout", s.auth.handleLogout)
	mux.HandleFunc("/oauth/session", s.auth.handleSession)
	mux.HandleFunc("/api/namespaces", s.namespaces)
	mux.HandleFunc("/api/namespaces/stream", s.namespacesStream)
	mux.HandleFunc("/api/toponode", s.topoNode)
	mux.HandleFunc("/api/topology", s.topology)
	mux.HandleFunc("/api/topology/stream", s.topologyStream)
	mux.HandleFunc("/pdf", s.pdf)
	mux.Handle("/", s.spa) // SPA + client routes (/, /print)
	return s.auth.wrap(mux)
}

// Run serves until ctx is cancelled, then shuts down gracefully.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{Addr: ":" + s.port, Handler: s.Handler()}
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	log.Printf("cable-map listening on :%s", s.port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// ---- API handlers ---------------------------------------------------------------

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) namespaces(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.store.Namespaces())
}

func (s *Server) topology(w http.ResponseWriter, r *http.Request) {
	topo, ok, errMsg := s.store.Snapshot(nsFilter(r))
	if !ok {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": errMsg})
		return
	}
	writeJSON(w, http.StatusOK, topo)
}

func (s *Server) topoNode(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing toponode name"})
		return
	}
	u, err := s.store.TopoNode(name, strings.TrimSpace(r.URL.Query().Get("ns")))
	if err != nil {
		switch {
		case errors.Is(err, eda.ErrTopoNodeNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "toponode not found"})
		case errors.Is(err, eda.ErrTopoNodeAmbiguous):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "namespace required because toponode name exists in multiple namespaces"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
		return
	}
	raw, err := yaml.Marshal(u.Object)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

func (s *Server) topologyStream(w http.ResponseWriter, r *http.Request) {
	flush, ok := startSSE(w)
	if !ok {
		return
	}
	ch, unsub := s.store.SubscribeTopology(nsFilter(r))
	defer unsub()
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case topo := <-ch:
			b, _ := json.Marshal(topo)
			fmt.Fprintf(w, "data: %s\n\n", b)
			flush()
		case <-ticker.C:
			io.WriteString(w, ": ping\n\n")
			flush()
		}
	}
}

func (s *Server) namespacesStream(w http.ResponseWriter, r *http.Request) {
	flush, ok := startSSE(w)
	if !ok {
		return
	}
	ch, unsub := s.store.SubscribeNamespaces()
	defer unsub()
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case list := <-ch:
			b, _ := json.Marshal(list)
			fmt.Fprintf(w, "data: %s\n\n", b)
			flush()
		case <-ticker.C:
			io.WriteString(w, ": ping\n\n")
			flush()
		}
	}
}

// ---- helpers --------------------------------------------------------------------

func nsFilter(r *http.Request) []string {
	if ns := strings.TrimSpace(r.URL.Query().Get("ns")); ns != "" {
		return []string{ns}
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// startSSE writes the SSE headers + reconnect hint and returns a flush func. The framing
// (text/event-stream, no-transform, X-Accel-Buffering) matches what the EventSource client
// in src/api.ts expects, including through the EDA HttpProxy.
func startSSE(w http.ResponseWriter) (func(), bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, false
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, "retry: 3000\n\n")
	flusher.Flush()
	return flusher.Flush, true
}

// spaHandler serves the embedded SPA, falling back to index.html for client-side routes
// (/, /print) so they load the app instead of 404ing. base:'./' in Vite keeps asset URLs
// relative, so serving at root works under the HttpProxy sub-path with no prefix logic.
func spaHandler(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))
	index, _ := fs.ReadFile(fsys, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if st, err := fs.Stat(fsys, p); err == nil && !st.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(index)
	})
}
