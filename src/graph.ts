// Builds the React Flow graph (positioned nodes + edges) and the trace adjacency
// straight from the topology tables — which carry the full per-port truth,
// including the edge/server interfaces the old switch-only view hid.
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import frontpanelMeta from './frontpanel-meta.json';
import { cageKey, breakoutChannel, type Topology, type LagInfo, type LldpStatus, type Breakout } from './api';
import type { Adjacency } from './trace';

type FpMeta = { ports: number; rows: number; aspect: number; slotted: boolean; layout: PortPos[] };
const FP_META: Record<string, FpMeta> = frontpanelMeta;

// port count + physical cage-row count per platform, derived from the stencils' data-port cages
// so the canvas panel matches the real box.
export const rowsOf = (platform: string) => FP_META[platform]?.rows ?? 2;
export const portCountOf = (platform: string) => FP_META[platform]?.ports ?? 32;

// role tier: smaller = closer to the fabric core (drawn higher up).
export const TIER: Record<string, number> = { superspine: 0, spine: 1, borderleaf: 2, leaf: 3 };
const tierOf = (role: string) => TIER[role] ?? 3;

// edge = plain server cable, lag = local port-channel (all members one box),
// mlag = multihomed/ESI bond (members span two leaves), isl = fabric uplink.
export type CableKind = 'isl' | 'edge' | 'lag' | 'mlag';
export const CABLE_COLOR: Record<CableKind, string> = {
  isl: 'var(--eda-blue-400)', edge: 'var(--eda-teal-500)', lag: 'var(--eda-yellow-500)', mlag: 'var(--eda-purple-400)',
};

// LLDP overlay palette (used in place of CABLE_COLOR while the overlay is on).
export const LLDP_COLOR: Record<LldpStatus, string> = {
  ok: 'var(--eda-green-500)', mismatch: 'var(--eda-red-500)', none: 'var(--eda-gray-600)',
};
// Aggregating a bundle / bond to its worst member status — a mismatch anywhere wins.
const LLDP_RANK: Record<LldpStatus, number> = { ok: 0, none: 1, mismatch: 2 };
const worseLldp = (a: LldpStatus, b: LldpStatus): LldpStatus => (LLDP_RANK[a] >= LLDP_RANK[b] ? a : b);

export type PortInfo = {
  port: string;         // cage id matching the stencil's data-port ("<port>" or "<slot>-<port>")
  channel?: number;     // breakout channel (1-based) when this cable lands on a broken-out sub-port
  kind: CableKind | 'free';
  side: 'top' | 'bottom';
  remote: string;       // short remote label e.g. "spine1" / "srv03" / "lag-a"
  remotePort: string;
  desc: string;
  cableId: string;      // edge id this port terminates, for hover-to-trace
  lldp?: LldpStatus;    // LLDP cross-check vs the configured remote
};

// React Flow handle id for a port (and breakout channel) — channelised so each sub-port's cable
// attaches to its own sliver rather than all converging on the cage.
export const portHandle = (port: string, channel?: number) => (channel ? `p${port}_${channel}` : `p${port}`);

export type PortPos = { p: string; x: number; y: number; w: number; h: number };
export type SwitchData = {
  name: string; role: string; platform: string;
  portCount: number;
  rows: number;                      // physical cage rows, mirrored on the canvas
  ports: PortInfo[];                 // occupied ports only (free cells inferred)
  layout?: PortPos[];                // real on-panel port positions (from the stencil); else grid
  aspect?: number;                   // cage-box w/h, to size the layout panel
  breakouts?: Record<string, Breakout>;  // cage id -> breakout split (channels + speed)
};

export type EndpointData = {
  label: string; full: string; remotePort: string;
  kind: 'edge' | 'lag' | 'mlag';
  members: number;        // member ports summed across every leaf it homes to
  leaves: string[];       // leaves this endpoint attaches to (>1 == multihomed)
  lacp?: boolean;         // LACP vs static (LAGs only)
  mode?: string;          // multihoming mode, e.g. AllActive (ESI only)
  lldp?: LldpStatus;      // worst LLDP status across the bond's member ports
};

