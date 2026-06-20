export type Node = { id: string; name: string; platform: string; os: string; role: string };
export type Edge = {
  id: string; source: string; target: string;
  sourcePort: string; targetPort: string; type: string;
};
export type Row = {
  label: string; desc: string;
  remoteNode: string; remotePort: string; type: string;
};
export type Topology = {
  nodes: Node[]; links: Edge[];
  tables: Record<string, Row[]>;
  occupied: Record<string, number[]>;
};

// Vite base (trailing slash) — prefix all same-origin URLs so they resolve under
// the EDA HttpProxy sub-path as well as at the root.
export const BASE = import.meta.env.BASE_URL;

export async function fetchTopology(): Promise<Topology> {
  const res = await fetch(`${BASE}api/topology`);
  if (!res.ok) throw new Error(`topology ${res.status}: ${(await res.json()).error || ''}`);
  return res.json();
}

// interface name (e.g. ethernet-1-12 or ethernet-1/12) -> port index 12,
// for matching table rows to front-panel cages.
export function portIdx(label: string): number | null {
  const m = label.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}
