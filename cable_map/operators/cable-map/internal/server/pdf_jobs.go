package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"cable-map.eda.labs/cable-map/operators/cable-map/internal/topology"
)

const pdfJobTTL = 10 * time.Minute

type pdfJobStatus string

const (
	pdfJobRunning pdfJobStatus = "running"
	pdfJobReady   pdfJobStatus = "ready"
	pdfJobError   pdfJobStatus = "error"
)

type pdfJobEvent struct {
	Status        pdfJobStatus `json:"status"`
	Phase         string       `json:"phase"`
	Detail        string       `json:"detail,omitempty"`
	Percent       *int         `json:"percent,omitempty"`
	Indeterminate bool         `json:"indeterminate,omitempty"`
	Message       string       `json:"message,omitempty"`
}

type pdfJobStore struct {
	mu   sync.Mutex
	jobs map[string]*pdfJob
	ttl  time.Duration
}

type pdfJob struct {
	id       string
	filename string
	ttl      time.Duration

	mu          sync.Mutex
	event       pdfJobEvent
	pdf         []byte
	expiresAt   time.Time
	subscribers map[chan pdfJobEvent]struct{}
}

type pdfJobRequest struct {
	Namespace string            `json:"namespace"`
	Nodes     []string          `json:"nodes"`
	Remote    map[string]string `json:"remote"`
	Stencils  map[string]string `json:"stencils"`
}

func newPDFJobStore() *pdfJobStore {
	return &pdfJobStore{jobs: map[string]*pdfJob{}, ttl: pdfJobTTL}
}

func (s *pdfJobStore) create(filename string) *pdfJob {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked(time.Now())

	id := newPDFJobID()
	for s.jobs[id] != nil {
		id = newPDFJobID()
	}
	job := &pdfJob{
		id: id, filename: filename, ttl: s.ttl,
		event:       pdfJobEvent{Status: pdfJobRunning, Phase: "Queued", Percent: intPtr(0)},
		subscribers: map[chan pdfJobEvent]struct{}{},
	}
	s.jobs[id] = job
	return job
}

func (s *pdfJobStore) get(id string) (*pdfJob, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked(time.Now())
	job, ok := s.jobs[id]
	return job, ok
}

func (s *pdfJobStore) cleanupLocked(now time.Time) {
	for id, job := range s.jobs {
		if job.expired(now) {
			delete(s.jobs, id)
		}
	}
}

func (j *pdfJob) expired(now time.Time) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return !j.expiresAt.IsZero() && now.After(j.expiresAt)
}

func (j *pdfJob) update(event pdfJobEvent) {
	if event.Status == "" {
		event.Status = pdfJobRunning
	}

	j.mu.Lock()
	j.event = event
	if isTerminalPDFJobStatus(event.Status) {
		j.expiresAt = time.Now().Add(j.ttl)
	}
	subs := make([]chan pdfJobEvent, 0, len(j.subscribers))
	for ch := range j.subscribers {
		sendPDFJobEvent(ch, event)
		subs = append(subs, ch)
	}
	if isTerminalPDFJobStatus(event.Status) {
		for _, ch := range subs {
			delete(j.subscribers, ch)
			close(ch)
		}
	}
	j.mu.Unlock()
}

func (j *pdfJob) ready(pdf []byte) {
	j.mu.Lock()
	j.pdf = pdf // freshly rendered slice, not aliased — take ownership rather than copy (it can be 100s of MB)
	j.mu.Unlock()
	j.update(pdfJobEvent{Status: pdfJobReady, Phase: "PDF ready", Percent: intPtr(100)})
}

func (j *pdfJob) fail(err error) {
	j.update(pdfJobEvent{Status: pdfJobError, Phase: "PDF export failed", Message: err.Error()})
}

func (j *pdfJob) subscribe() (<-chan pdfJobEvent, func()) {
	ch := make(chan pdfJobEvent, 8)

	j.mu.Lock()
	event := j.event
	sendPDFJobEvent(ch, event)
	if isTerminalPDFJobStatus(event.Status) {
		close(ch)
	} else {
		j.subscribers[ch] = struct{}{}
	}
	j.mu.Unlock()

	unsub := func() {
		j.mu.Lock()
		delete(j.subscribers, ch)
		j.mu.Unlock()
	}
	return ch, unsub
}

