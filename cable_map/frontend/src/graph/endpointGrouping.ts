import type { Edge as RFEdge } from '@xyflow/react';
import { breakoutChannel, shortPortLabel } from '../domain/ports/interfaceNames';
import type { LagInfo, LldpStatus, Row } from '../domain/topology/contract';
import { worseLldp } from './constants';
import { compactSwitchHandle, portHandle } from './geometry';
import type { CableKind, EndpointData, GraphEndpoint, PortInfo } from './types';

type EndpointMember = {
  port: string;
  channel?: number;
  desc: string;
  remotePort: string;
  label: string;
  lldp: LldpStatus;
};

type EndpointAccum = {
  key: string;
  label: string;
  full: string;
  lagName?: string;
  portsByNode: Map<string, EndpointMember[]>;
};

type IslBundle = {
  id: string;
  child: string;
  parent: string;
  side: 'top' | 'bottom';
  lldp: LldpStatus;
  cables: Map<string, { childPort: string; parentPort: string; childLabel: string; parentLabel: string }>;
};

export type EndpointGroups = Map<string, EndpointAccum>;
export type IslBundles = Map<string, IslBundle>;

export type LinkAdjacency = (id: string, a: string, b: string, ports: string[]) => void;
export type LagLookup = (name?: string) => LagInfo | undefined;
export type PortsLookup = (node: string) => PortInfo[];
export type SwitchHandleLookup = (node: string, remote: string, target?: boolean) => string | null;

// Strip "leafN-" prefix and "-peer" suffix to a compact endpoint label.
export function shortEndpoint(leafId: string, remote: string): string {
  let s = remote.startsWith(`${leafId}-`) ? remote.slice(leafId.length + 1) : remote;
  s = s.replace(/-peer$/, '');
  return s;
}

export function addEndpointMember(groups: EndpointGroups, node: string, row: Row, port: string, remoteName: string) {
  const key = row.lag ?? `${node}|${row.label}`; // LAG members share one key; plain edges key per-port
  const accum = groups.get(key) ?? groups.set(key, {
    key,
    label: shortEndpoint(node, remoteName),
    full: row.lag ?? remoteName,
    lagName: row.lag,
    portsByNode: new Map(),
  }).get(key)!;
  (accum.portsByNode.get(node) ?? accum.portsByNode.set(node, []).get(node)!)
    .push({
      port,
      channel: breakoutChannel(row.label) ?? undefined,
      desc: row.desc,
      remotePort: row.remotePort,
      label: row.label,
      lldp: row.lldpStatus ?? 'none',
    });
}

export function addCompactEndpointPort({
  node,
  row,
  port,
  remoteName,
  lag,
  ports,
}: {
  node: string;
  row: Row;
  port: string;
  remoteName: string;
  lag?: LagInfo;
  ports: PortInfo[];
}) {
  const kind: CableKind = lag?.multihomed ? 'mlag' : row.lag ? 'lag' : 'edge';
  const channel = breakoutChannel(row.label) ?? undefined;
  const sid = `stub|${node}|${port}${channel ? `_${channel}` : ''}`;
  ports.push({
    port,
    channel,
    kind,
    side: 'bottom',
    remote: shortEndpoint(node, remoteName),
    remotePort: row.remotePort,
    desc: row.desc,
    cableId: sid,
    lldp: row.lldpStatus ?? 'none',
  });
}

export function canonicalIslCableId(node: string, row: Row): string {
  const ends = [`${node}:${row.remotePort}`, `${row.remoteNode}:${row.label}`].toSorted();
  return `isl|${ends[0]}|${ends[1]}`;
}

export function addIslBundleMember({
  bundles,
  node,
  row,
  side,
  localPort,
  remotePort,
}: {
  bundles: IslBundles;
  node: string;
  row: Row;
  side: 'top' | 'bottom';
  localPort: string;
  remotePort: string;
}): string {
  const cableId = canonicalIslCableId(node, row);
  const bid = `isllag|${row.lag!.replace(/^lag-/, '').replace(/-(local|remote)$/, '')}`;
  const [a, b] = [node, row.remoteNode].toSorted();
  const aPort = a === node ? localPort : remotePort;
  const bPort = a === node ? remotePort : localPort;
  const bundle = bundles.get(bid) ?? bundles.set(bid, {
    id: bid,
    child: a,
    parent: b,
    side,
    lldp: 'ok',
    cables: new Map(),
  }).get(bid)!;
  bundle.lldp = worseLldp(bundle.lldp, row.lldpStatus ?? 'none');
  bundle.cables.set(cableId, {
    childPort: aPort,
    parentPort: bPort,
    childLabel: shortPortLabel(a === node ? row.label : row.remotePort),
    parentLabel: shortPortLabel(a === node ? row.remotePort : row.label),
  });
  return bid;
}

