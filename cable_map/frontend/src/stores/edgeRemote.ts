import { createExternalStore } from './createExternalStore';

const KEY = 'cable-map-edge-remote';
const SEP = ' ';
type Field = 'node' | 'port';
type Store = Record<string, string>;

const keyFor = (nodeId: string, port: string, field: Field) => `${nodeId}${SEP}${port}${SEP}${field}`;
const nodeOf = (k: string) => k.slice(0, k.indexOf(SEP));

const load = (): Store => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Store; } catch { return {}; }
};

const persist = (snapshot: Store) => {
  try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch { /* quota / unavailable */ }
};

const store = createExternalStore<Store>(load());

export const edgeRemote = {
  get: (nodeId: string, port: string, field: Field): string => store.getSnapshot()[keyFor(nodeId, port, field)] ?? '',
  set(nodeId: string, port: string, field: Field, text: string) {
    const k = keyFor(nodeId, port, field);
    const next = { ...store.getSnapshot() };
    if (text.trim()) next[k] = text; else delete next[k];
    persist(next);
    store.setSnapshot(next);
  },
  subset(nodeIds: string[]): Store {
    const ids = new Set(nodeIds);
    const out: Store = {};
    for (const k of Object.keys(store.getSnapshot())) if (ids.has(nodeOf(k))) out[k] = store.getSnapshot()[k];
    return out;
  },
  hydrate(map: Store) {
    store.setSnapshot({ ...store.getSnapshot(), ...map });
  },
};

export function useEdgeRemote(nodeId: string, port: string, field: Field): string {
  const k = keyFor(nodeId, port, field);
  return store.useStoreSelector((snapshot) => snapshot[k] ?? '', '');
}
