// Contract types are generated from the Go structs (internal/topology/contract.go) into
// `src/topology.gen.ts` by tygo (`make ts-contract`); re-exported here so the app imports them from `./api`.
import type { Topology } from './topology.gen';
import { authHeader, currentToken } from './auth';
export type { Node, Edge, Row, LagInfo, LagMember, Breakout, Topology, LldpStatus } from './topology.gen';

// Vite base (trailing slash) — prefix all same-origin URLs so they resolve under
// the EDA HttpProxy sub-path as well as at the root.
export const BASE = import.meta.env.BASE_URL;

// EventSource can't set an Authorization header, so the keycloak-js token rides as a query param on
// SSE/navigation URLs; the backend accepts ?access_token= equivalently to a bearer header.
function withToken(url: string): string {
  const tok = currentToken();
  if (!tok) return url;
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(tok)}`;
}

export async function fetchTopology(namespace = ''): Promise<Topology> {
  const qs = namespace ? `?ns=${encodeURIComponent(namespace)}` : '';
  const res = await fetch(`${BASE}api/topology${qs}`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`topology ${res.status}: ${(await res.json()).error || ''}`);
  return res.json();
}

// Live topology over Server-Sent Events. The server pushes the current snapshot on connect
// and a fresh payload on every change; EventSource auto-reconnects (honouring the server's
// `retry:` hint). Returns an unsubscribe that closes the stream.
export async function fetchNamespaces(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}api/namespaces`, { headers: await authHeader() });
    return res.ok ? await res.json() : [];
  } catch { return []; }
}

// Live EDA namespace list — the picker updates as namespaces are created/deleted.
export function streamNamespaces(onList: (names: string[]) => void, onError?: (msg: string) => void): () => void {
  const es = new EventSource(withToken(`${BASE}api/namespaces/stream`));
  es.addEventListener('message', (ev) => {
    try { onList(JSON.parse(ev.data) as string[]); } catch { /* ignore malformed frame */ }
  });
  es.addEventListener('error', () => onError?.('namespace stream disconnected — reconnecting…'));
  return () => es.close();
}

export function streamTopology(namespace: string, onTopo: (t: Topology) => void, onError: (msg: string) => void): () => void {
  let closed = false;
  void fetchTopology(namespace)
    .then((t) => { if (!closed) onTopo(t); })
    .catch((e) => { if (!closed) onError(String((e as Error).message || e)); });

  const es = new EventSource(withToken(`${BASE}api/topology/stream?ns=${encodeURIComponent(namespace)}`));
  es.addEventListener('message', (ev) => {
    if (closed || !ev.data) return;
    try { onTopo(JSON.parse(ev.data) as Topology); } catch (e) { onError(String((e as Error).message || e)); }
  });
  es.addEventListener('error', () => { if (!closed) onError('live stream disconnected — reconnecting…'); });
  return () => { closed = true; es.close(); };
}

const srosConnector = (label: string) => label.match(/(?:^|[/_-])c(\d+)(?:[/_-]|$)/i)?.[1] ?? null;

// EDA/SROS interface name -> front-panel cage index. For SRL names like ethernet-1-12,
// the cage is the 2nd number. For native SROS connector names like 1/1/c12/1, the cage
// is the c-number; the following number is a breakout channel and must not be captured.
export function portIdx(label: string): number | null {
  const connector = srosConnector(label);
  if (connector != null) return Number(connector);
  const ns = label.match(/\d+/g);
  if (!ns) return null;
  return Number(ns.length >= 2 ? ns[1] : ns[0]);
}

// Front-panel cage id matching the stencil's data-port. On modular (slotted) chassis a cage is
// addressed per slot, so the key is "<slot>-<port>"; on fixed chassis it's just the port.
// Native SROS 1/1/c6/1 maps to "1-6" when slotted and "6" otherwise.
export function cageKey(label: string, slotted: boolean): string | null {
  const ns = label.match(/\d+/g);
  if (!ns) return null;
  const connector = srosConnector(label);
  const port = connector ?? (ns.length >= 2 ? ns[1] : ns[0]);
  if (slotted) return ns.length >= 2 ? `${ns[0]}-${port}` : port;
  return port;
}

// breakout channel (1-based) if this interface is a broken-out sub-port, else null.
export function breakoutChannel(label: string): number | null {
  const nativeSros = label.match(/(?:^|[/_-])c\d+[/_-](\d+)$/i);
  if (nativeSros) return Number(nativeSros[1]);
  const ns = label.match(/\d+/g);
  return ns && ns.length >= 3 ? Number(ns[2]) : null;
}