func (j *pdfJob) result() ([]byte, string, pdfJobEvent) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.pdf, j.filename, j.event // j.pdf is set once at ready and never mutated; no need to copy
}

// status returns the latest progress event without copying the (large) rendered PDF — used by the
// polling endpoint, which the frontend prefers over SSE since the EDA httpproxy buffers streams.
func (j *pdfJob) status() pdfJobEvent {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.event
}

func isTerminalPDFJobStatus(status pdfJobStatus) bool {
	return status == pdfJobReady || status == pdfJobError
}

func sendPDFJobEvent(ch chan pdfJobEvent, event pdfJobEvent) {
	select {
	case ch <- event:
	default:
		select {
		case <-ch:
		default:
		}
		select {
		case ch <- event:
		default:
		}
	}
}

func newPDFJobID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

func intPtr(v int) *int {
	return &v
}

func (s *Server) pdfJobsRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/pdf/jobs" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req pdfJobRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20))
	if err := dec.Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid PDF job request"})
		return
	}

	topo, ok, errMsg := s.store.Snapshot(namespaceFilter(req.Namespace))
	if !ok {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": errMsg})
		return
	}

	nodes := selectPDFNodes(topo, req.Nodes)
	if len(nodes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no nodes to render"})
		return
	}
	if req.Remote == nil {
		req.Remote = map[string]string{}
	}
	if req.Stencils == nil {
		req.Stencils = map[string]string{}
	}

	job := s.pdfJobs.create(pdfFilename(req.Namespace))
	go func() {
		pdf, err := s.engine.renderWithProgress(contextWithoutCancel(r.Context()), nodes, stencilDir(), req.Remote, req.Stencils, func(progress pdfRenderProgress) {
			job.update(pdfJobEvent{
				Status:        pdfJobRunning,
				Phase:         progress.Phase,
				Detail:        progress.Detail,
				Percent:       progress.Percent,
				Indeterminate: progress.Indeterminate,
			})
		})
		if err != nil {
			job.fail(err)
			return
		}
		job.ready(pdf)
	}()

	writeJSON(w, http.StatusAccepted, map[string]string{"id": job.id})
}

func (s *Server) pdfJob(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/pdf/jobs/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	switch parts[1] {
	case "status":
		s.pdfJobStatus(w, r, parts[0])
	case "events":
		s.pdfJobEvents(w, r, parts[0])
	case "download":
		s.pdfJobDownload(w, r, parts[0])
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) pdfJobStatus(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	job, ok := s.pdfJobs.get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "PDF job not found"})
		return
	}
	writeJSON(w, http.StatusOK, job.status())
}

func (s *Server) pdfJobEvents(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	job, ok := s.pdfJobs.get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "PDF job not found"})
		return
	}

	flush, ok := startSSE(w)
	if !ok {
		return
	}
	events, unsub := job.subscribe()
	defer unsub()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			writeSSEJSON(w, event)
			flush()
		case <-ticker.C:
			io.WriteString(w, ": ping\n\n")
			flush()
		}
	}
}

func (s *Server) pdfJobDownload(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	job, ok := s.pdfJobs.get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "PDF job not found"})
		return
	}

	pdf, filename, event := job.result()
	switch event.Status {
	case pdfJobReady:
		if len(pdf) == 0 {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "PDF export returned an empty document"})
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, filename))
		_, _ = w.Write(pdf)
	case pdfJobError:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": event.Message})
	default:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "PDF job is still running"})
	}
}

func writeSSEJSON(w io.Writer, v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(w, "data: %s\n\n", b)
}

func namespaceFilter(namespace string) []string {
	if ns := strings.TrimSpace(namespace); ns != "" {
		return []string{ns}
	}
	return nil
}

func selectPDFNodes(topo topology.Topology, names []string) []topology.Node {
	if len(names) == 0 {
		return topo.Nodes
	}
	byName := make(map[string]topology.Node, len(topo.Nodes))
	for _, n := range topo.Nodes {
		byName[n.Name] = n
	}
	nodes := make([]topology.Node, 0, len(names))
	for _, name := range names {
		if n, ok := byName[strings.TrimSpace(name)]; ok {
			nodes = append(nodes, n)
		}
	}
	return nodes
}

func contextWithoutCancel(ctx context.Context) context.Context {
	return context.WithoutCancel(ctx)
}