// ---- layout constants ---------------------------------------------------
const CELL = 13, CELL_GAP = 3, HEAD_H = 32, STRIP_PAD = 8;
export const colsOf = (portCount: number, rows: number) => Math.max(1, Math.ceil(portCount / rows));
export const switchW = (portCount: number, rows: number) =>
  Math.max(196, colsOf(portCount, rows) * (CELL + CELL_GAP) + STRIP_PAD * 2);
export const switchH = (rows: number) => HEAD_H + rows * CELL + (rows - 1) * CELL_GAP + STRIP_PAD * 2;
export const layoutOf = (platform: string) => { const l = FP_META[platform]?.layout; return l && l.length ? l : undefined; };
export const aspectOf = (platform: string) => FP_META[platform]?.aspect ?? 4;
// modular chassis whose cages are addressed per slot ("<slot>-<port>"); drives cageKey() parsing.
export const slottedOf = (platform: string) => FP_META[platform]?.slotted ?? false;
// real-layout panel: sized by cage rows (so port numbers stay legible), width from the cage-box aspect.
const LAYOUT_ROW = 19;
export const panelDims = (rows: number, aspect: number) => ({ w: rows * LAYOUT_ROW * aspect, h: rows * LAYOUT_ROW });
export const switchHOf = (platform: string) =>
  layoutOf(platform)
    ? HEAD_H + panelDims(rowsOf(platform), aspectOf(platform)).h + STRIP_PAD * 2
    : switchH(rowsOf(platform));
const SWITCH_HEADER_H = 20, SWITCH_HEADER_MB = 6;
const SWITCH_PANEL_X = STRIP_PAD, SWITCH_PANEL_Y = STRIP_PAD + SWITCH_HEADER_H + SWITCH_HEADER_MB;
const EP_W = 112, EP_H = 22, EP_VGAP = 6, EP_HGAP = 10, EP_COLS = 2;
const SPINE_Y = 0, LEAF_Y = 320, EP_TOP_GAP = 34;

// strip "leafN-" prefix and "-peer" suffix to a compact endpoint label.
function shortEndpoint(leafId: string, remote: string): string {
  let s = remote.startsWith(`${leafId}-`) ? remote.slice(leafId.length + 1) : remote;
  s = s.replace(/-peer$/, '');
  return s;
}

export type BuiltGraph = { nodes: RFNode[]; edges: RFEdge[]; adjacency: Adjacency };

export function switchCages(d: SwitchData): string[] {
  return d.layout ? d.layout.map((p) => p.p) : Array.from({ length: d.portCount }, (_, i) => String(i + 1));
}

export function findSwitchPort(d: SwitchData, text: string): string | null {
  const cages = switchCages(d);
  const cageSet = new Set(cages);
  const slotted = cages.some((cage) => cage.includes('-'));
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = new Set<string>();

  for (const token of [text.toLowerCase(), ...tokens]) {
    const key = cageKey(token, slotted);
    if (key) candidates.add(key);

    const normalized = token
      .replace(/^ethernet-/, '')
      .replace(/^et-/, '')
      .replace(/\//g, '-')
      .replace(/[^a-z0-9-]+/g, '');
    if (normalized) candidates.add(normalized);

    const numbers = token.match(/\d+/g) ?? [];
    if (numbers.length >= 2) candidates.add(`${numbers[0]}-${numbers[1]}`);
    if (numbers.length >= 1) candidates.add(numbers.at(-1)!);
  }

  for (const candidate of candidates) {
    if (cageSet.has(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate)) continue;
    const match = cages.find((cage) => cage === candidate || cage.endsWith(`-${candidate}`));
    if (match) return match;
  }
  return null;
}

export function switchPortCenter(d: SwitchData, port: string): { x: number; y: number } | null {
  const rows = Math.max(1, d.rows);
  if (d.layout) {
    const p = d.layout.find((pos) => pos.p === port);
    if (!p) return null;
    const { w: W, h: H } = panelDims(rows, d.aspect ?? 4);
    return { x: SWITCH_PANEL_X + p.x * W, y: SWITCH_PANEL_Y + p.y * H };
  }

  const index = Number(port) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= d.portCount) return null;
  const row = index % rows;
  const col = Math.floor(index / rows);
  return {
    x: SWITCH_PANEL_X + col * (CELL + CELL_GAP) + CELL / 2,
    y: SWITCH_PANEL_Y + row * (CELL + CELL_GAP) + CELL / 2,
  };
}

