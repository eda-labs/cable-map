import type { Node as RFNode } from '@xyflow/react';
import { aspectOf, layoutOf, portCountOf, rowsOf } from '../domain/ports/frontPanelMeta';
import type { Breakout, Topology } from '../domain/topology/contract';
import { labelOf } from '../domain/topology/labels';
import {
  EP_COLS, EP_H, EP_HGAP, EP_TOP_GAP, EP_VGAP, EP_W, LEAF_Y, SPINE_Y, tierOf,
} from './constants';
import {
  COMPACT_SWITCH_H, COMPACT_SWITCH_W, STRIP_PAD, panelDims, switchHOf, switchW,
} from './geometry';
import type { GraphEndpoint, PortInfo, SwitchData } from './types';

type LayoutGraphArgs = {
  topo: Topology;
  compact: boolean;
  tiered: boolean;
  endpoints: GraphEndpoint[];
  switchPorts: Map<string, PortInfo[]>;
  stencilOf: (name: string) => string;
};

function naturalName(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function podKey(n: Topology['nodes'][number]): string {
  return labelOf(n, 'eda.nokia.com/pod') ?? 'pod';
}

function nodeStateOf(n: Topology['nodes'][number]): string | undefined {
  const value = n.raw?.status?.['node-state'];
  return value == null ? undefined : String(value);
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

export function layoutGraph({ topo, compact, tiered, endpoints, switchPorts, stencilOf }: LayoutGraphArgs): RFNode[] {
  const leaves = topo.nodes.filter((n) => tierOf(n.role) >= 2);
  const cores = topo.nodes.filter((n) => tierOf(n.role) < 2);

  // sized by the node's resolved stencil (callers pass the node name, not its display platform)
  const swW = (name: string) => {
    const p = stencilOf(name);
    return compact
      ? COMPACT_SWITCH_W
      : layoutOf(p) ? panelDims(rowsOf(p), aspectOf(p)).w + STRIP_PAD * 2 : switchW(portCountOf(p), rowsOf(p));
  };
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
    // without making leaf->spine links disappear into the far centre of a 1000-node canvas.
    const GAP_X = 64, POD_GAP = 180, SPINE_GAP = 96, LEAF_COLS = 8;
    const SPINE_TIER_Y = 210, LEAF_TIER_Y = 440;
    const pods = new Map<string, { leaves: typeof topo.nodes; spines: typeof topo.nodes }>();

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
    // leaves laid out left->right, each given a slot wide enough for its endpoint fan
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
    const nodeState = nodeStateOf(n);
    return {
      id: n.name, type: 'switch', position: pos.get(n.name) ?? { x: 0, y: 0 },
      width: swW(n.name),
      height: swH(n.name),
      initialWidth: swW(n.name),
      initialHeight: swH(n.name),
      data: {
        name: n.name, role: n.role, platform: n.platform,
        nodeState,
        synced: nodeState?.trim().toLowerCase() === 'synced',
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
  const centroid = (ep: GraphEndpoint) => ep.leaves.reduce((s, n) => s + (leafCenter.get(n) ?? 0), 0) / ep.leaves.length;

  const leafExtent = (id: string) => {
    const lf = byLeaf.get(id);
    const p = pos.get(id);
    if (!lf || !p) return null;
    const w = swW(lf.name);
    return { left: p.x, right: p.x + w };
  };

  const multiByLeaves = new Map<string, GraphEndpoint[]>();
  for (const ep of multi) {
    const key = ep.leaves.toSorted(naturalName).join('|') || ep.id;
    (multiByLeaves.get(key) ?? multiByLeaves.set(key, []).get(key)!).push(ep);
  }

  type MultiGroup = {
    endpoints: GraphEndpoint[];
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

  return rfNodes;
}
