// Builds the React Flow graph (positioned nodes + edges) and the trace adjacency
// straight from the topology tables — which carry the full per-port truth,
// including the edge/server interfaces the old switch-only view hid.
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import PORTS from './frontpanel/ports.json';
import ROWS from './frontpanel/rows.json';
import { portIdx, type Topology } from './api';
import type { Adjacency } from './trace';

const portMap = PORTS as Record<string, number[]>;
// physical cage-row count per platform (measured from the stencils, see rows.json):
// D3L/D5 = 2, D2L = 3, H5-64D/H4 = 4 … so the canvas panel matches the real box.
const rowMap = ROWS as Record<string, number>;
export const rowsOf = (platform: string) => rowMap[platform] ?? 2;
export const portCountOf = (platform: string) => portMap[platform]?.length ?? 32;

// role tier: smaller = closer to the fabric core (drawn higher up).
export const TIER: Record<string, number> = { superspine: 0, spine: 1, borderleaf: 2, leaf: 3 };
const tierOf = (role: string) => TIER[role] ?? 3;

export type CableKind = 'isl' | 'edge' | 'lag';
export const CABLE_COLOR: Record<CableKind, string> = { isl: '#5B9BFF', edge: '#13C39A', lag: '#FFB020' };

export type PortInfo = {
  port: number;
  kind: CableKind | 'free';
  side: 'top' | 'bottom';
  remote: string;       // short remote label e.g. "spine1" / "srv03" / "lag-a"
  remotePort: string;
  desc: string;
  cableId: string;      // edge id this port terminates, for hover-to-trace
};

export type SwitchData = {
  name: string; role: string; platform: string;
  portCount: number;
  rows: number;                      // physical cage rows, mirrored on the canvas
  ports: PortInfo[];                 // occupied ports only (free cells inferred)
};

export type EndpointData = {
  label: string; full: string; remotePort: string;
  kind: 'edge' | 'lag'; members: number; localPorts: number[];
};

// ---- layout constants ---------------------------------------------------
const CELL = 13, CELL_GAP = 3, HEAD_H = 32, STRIP_PAD = 8;
export const colsOf = (portCount: number, rows: number) => Math.max(1, Math.ceil(portCount / rows));
export const switchW = (portCount: number, rows: number) =>
  Math.max(196, colsOf(portCount, rows) * (CELL + CELL_GAP) + STRIP_PAD * 2);
export const switchH = (rows: number) => HEAD_H + rows * CELL + (rows - 1) * CELL_GAP + STRIP_PAD * 2;
const EP_W = 112, EP_H = 22, EP_VGAP = 6, EP_HGAP = 10, EP_COLS = 2;
const SPINE_Y = 0, LEAF_Y = 320, EP_TOP_GAP = 34;

// strip "leafN-" prefix and "-peer" suffix to a compact endpoint label.
function shortEndpoint(leafId: string, remote: string): string {
  let s = remote.startsWith(`${leafId}-`) ? remote.slice(leafId.length + 1) : remote;
  s = s.replace(/-peer$/, '');
  return s;
}

export type BuiltGraph = { nodes: RFNode[]; edges: RFEdge[]; adjacency: Adjacency };

