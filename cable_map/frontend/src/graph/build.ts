// Builds the React Flow graph (positioned nodes + edges) and the trace adjacency straight from the
// topology tables — which carry the full per-port truth, including the edge/server interfaces.
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import { cageKey, breakoutChannel, type Topology, type LagInfo, type LldpStatus, type Breakout } from '../api';
import { stencilFor, componentsOf } from '../stencil';
import { aspectOf, layoutOf, portCountOf, rowsOf, slottedOf } from './meta';
import {
  COMPACT_SWITCH_H, COMPACT_SWITCH_W, STRIP_PAD, compactSwitchHandle, panelDims, portHandle, switchHOf, switchW,
} from './geometry';
import {
  worseLldp,
  type BuildGraphOptions, type BuiltGraph, type CableKind, type EndpointData, type PortInfo, type SwitchData,
} from './types';

// role tier: smaller = closer to the fabric core (drawn higher up).
const TIER: Record<string, number> = { superspine: 0, spine: 1, borderleaf: 2, leaf: 3 };
const tierOf = (role: string) => TIER[role] ?? 3;

const LARGE_TOPOLOGY_NODE_THRESHOLD = 300;
const LARGE_TOPOLOGY_ROW_THRESHOLD = 5000;
const EP_W = 112, EP_H = 22, EP_VGAP = 6, EP_HGAP = 10, EP_COLS = 2;
const SPINE_Y = 0, LEAF_Y = 320, EP_TOP_GAP = 34;

export function isLargeTopology(topo: Topology): boolean {
  const rows = topo.nodes.reduce((sum, node) => sum + (node.table?.length ?? 0), 0);
  return topo.nodes.length >= LARGE_TOPOLOGY_NODE_THRESHOLD || rows >= LARGE_TOPOLOGY_ROW_THRESHOLD;
}

// strip "leafN-" prefix and "-peer" suffix to a compact endpoint label.
function shortEndpoint(leafId: string, remote: string): string {
  let s = remote.startsWith(`${leafId}-`) ? remote.slice(leafId.length + 1) : remote;
  s = s.replace(/-peer$/, '');
  return s;
}

// ethernet-1-12 -> "1-12" (matches the on-panel cage labelling)
function shortPortLabel(iface: string): string {
  return iface.replace(/^ethernet-/, '').replace(/^et-/, '');
}

function labelOf(n: Topology['nodes'][number], key: string): string | undefined {
  return n.labels?.[key] ?? n.raw?.metadata?.labels?.[key];
}

