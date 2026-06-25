// Package eda is the EDA-native data layer: it streams the toponode/topolink/interface
// resources from the EDA State Aggregator via the EDK (eda.dev/edk pkg/state + pkg/cr),
// caches them, and rebuilds the cable-map view model on every change. It replaces the
// hand-rolled Kubernetes watch loops of the old TypeScript backend (eda.ts).
//
// Reads go over gRPC/mTLS to the State Aggregator; the EDK handles service discovery and
// the internal certs (/var/run/eda/tls/internal/...). No raw Kubernetes access.
package eda

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	edav1 "eda.dev/edk/api/v1"
	"eda.dev/edk/pkg/cr"
	"eda.dev/edk/pkg/state"
	"eda.dev/edk/pkg/utils/jspath"

	"cable-map.eda.labs/cable-map/operators/cable-map/internal/topology"
)

// The three resources the cable-map view is derived from. TopoNode/TopoLink reuse the EDK
// core GVKs; interfaces.eda.nokia.com has no EDK Go type, so it is read untyped.
type crKind struct{ group, version, kind string }

var kinds = []crKind{
	{edav1.KTopoNodeGVK.Group, edav1.KTopoNodeGVK.Version, edav1.KTopoNodeGVK.Kind},
	{edav1.KTopoLinkGVK.Group, edav1.KTopoLinkGVK.Version, edav1.KTopoLinkGVK.Kind},
	{"interfaces.eda.nokia.com", "v1", "Interface"},
	{"interfaces.eda.nokia.com", "v1alpha1", "Breakout"},
}

const debounce = 300 * time.Millisecond

var (
	ErrTopoNodeNotFound  = errors.New("toponode not found")
	ErrTopoNodeAmbiguous = errors.New("toponode name exists in multiple namespaces")
)

type topoSub struct {
	filter []string
	fkey   string
	ch     chan topology.Topology
	last   string
}

type nsSub struct {
	ch   chan []string
	last string
}

// Store holds the live caches and fans rebuilt topologies out to SSE subscribers.
type Store struct {
	mu       sync.Mutex
	caches   map[string]map[string]*unstructured.Unstructured // kind -> "ns|name" -> obj
	topoSubs map[*topoSub]struct{}
	nsSubs   map[*nsSub]struct{}
	timer    *time.Timer

	anySynced bool
	lastErr   string
}

// NewStore starts the per-resource streams and returns immediately; data fills in as the
// State Aggregator syncs. Streams reconnect on error until ctx is cancelled.
func NewStore(ctx context.Context) *Store {
	s := &Store{
		caches:   map[string]map[string]*unstructured.Unstructured{},
		topoSubs: map[*topoSub]struct{}{},
		nsSubs:   map[*nsSub]struct{}{},
	}
	for _, k := range kinds {
		s.caches[k.kind] = map[string]*unstructured.Unstructured{}
		go s.streamKind(ctx, k)
	}
	return s
}

func (s *Store) streamKind(ctx context.Context, k crKind) {
	jp := cr.DbCrJsPathAnyNamespace(k.group, k.version, k.kind, "")
	for ctx.Err() == nil {
		sc, err := state.Stream(jp, []string{"**"}, state.Context(ctx))
		if err != nil {
			s.setErr(err)
			log.Printf("[eda] stream %s subscribe failed: %v", k.kind, err)
			if !sleep(ctx, 2*time.Second) {
				return
			}
			continue
		}
		for {
			data, syncComplete, err := sc.Get()
			if err != nil {
				s.setErr(err)
				log.Printf("[eda] stream %s recv error: %v", k.kind, err)
				break // reconnect
			}
			if syncComplete {
				s.markSynced()
				s.scheduleRebuild()
				continue
			}
			ns, name := "", ""
			if data.Data != nil {
				ns, name = data.Data.GetNamespace(), data.Data.GetName()
			}
			if name == "" {
				name = keyAt(data.JsPath, 1)
			}
			if ns == "" {
				ns = keyAt(data.JsPath, 0)
			}
			ckey := ns + "|" + name
			s.mu.Lock()
			cache := s.caches[k.kind]
			if data.Data == nil {
				delete(cache, ckey)
			} else {
				cache[ckey] = data.Data
			}
			s.mu.Unlock()
			s.scheduleRebuild()
		}
		if !sleep(ctx, 2*time.Second) {
			return
		}
	}
}

