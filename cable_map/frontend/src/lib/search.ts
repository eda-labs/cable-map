import { type Node as RFNode } from '@xyflow/react';
import { findSwitchPort, switchPortCenter, type SwitchData } from '../graph';
import type { Adjacency } from '../graph/adjacency';

export const SEARCH_PORT_ZOOM = 3.2;

export type SearchMatcher = {
  raw: string;
  terms: string[];
  isRegex: boolean;
  error?: string;
  matches: (value: string) => boolean;
};

export type PortSearchTarget = { x: number; y: number; nodeId: string; port: string };
export type SearchHighlight = { nodes: string[]; edges: string[]; ports: string[] };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeNameToken(query: string, name: string): string {
  return query.replace(new RegExp(`(^|\\s)${escapeRegExp(name)}(?=\\s|$)`, 'i'), ' ');
}

export function buildSearchMatcher(query: string): SearchMatcher | null {
  const raw = query.trim();
  if (!raw) return null;

  const regexMatch = raw.match(/^\/(.+)\/([dgimsuvy]*)$/);
  if (regexMatch) {
    const flags = [...new Set(regexMatch[2].replace(/[gy]/g, '').split(''))].join('');
    const normalizedFlags = flags.includes('i') ? flags : `${flags}i`;
    try {
      const regex = new RegExp(regexMatch[1], normalizedFlags);
      return { raw, terms: [], isRegex: true, matches: (value) => regex.test(value) };
    } catch (e) {
      return {
        raw,
        terms: [],
        isRegex: true,
        error: String((e as Error).message || e),
        matches: () => false,
      };
    }
  }

  const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    raw,
    terms,
    isRegex: false,
    matches: (value) => {
      const hay = value.toLowerCase();
      return terms.every((term) => hay.includes(term));
    },
  };
}

function switchSearchText(node: RFNode, data: SwitchData): string {
  return [node.id, data.name, data.role, data.platform].join(' ').toLowerCase();
}

function removeOneTerm(terms: string[], index: number): string[] {
  return terms.filter((_, i) => i !== index);
}

export function portSearchTarget(matcher: SearchMatcher | null, nodes: RFNode[]): PortSearchTarget | null {
  if (!matcher || matcher.error || matcher.isRegex) return null;
  const normalized = matcher.raw.toLowerCase();
  const tokens = new Set(matcher.terms);
  const switches = nodes
    .filter((node) => node.type === 'switch')
    .map((node) => {
      const data = node.data as SwitchData;
      const names = [...new Set([node.id, data.name].filter(Boolean).map((name) => name.toLowerCase()))];
      return { node, data, names };
    });

  const exactCandidates = switches
    .filter(({ names }) => names.some((name) => tokens.has(name)))
    .toSorted((left, right) => Math.max(...right.names.map((name) => name.length)) - Math.max(...left.names.map((name) => name.length)));

  for (const { node, data, names } of exactCandidates) {
    let portText = normalized;
    for (const name of names) portText = removeNameToken(portText, name);
    const port = findSwitchPort(data, portText);
    if (!port) continue;
    const center = switchPortCenter(data, port);
    if (!center) continue;
    return { x: node.position.x + center.x, y: node.position.y + center.y, nodeId: node.id, port };
  }

  const numericTerms = matcher.terms
    .map((term, index) => ({ term, index }))
    .filter(({ term }) => /\d/.test(term))
    .toReversed();
  for (const { node, data } of switches) {
    const nodeText = switchSearchText(node, data);
    for (const { term, index } of numericTerms) {
      const nodeTerms = removeOneTerm(matcher.terms, index);
      if (!nodeTerms.length || !nodeTerms.every((nodeTerm) => nodeText.includes(nodeTerm))) continue;
      const port = findSwitchPort(data, term);
      if (!port) continue;
      const center = switchPortCenter(data, port);
      if (!center) continue;
      return { x: node.position.x + center.x, y: node.position.y + center.y, nodeId: node.id, port };
    }
  }
  return null;
}

function edgesForPort(adjacency: Adjacency, nodeId: string, port: string): string[] {
  const key = `${nodeId}:${port}`;
  const edges: string[] = [];
  for (const [edgeId, ports] of adjacency.edgePorts) {
    if (ports.includes(key)) edges.push(edgeId);
  }
  return edges;
}

export function searchHighlight(
  matcher: SearchMatcher | null,
  displayNodes: RFNode[],
  adjacency: Adjacency,
  shown: Set<string> | null,
  portTarget: PortSearchTarget | null,
): SearchHighlight {
  if (!matcher || matcher.error) return { nodes: [], edges: [], ports: [] };
  if (portTarget) {
    return {
      nodes: [portTarget.nodeId],
      edges: edgesForPort(adjacency, portTarget.nodeId, portTarget.port),
      ports: [`${portTarget.nodeId}:${portTarget.port}`],
    };
  }

  const displayNodeIds = new Set(displayNodes.map((node) => node.id));
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const [id, hay] of adjacency.search) {
    if (shown && !shown.has(id)) continue;
    if (!matcher.matches(hay)) continue;
    if (displayNodeIds.has(id)) nodes.add(id);
    for (const edgeId of adjacency.nodeEdges.get(id) ?? []) edges.add(edgeId);
  }
  return { nodes: [...nodes], edges: [...edges], ports: [] };
}