export function buildGraph(topo: Topology): BuiltGraph {
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));
  const role = (id: string) => byId.get(id)?.role ?? 'leaf';

  const nodeEdges = new Map<string, Set<string>>();
  const edgeEnds = new Map<string, [string, string]>();
  const edgePorts = new Map<string, string[]>();
  const search = new Map<string, string>();
  const link = (id: string, a: string, b: string, ports: string[]) => {
    edgeEnds.set(id, [a, b]); edgePorts.set(id, ports);
    (nodeEdges.get(a) ?? nodeEdges.set(a, new Set()).get(a)!).add(id);
    (nodeEdges.get(b) ?? nodeEdges.set(b, new Set()).get(b)!).add(id);
  };

  const rfEdges: RFEdge[] = [];
  const islSeen = new Set<string>();

  // per-switch port metadata + endpoint grouping, from each node's table
  const switchPorts = new Map<string, PortInfo[]>();
  const endpoints: Array<{ id: string; leafId: string; data: EndpointData }> = [];

  for (const sw of topo.nodes) {
    const rows = topo.tables[sw.id] ?? [];
    const ports: PortInfo[] = [];
    const haystack = [sw.name, sw.platform, sw.role];
    // group this node's edge rows by remote (single server vs LAG bundle)
    const groups = new Map<string, typeof rows>();

    for (const r of rows) {
      const p = portIdx(r.label);
      if (r.type === 'interSwitch' && r.remoteNode && p != null) {
        const up = tierOf(role(r.remoteNode)) < tierOf(sw.role);
        // canonical ISL id (dedupe the mirrored row on the far node)
        const ends = [`${sw.id}:${r.remotePort}`, `${r.remoteNode}:${r.label}`].toSorted();
        const id = `isl|${ends[0]}|${ends[1]}`;
        ports.push({ port: p, kind: 'isl', side: up ? 'top' : 'bottom', remote: r.remoteNode, remotePort: r.remotePort, desc: r.desc, cableId: id });
        haystack.push(r.label);
        if (!islSeen.has(id)) {
          islSeen.add(id);
          const child = tierOf(sw.role) >= tierOf(role(r.remoteNode)) ? sw.id : r.remoteNode;
          const parent = child === sw.id ? r.remoteNode : sw.id;
          const childPort = child === sw.id ? p : portIdx(r.remotePort);
          const parentPort = child === sw.id ? portIdx(r.remotePort) : p;
          rfEdges.push({
            id, source: child, target: parent, type: 'cable',
            sourceHandle: `p${childPort}`, targetHandle: `p${parentPort}t`,
            data: { kind: 'isl', a: shortPortLabel(r.label), b: shortPortLabel(r.remotePort) },
          });
          link(id, child, parent, [`${child}:${childPort}`, `${parent}:${parentPort}`]);
        }
      } else if (r.type === 'edge' && r.remoteNode && p != null) {
        (groups.get(r.remoteNode) ?? groups.set(r.remoteNode, []).get(r.remoteNode)!).push(r);
        haystack.push(r.label);   // the server name is indexed on the endpoint chip
      }
    }

    // realise endpoint chips + stub cables for this switch's edge interfaces
    for (const [remote, grp] of groups) {
      const kind: 'edge' | 'lag' = grp.length > 1 ? 'lag' : 'edge';
      const epId = `ep|${sw.id}|${remote}`;
      const localPorts = grp.map((r) => portIdx(r.label)!).toSorted((a, b) => a - b);
      endpoints.push({
        id: epId, leafId: sw.id,
        data: { label: shortEndpoint(sw.id, remote), full: remote, remotePort: grp[0].remotePort, kind, members: grp.length, localPorts },
      });
      search.set(epId, [remote, grp[0].remotePort, ...grp.map((r) => r.label)].join(' ').toLowerCase());
      for (const r of grp) {
        const p = portIdx(r.label)!;
        const id = `stub|${sw.id}|${p}`;
        ports.push({ port: p, kind, side: 'bottom', remote: shortEndpoint(sw.id, remote), remotePort: r.remotePort, desc: r.desc, cableId: id });
        rfEdges.push({
          id, source: sw.id, target: epId, type: 'cable',
          sourceHandle: `p${p}`, targetHandle: 'in',
          data: { kind, a: shortPortLabel(r.label), b: r.remotePort },
        });
        link(id, sw.id, epId, [`${sw.id}:${p}`]);
      }
    }

    switchPorts.set(sw.id, ports);
    search.set(sw.id, haystack.join(' ').toLowerCase());
  }

  // ---- positions -------------------------------------------------------
  const leaves = topo.nodes.filter((n) => tierOf(n.role) >= 2);
  const cores = topo.nodes.filter((n) => tierOf(n.role) < 2);

  const swW = (p: string) => switchW(portCountOf(p), rowsOf(p));
  const pos = new Map<string, { x: number; y: number }>();
  // leaves laid out left→right, each given a slot wide enough for its endpoint fan
  const SLOT_GAP = 64;
  let cursor = 0;
  const leafCenter = new Map<string, number>();
  for (const lf of leaves) {
    const w = Math.max(swW(lf.platform), EP_COLS * EP_W + (EP_COLS - 1) * EP_HGAP);
    const x = cursor;
    pos.set(lf.id, { x: x + (w - swW(lf.platform)) / 2, y: LEAF_Y });
    leafCenter.set(lf.id, x + w / 2);
    cursor += w + SLOT_GAP;
  }
  const spanL = 0, spanR = Math.max(cursor - SLOT_GAP, switchW(32, 2));
  // cores centred above the leaf span
  if (cores.length) {
    const totalW = cores.reduce((s, c) => s + swW(c.platform), 0) + (cores.length - 1) * 120;
    let cx = (spanL + spanR) / 2 - totalW / 2;
    for (const c of cores) {
      pos.set(c.id, { x: cx, y: SPINE_Y });
      cx += swW(c.platform) + 120;
    }
  }

  const rfNodes: RFNode[] = topo.nodes.map((n) => ({
    id: n.id, type: 'switch', position: pos.get(n.id) ?? { x: 0, y: 0 },
    data: { name: n.name, role: n.role, platform: n.platform, portCount: portCountOf(n.platform), rows: rowsOf(n.platform), ports: switchPorts.get(n.id) ?? [] } satisfies SwitchData,
    draggable: true,
  }));

  // endpoint chips fan out below their leaf in an EP_COLS-wide grid, starting
  // below that leaf's own bottom (taller leaves like D2L push their chips down)
  const byLeaf = new Map(leaves.map((l) => [l.id, l]));
  const epIndex = new Map<string, number>();
  for (const ep of endpoints) {
    const i = epIndex.get(ep.leafId) ?? 0; epIndex.set(ep.leafId, i + 1);
    const center = leafCenter.get(ep.leafId) ?? 0;
    const leafTop = LEAF_Y + switchH(rowsOf(byLeaf.get(ep.leafId)?.platform ?? '')) + EP_TOP_GAP;
    const col = i % EP_COLS, row = Math.floor(i / EP_COLS);
    const clusterW = EP_COLS * EP_W + (EP_COLS - 1) * EP_HGAP;
    const x = center - clusterW / 2 + col * (EP_W + EP_HGAP);
    const y = leafTop + row * (EP_H + EP_VGAP);
    rfNodes.push({ id: ep.id, type: 'endpoint', position: { x, y }, data: ep.data, draggable: true });
  }

  return { nodes: rfNodes, edges: rfEdges, adjacency: { nodeEdges, edgeEnds, edgePorts, search } };
}

// ethernet-1-12 -> "1-12" (matches the on-panel cage labelling)
export function shortPortLabel(iface: string): string {
  return iface.replace(/^ethernet-/, '').replace(/^et-/, '');
}
