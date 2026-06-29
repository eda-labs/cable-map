import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNodesState, type Node as RFNode } from '@xyflow/react';
import { type Topology } from '../api';
import { buildGraph } from '../graph';
import { setAdjacency, type Adjacency } from '../trace';

// Builds the React Flow graph from a topology and owns the node state. The `setAdjacency` call
// inside the memo pushes adjacency into the trace store — every highlight depends on it. A live
// stream tick rebuilds node data but keeps each node's current position so a dragged node never
// snaps back; new nodes adopt their computed layout position.
export function useGraphModel(topo: Topology | null, largeTopology: boolean) {
  const [selected, setSelected] = useState<string[]>([]);

  const { nodes: builtNodes, edges, switchIds, adjacency } = useMemo(() => {
    const empty: Adjacency = { nodeEdges: new Map(), edgeEnds: new Map(), edgePorts: new Map(), search: new Map(), nodeLabels: new Map() };
    if (!topo) return { nodes: [] as RFNode[], edges: [], switchIds: new Set<string>(), adjacency: empty };
    const g = buildGraph(topo, { compact: false, tiered: largeTopology });
    setAdjacency(g.adjacency);
    return { nodes: g.nodes, edges: g.edges, switchIds: new Set(topo.nodes.map((n) => n.name)), adjacency: g.adjacency };
  }, [topo, largeTopology]);

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  useEffect(() => {
    setNodes((prev) => {
      const pos = new Map(prev.map((n) => [n.id, n.position]));
      return builtNodes.map((n) => { const p = pos.get(n.id); return p ? { ...n, position: p } : n; });
    });
  }, [builtNodes, setNodes]);

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: RFNode[] }) =>
    setSelected(sel.filter((n) => n.type === 'switch').map((n) => n.id)), []);
  const clearSelection = useCallback(() => setSelected([]), []);

  // Ctrl/Cmd+A selects all switches (ignored while typing in an input)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
      const el = document.activeElement;
      if (el && /^(input|textarea)$/i.test(el.tagName)) return;
      e.preventDefault();
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.type === 'switch' })));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setNodes]);

  return { nodes, onNodesChange, edges, switchIds, adjacency, selected, onSelectionChange, clearSelection };
}
