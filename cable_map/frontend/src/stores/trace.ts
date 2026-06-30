// Tiny dependency-free external store for cable *tracing*. Hovering or pinning a
// node / cable lights that cable (or all of a node's cables) end-to-end and lets
// every node, port and edge cheaply read whether it is active or dimmed.
import { emptyAdjacency, type Adjacency } from '../graph/adjacency';
import { createExternalStore } from './createExternalStore';

export type TraceState = {
  edges: Set<string>;
  nodes: Set<string>;
  ports: Set<string>;     // "nodeId:port"
  any: boolean;
  pinned: boolean;
  key: string | null;
};

const EMPTY: TraceState = { edges: new Set(), nodes: new Set(), ports: new Set(), any: false, pinned: false, key: null };

let adj: Adjacency = emptyAdjacency();
let base: TraceState = EMPTY;
let hoverKey: string | null = null;
let hoverSuspended = false;
let pinnedKey: string | null = null;
// active free-text + label filter (kept off the key string so labels with ':' etc. don't collide)
let fTerm = '';
let fLabels: string[] = [];
const store = createExternalStore<TraceState>(EMPTY);

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

function explicit(nodesIn: Iterable<string>, edgesIn: Iterable<string>, portsIn: Iterable<string>): TraceState {
  const edges = new Set(edgesIn);
  const nodes = new Set(nodesIn);
  const ports = new Set(portsIn);
  for (const id of edges) {
    const ends = adj.edgeEnds.get(id);
    if (ends) { nodes.add(ends[0]); nodes.add(ends[1]); }
    for (const p of adj.edgePorts.get(id) ?? []) ports.add(p);
  }
  for (const p of ports) {
    const sep = p.indexOf(':');
    if (sep > 0) nodes.add(p.slice(0, sep));
  }
  return { edges, nodes, ports, any: edges.size > 0 || nodes.size > 0 || ports.size > 0, pinned: false, key: null };
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
  if (!key) { store.setSnapshot(base); return; }
  store.setSnapshot({ ...resolve(key), pinned, key });
}

function refresh() {
  if (pinnedKey) { apply(pinnedKey, true); return; }
  if (hoverKey) { apply(hoverKey, false); return; }
  store.setSnapshot(base);
}

export const trace = {
  hover(key: string | null) {
    if (hoverSuspended) return;
    hoverKey = key;
    if (!pinnedKey) refresh();
  },
  suspendHover(suspended: boolean) {
    hoverSuspended = suspended;
    if (suspended && hoverKey) {
      hoverKey = null;
      if (!pinnedKey) refresh();
    }
  },
  pin(key: string, force = false) { pinnedKey = !force && pinnedKey === key ? null : key; refresh(); },
  // combined search box + label-chip filter: a node must match the free-text term AND carry every label
  filter(term: string, labels: string[]) {
    fTerm = term; fLabels = labels;
    const active = !!term || labels.length > 0;
    base = active ? { ...resolve('filter'), key: 'filter' } : EMPTY;
    refresh();
  },
  search(term: string) { this.filter(term, fLabels); },
  highlight(nodes: Iterable<string>, edges: Iterable<string>, ports: Iterable<string>) {
    base = { ...explicit(nodes, edges, ports), key: 'search' };
    if (!base.any) base = EMPTY;
    refresh();
  },
  clearSearch() {
    base = EMPTY;
    refresh();
  },
  clear() {
    fTerm = ''; fLabels = []; hoverKey = null; hoverSuspended = false; pinnedKey = null; base = EMPTY; store.setSnapshot(EMPTY);
  },
  isPinned: () => !!pinnedKey,
  getPinned: () => pinnedKey,
  isHoverSuspended: () => hoverSuspended,
};

export function useTrace<T>(selector: (s: TraceState) => T): T {
  return store.useStoreSelector(selector, selector(EMPTY));
}

// Per-element display mode: 'idle' (nothing active), 'on' (this is highlighted),
// 'dim' (something else is active so fade this back). `inSet` tells us whether
// this element is part of the active trace for the current state.
export type Mode = 'idle' | 'on' | 'dim';
export function modeFor(inSet: (s: TraceState) => boolean) {
  return (s: TraceState): Mode => (!s.any ? 'idle' : inSet(s) ? 'on' : 'dim');
}