function naturalName(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function breakoutsWithInferredChannels(explicit: Record<string, Breakout> | undefined, ports: PortInfo[]): Record<string, Breakout> | undefined {
  const inferred = new Map<string, number>();
  for (const port of ports) {
    if (!port.channel || explicit?.[port.port]) continue;
    inferred.set(port.port, Math.max(inferred.get(port.port) ?? 0, port.channel));
  }

  if (!inferred.size) return explicit;
  const out = { ...explicit };
  for (const [port, channels] of inferred) {
    if (channels > 1) out[port] = { channels, speed: '' };
  }
  return Object.keys(out).length ? out : undefined;
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

export function buildGraph(topo: Topology, options: BuildGraphOptions = {}): BuiltGraph {
  const compact = options.compact ?? isLargeTopology(topo);
  const tiered = options.tiered ?? compact;
  const byName = new Map(topo.nodes.map((n) => [n.name, n]));
  const role = (name: string) => byName.get(name)?.role ?? 'leaf';
  // the stencil each node renders (its platform, or card-derived for modular SROS chassis); drives all
  // sizing + FP_META lookups, while node.platform stays the displayed model name.
  const stencilByName = new Map(topo.nodes.map((n) => [n.name, stencilFor(n.platform, componentsOf(n.raw))]));
  const stencilOf = (name: string) => stencilByName.get(name) ?? '';
  const lagOf = (name?: string): LagInfo | undefined => (name ? topo.lags[name] : undefined);
  const sideBetween = (node: string, remote: string): 'top' | 'bottom' =>
    tierOf(role(remote)) <= tierOf(role(node)) ? 'top' : 'bottom';
  const switchHandle = (node: string, remote: string, target = false) =>
    compact ? compactSwitchHandle(sideBetween(node, remote), target) : null;

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

  // Edge endpoints are grouped globally only when the backend marked them with a LAG resource.
  // Plain edge links stay per physical port, even when multiple links share the same peer label.
  type Member = { port: string; channel?: number; desc: string; remotePort: string; label: string; lldp: LldpStatus };
  type Accum = { key: string; label: string; full: string; lagName?: string; portsByNode: Map<string, Member[]> };
  const epAccum = new Map<string, Accum>();

  for (const sw of topo.nodes) {
    const slotted = slottedOf(stencilOf(sw.name));
    for (const r of sw.table ?? []) {
      const p = cageKey(r.label, slotted);
      if (p == null) continue;

      if (r.type === 'interSwitch' && r.remoteNode) {
        hay(sw.name).push(r.label);
        const remoteTier = tierOf(role(r.remoteNode));
        // uplinks leave the top; a same-tier peer link (leaf↔leaf MLAG ISL) also routes over
        // the top, into the open space above — routing it below would dive through the host band.
        const side: 'top' | 'bottom' = remoteTier <= tierOf(sw.role) ? 'top' : 'bottom';
        const rp = cageKey(r.remotePort, slottedOf(stencilOf(r.remoteNode))) ?? p;
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
              sourceHandle: switchHandle(child, parent) ?? `p${childPort}`,
              targetHandle: switchHandle(parent, child, true) ?? `p${parentPort}t`,
              data: { kind: 'isl', a: shortPortLabel(r.label), b: shortPortLabel(r.remotePort), lldp: r.lldpStatus, fast: compact },
            });
            link(cableId, child, parent, [`${child}:${childPort}`, `${parent}:${parentPort}`]);
          }
        }
      } else if (r.type === 'edge') {
        const name = r.peer || r.remoteNode || '';
        if (compact) {
          const lag = lagOf(r.lag);
          const kind: CableKind = lag?.multihomed ? 'mlag' : r.lag ? 'lag' : 'edge';
          const sid = `stub|${sw.name}|${p}${breakoutChannel(r.label) ? `_${breakoutChannel(r.label)}` : ''}`;
          portsOf(sw.name).push({
            port: p,
            channel: breakoutChannel(r.label) ?? undefined,
            kind,
            side: 'bottom',
            remote: shortEndpoint(sw.name, name),
            remotePort: r.remotePort,
            desc: r.desc,
            cableId: sid,
            lldp: r.lldpStatus ?? 'none',
          });
          hay(sw.name).push(r.label);
          continue;
        }

        const key = r.lag ?? `${sw.name}|${r.label}`;   // LAG members share one key; plain edges key per-port
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
    const kind: EndpointData['kind'] = a.lagName ? (lag?.multihomed ? 'mlag' : 'lag') : 'edge';
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
          sourceHandle: compact ? compactSwitchHandle('bottom') : portHandle(m.port, m.channel),
          targetHandle: 'in',
          data: { kind, a: shortPortLabel(m.label), b: m.remotePort || a.label, lldp: m.lldp, fast: compact },
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
      sourceHandle: switchHandle(b.child, b.parent) ?? `p${rep.childPort}`,
      targetHandle: switchHandle(b.parent, b.child, true) ?? `p${rep.parentPort}t`,
      data: { kind: 'isl', a: cables.map((c) => c.childLabel).join(', '), b: cables.map((c) => c.parentLabel).join(', '), count: cables.length, lldp: b.lldp, fast: compact },
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

  // sized by the node's resolved stencil (callers pass the node name, not its display platform)
  const swW = (name: string) => { const p = stencilOf(name); return compact
    ? COMPACT_SWITCH_W
    : layoutOf(p) ? panelDims(rowsOf(p), aspectOf(p)).w + STRIP_PAD * 2 : switchW(portCountOf(p), rowsOf(p)); };
  const swH = (name: string) => compact ? COMPACT_SWITCH_H : switchHOf(stencilOf(name));
  const pos = new Map<string, { x: number; y: number }>();
  const leafCenter = new Map<string, number>();

  if (compact) {
    const GAP_X = 28, GAP_Y = 30;
    const leafCols = Math.min(64, Math.max(1, Math.ceil(Math.sqrt(leaves.length * 4))));
    const leafWidth = leafCols * COMPACT_SWITCH_W + (leafCols - 1) * GAP_X;
    const placeGrid = (items: typeof topo.nodes, y: number, cols: number) => {
      const safeCols = Math.max(1, Math.min(cols, Math.max(1, items.length)));
      const totalW = safeCols * COMPACT_SWITCH_W + (safeCols - 1) * GAP_X;
      const startX = Math.max(0, (leafWidth - totalW) / 2);
      for (const [i, item] of items.entries()) {
        const col = i % safeCols;
        const row = Math.floor(i / safeCols);
        const x = startX + col * (COMPACT_SWITCH_W + GAP_X);
        const yy = y + row * (COMPACT_SWITCH_H + GAP_Y);
        pos.set(item.name, { x, y: yy });
        if (tierOf(item.role) >= 2) leafCenter.set(item.name, x + COMPACT_SWITCH_W / 2);
      }
    };

    placeGrid(topo.nodes.filter((n) => tierOf(n.role) === 0), SPINE_Y, 16);
    placeGrid(topo.nodes.filter((n) => tierOf(n.role) === 1), SPINE_Y + 120, 32);
    placeGrid(leaves, SPINE_Y + 360, leafCols);
  } else if (tiered) {
    // Large detailed fabrics need locality: every pod keeps its leaves under its own spines,
    // while superspines stay as the shared top tier. This preserves full front-panel detail
    // without making leaf→spine links disappear into the far centre of a 1000-node canvas.
    const GAP_X = 64, POD_GAP = 180, SPINE_GAP = 96, LEAF_COLS = 8;
    const SPINE_TIER_Y = 210, LEAF_TIER_Y = 440;
    const pods = new Map<string, { leaves: typeof topo.nodes; spines: typeof topo.nodes }>();
    const podKey = (n: typeof topo.nodes[number]) => labelOf(n, 'eda.nokia.com/pod') ?? 'pod';

    for (const leaf of leaves) (pods.get(podKey(leaf)) ?? pods.set(podKey(leaf), { leaves: [], spines: [] }).get(podKey(leaf))!).leaves.push(leaf);
    for (const spine of cores.filter((n) => tierOf(n.role) === 1)) (pods.get(podKey(spine)) ?? pods.set(podKey(spine), { leaves: [], spines: [] }).get(podKey(spine))!).spines.push(spine);

    let cursor = 0;
    const podNames = [...pods.keys()].toSorted(naturalName);
    for (const podName of podNames) {
      const pod = pods.get(podName)!;
      pod.leaves.sort((a, b) => naturalName(a.name, b.name));
      pod.spines.sort((a, b) => naturalName(a.name, b.name));

      const maxLeafW = Math.max(1, ...pod.leaves.map((n) => swW(n.name)));
      const maxLeafH = Math.max(1, ...pod.leaves.map((n) => swH(n.name)));
      const cols = Math.max(1, Math.min(LEAF_COLS, pod.leaves.length || 1));
      const leafRowGap = maxLeafH + EP_TOP_GAP + 2 * (EP_H + EP_VGAP) + 72;
      const leafGridW = cols * maxLeafW + (cols - 1) * GAP_X;
      const spineGridW = pod.spines.reduce((sum, n) => sum + swW(n.name), 0) + Math.max(0, pod.spines.length - 1) * SPINE_GAP;
      const podW = Math.max(leafGridW, spineGridW, switchW(32, 2));

      const leafStartX = cursor + (podW - leafGridW) / 2;
      for (const [i, leaf] of pod.leaves.entries()) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = leafStartX + col * (maxLeafW + GAP_X) + (maxLeafW - swW(leaf.name)) / 2;
        const y = LEAF_TIER_Y + row * leafRowGap;
        pos.set(leaf.name, { x, y });
        leafCenter.set(leaf.name, x + swW(leaf.name) / 2);
      }

      let sx = cursor + (podW - spineGridW) / 2;
      for (const spine of pod.spines) {
        pos.set(spine.name, { x: sx, y: SPINE_TIER_Y });
        sx += swW(spine.name) + SPINE_GAP;
      }
      cursor += podW + POD_GAP;
    }

    const supers = cores.filter((n) => tierOf(n.role) === 0).toSorted((a, b) => naturalName(a.name, b.name));
    const totalW = Math.max(cursor - POD_GAP, switchW(32, 2));
    for (const [i, node] of supers.entries()) {
      const w = swW(node.name);
      const x = supers.length <= 1 ? (totalW - w) / 2 : (totalW - w) * (i / (supers.length - 1));
      pos.set(node.name, { x, y: SPINE_Y });
    }
  } else {
    // leaves laid out left→right, each given a slot wide enough for its endpoint fan
    const SLOT_GAP = 64;
    let cursor = 0;
    for (const lf of leaves) {
      const w = Math.max(swW(lf.name), EP_COLS * EP_W + (EP_COLS - 1) * EP_HGAP);
      const x = cursor;
      pos.set(lf.name, { x: x + (w - swW(lf.name)) / 2, y: LEAF_Y });
      leafCenter.set(lf.name, x + w / 2);
      cursor += w + SLOT_GAP;
    }
    const spanL = 0, spanR = Math.max(cursor - SLOT_GAP, switchW(32, 2));
    // cores centred above the leaf span
    if (cores.length) {
      const totalW = cores.reduce((s, c) => s + swW(c.name), 0) + (cores.length - 1) * 120;
      let cx = (spanL + spanR) / 2 - totalW / 2;
      for (const c of cores) {
        pos.set(c.name, { x: cx, y: SPINE_Y });
        cx += swW(c.name) + 120;
      }
    }
  }

  const rfNodes: RFNode[] = topo.nodes.map((n) => {
    const nodePorts = switchPorts.get(n.name) ?? [];
    return {
      id: n.name, type: 'switch', position: pos.get(n.name) ?? { x: 0, y: 0 },
      width: swW(n.name),
      height: swH(n.name),
      initialWidth: swW(n.name),
      initialHeight: swH(n.name),
      data: {
        name: n.name, role: n.role, platform: n.platform,
        portCount: portCountOf(stencilOf(n.name)), rows: rowsOf(stencilOf(n.name)),
        ports: nodePorts, layout: compact ? undefined : layoutOf(stencilOf(n.name)),
        aspect: aspectOf(stencilOf(n.name)), breakouts: compact ? undefined : breakoutsWithInferredChannels(n.breakouts, nodePorts), compact,
      } satisfies SwitchData,
      draggable: !compact,
    };
  });

  // single-homed chips fan out below their one leaf in an EP_COLS-wide grid; multihomed
  // (ESI) chips are clustered per leaf set and wrap inside that leaf span.
  const byLeaf = new Map(leaves.map((l) => [l.name, l]));
  const leafTopOf = (id: string) => (pos.get(id)?.y ?? LEAF_Y) + swH(id) + EP_TOP_GAP;
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
    rfNodes.push({ id: ep.id, type: 'endpoint', position: { x, y }, width: EP_W, height: EP_H, initialWidth: EP_W, initialHeight: EP_H, data: ep.data, draggable: !compact });
  }

  // band sits below the deepest single-homed fan so ESI cables clear the chips above
  const fanBottom = (lf: string) => leafTopOf(lf) + Math.ceil((fanCount.get(lf) ?? 0) / EP_COLS) * (EP_H + EP_VGAP);
  const bandY = (leaves.length ? Math.max(...leaves.map((l) => fanBottom(l.name))) : LEAF_Y) + 48;
  const centroid = (ep: Endpoint) => ep.leaves.reduce((s, n) => s + (leafCenter.get(n) ?? 0), 0) / ep.leaves.length;

  const leafExtent = (id: string) => {
    const lf = byLeaf.get(id);
    const p = pos.get(id);
    if (!lf || !p) return null;
    const w = swW(lf.name);
    return { left: p.x, right: p.x + w };
  };

  const multiByLeaves = new Map<string, Endpoint[]>();
  for (const ep of multi) {
    const key = ep.leaves.toSorted(naturalName).join('|') || ep.id;
    (multiByLeaves.get(key) ?? multiByLeaves.set(key, []).get(key)!).push(ep);
  }

  type MultiGroup = {
    endpoints: Endpoint[];
    startX: number;
    endX: number;
    cols: number;
    rows: number;
    lane: number;
  };

  const multiGroups: MultiGroup[] = [...multiByLeaves.values()].map((group) => {
    const endpointsInGroup = group.toSorted((a, b) => naturalName(a.data.label, b.data.label) || naturalName(a.id, b.id));
    const extents = endpointsInGroup[0].leaves.map(leafExtent).filter((x): x is NonNullable<typeof x> => x != null);
    const fallbackCenter = endpointsInGroup.reduce((sum, ep) => sum + centroid(ep), 0) / endpointsInGroup.length;
    const left = extents.length ? Math.min(...extents.map((e) => e.left)) : fallbackCenter - EP_W / 2;
    const right = extents.length ? Math.max(...extents.map((e) => e.right)) : fallbackCenter + EP_W / 2;
    const availableW = Math.max(EP_W, right - left);
    const cols = Math.max(1, Math.min(endpointsInGroup.length, Math.floor((availableW + EP_HGAP) / (EP_W + EP_HGAP))));
    const rows = Math.ceil(endpointsInGroup.length / cols);
    const gridW = cols * EP_W + (cols - 1) * EP_HGAP;
    const startX = left + (availableW - gridW) / 2;
    return { endpoints: endpointsInGroup, startX, endX: startX + gridW, cols, rows, lane: 0 };
  }).toSorted((a, b) => a.startX - b.startX || a.endX - b.endX);

  const lanes: { right: number; rows: number }[] = [];
  for (const group of multiGroups) {
    let lane = lanes.findIndex((l) => group.startX >= l.right + EP_HGAP);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push({ right: -Infinity, rows: 0 });
    }
    group.lane = lane;
    lanes[lane].right = Math.max(lanes[lane].right, group.endX);
    lanes[lane].rows = Math.max(lanes[lane].rows, group.rows);
  }

  const laneY: number[] = [];
  let nextLaneY = bandY;
  for (const lane of lanes) {
    laneY.push(nextLaneY);
    nextLaneY += lane.rows * (EP_H + EP_VGAP) + EP_VGAP;
  }

  for (const group of multiGroups) {
    for (const [i, ep] of group.endpoints.entries()) {
      const col = i % group.cols, row = Math.floor(i / group.cols);
      const x = group.startX + col * (EP_W + EP_HGAP);
      const y = laneY[group.lane] + row * (EP_H + EP_VGAP);
      rfNodes.push({ id: ep.id, type: 'endpoint', position: { x, y }, width: EP_W, height: EP_H, initialWidth: EP_W, initialHeight: EP_H, data: ep.data, draggable: !compact });
    }
  }

  return { nodes: rfNodes, edges: rfEdges, adjacency: { nodeEdges, edgeEnds, edgePorts, search, nodeLabels } };
}
