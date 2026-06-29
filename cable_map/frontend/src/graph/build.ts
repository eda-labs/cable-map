// Builds the React Flow graph (positioned nodes + edges) and the trace adjacency straight from the
// topology tables — which carry the full per-port truth, including the edge/server interfaces.
import type { Edge as RFEdge } from '@xyflow/react';
import { cageKey, shortPortLabel } from '../domain/ports/interfaceNames';
import type { LagInfo, Topology } from '../domain/topology/contract';
import { nodeLabelPairs } from '../domain/topology/labels';
import { stencilFor, componentsOf } from '../stencil';
import { slottedOf } from '../domain/ports/frontPanelMeta';
import { emptyAdjacency, linkAdjacency } from './adjacency';
import { LARGE_TOPOLOGY_NODE_THRESHOLD, LARGE_TOPOLOGY_ROW_THRESHOLD, tierOf } from './constants';
import {
  addCompactEndpointPort, addEndpointMember, addIslBundleMember, canonicalIslCableId,
  realizeEndpointGroups, realizeIslBundles, type EndpointGroups, type IslBundles,
} from './endpointGrouping';
import {
  compactSwitchHandle,
} from './geometry';
import { layoutGraph } from './layout';
import {
  type BuildGraphOptions, type BuiltGraph, type PortInfo,
} from './types';

export function isLargeTopology(topo: Topology): boolean {
  const rows = topo.nodes.reduce((sum, node) => sum + (node.table?.length ?? 0), 0);
  return topo.nodes.length >= LARGE_TOPOLOGY_NODE_THRESHOLD || rows >= LARGE_TOPOLOGY_ROW_THRESHOLD;
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

  const adjacency = emptyAdjacency();
  const { search, nodeLabels } = adjacency;
  const link = (id: string, a: string, b: string, ports: string[]) => {
    linkAdjacency(adjacency, id, a, b, ports);
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
  const islBundles: IslBundles = new Map();

  // Edge endpoints are grouped globally only when the backend marked them with a LAG resource.
  // Plain edge links stay per physical port, even when multiple links share the same peer label.
  const endpointGroups: EndpointGroups = new Map();

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
        const cableId = canonicalIslCableId(sw.name, r);

        if (lagOf(r.lag)?.isl) {
          const bid = addIslBundleMember({ bundles: islBundles, node: sw.name, row: r, side, localPort: p, remotePort: rp });
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
          addCompactEndpointPort({ node: sw.name, row: r, port: p, remoteName: name, lag: lagOf(r.lag), ports: portsOf(sw.name) });
          hay(sw.name).push(r.label);
          continue;
        }

        addEndpointMember(endpointGroups, sw.name, r, p, name);
        hay(sw.name).push(r.label);
      }
    }
  }

  // realise endpoint chips + a stub cable per member port, all converging on the one chip
  const endpoints = realizeEndpointGroups({ groups: endpointGroups, compact, lagOf, portsOf, rfEdges, search, link });

  // emit one drawn cable per ISL bundle, labelled with its member count
  realizeIslBundles({ bundles: islBundles, fast: compact, switchHandle, rfEdges, link });

  // per-node label set ("key=value") for the label filter; also fold labels into the free-text haystack
  for (const n of topo.nodes) {
    const pairs = nodeLabelPairs(n);
    nodeLabels.set(n.name, new Set(pairs));
    search.set(n.name, [...(haystacks.get(n.name) ?? [n.name, n.platform, n.role]), ...pairs].join(' ').toLowerCase());
  }

  const rfNodes = layoutGraph({ topo, compact, tiered, endpoints, switchPorts, stencilOf });
  return { nodes: rfNodes, edges: rfEdges, adjacency };
}
