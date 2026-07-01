import type { Node, Row, Topology } from './contract';
import { breakoutChannel, cageKey } from '../ports/interfaceNames';

export type TopoLink = Topology['links'][number];

// Lookups the rack view needs to resolve hover/click targets: which link lands on a
// port, which table rows sit behind a front-panel cage, and how a backend link id
// (the LinkCR name) maps onto the 2D graph's trace ids (isl|…, isllag|…, stub|…) so
// tracing stays in sync across both views.
export type LinkIndex = {
  linkById: Map<string, TopoLink>;
  linkByEnd: Map<string, TopoLink>;        // "node|interface" -> link
  rowByEnd: Map<string, Row>;              // "node|interface" -> that node's table row
  rowsByCage: Map<string, Row[]>;          // "node|cage" -> table rows landing on the cage
  traceIdByLinkId: Map<string, string>;    // link id -> preferred 2D trace id
  linkIdsByTraceId: Map<string, string[]>; // 2D trace id -> link ids it covers
};

export const endKey = (node: string, port: string) => `${node}|${port}`;

// Stub cables (switch port -> endpoint chip) are keyed per member port in the 2D graph.
export function stubTraceId(node: string, cage: string, channel: number | null): string {
  return `stub|${node}|${cage}${channel ? `_${channel}` : ''}`;
}

// Mirrors canonicalIslCableId in graph/endpointGrouping.ts, seen from a table row.
export function islTraceIdFromRow(node: string, row: Row): string {
  const ends = [`${node}:${row.remotePort}`, `${row.remoteNode}:${row.label}`].toSorted();
  return `isl|${ends[0]}|${ends[1]}`;
}

function islBundleTraceId(lag: string): string {
  return `isllag|${lag.replace(/^lag-/, '').replace(/-(local|remote)$/, '')}`;
}

export function buildLinkIndex(topo: Topology, slottedFor: (node: Node) => boolean): LinkIndex {
  const linkById = new Map<string, TopoLink>();
  const linkByEnd = new Map<string, TopoLink>();
  const rowByEnd = new Map<string, Row>();
  const rowsByCage = new Map<string, Row[]>();
  const traceIdByLinkId = new Map<string, string>();
  const linkIdsByTraceId = new Map<string, string[]>();
  const slotted = new Map<string, boolean>();

  for (const node of topo.nodes) {
    slotted.set(node.name, slottedFor(node));
    for (const row of node.table ?? []) {
      rowByEnd.set(endKey(node.name, row.label), row);
      const cage = cageKey(row.label, slotted.get(node.name)!);
      if (!cage) continue;
      const key = endKey(node.name, cage);
      const rows = rowsByCage.get(key) ?? [];
      rows.push(row);
      rowsByCage.set(key, rows);
    }
  }

  const addTraceId = (traceId: string, linkId: string) => {
    const ids = linkIdsByTraceId.get(traceId) ?? [];
    ids.push(linkId);
    linkIdsByTraceId.set(traceId, ids);
  };

  for (const link of topo.links) {
    linkById.set(link.id, link);
    linkByEnd.set(endKey(link.source, link.sourcePort), link);
    linkByEnd.set(endKey(link.target, link.targetPort), link);
    addTraceId(link.id, link.id);

    const ends = [
      { node: link.source, port: link.sourcePort },
      { node: link.target, port: link.targetPort },
    ];
    let preferred: string | undefined;
    for (const end of ends) {
      const row = rowByEnd.get(endKey(end.node, end.port));
      if (!row) continue;
      if (row.type === 'interSwitch') {
        const islLag = row.lag && topo.lags[row.lag]?.isl ? islBundleTraceId(row.lag) : null;
        const traceId = islLag ?? islTraceIdFromRow(end.node, row);
        addTraceId(traceId, link.id);
        preferred ??= traceId;
        break; // both ends resolve to the same canonical/bundle id
      }
      if (row.type === 'edge') {
        const cage = cageKey(row.label, slotted.get(end.node) ?? false);
        if (!cage) continue;
        const traceId = stubTraceId(end.node, cage, breakoutChannel(row.label));
        addTraceId(traceId, link.id);
        preferred ??= traceId;
      }
    }
    traceIdByLinkId.set(link.id, preferred ?? link.id);
  }

  return { linkById, linkByEnd, rowByEnd, rowsByCage, traceIdByLinkId, linkIdsByTraceId };
}