export function realizeIslBundles({
  bundles,
  fast,
  switchHandle,
  rfEdges,
  link,
}: {
  bundles: IslBundles;
  fast: boolean;
  switchHandle: SwitchHandleLookup;
  rfEdges: RFEdge[];
  link: LinkAdjacency;
}) {
  for (const b of bundles.values()) {
    const cables = [...b.cables.values()].toSorted((x, y) => x.childPort.localeCompare(y.childPort, undefined, { numeric: true }));
    const rep = cables[0];
    rfEdges.push({
      id: b.id,
      source: b.child,
      target: b.parent,
      type: 'cable',
      sourceHandle: switchHandle(b.child, b.parent) ?? `p${rep.childPort}`,
      targetHandle: switchHandle(b.parent, b.child, true) ?? `p${rep.parentPort}t`,
      data: {
        kind: 'isl',
        a: cables.map((c) => c.childLabel).join(', '),
        b: cables.map((c) => c.parentLabel).join(', '),
        count: cables.length,
        lldp: b.lldp,
        fast,
      },
    });
    link(b.id, b.child, b.parent, cables.flatMap((c) => [`${b.child}:${c.childPort}`, `${b.parent}:${c.parentPort}`]));
  }
}

export function realizeEndpointGroups({
  groups,
  compact,
  lagOf,
  portsOf,
  rfEdges,
  search,
  link,
}: {
  groups: EndpointGroups;
  compact: boolean;
  lagOf: LagLookup;
  portsOf: PortsLookup;
  rfEdges: RFEdge[];
  search: Map<string, string>;
  link: LinkAdjacency;
}): GraphEndpoint[] {
  const endpoints: GraphEndpoint[] = [];

  for (const a of groups.values()) {
    const leaves = [...a.portsByNode.keys()];
    const total = [...a.portsByNode.values()].reduce((s, m) => s + m.length, 0);
    const lag = lagOf(a.lagName);
    const kind: EndpointData['kind'] = a.lagName ? (lag?.multihomed ? 'mlag' : 'lag') : 'edge';
    const epId = `ep|${a.key}`;
    const allMembers = [...a.portsByNode.values()].flat();
    const remotePort = allMembers[0].remotePort;
    const epLldp = allMembers.reduce<LldpStatus>((acc, m) => worseLldp(acc, m.lldp), 'ok');
    endpoints.push({
      id: epId,
      leaves,
      data: {
        label: a.label,
        full: a.full,
        remotePort,
        kind,
        members: total,
        leaves,
        lacp: lag?.lacp,
        mode: lag?.mode,
        lldp: epLldp,
      },
    });
    const labels = allMembers.map((x) => x.label);
    search.set(epId, [a.label, a.full, remotePort, ...labels].join(' ').toLowerCase());

    for (const [node, members] of a.portsByNode) {
      for (const m of members) {
        const sid = `stub|${node}|${m.port}${m.channel ? `_${m.channel}` : ''}`;
        portsOf(node).push({
          port: m.port,
          channel: m.channel,
          kind,
          side: 'bottom',
          remote: a.label,
          remotePort: m.remotePort,
          desc: m.desc,
          cableId: sid,
          lldp: m.lldp,
        });
        rfEdges.push({
          id: sid,
          source: node,
          target: epId,
          type: 'cable',
          sourceHandle: compact ? compactSwitchHandle('bottom') : portHandle(m.port, m.channel),
          targetHandle: 'in',
          data: { kind, a: shortPortLabel(m.label), b: m.remotePort || a.label, lldp: m.lldp, fast: compact },
        });
        link(sid, node, epId, [`${node}:${m.port}`]);
      }
    }
  }

  return endpoints;
}
