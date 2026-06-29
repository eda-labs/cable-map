import { useEffect, useMemo, useState } from 'react';
import { type Node as RFNode, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import { trace, type Adjacency } from '../trace';
import { SEARCH_PORT_ZOOM, buildSearchMatcher, portSearchTarget, searchHighlight } from '../lib/search';
import { type FitNodesOptions } from '../lib/viewport';

type ViewportController = {
  fitNodes: (targetNodes: RFNode[], options: FitNodesOptions) => void;
  setLargeViewport: (v: Viewport) => void;
};

type SearchArgs = {
  displayNodes: RFNode[];
  adjacency: Adjacency;
  shown: Set<string> | null;
  ready: boolean;
  largeTopology: boolean;
  flow: ReactFlowInstance | null;
  viewport: ViewportController;
};

// Owns the search box. Derives the highlight set + the fit target from the query, pushes the
// highlight into the trace store, and centres/fits the viewport on the match (a port match zooms
// to SEARCH_PORT_ZOOM). Runs downstream of the flow model since it reads `displayNodes`.
export function useSearch({ displayNodes, adjacency, shown, ready, largeTopology, flow, viewport }: SearchArgs) {
  const { fitNodes, setLargeViewport } = viewport;
  const [query, setQuery] = useState('');
  const searchMatcher = useMemo(() => buildSearchMatcher(query), [query]);
  const displayNodeIds = useMemo(() => new Set(displayNodes.map((n) => n.id)), [displayNodes]);
  const searchTargetIds = useMemo(() => {
    if (!searchMatcher || searchMatcher.error) return [];

    const targets = new Set<string>();
    for (const [id, hay] of adjacency.search) {
      if (!searchMatcher.matches(hay)) continue;
      if (shown && !shown.has(id)) continue;
      if (displayNodeIds.has(id)) {
        targets.add(id);
        continue;
      }

      for (const edgeId of adjacency.nodeEdges.get(id) ?? []) {
        const ends = adjacency.edgeEnds.get(edgeId);
        if (!ends) continue;
        const other = ends[0] === id ? ends[1] : ends[0];
        if (displayNodeIds.has(other)) targets.add(other);
      }
    }
    return [...targets];
  }, [searchMatcher, adjacency, shown, displayNodeIds]);
  const searchTargetNodes = useMemo(
    () => displayNodes.filter((node) => searchTargetIds.includes(node.id)),
    [displayNodes, searchTargetIds],
  );
  const searchPortTarget = useMemo(() => portSearchTarget(searchMatcher, displayNodes), [searchMatcher, displayNodes]);
  const highlightedSearch = useMemo(
    () => searchHighlight(searchMatcher, displayNodes, adjacency, shown, searchPortTarget),
    [searchMatcher, displayNodes, adjacency, shown, searchPortTarget],
  );
  useEffect(() => {
    if (!ready || !searchMatcher || searchMatcher.error) {
      trace.clearSearch();
      return;
    }
    trace.highlight(highlightedSearch.nodes, highlightedSearch.edges, highlightedSearch.ports);
  }, [ready, searchMatcher, highlightedSearch]);
  useEffect(() => {
    if (!flow || !ready || !searchMatcher || searchMatcher.error) return;
    const handle = window.setTimeout(() => {
      if (searchPortTarget) {
        void flow.setCenter(searchPortTarget.x, searchPortTarget.y, {
          zoom: SEARCH_PORT_ZOOM,
          duration: 350,
        }).then((ok) => {
          if (ok && largeTopology) setLargeViewport(flow.getViewport());
        });
        return;
      }
      if (searchTargetNodes.length === 0) return;
      fitNodes(searchTargetNodes, {
        padding: searchTargetNodes.length === 1 ? 0.45 : 0.25,
        duration: 350,
        maxZoom: 1.4,
      });
    }, 160);
    return () => window.clearTimeout(handle);
  }, [flow, ready, searchMatcher, searchPortTarget, searchTargetNodes, fitNodes, setLargeViewport, largeTopology]);

  return { query, setQuery, searchError: searchMatcher?.error };
}
