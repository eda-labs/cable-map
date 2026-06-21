// Builds the React Flow graph (positioned nodes + edges) and the trace adjacency
// straight from the topology tables — which carry the full per-port truth,
// including the edge/server interfaces the old switch-only view hid.
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import PORTS from './frontpanel/ports.json';
import ROWS from './frontpanel/rows.json';
import { portIdx, type Topology, type LagInfo } from './api';
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

// edge = plain server cable, lag = local port-channel (all members one box),
// mlag = multihomed/ESI bond (members span two leaves), isl = fabric uplink.
export type CableKind = 'isl' | 'edge' | 'lag' | 'mlag';
export const CABLE_COLOR: Record<CableKind, string> = {
  isl: '#5B9BFF', edge: '#13C39A', lag: '#FFB020', mlag: '#C77DFF',
};

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
  kind: 'edge' | 'lag' | 'mlag';
  members: number;        // member ports summed across every leaf it homes to
  leaves: string[];       // leaves this endpoint attaches to (>1 == multihomed)
  lacp?: boolean;         // LACP vs static (LAGs only)
  mode?: string;          // multihoming mode, e.g. AllActive (ESI only)
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
  const lagOf = (name?: string): LagInfo | undefined => (name ? topo.lags[name] : undefined);

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
  const switchPorts = new Map<string, PortInfo[]>();
  const portsOf = (node: string) => switchPorts.get(node) ?? switchPorts.set(node, []).get(node)!;
  const haystacks = new Map<string, string[]>();
  const hay = (node: string) =>
    haystacks.get(node) ??
    haystacks.set(node, [byId.get(node)?.name ?? node, byId.get(node)?.platform ?? '', role(node)]).get(node)!;

  // ISL port-channels collapse their parallel members into one drawn cable (×N); plain
  // ISLs stay one-cable-per-link. Bundles accumulate across the mirrored far-side rows.
  type Bundle = {
    id: string; child: string; parent: string; side: 'top' | 'bottom';
    cables: Map<string, { childPort: number; parentPort: number; childLabel: string; parentLabel: string }>;
  };
  const bundles = new Map<string, Bundle>();

  // Edge endpoints are grouped GLOBALLY (across nodes), keyed by LAG resource when bundled,
  // so a multihomed LAG landing on two leaves becomes one shared chip instead of two.
  type Member = { port: number; desc: string; remotePort: string; label: string };
  type Accum = { key: string; label: string; full: string; lagName?: string; portsByNode: Map<string, Member[]> };
  const epAccum = new Map<string, Accum>();

  for (const sw of topo.nodes) {
    for (const r of topo.tables[sw.id] ?? []) {
      const p = portIdx(r.label);
      if (p == null) continue;

      if (r.type === 'interSwitch' && r.remoteNode) {
        hay(sw.id).push(r.label);
        const up = tierOf(role(r.remoteNode)) < tierOf(sw.role);
        const rp = portIdx(r.remotePort) ?? p;
        // canonical per-cable id, stable across the mirrored far-side row
        const ends = [`${sw.id}:${r.remotePort}`, `${r.remoteNode}:${r.label}`].toSorted();
        const cableId = `isl|${ends[0]}|${ends[1]}`;

        if (lagOf(r.lag)?.isl) {
          // bundle: -local/-remote name the two ends of the same channel — normalise to one key
          const bid = `isllag|${r.lag!.replace(/^lag-/, '').replace(/-(local|remote)$/, '')}`;
          const [a, b] = [sw.id, r.remoteNode].toSorted();
          const aPort = a === sw.id ? p : rp;
          const bPort = a === sw.id ? rp : p;
          const bundle = bundles.get(bid) ?? bundles.set(bid, { id: bid, child: a, parent: b, side: up ? 'top' : 'bottom', cables: new Map() }).get(bid)!;
          bundle.cables.set(cableId, {
            childPort: aPort, parentPort: bPort,
            childLabel: shortPortLabel(a === sw.id ? r.label : r.remotePort),
            parentLabel: shortPortLabel(a === sw.id ? r.remotePort : r.label),
          });
          portsOf(sw.id).push({ port: p, kind: 'isl', side: up ? 'top' : 'bottom', remote: r.remoteNode, remotePort: r.remotePort, desc: r.desc, cableId: bid });
        } else {
          portsOf(sw.id).push({ port: p, kind: 'isl', side: up ? 'top' : 'bottom', remote: r.remoteNode, remotePort: r.remotePort, desc: r.desc, cableId });
          if (!islSeen.has(cableId)) {
            islSeen.add(cableId);
            const child = tierOf(sw.role) >= tierOf(role(r.remoteNode)) ? sw.id : r.remoteNode;
            const parent = child === sw.id ? r.remoteNode : sw.id;
            const childPort = child === sw.id ? p : rp;
            const parentPort = child === sw.id ? rp : p;
            rfEdges.push({
              id: cableId, source: child, target: parent, type: 'cable',
              sourceHandle: `p${childPort}`, targetHandle: `p${parentPort}t`,
              data: { kind: 'isl', a: shortPortLabel(r.label), b: shortPortLabel(r.remotePort) },
            });
            link(cableId, child, parent, [`${child}:${childPort}`, `${parent}:${parentPort}`]);
          }
        }
      } else if (r.type === 'edge') {
        const name = r.peer || r.remoteNode || '';
        const key = r.lag ?? `${sw.id}|${name}`;   // LAG members share one key; plain servers key per-leaf
        const accum = epAccum.get(key) ?? epAccum.set(key, {
          key, label: shortEndpoint(sw.id, name), full: r.lag ?? name, lagName: r.lag, portsByNode: new Map(),
        }).get(key)!;
        (accum.portsByNode.get(sw.id) ?? accum.portsByNode.set(sw.id, []).get(sw.id)!)
          .push({ port: p, desc: r.desc, remotePort: r.remotePort, label: r.label });
        hay(sw.id).push(r.label);
      }
    }
  }

  // realise endpoint chips + a stub cable per member port, all converging on the one chip
  type Endpoint = { id: string; leaves: string[]; data: EndpointData };
  const endpoints: Endpoint[] = [];
  for (const a of epAccum.values()) {
    const leaves = [...a.portsByNode.keys()];
    const total = [...a.portsByNode.values()].reduce((s, m) => s + m.length, 0);
    const lag = lagOf(a.lagName);
    const multihomed = leaves.length > 1 || !!lag?.multihomed;
    const kind: EndpointData['kind'] = multihomed ? 'mlag' : (a.lagName || total > 1) ? 'lag' : 'edge';
    const epId = `ep|${a.key}`;
    const remotePort = [...a.portsByNode.values()][0][0].remotePort;
    endpoints.push({
      id: epId, leaves,
      data: { label: a.label, full: a.full, remotePort, kind, members: total, leaves, lacp: lag?.lacp, mode: lag?.mode },
    });
    const labels = [...a.portsByNode.values()].flatMap((m) => m.map((x) => x.label));
    search.set(epId, [a.label, a.full, remotePort, ...labels].join(' ').toLowerCase());
    for (const [node, members] of a.portsByNode) {
      for (const m of members) {
        const sid = `stub|${node}|${m.port}`;
        portsOf(node).push({ port: m.port, kind, side: 'bottom', remote: a.label, remotePort: m.remotePort, desc: m.desc, cableId: sid });
        rfEdges.push({
          id: sid, source: node, target: epId, type: 'cable',
          sourceHandle: `p${m.port}`, targetHandle: 'in',
          data: { kind, a: shortPortLabel(m.label), b: m.remotePort || a.label },
        });
        link(sid, node, epId, [`${node}:${m.port}`]);
      }
    }
  }

  // emit one drawn cable per ISL bundle, labelled with its member count
  for (const b of bundles.values()) {
    const cables = [...b.cables.values()].toSorted((x, y) => x.childPort - y.childPort);
    const rep = cables[0];
    rfEdges.push({
      id: b.id, source: b.child, target: b.parent, type: 'cable',
      sourceHandle: `p${rep.childPort}`, targetHandle: `p${rep.parentPort}t`,
      data: { kind: 'isl', a: cables.map((c) => c.childLabel).join(', '), b: cables.map((c) => c.parentLabel).join(', '), count: cables.length },
    });
    link(b.id, b.child, b.parent, cables.flatMap((c) => [`${b.child}:${c.childPort}`, `${b.parent}:${c.parentPort}`]));
  }

  for (const n of topo.nodes) search.set(n.id, (haystacks.get(n.id) ?? [n.name, n.platform, n.role]).join(' ').toLowerCase());

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

  // single-homed chips fan out below their one leaf in an EP_COLS-wide grid; multihomed
  // (ESI) chips drop into a shared band underneath, centred between the leaves they bond.
  const byLeaf = new Map(leaves.map((l) => [l.id, l]));
  const leafTopOf = (id: string) => LEAF_Y + switchH(rowsOf(byLeaf.get(id)?.platform ?? '')) + EP_TOP_GAP;
  const single = endpoints.filter((e) => e.data.kind !== 'mlag');
  const multi = endpoints.filter((e) => e.data.kind === 'mlag');

  const fanCount = new Map<string, number>();
  for (const ep of single) fanCount.set(ep.leaves[0], (fanCount.get(ep.leaves[0]) ?? 0) + 1);

  const clusterW = EP_COLS * EP_W + (EP_COLS - 1) * EP_HGAP;
  const epIndex = new Map<string, number>();
  for (const ep of single) {
    const lf = ep.leaves[0];
    const i = epIndex.get(lf) ?? 0; epIndex.set(lf, i + 1);
    const center = leafCenter.get(lf) ?? 0;
    const col = i % EP_COLS, row = Math.floor(i / EP_COLS);
    const x = center - clusterW / 2 + col * (EP_W + EP_HGAP);
    const y = leafTopOf(lf) + row * (EP_H + EP_VGAP);
    rfNodes.push({ id: ep.id, type: 'endpoint', position: { x, y }, data: ep.data, draggable: true });
  }

  // band sits below the deepest single-homed fan so ESI cables clear the chips above
  const fanBottom = (lf: string) => leafTopOf(lf) + Math.ceil((fanCount.get(lf) ?? 0) / EP_COLS) * (EP_H + EP_VGAP);
  const bandY = (leaves.length ? Math.max(...leaves.map((l) => fanBottom(l.id))) : LEAF_Y) + 48;
  const centroid = (ep: Endpoint) => ep.leaves.reduce((s, n) => s + (leafCenter.get(n) ?? 0), 0) / ep.leaves.length;
  let prevRight = -Infinity;
  for (const ep of multi.toSorted((p, q) => centroid(p) - centroid(q))) {
    const x = Math.max(centroid(ep) - EP_W / 2, prevRight + EP_HGAP);
    prevRight = x + EP_W;
    rfNodes.push({ id: ep.id, type: 'endpoint', position: { x, y: bandY }, data: ep.data, draggable: true });
  }

  return { nodes: rfNodes, edges: rfEdges, adjacency: { nodeEdges, edgeEnds, edgePorts, search } };
}

// ethernet-1-12 -> "1-12" (matches the on-panel cage labelling)
export function shortPortLabel(iface: string): string {
  return iface.replace(/^ethernet-/, '').replace(/^et-/, '');
}
