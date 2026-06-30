import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNodesState, type Node as RFNode } from '@xyflow/react';
import type { Topology } from '../domain/topology/contract';
import { emptyAdjacency, type Adjacency } from '../graph/adjacency';
import { buildGraph } from '../graph';
import { setAdjacency } from '../trace';

function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

type SelectNodeOptions = {
  protect?: boolean;
};

const SELECTION_PROTECTION_MS = 2500;

// Builds the React Flow graph from a topology and owns the node state. The `setAdjacency` call
// inside the memo pushes adjacency into the trace store — every highlight depends on it. A live
// stream tick rebuilds node data but keeps each node's current position so a dragged node never
// snaps back; new nodes adopt their computed layout position.
export function useGraphModel(topo: Topology | null, largeTopology: boolean) {
  const [selected, setSelected] = useState<string[]>([]);
  const protectedSelectionRef = useRef<string | null>(null);
  const protectionTimerRef = useRef<number | null>(null);

  const { nodes: builtNodes, edges, switchIds, adjacency } = useMemo(() => {
    const empty: Adjacency = emptyAdjacency();
    if (!topo) return { nodes: [] as RFNode[], edges: [], switchIds: new Set<string>(), adjacency: empty };
    const g = buildGraph(topo, { compact: false, tiered: largeTopology });
    setAdjacency(g.adjacency);
    return { nodes: g.nodes, edges: g.edges, switchIds: new Set(topo.nodes.map((n) => n.name)), adjacency: g.adjacency };
  }, [topo, largeTopology]);

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return builtNodes.map((n) => {
        const previous = prevById.get(n.id);
        return previous ? { ...n, position: previous.position } : n;
      });
    });
  }, [builtNodes, setNodes]);

  const releaseProtectedSelection = useCallback(() => {
    protectedSelectionRef.current = null;
    if (protectionTimerRef.current != null) {
      window.clearTimeout(protectionTimerRef.current);
      protectionTimerRef.current = null;
    }
  }, []);

  const protectSelection = useCallback((id: string) => {
    if (protectionTimerRef.current != null) window.clearTimeout(protectionTimerRef.current);
    protectedSelectionRef.current = id;
    protectionTimerRef.current = window.setTimeout(() => {
      if (protectedSelectionRef.current === id) protectedSelectionRef.current = null;
      protectionTimerRef.current = null;
    }, SELECTION_PROTECTION_MS);
  }, []);

  useEffect(() => () => {
    if (protectionTimerRef.current != null) window.clearTimeout(protectionTimerRef.current);
  }, []);

  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: RFNode[] }) => {
    const next = sel.filter((n) => n.type === 'switch').map((n) => n.id);
    setSelected((prev) => {
      const protectedId = protectedSelectionRef.current;
      if (protectedId && prev.includes(protectedId)) {
        if (!next.includes(protectedId)) return prev;
        return sameSelection(prev, [protectedId]) ? prev : [protectedId];
      }
      return sameSelection(prev, next) ? prev : next;
    });
  }, []);
  const selectNode = useCallback((id: string | null, options?: SelectNodeOptions) => {
    const next = id && switchIds.has(id) ? id : null;
    if (next && options?.protect) protectSelection(next);
    else releaseProtectedSelection();
    setSelected(next ? [next] : []);
  }, [protectSelection, releaseProtectedSelection, switchIds]);
  const clearSelection = useCallback(() => {
    releaseProtectedSelection();
    setSelected((prev) => prev.length ? [] : prev);
  }, [releaseProtectedSelection]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedNodes = useMemo(
    () => nodes.map((n) => {
      if (n.type !== 'switch') return n.selected ? { ...n, selected: false } : n;
      const shouldSelect = n.type === 'switch' && selectedSet.has(n.id);
      const dataSelectionMatches = (n.data as { selected?: unknown }).selected === shouldSelect;
      const data = dataSelectionMatches ? n.data : { ...n.data, selected: shouldSelect };
      return n.selected === shouldSelect && dataSelectionMatches ? n : { ...n, selected: shouldSelect, data };
    }),
    [nodes, selectedSet],
  );

  // Ctrl/Cmd+A selects all switches (ignored while typing in an input)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
      const el = document.activeElement;
      if (el && /^(input|textarea)$/i.test(el.tagName)) return;
      e.preventDefault();
      releaseProtectedSelection();
      setSelected([...switchIds]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [releaseProtectedSelection, switchIds]);

  return { nodes: selectedNodes, onNodesChange, edges, switchIds, adjacency, selected, onSelectionChange, selectNode, clearSelection };
}
