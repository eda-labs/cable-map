export type Node = { id: string; name: string; platform: string; os: string; role: string };
export type Edge = {
  id: string; source: string; target: string;
  sourcePort: string; targetPort: string; type: string;
};
export type LldpStatus = 'ok' | 'mismatch' | 'none';
export type Row = {
  label: string; desc: string;
  remoteNode: string; remotePort: string; type: string;
  lag?: string;   // LAG resource name when this port is bundled into a port-channel
  peer?: string;  // endpoint/server label for edge links whose remote node is external
  lldpStatus?: LldpStatus;
  lldpPeer?: string;   // LLDP-observed neighbour(s), "node port"
};
// Mirror of eda.ts LagInfo — see there for the multihomed/ESI classification nuance.
export type LagInfo = {
  name: string;
  lacp: boolean;
  isl: boolean;
  multihomed: boolean;
  mode: string;
  members: { node: string; port: string }[];
  nodes: string[];
};
export type Topology = {
  nodes: Node[]; links: Edge[];
  tables: Record<string, Row[]>;
  occupied: Record<string, number[]>;
  lags: Record<string, LagInfo>;
};

// Vite base (trailing slash) — prefix all same-origin URLs so they resolve under
// the EDA HttpProxy sub-path as well as at the root.
export const BASE = import.meta.env.BASE_URL;

export async function fetchTopology(): Promise<Topology> {
  const res = await fetch(`${BASE}api/topology`);
  if (!res.ok) throw new Error(`topology ${res.status}: ${(await res.json()).error || ''}`);
  return res.json();
}

// Live topology over Server-Sent Events. The server pushes the current snapshot on connect
// and a fresh payload on every change; EventSource auto-reconnects (honouring the server's
// `retry:` hint). Returns an unsubscribe that closes the stream.
export function streamTopology(onTopo: (t: Topology) => void, onError: (msg: string) => void): () => void {
  const es = new EventSource(`${BASE}api/topology/stream`);
  es.addEventListener('message', (ev) => {
    try { onTopo(JSON.parse(ev.data) as Topology); } catch (e) { onError(String((e as Error).message || e)); }
  });
  es.addEventListener('error', () => onError('live stream disconnected — reconnecting…'));
  return () => es.close();
}

// interface name (e.g. ethernet-1-12 or ethernet-1/12) -> port index 12,
// for matching table rows to front-panel cages.
export function portIdx(label: string): number | null {
  const m = label.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}
