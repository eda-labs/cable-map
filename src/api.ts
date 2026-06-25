// Contract types are generated from the Go structs (internal/topology/contract.go) into
// `src/topology.gen.ts` by tygo (`make ts-contract`); re-exported here so the app imports them from `./api`.
import type { Topology } from './topology.gen';
export type { Node, Edge, Row, LagInfo, LagMember, Breakout, Topology, LldpStatus } from './topology.gen';

// Vite base (trailing slash) — prefix all same-origin URLs so they resolve under
// the EDA HttpProxy sub-path as well as at the root.
export const BASE = import.meta.env.BASE_URL;

export async function fetchTopology(namespace = ''): Promise<Topology> {
  const qs = namespace ? `?ns=${encodeURIComponent(namespace)}` : '';
  const res = await fetch(`${BASE}api/topology${qs}`);
  if (!res.ok) throw new Error(`topology ${res.status}: ${(await res.json()).error || ''}`);
  return res.json();
}

// Live topology over Server-Sent Events. The server pushes the current snapshot on connect
// and a fresh payload on every change; EventSource auto-reconnects (honouring the server's
// `retry:` hint). Returns an unsubscribe that closes the stream.
export async function fetchNamespaces(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}api/namespaces`);
    return res.ok ? await res.json() : [];
  } catch { return []; }
}

// Live EDA namespace list — the picker updates as namespaces are created/deleted.
export function streamNamespaces(onList: (names: string[]) => void, onError?: (msg: string) => void): () => void {
  const es = new EventSource(`${BASE}api/namespaces/stream`);
  es.addEventListener('message', (ev) => {
    try { onList(JSON.parse(ev.data) as string[]); } catch { /* ignore malformed frame */ }
  });
  es.addEventListener('error', () => onError?.('namespace stream disconnected — reconnecting…'));
  return () => es.close();
}

export function streamTopology(namespace: string, onTopo: (t: Topology) => void, onError: (msg: string) => void): () => void {
  const es = new EventSource(`${BASE}api/topology/stream?ns=${encodeURIComponent(namespace)}`);
  es.addEventListener('message', (ev) => {
    try { onTopo(JSON.parse(ev.data) as Topology); } catch (e) { onError(String((e as Error).message || e)); }
  });
  es.addEventListener('error', () => onError('live stream disconnected — reconnecting…'));
  return () => es.close();
}

// EDA normalised interface name -> front-panel cage index. The cage is the <port>: for
// ethernet-<card>-<port> (e.g. ethernet-1-12, ethernet-1/12) that's the 2nd number; for a breakout
// ethernet-<card>-<port>-<channel> (e.g. ethernet-1-12-3) it's still the 2nd — the 3rd is the
// channel, which must NOT be mistaken for a cage. Single-number names map to that number.
export function portIdx(label: string): number | null {
  const ns = label.match(/\d+/g);
  if (!ns) return null;
  return Number(ns.length >= 2 ? ns[1] : ns[0]);
}

// Front-panel cage id matching the stencil's data-port. On modular (slotted) chassis a cage is
// addressed per slot, so the key is "<slot>-<port>" (from ethernet-<slot>-<port>); on fixed chassis
// it's just the port. Returned as a string so both shapes share one identity space.
export function cageKey(label: string, slotted: boolean): string | null {
  const ns = label.match(/\d+/g);
  if (!ns) return null;
  if (slotted) return ns.length >= 2 ? `${ns[0]}-${ns[1]}` : ns[0];
  return ns.length >= 2 ? ns[1] : ns[0];
}

// breakout channel (1-based) if this interface is a broken-out sub-port, else null — i.e. the 3rd
// number in ethernet-<card>-<port>-<channel>.
export function breakoutChannel(label: string): number | null {
  const ns = label.match(/\d+/g);
  return ns && ns.length >= 3 ? Number(ns[2]) : null;
}