func (s *Store) markSynced() {
	s.mu.Lock()
	s.anySynced = true
	s.lastErr = ""
	s.mu.Unlock()
}

func (s *Store) setErr(err error) {
	s.mu.Lock()
	s.lastErr = err.Error()
	s.mu.Unlock()
}

func (s *Store) scheduleRebuild() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(debounce, s.rebuild)
}

func (s *Store) rebuild() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.timer = nil

	// namespaces
	nsList := s.namespacesLocked()
	nsJSON := strings.Join(nsList, "\x00")
	for sub := range s.nsSubs {
		if nsJSON == sub.last {
			continue
		}
		sub.last = nsJSON
		sendNS(sub, nsList)
	}

	// topology, computed once per distinct namespace filter
	snapJSON := map[string]string{}
	snapVal := map[string]topology.Topology{}
	for sub := range s.topoSubs {
		j, ok := snapJSON[sub.fkey]
		if !ok {
			t := s.snapshotLocked(sub.filter)
			b, _ := json.Marshal(t)
			j = string(b)
			snapJSON[sub.fkey] = j
			snapVal[sub.fkey] = t
		}
		if j == sub.last {
			continue
		}
		sub.last = j
		sendTopo(sub, snapVal[sub.fkey])
	}
}

// SubscribeTopology returns a channel that yields the current topology immediately and a
// fresh one on every change (deduped). filter is the namespace selection (empty = all).
func (s *Store) SubscribeTopology(filter []string) (<-chan topology.Topology, func()) {
	sub := &topoSub{filter: append([]string(nil), filter...), fkey: filterKey(filter), ch: make(chan topology.Topology, 1)}
	s.mu.Lock()
	s.topoSubs[sub] = struct{}{}
	t := s.snapshotLocked(sub.filter)
	b, _ := json.Marshal(t)
	sub.last = string(b)
	sendTopo(sub, t)
	s.mu.Unlock()
	return sub.ch, func() { s.mu.Lock(); delete(s.topoSubs, sub); s.mu.Unlock() }
}

// SubscribeNamespaces mirrors SubscribeTopology for the namespace list.
func (s *Store) SubscribeNamespaces() (<-chan []string, func()) {
	sub := &nsSub{ch: make(chan []string, 1)}
	s.mu.Lock()
	s.nsSubs[sub] = struct{}{}
	list := s.namespacesLocked()
	sub.last = strings.Join(list, "\x00")
	sendNS(sub, list)
	s.mu.Unlock()
	return sub.ch, func() { s.mu.Lock(); delete(s.nsSubs, sub); s.mu.Unlock() }
}

// Snapshot is the one-shot topology for a namespace filter (empty = all). ok is false when
// nothing has synced yet and a stream error is outstanding (the HTTP layer returns 502).
func (s *Store) Snapshot(filter []string) (topology.Topology, bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.anySynced && s.lastErr != "" {
		return topology.Topology{}, false, s.lastErr
	}
	return s.snapshotLocked(filter), true, ""
}

// Namespaces is the one-shot sorted EDA namespace list (those holding topology resources).
func (s *Store) Namespaces() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.namespacesLocked()
}

// TopoNode returns a cached TopoNode object from the EDK State Aggregator stream.
func (s *Store) TopoNode(name, namespace string) (*unstructured.Unstructured, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cache := s.caches[edav1.KTopoNodeGVK.Kind]
	if namespace != "" {
		u := cache[namespace+"|"+name]
		if u == nil {
			return nil, ErrTopoNodeNotFound
		}
		return cloneTopoNode(u, namespace), nil
	}

	var found *unstructured.Unstructured
	foundNS := ""
	for key, u := range cache {
		if nameOf(key) != name {
			continue
		}
		if found != nil {
			return nil, ErrTopoNodeAmbiguous
		}
		found = u
		foundNS = nsOf(key)
	}
	if found == nil {
		return nil, ErrTopoNodeNotFound
	}
	return cloneTopoNode(found, foundNS), nil
}