function nodeLabelPairs(n: Topology['nodes'][number]): string[] {
  const labels = new Map<string, string>();
  const rawLabels = n.raw?.metadata?.labels;

  if (rawLabels && typeof rawLabels === 'object' && !Array.isArray(rawLabels)) {
    for (const [key, value] of Object.entries(rawLabels)) {
      if (value == null) continue;
      labels.set(key, String(value));
    }
  }
  for (const [key, value] of Object.entries(n.labels ?? {})) labels.set(key, value);
  if (n.role && !labels.has('eda.nokia.com/role')) labels.set('eda.nokia.com/role', n.role);

  return [...labels.entries()]
    .filter(([key, value]) => key.trim() && value.trim())
    .map(([key, value]) => `${key}=${value}`);
}

export function buildGraph(topo: Topology): BuiltGraph {
  const byName = new Map(topo.nodes.map((n) => [n.name, n]));
  const role = (name: string) => byName.get(name)?.role ?? 'leaf';
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
    haystacks.set(node, [byName.get(node)?.name ?? node, byName.get(node)?.platform ?? '', role(node)]).get(node)!;

  // ISL port-channels collapse their parallel members into one drawn cable (×N); plain
  // ISLs stay one-cable-per-link. Bundles accumulate across the mirrored far-side rows.
  type Bundle = {
    id: string; child: string; parent: string; side: 'top' | 'bottom'; lldp: LldpStatus;
    cables: Map<string, { childPort: string; parentPort: string; childLabel: string; parentLabel: string }>;
  };
  const bundles = new Map<string, Bundle>();

  // Edge endpoints are grouped GLOBALLY (across nodes), keyed by LAG resource when bundled,
  // so a multihomed LAG landing on two leaves becomes one shared chip instead of two.
  type Member = { port: string; channel?: number; desc: string; remotePort: string; label: string; lldp: LldpStatus };
  type Accum = { key: string; label: string; full: string; lagName?: string; portsByNode: Map<string, Member[]> };
  const epAccum = new Map<string, Accum>();

  for (const sw of topo.nodes) {
    const slotted = slottedOf(sw.platform);
    for (const r of sw.table ?? []) {
      const p = cageKey(r.label, slotted);
      if (p == null) continue;

      if (r.type === 'interSwitch' && r.remoteNode) {
        hay(sw.name).push(r.label);
        const remoteTier = tierOf(role(r.remoteNode));
        // uplinks leave the top; a same-tier peer link (leaf↔leaf MLAG ISL) also routes over
        // the top, into the open space above — routing it below would dive through the host band.
        const side: 'top' | 'bottom' = remoteTier <= tierOf(sw.role) ? 'top' : 'bottom';
        const rp = cageKey(r.remotePort, slottedOf(byName.get(r.remoteNode)?.platform ?? '')) ?? p;
        // canonical per-cable id, stable across the mirrored far-side row
        const ends = [`${sw.name}:${r.remotePort}`, `${r.remoteNode}:${r.label}`].toSorted();
        const cableId = `isl|${ends[0]}|${ends[1]}`;

        if (lagOf(r.lag)?.isl) {
          // bundle: -local/-remote name the two ends of the same channel — normalise to one key
          const bid = `isllag|${r.lag!.replace(/^lag-/, '').replace(/-(local|remote)$/, '')}`;
          const [a, b] = [sw.name, r.remoteNode].toSorted();
          const aPort = a === sw.name ? p : rp;
          const bPort = a === sw.name ? rp : p;
          const bundle = bundles.get(bid) ?? bundles.set(bid, { id: bid, child: a, parent: b, side, lldp: 'ok', cables: new Map() }).get(bid)!;
          bundle.lldp = worseLldp(bundle.lldp, r.lldpStatus ?? 'none');
          bundle.cables.set(cableId, {
            childPort: aPort, parentPort: bPort,
            childLabel: shortPortLabel(a === sw.name ? r.label : r.remotePort),
            parentLabel: shortPortLabel(a === sw.name ? r.remotePort : r.label),
          });
          portsOf(sw.name).push({ port: p, kind: 'isl', side, remote: r.remoteNode, remotePort: r.remotePort, desc: r.desc, cableId: bid, lldp: r.lldpStatus });
        } else {
          portsOf(sw.name).push({ port: p, kind: 'isl', side, remote: r.remoteNode, remotePort: r.remotePort, desc: r.desc, cableId, lldp: r.lldpStatus });
          if (!islSeen.has(cableId)) {
            islSeen.add(cableId);
            const child = tierOf(sw.role) >= tierOf(role(r.remoteNode)) ? sw.name : r.remoteNode;
            const parent = child === sw.name ? r.remoteNode : sw.name;
            const childPort = child === sw.name ? p : rp;
            const parentPort = child === sw.name ? rp : p;
            rfEdges.push({
              id: cableId, source: child, target: parent, type: 'cable',
              sourceHandle: `p${childPort}`, targetHandle: `p${parentPort}t`,
              data: { kind: 'isl', a: shortPortLabel(r.label), b: shortPortLabel(r.remotePort), lldp: r.lldpStatus },
            });
            link(cableId, child, parent, [`${child}:${childPort}`, `${parent}:${parentPort}`]);
          }
        }
      } else if (r.type === 'edge') {
        const name = r.peer || r.remoteNode || '';
        const key = r.lag ?? `${sw.name}|${name}`;   // LAG members share one key; plain servers key per-leaf
        const accum = epAccum.get(key) ?? epAccum.set(key, {
          key, label: shortEndpoint(sw.name, name), full: r.lag ?? name, lagName: r.lag, portsByNode: new Map(),
        }).get(key)!;
        (accum.portsByNode.get(sw.name) ?? accum.portsByNode.set(sw.name, []).get(sw.name)!)
          .push({ port: p, channel: breakoutChannel(r.label) ?? undefined, desc: r.desc, remotePort: r.remotePort, label: r.label, lldp: r.lldpStatus ?? 'none' });
        hay(sw.name).push(r.label);
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
    const allMembers = [...a.portsByNode.values()].flat();
    const remotePort = allMembers[0].remotePort;
    const epLldp = allMembers.reduce<LldpStatus>((acc, m) => worseLldp(acc, m.lldp), 'ok');
    endpoints.push({
      id: epId, leaves,
      data: { label: a.label, full: a.full, remotePort, kind, members: total, leaves, lacp: lag?.lacp, mode: lag?.mode, lldp: epLldp },
    });
    const labels = allMembers.map((x) => x.label);
    search.set(epId, [a.label, a.full, remotePort, ...labels].join(' ').toLowerCase());
    for (const [node, members] of a.portsByNode) {
      for (const m of members) {
        const sid = `stub|${node}|${m.port}${m.channel ? `_${m.channel}` : ''}`;
        portsOf(node).push({ port: m.port, channel: m.channel, kind, side: 'bottom', remote: a.label, remotePort: m.remotePort, desc: m.desc, cableId: sid, lldp: m.lldp });
        rfEdges.push({
          id: sid, source: node, target: epId, type: 'cable',
          sourceHandle: portHandle(m.port, m.channel), targetHandle: 'in',
          data: { kind, a: shortPortLabel(m.label), b: m.remotePort || a.label, lldp: m.lldp },
        });
        link(sid, node, epId, [`${node}:${m.port}`]);
      }
    }
  }

  // emit one drawn cable per ISL bundle, labelled with its member count
  for (const b of bundles.values()) {
    const cables = [...b.cables.values()].toSorted((x, y) => x.childPort.localeCompare(y.childPort, undefined, { numeric: true }));
    const rep = cables[0];
    rfEdges.push({
      id: b.id, source: b.child, target: b.parent, type: 'cable',
      sourceHandle: `p${rep.childPort}`, targetHandle: `p${rep.parentPort}t`,
      data: { kind: 'isl', a: cables.map((c) => c.childLabel).join(', '), b: cables.map((c) => c.parentLabel).join(', '), count: cables.length, lldp: b.lldp },
    });
    link(b.id, b.child, b.parent, cables.flatMap((c) => [`${b.child}:${c.childPort}`, `${b.parent}:${c.parentPort}`]));
  }

  // per-node label set ("key=value") for the label filter; also fold labels into the free-text haystack
  const nodeLabels = new Map<string, Set<string>>();
  for (const n of topo.nodes) {
    const pairs = nodeLabelPairs(n);
    nodeLabels.set(n.name, new Set(pairs));
    search.set(n.name, [...(haystacks.get(n.name) ?? [n.name, n.platform, n.role]), ...pairs].join(' ').toLowerCase());
  }

  // ---- positions -------------------------------------------------------
  const leaves = topo.nodes.filter((n) => tierOf(n.role) >= 2);
  const cores = topo.nodes.filter((n) => tierOf(n.role) < 2);

  const swW = (p: string) => layoutOf(p) ? panelDims(rowsOf(p), aspectOf(p)).w + STRIP_PAD * 2 : switchW(portCountOf(p), rowsOf(p));
  const pos = new Map<string, { x: number; y: number }>();
  // leaves laid out left→right, each given a slot wide enough for its endpoint fan
  const SLOT_GAP = 64;
  let cursor = 0;
  const leafCenter = new Map<string, number>();
  for (const lf of leaves) {
    const w = Math.max(swW(lf.platform), EP_COLS * EP_W + (EP_COLS - 1) * EP_HGAP);
    const x = cursor;
    pos.set(lf.name, { x: x + (w - swW(lf.platform)) / 2, y: LEAF_Y });
    leafCenter.set(lf.name, x + w / 2);
    cursor += w + SLOT_GAP;
  }
  const spanL = 0, spanR = Math.max(cursor - SLOT_GAP, switchW(32, 2));
  // cores centred above the leaf span
  if (cores.length) {
    const totalW = cores.reduce((s, c) => s + swW(c.platform), 0) + (cores.length - 1) * 120;
    let cx = (spanL + spanR) / 2 - totalW / 2;
    for (const c of cores) {
      pos.set(c.name, { x: cx, y: SPINE_Y });
      cx += swW(c.platform) + 120;
    }
  }

  const rfNodes: RFNode[] = topo.nodes.map((n) => ({
    id: n.name, type: 'switch', position: pos.get(n.name) ?? { x: 0, y: 0 },
    data: { name: n.name, role: n.role, platform: n.platform, portCount: portCountOf(n.platform), rows: rowsOf(n.platform), ports: switchPorts.get(n.name) ?? [], layout: layoutOf(n.platform), aspect: aspectOf(n.platform), breakouts: n.breakouts } satisfies SwitchData,
    draggable: true,
  }));

  // single-homed chips fan out below their one leaf in an EP_COLS-wide grid; multihomed
  // (ESI) chips drop into a shared band underneath, centred between the leaves they bond.
  const byLeaf = new Map(leaves.map((l) => [l.name, l]));
  const leafTopOf = (id: string) => LEAF_Y + switchHOf(byLeaf.get(id)?.platform ?? '') + EP_TOP_GAP;
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
  const bandY = (leaves.length ? Math.max(...leaves.map((l) => fanBottom(l.name))) : LEAF_Y) + 48;
  const centroid = (ep: Endpoint) => ep.leaves.reduce((s, n) => s + (leafCenter.get(n) ?? 0), 0) / ep.leaves.length;
  let prevRight = -Infinity;
  for (const ep of multi.toSorted((p, q) => centroid(p) - centroid(q))) {
    const x = Math.max(centroid(ep) - EP_W / 2, prevRight + EP_HGAP);
    prevRight = x + EP_W;
    rfNodes.push({ id: ep.id, type: 'endpoint', position: { x, y: bandY }, data: ep.data, draggable: true });
  }

  return { nodes: rfNodes, edges: rfEdges, adjacency: { nodeEdges, edgeEnds, edgePorts, search, nodeLabels } };
}

// ethernet-1-12 -> "1-12" (matches the on-panel cage labelling)
export function shortPortLabel(iface: string): string {
  return iface.replace(/^ethernet-/, '').replace(/^et-/, '');
}
