import { useSyncExternalStore } from 'react';

const KEY = 'cable-map-edge-remote';
const SEP = ' ';
type Field = 'node' | 'port';
type Store = Record<string, string>;

const keyFor = (nodeId: string, port: string, field: Field) => `${nodeId}${SEP}${port}${SEP}${field}`;
const nodeOf = (k: string) => k.slice(0, k.indexOf(SEP));

const load = (): Store => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Store; } catch { return {}; }
};

let store: Store = load();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* quota / unavailable */ } };

export const edgeRemote = {
  get: (nodeId: string, port: string, field: Field): string => store[keyFor(nodeId, port, field)] ?? '',
  set(nodeId: string, port: string, field: Field, text: string) {
    const k = keyFor(nodeId, port, field);
    store = { ...store };
    if (text.trim()) store[k] = text; else delete store[k];
    persist();
    emit();
  },
  subset(nodeIds: string[]): Store {
    const ids = new Set(nodeIds);
    const out: Store = {};
    for (const k of Object.keys(store)) if (ids.has(nodeOf(k))) out[k] = store[k];
    return out;
  },
  hydrate(map: Store) { store = { ...store, ...map }; emit(); },
};

export function useEdgeRemote(nodeId: string, port: string, field: Field): string {
  const k = keyFor(nodeId, port, field);
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => store[k] ?? '',
    () => '',
  );
}
