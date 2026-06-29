import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Edge as RFEdge, type Node as RFNode, type Viewport } from '@xyflow/react';
import { useTrace, type Adjacency } from '../trace';
import { edgeVisibleForShown, isStubEdge, type EdgeLinkMode } from '../lib/edgeLinks';
import { LARGE_WEBGL_NODE_ZOOM, nodeIntersectsViewport } from '../lib/viewport';

// Stable refs so the no-elements paths don't allocate a fresh [] each render.
const NO_EDGES: RFEdge[] = [];
const NO_NODES: RFNode[] = [];
const WEBGL_OK = (() => {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch { return false; }
})();

type FlowModelArgs = {
  nodes: RFNode[];
  edges: RFEdge[];
  shown: Set<string> | null;
  adjacency: Adjacency;
  edgeLinkMode: EdgeLinkMode;
  activeStubEdges: Set<string>;
  activeStubPortIds: string[];
  activeStubEndpointIds: Set<string>;
  largeTopology: boolean;
  largeViewport: Viewport;
  windowSize: { width: number; height: number };
  namespace: string;
};

// Turns the raw graph + filter/edge-link state into what actually renders: `displayNodes`/
// `displayEdges` (full set for the WebGL layers) and the culled `flowNodes`/`flowEdges` handed to
// React Flow, plus the WebGL decision flags. Owns the per-namespace WebGL-unavailable fallback.
export function useFlowModel({
  nodes, edges, shown, adjacency, edgeLinkMode,
  activeStubEdges, activeStubPortIds, activeStubEndpointIds,
  largeTopology, largeViewport, windowSize, namespace,
}: FlowModelArgs) {
  const [webglEdgesUnavailable, setWebglEdgesUnavailable] = useState(false);
  const markWebglEdgesUnavailable = useCallback(() => setWebglEdgesUnavailable(true), []);
  useEffect(() => { setWebglEdgesUnavailable(false); }, [namespace]);

  const displayNodes = useMemo(() => {
    let ns = edgeLinkMode === 'enabled'
      ? nodes
      : nodes.filter((n) => n.type !== 'endpoint' || activeStubEndpointIds.has(n.id));
    if (shown) ns = ns.filter((n) => shown.has(n.id));
    if (edgeLinkMode !== 'stub') return ns;
    const out: RFNode[] = [];
    for (const node of ns) {
      out.push(node.type === 'switch'
        ? Object.assign({}, node, { data: Object.assign({}, node.data, { showEdgeStubs: true, activeEdgeStubPorts: activeStubPortIds }) })
        : node);
    }
    return out;
  }, [edgeLinkMode, nodes, shown, activeStubEndpointIds, activeStubPortIds]);

  const displayEdges = useMemo(() => {
    let base = edges;
    if (edgeLinkMode === 'stub') {
      base = edges
        .filter((e) => !isStubEdge(e.id) || activeStubEdges.has(e.id))
        .map((e) => activeStubEdges.has(e.id)
          ? Object.assign({}, e, { data: Object.assign({}, e.data, { forceOn: true }) })
          : e);
    } else if (edgeLinkMode === 'hidden') {
      base = edges.filter((e) => !isStubEdge(e.id));
    }
    if (shown) base = base.filter((e) => edgeVisibleForShown(e.id, shown, adjacency));
    return base;
  }, [edgeLinkMode, edges, activeStubEdges, shown, adjacency]);

  // GL draws the cables whenever WebGL is usable; otherwise React Flow's SVG edges take over.
  const webglEdges = WEBGL_OK && !webglEdgesUnavailable;
  const useWebglNodeOverview = webglEdges && largeTopology && largeViewport.zoom < LARGE_WEBGL_NODE_ZOOM;

  const flowNodes = useMemo(
    () => useWebglNodeOverview
      ? NO_NODES
      : largeTopology
        ? displayNodes.filter((node) => nodeIntersectsViewport(node, largeViewport, windowSize.width, windowSize.height))
        : displayNodes,
    [useWebglNodeOverview, largeTopology, displayNodes, largeViewport, windowSize],
  );
  const flowNodeIds = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes]);
  // the hovered cable rides above its neighbours — only meaningful for React Flow's SVG edges (the GL
  // layer orders traced cables on top itself). Applied here, not in displayEdges, so GL's `edges` prop
  // stays referentially stable across hovers and its geometry cache holds.
  const traceKey = useTrace((s) => s.key);
  const elevatedEdge = traceKey?.startsWith('cable:') ? traceKey.slice(6) : null;
  const flowEdges = useMemo(() => {
    if (webglEdges) return NO_EDGES; // GL draws the cables; React Flow draws none
    const base = largeTopology
      ? displayEdges.filter((edge) => flowNodeIds.has(String(edge.source)) && flowNodeIds.has(String(edge.target)))
      : displayEdges;
    return elevatedEdge ? base.map((e) => (e.id === elevatedEdge ? { ...e, zIndex: 1 } : e)) : base;
  }, [webglEdges, largeTopology, displayEdges, flowNodeIds, elevatedEdge]);

  return {
    displayNodes, displayEdges, flowNodes, flowEdges,
    webglEdges, useWebglNodeOverview, markWebglEdgesUnavailable,
  };
}
