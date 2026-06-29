import { type Edge as RFEdge } from '@xyflow/react';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOffOutlined';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernetOutlined';
import { type Adjacency } from '../trace';

export type EdgeLinkMode = 'enabled' | 'stub' | 'hidden';
export const EDGE_LINK_MODE_ORDER: EdgeLinkMode[] = ['enabled', 'stub', 'hidden'];

export function isStubEdge(id: string): boolean {
  return id.startsWith('stub|');
}

export function edgeVisibleForShown(edgeId: string, shown: Set<string> | null, adjacency: Adjacency): boolean {
  if (!shown) return true;
  const ends = adjacency.edgeEnds.get(edgeId);
  return !!ends && shown.has(ends[0]) && shown.has(ends[1]);
}

function isBundledStubEdge(edge: { id: string; data?: unknown }): boolean {
  if (!isStubEdge(edge.id)) return false;
  const kind = (edge.data as { kind?: string } | undefined)?.kind;
  return kind === 'lag' || kind === 'mlag';
}

export function expandActiveStubEdges(edges: RFEdge[], active: Set<string>): Set<string> {
  if (!active.size) return active;
  const byTarget = new Map<string, string[]>();
  for (const edge of edges) {
    if (!isStubEdge(edge.id)) continue;
    const target = String(edge.target);
    const ids = byTarget.get(target) ?? [];
    ids.push(edge.id);
    byTarget.set(target, ids);
  }

  const out = new Set(active);
  for (const edge of edges) {
    if (!active.has(edge.id) || !isBundledStubEdge(edge)) continue;
    for (const sibling of byTarget.get(String(edge.target)) ?? []) out.add(sibling);
  }
  return out;
}

export function activeStubPorts(edgeIds: Set<string>, adjacency: Adjacency, switchIds: Set<string>): string[] {
  const out = new Set<string>();
  for (const edgeId of edgeIds) {
    for (const port of adjacency.edgePorts.get(edgeId) ?? []) {
      const sep = port.indexOf(':');
      if (sep <= 0) continue;
      if (switchIds.has(port.slice(0, sep))) out.add(port);
    }
  }
  return [...out];
}

export function nextEdgeLinkMode(mode: EdgeLinkMode): EdgeLinkMode {
  const index = EDGE_LINK_MODE_ORDER.indexOf(mode);
  return EDGE_LINK_MODE_ORDER[(index + 1) % EDGE_LINK_MODE_ORDER.length];
}

export function edgeLinkModeTitle(mode: EdgeLinkMode): string {
  switch (mode) {
    case 'enabled':
      return 'Edge links enabled — click for stubs';
    case 'stub':
      return 'Edge link stubs — click to hide';
    case 'hidden':
      return 'Edge links hidden — click to show';
  }
}

export function edgeLinkModeIcon(mode: EdgeLinkMode) {
  switch (mode) {
    case 'enabled':
      return <VisibilityIcon />;
    case 'stub':
      return <SettingsEthernetIcon />;
    case 'hidden':
      return <VisibilityOffIcon />;
  }
}
