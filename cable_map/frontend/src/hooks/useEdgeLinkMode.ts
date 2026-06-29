import { useCallback, useMemo, useState } from 'react';
import { type Edge as RFEdge } from '@xyflow/react';
import { useTrace, type Adjacency } from '../trace';
import {
  activeStubPorts, edgeVisibleForShown, expandActiveStubEdges, isStubEdge, nextEdgeLinkMode,
  type EdgeLinkMode,
} from '../lib/edgeLinks';

// Owns the edge-link (stub) display mode and the derived sets it drives: which stub edges, switch
// ports and endpoint nodes are active. In 'stub' mode a traced bundled stub expands to its siblings.
export function useEdgeLinkMode(
  edges: RFEdge[],
  adjacency: Adjacency,
  switchIds: Set<string>,
  shown: Set<string> | null,
) {
  const [edgeLinkMode, setEdgeLinkMode] = useState<EdgeLinkMode>('enabled');
  const cycleMode = useCallback(() => setEdgeLinkMode((current) => nextEdgeLinkMode(current)), []);

  const hasEdgeLinks = useMemo(() => edges.some((e) => isStubEdge(e.id)), [edges]);

  const activeStubEdgeIds = useTrace((s) => {
    if (!s.edges.size) return '';
    const out: string[] = [];
    for (const edgeId of s.edges) if (isStubEdge(edgeId)) out.push(edgeId);
    return out.toSorted().join('\n');
  });
  const directlyActiveStubEdges = useMemo(() => new Set(activeStubEdgeIds ? activeStubEdgeIds.split('\n') : []), [activeStubEdgeIds]);
  const activeStubEdges = useMemo(
    () => edgeLinkMode === 'stub' ? expandActiveStubEdges(edges, directlyActiveStubEdges) : directlyActiveStubEdges,
    [edgeLinkMode, edges, directlyActiveStubEdges],
  );
  const activeStubPortIds = useMemo(
    () => edgeLinkMode === 'stub' ? activeStubPorts(activeStubEdges, adjacency, switchIds) : [],
    [edgeLinkMode, activeStubEdges, adjacency, switchIds],
  );
  const activeStubEndpointIds = useMemo(() => {
    const out = new Set<string>();
    if (edgeLinkMode !== 'stub') return out;
    for (const edgeId of activeStubEdges) {
      if (!edgeVisibleForShown(edgeId, shown, adjacency)) continue;
      const ends = adjacency.edgeEnds.get(edgeId);
      if (!ends) continue;
      for (const id of ends) {
        if (!switchIds.has(id)) out.add(id);
      }
    }
    return out;
  }, [edgeLinkMode, activeStubEdges, shown, adjacency, switchIds]);

  return { edgeLinkMode, cycleMode, hasEdgeLinks, activeStubEdges, activeStubPortIds, activeStubEndpointIds };
}
