import { useEffect, useMemo, useRef, useState } from 'react';
import { type Node as RFNode } from '@xyflow/react';
import { type Adjacency } from '../trace';
import { type FitNodesOptions } from '../lib/viewport';

type LabelFilterDeps = {
  nodes: RFNode[];
  ready: boolean;
  fitNodes: (targetNodes: RFNode[], options: FitNodesOptions) => void;
  largeTopology: boolean;
};

// Owns the label filter. `shown` is the set of node ids to display (null = no filter): nodes
// carrying any selected label, plus each matched node's directly-attached context (a switch
// pulls in its endpoint chips, an endpoint pulls in its switches). Auto-fits to the selection.
export function useLabelFilter(
  adjacency: Adjacency,
  switchIds: Set<string>,
  namespace: string,
  { nodes, ready, fitNodes, largeTopology }: LabelFilterDeps,
) {
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]); // [] = no filter

  const nodeLabelOptions = useMemo(
    () => {
      const labels = new Set<string>();
      for (const nodeLabels of adjacency.nodeLabels.values()) {
        for (const label of nodeLabels) labels.add(label);
      }
      return [...labels].toSorted((left, right) => left.localeCompare(right));
    },
    [adjacency],
  );

  useEffect(() => {
    setSelectedLabels([]);
  }, [namespace]);

  // drop any selected labels that no longer exist (e.g. after a namespace/topology change)
  useEffect(() => {
    setSelectedLabels((prev) => {
      const next = prev.filter((v) => nodeLabelOptions.includes(v));
      return next.length === prev.length ? prev : next;
    });
  }, [nodeLabelOptions]);

  const filterActive = selectedLabels.length > 0;
  const shown = useMemo<Set<string> | null>(() => {
    if (!filterActive) return null;
    const sel = new Set(selectedLabels);
    const out = new Set<string>();
    for (const [id, set] of adjacency.nodeLabels) {
      let match = false;
      for (const s of sel) if (set.has(s)) { match = true; break; }
      if (!match) continue;
      out.add(id);
    }
    // keep a matched node's directly-attached context across a switch↔endpoint edge only.
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot the seed matches before adding context nodes.
    for (const id of [...out]) {
      const idIsSwitch = switchIds.has(id);
      for (const ed of adjacency.nodeEdges.get(id) ?? []) {
        const ends = adjacency.edgeEnds.get(ed);
        if (!ends) continue;
        const other = ends[0] === id ? ends[1] : ends[0];
        if (idIsSwitch !== switchIds.has(other)) out.add(other);
      }
    }
    return out;
  }, [filterActive, selectedLabels, adjacency, switchIds]);

  // read the latest `shown`/`nodes` via refs so the auto-fit effect fires on the user's label
  // selection, not on every data refresh that recomputes them.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    if (!ready) return;
    const target = shownRef.current;
    const handle = window.setTimeout(() => {
      if (!target || target.size === 0) {
        fitNodes(nodesRef.current, { padding: 0.12, duration: 400, maxZoom: largeTopology ? 0.5 : undefined });
        return;
      }
      fitNodes(nodesRef.current.filter((node) => target.has(node.id)), { padding: 0.2, duration: 400, maxZoom: 1.4 });
    }, 60);
    return () => window.clearTimeout(handle);
  }, [selectedLabels, ready, fitNodes, largeTopology]);

  return { nodeLabelOptions, selectedLabels, setSelectedLabels, shown };
}