func (s *Store) snapshotLocked(filter []string) topology.Topology {
	in := inFilter(filter)
	var nodes []topology.RawNode
	var links []topology.RawLink
	var ifaces []topology.RawIface
	for key, u := range s.caches[edav1.KTopoNodeGVK.Kind] {
		if in(nsOf(key)) {
			nodes = append(nodes, projNode(nsOf(key), u))
		}
	}
	for key, u := range s.caches[edav1.KTopoLinkGVK.Kind] {
		if in(nsOf(key)) {
			links = append(links, projLink(u))
		}
	}
	for key, u := range s.caches["Interface"] {
		if in(nsOf(key)) {
			ifaces = append(ifaces, projIface(u))
		}
	}
	var breakouts []topology.RawBreakout
	for key, u := range s.caches["Breakout"] {
		if in(nsOf(key)) {
			breakouts = append(breakouts, projBreakout(u))
		}
	}
	// Stable input order -> stable output JSON, so dedup and the UI don't churn.
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
	sort.Slice(links, func(i, j int) bool { return links[i].Name < links[j].Name })
	sort.Slice(ifaces, func(i, j int) bool { return ifaces[i].Name < ifaces[j].Name })
	sort.Slice(breakouts, func(i, j int) bool { return breakouts[i].Name < breakouts[j].Name })
	return topology.BuildTopology(nodes, links, ifaces, breakouts)
}

