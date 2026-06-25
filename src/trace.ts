// Tiny dependency-free external store for cable *tracing*. Hovering or pinning a
// node / cable lights that cable (or all of a node's cables) end-to-end and lets
// every node, port and edge cheaply read whether it is active or dimmed.
//
// Components subscribe with a selector that returns a PRIMITIVE (string/bool) so
// useSyncExternalStore stays stable and only the affected pieces re-render.
import { useSyncExternalStore } from 'react';

export type Adjacency = {
  nodeEdges: Map<string, Set<string>>;         // nodeId   -> edgeIds touching it
  edgeEnds: Map<string, [string, string]>;     // edgeId   -> [source, target]
  edgePorts: Map<string, string[]>;            // edgeId   -> ["node:port", ...]
  search: Map<string, string>;                 // id       -> lower-cased haystack
  nodeLabels: Map<string, Set<string>>;        // nodeId   -> set of "key=value" labels (exact match)
};

export type TraceState = {
  edges: Set<string>;
  nodes: Set<string>;
  ports: Set<string>;     // "nodeId:port"
  any: boolean;
  pinned: boolean;
  key: string | null;
};

const EMPTY: TraceState = { edges: new Set(), nodes: new Set(), ports: new Set(), any: false, pinned: false, key: null };

let adj: Adjacency = { nodeEdges: new Map(), edgeEnds: new Map(), edgePorts: new Map(), search: new Map(), nodeLabels: new Map() };
let state: TraceState = EMPTY;
// active free-text + label filter (kept off the key string so labels with ':' etc. don't collide)
let fTerm = '';
let fLabels: string[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function setAdjacency(a: Adjacency) { adj = a; }

function collect(edges: Iterable<string>, seed: string[] = []): TraceState {
  const e = new Set<string>();
  const nodes = new Set<string>(seed);
  const ports = new Set<string>();
  for (const id of edges) {
    e.add(id);
    const ends = adj.edgeEnds.get(id);
    if (ends) { nodes.add(ends[0]); nodes.add(ends[1]); }
    for (const p of adj.edgePorts.get(id) ?? []) ports.add(p);
  }
  return { edges: e, nodes, ports, any: e.size > 0 || nodes.size > 0, pinned: false, key: null };
}

function resolve(key: string): TraceState {
  if (key.startsWith('node:')) {
    const id = key.slice(5);
    return collect(adj.nodeEdges.get(id) ?? [], [id]);
  }
  if (key.startsWith('cable:')) {
    return collect([key.slice(6)]);
  }
  if (key === 'filter') {
    const term = fTerm.trim().toLowerCase();
    if (!term && fLabels.length === 0) return EMPTY;
    const hitNodes: string[] = [];
    const hitEdges = new Set<string>();
    for (const [id, hay] of adj.search) {
      if (term && !hay.includes(term)) continue;
      if (fLabels.length) {
        const set = adj.nodeLabels.get(id);
        if (!set || !fLabels.every((l) => set.has(l))) continue;   // AND across selected labels
      }
      hitNodes.push(id);
      for (const ed of adj.nodeEdges.get(id) ?? []) hitEdges.add(ed);
    }
    return collect(hitEdges, hitNodes);
  }
  return EMPTY;
}

function apply(key: string | null, pinned: boolean) {
  if (!key) { state = EMPTY; emit(); return; }
  state = { ...resolve(key), pinned, key };
  emit();
}

export const trace = {
  hover(key: string | null) { if (!state.pinned) apply(key, false); },
  pin(key: string) { apply(state.pinned && state.key === key ? null : key, true); },
  // combined search box + label-chip filter: a node must match the free-text term AND carry every label
  filter(term: string, labels: string[]) {
    fTerm = term; fLabels = labels;
    const active = !!term || labels.length > 0;
    apply(active ? 'filter' : null, active);
  },
  search(term: string) { this.filter(term, fLabels); },
  clear() { fTerm = ''; fLabels = []; apply(null, false); },
  isPinned: () => state.pinned,
};

function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
const snap = () => state;

export function useTrace<T>(selector: (s: TraceState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(snap()), () => selector(EMPTY));
}

// Per-element display mode: 'idle' (nothing active), 'on' (this is highlighted),
// 'dim' (something else is active so fade this back). `inSet` tells us whether
// this element is part of the active trace for the current state.
export type Mode = 'idle' | 'on' | 'dim';
export function modeFor(inSet: (s: TraceState) => boolean) {
  return (s: TraceState): Mode => (!s.any ? 'idle' : inSet(s) ? 'on' : 'dim');
}