func (s *Store) namespacesLocked() []string {
	set := map[string]struct{}{}
	for _, cache := range s.caches {
		for key := range cache {
			if ns := nsOf(key); ns != "" {
				set[ns] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(set))
	for ns := range set {
		out = append(out, ns)
	}
	sort.Strings(out)
	return out
}

// ---- helpers --------------------------------------------------------------------

func inFilter(filter []string) func(string) bool {
	if len(filter) == 0 {
		return func(string) bool { return true }
	}
	want := map[string]struct{}{}
	for _, f := range filter {
		want[f] = struct{}{}
	}
	return func(ns string) bool { _, ok := want[ns]; return ok }
}

func filterKey(filter []string) string {
	cp := append([]string(nil), filter...)
	sort.Strings(cp)
	return strings.Join(cp, "\x00")
}

func nsOf(cacheKey string) string {
	if i := strings.IndexByte(cacheKey, '|'); i >= 0 {
		return cacheKey[:i]
	}
	return ""
}

func nameOf(cacheKey string) string {
	if i := strings.IndexByte(cacheKey, '|'); i >= 0 {
		return cacheKey[i+1:]
	}
	return cacheKey
}

func cloneTopoNode(u *unstructured.Unstructured, namespace string) *unstructured.Unstructured {
	out := u.DeepCopy()
	if out.GetNamespace() == "" {
		out.SetNamespace(namespace)
	}
	return out
}

func keyAt(jp jspath.JsPath, idx int) (out string) {
	defer func() { _ = recover() }()
	if v, ok := jp.GetKeyByIdx(idx).(string); ok {
		out = v
	}
	return out
}

func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func sendTopo(sub *topoSub, t topology.Topology) {
	select {
	case sub.ch <- t:
	default:
		select {
		case <-sub.ch:
		default:
		}
		select {
		case sub.ch <- t:
		default:
		}
	}
}

func sendNS(sub *nsSub, list []string) {
	select {
	case sub.ch <- list:
	default:
		select {
		case <-sub.ch:
		default:
		}
		select {
		case sub.ch <- list:
		default:
		}
	}
}

// ---- projections from unstructured CRs ------------------------------------------

// projNode/projLink decode the EDK typed TopoNode/TopoLink via the EDK *FromUnstructured helpers.
func projNode(namespace string, u *unstructured.Unstructured) topology.RawNode {
	tn := edav1.TopoNodeFromUnstructured(u)
	version := tn.Status.Version
	if version == "" {
		version = tn.Spec.Version
	}
	ns := u.GetNamespace()
	raw := u
	if ns == "" {
		ns = namespace
		if namespace != "" {
			raw = u.DeepCopy()
			raw.SetNamespace(namespace)
		}
	}
	return topology.RawNode{
		Name:            u.GetName(),
		Namespace:       ns,
		Labels:          u.GetLabels(),
		Platform:        tn.Spec.Platform,
		OperatingSystem: string(tn.Spec.OperatingSystem),
		StatusPlatform:  tn.Status.Platform,
		Version:         version,
		StatusVersion:   tn.Status.Version,
		Raw:             strippedCR(raw),
	}
}

// strippedCR deep-copies the CR and drops the noisy/volatile k8s bookkeeping (managedFields,
// resourceVersion) before it is embedded on the node.
func strippedCR(u *unstructured.Unstructured) map[string]interface{} {
	obj := u.DeepCopy().Object
	if md, ok := obj["metadata"].(map[string]interface{}); ok {
		delete(md, "managedFields")
		delete(md, "resourceVersion")
	}
	return obj
}

func projLink(u *unstructured.Unstructured) topology.RawLink {
	out := topology.RawLink{Name: u.GetName()}
	for _, m := range edav1.TopoLinkSpecFromUnstructured(u).TopoLinks {
		out.Links = append(out.Links, topology.LinkEntry{
			Type:   string(m.Type),
			Local:  endpoint(m.Local),
			Remote: endpoint(m.Remote),
		})
	}
	return out
}

func endpoint(e edav1.Endpoint) topology.LinkEnd {
	return topology.LinkEnd{Node: e.Node, Interface: e.Interface, InterfaceResource: e.InterfaceResource}
}

func projIface(u *unstructured.Unstructured) topology.RawIface {
	out := topology.RawIface{
		Name:        u.GetName(),
		Labels:      u.GetLabels(),
		Description: us(u.Object, "spec", "description"),
		Type:        us(u.Object, "spec", "type"),
		LagType:     us(u.Object, "spec", "lag", "type"),
		LagMode:     us(u.Object, "spec", "lag", "multihoming", "mode"),
	}
	members, _, _ := unstructured.NestedSlice(u.Object, "spec", "members")
	for _, mi := range members {
		if m, ok := mi.(map[string]interface{}); ok {
			out.Members = append(out.Members, topology.IfMember{Node: mstr(m, "node"), Interface: mstr(m, "interface")})
		}
	}
	smembers, _, _ := unstructured.NestedSlice(u.Object, "status", "members")
	for _, mi := range smembers {
		m, ok := mi.(map[string]interface{})
		if !ok {
			continue
		}
		sm := topology.IfStatusMember{Node: mstr(m, "node"), Interface: mstr(m, "interface"), NodeInterface: mstr(m, "nodeInterface")}
		if nbrs, ok := m["neighbors"].([]interface{}); ok {
			for _, ni := range nbrs {
				if nm, ok := ni.(map[string]interface{}); ok {
					sm.Neighbors = append(sm.Neighbors, topology.IfNeighbor{Node: mstr(nm, "node"), Interface: mstr(nm, "interface")})
				}
			}
		}
		out.StatusMembers = append(out.StatusMembers, sm)
	}
	return out
}

func projBreakout(u *unstructured.Unstructured) topology.RawBreakout {
	// the CRD uses plural arrays (nodes/nodeSelectors/interfaces); accept the singular forms too.
	strs := func(plural, singular string) []string {
		if v, _, _ := unstructured.NestedStringSlice(u.Object, "spec", plural); len(v) > 0 {
			return v
		}
		if s := us(u.Object, "spec", singular); s != "" {
			return []string{s}
		}
		return nil
	}
	ch, _, _ := unstructured.NestedInt64(u.Object, "spec", "channels")
	return topology.RawBreakout{
		Name:          u.GetName(),
		Nodes:         strs("nodes", "node"),
		NodeSelectors: strs("nodeSelectors", "nodeSelector"),
		Interfaces:    strs("interfaces", "interface"),
		Channels:      int(ch),
		Speed:         us(u.Object, "spec", "speed"),
	}
}

func us(obj map[string]interface{}, fields ...string) string {
	v, _, _ := unstructured.NestedString(obj, fields...)
	return v
}

func mstr(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}
