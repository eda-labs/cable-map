import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ReactFlowInstance } from '@xyflow/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { isLargeTopology } from './graph';
import { type Mode } from './theme';
import { useWindowSize } from './hooks/useWindowSize';
import { useTopologyStream } from './hooks/useTopologyStream';
import { usePdfExport } from './hooks/usePdfExport';
import { useViewportController } from './hooks/useViewportController';
import { useGraphModel } from './hooks/useGraphModel';
import { useLabelFilter } from './hooks/useLabelFilter';
import { useEdgeLinkMode } from './hooks/useEdgeLinkMode';
import { useFlowModel } from './hooks/useFlowModel';
import { useSearch } from './hooks/useSearch';
import AppToolbar from './components/AppToolbar';
import FlowCanvas from './components/FlowCanvas';
import RackView from './rackview/RackView';
import NodeDrawer from './components/NodeDrawer';
import PdfExportProgress from './components/PdfExportProgress';
import { type OpenNodeOptions } from './components/NodeActionsContext';
import { NODE_FOCUS_ZOOM } from './lib/viewport';
import { trace } from './trace';

// Composition root: wires the data/view-model hooks into the toolbar, canvas and drawer. The
// hooks form a fixed pipeline — graph → label filter → edge-link mode → flow model → search — so
// each one's outputs feed the next. See the hooks in src/hooks for the per-concern logic.
export default function App({ mode, onToggleMode }: { mode: Mode; onToggleMode: () => void }) {
  const { topo, err, namespace, setNamespace, namespaces } = useTopologyStream();
  const ready = !!topo && topo.nodes.length > 0;
  const largeTopology = useMemo(() => (topo ? isLargeTopology(topo) : false), [topo]);
  const windowSize = useWindowSize();
  const [viewMode, setViewMode] = useState<'topology' | 'racks'>('topology');

  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const flowHostRef = useRef<HTMLDivElement | null>(null);
  const viewportActionSeqRef = useRef(0);
  const getViewportActionSeq = useCallback(() => viewportActionSeqRef.current, []);
  const nextViewportActionSeq = useCallback(() => {
    viewportActionSeqRef.current += 1;
    return viewportActionSeqRef.current;
  }, []);
  const viewport = useViewportController(flow, largeTopology, flowHostRef, namespace);
  const { centerNode } = viewport;

  const graph = useGraphModel(topo, largeTopology);
  const { selectNode } = graph;
  const filter = useLabelFilter(graph.adjacency, graph.switchIds, namespace,
    { nodes: graph.nodes, ready, fitNodes: viewport.fitNodes, largeTopology });
  const links = useEdgeLinkMode(graph.edges, graph.adjacency, graph.switchIds, filter.shown);
  const flowModel = useFlowModel({
    nodes: graph.nodes, edges: graph.edges, shown: filter.shown, adjacency: graph.adjacency,
    edgeLinkMode: links.edgeLinkMode, activeStubEdges: links.activeStubEdges,
    activeStubPortIds: links.activeStubPortIds, activeStubEndpointIds: links.activeStubEndpointIds,
    largeTopology, largeViewport: viewport.largeViewport, windowSize, namespace,
  });
  const search = useSearch({
    displayNodes: flowModel.displayNodes, adjacency: graph.adjacency, shown: filter.shown,
    ready, largeTopology, flow, viewport, getViewportActionSeq,
  });

  const [open, setOpen] = useState<string | null>(null);
  const [drawerExpanded, setDrawerExpanded] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(0);
  const [drawerResetSizeSignal, setDrawerResetSizeSignal] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<{ name: string; pin: boolean; seq: number } | null>(null);
  const nodeByName = useMemo(() => new Map(topo?.nodes.map((n) => [n.name, n]) ?? []), [topo]);
  const graphNodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const renderedNodeIds = useMemo(() => new Set(flowModel.flowNodes.map((n) => n.id)), [flowModel.flowNodes]);
  const openNode = open ? nodeByName.get(open) : undefined;
  const { exportNodeIds, exportScope } = useMemo(() => {
    const allNodeIds = topo?.nodes.map((n) => n.name) ?? [];
    const shown = filter.shown;
    if (!shown) {
      return {
        exportNodeIds: graph.selected.length ? graph.selected : allNodeIds,
        exportScope: graph.selected.length ? 'selected' as const : 'all' as const,
      };
    }

    const filteredNodeIds = allNodeIds.filter((id) => shown.has(id));
    const filteredNodeSet = new Set(filteredNodeIds);
    const selectedFilteredNodeIds = graph.selected.filter((id) => filteredNodeSet.has(id));
    return selectedFilteredNodeIds.length
      ? { exportNodeIds: selectedFilteredNodeIds, exportScope: 'selected' as const }
      : { exportNodeIds: filteredNodeIds, exportScope: 'filtered' as const };
  }, [topo, filter.shown, graph.selected]);
  useEffect(() => {
    if (!pendingFocus || !renderedNodeIds.has(pendingFocus.name)) return;
    if (viewportActionSeqRef.current !== pendingFocus.seq) return;
    setPendingFocus((current) => current?.seq === pendingFocus.seq ? null : current);
    if (pendingFocus.pin) trace.pin(`node:${pendingFocus.name}`, true);
    selectNode(pendingFocus.name, { protect: true });
  }, [pendingFocus, renderedNodeIds, selectNode]);

  const selectDrawerNode = useCallback((name: string | null, options: OpenNodeOptions = {}) => {
    const { expand = false, pan = false, pin = false, select = false } = options;
    const actionSeq = nextViewportActionSeq();
    startTransition(() => {
      setOpen((current) => current === name ? current : name);
      if (expand) {
        setDrawerExpanded(!!name);
        setDrawerResetSizeSignal((v) => v + 1);
      }
      else if (!name) setDrawerExpanded(false);
    });
    if (!name) setPendingFocus(null);
    if (name && pan) {
      const target = graphNodeById.get(name);
      if (target) {
        void centerNode(target, {
          duration: 350,
          minZoom: NODE_FOCUS_ZOOM,
          bottomInset: drawerExpanded ? drawerHeight : 0,
        }).then((ok) => {
          if (ok && viewportActionSeqRef.current === actionSeq) {
            setPendingFocus({ name, pin, seq: actionSeq });
            return;
          }
          if (!ok && viewportActionSeqRef.current === actionSeq) {
            if (pin) trace.pin(`node:${name}`, true);
            if (select) selectNode(name);
          }
        });
        return;
      }
    }
    if (name && pin) trace.pin(`node:${name}`, true);
    if (select) selectNode(name);
  }, [centerNode, drawerExpanded, drawerHeight, graphNodeById, nextViewportActionSeq, selectNode]);
  const pdf = usePdfExport({ topo, namespace });
  const pdfLoading = pdf.pdfState.status === 'loading';
  useEffect(() => {
    if (viewMode === 'racks') setFlow(null);
  }, [viewMode]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Snackbar
        open={pdf.pdfState.status === 'error'}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={pdf.dismissError}>
          {pdf.pdfState.status === 'error' ? pdf.pdfState.message : ''}
        </Alert>
      </Snackbar>
      <PdfExportProgress state={pdf.pdfState} />

      <AppToolbar
        mode={mode} onToggleMode={onToggleMode}
        ready={ready} topo={topo}
        query={search.query} onQueryChange={search.setQuery} searchError={search.searchError}
        nodeLabelOptions={filter.nodeLabelOptions}
        selectedLabels={filter.selectedLabels} onSelectedLabelsChange={filter.setSelectedLabels}
        labelFilterText={filter.labelFilterText} onLabelFilterTextChange={filter.setLabelFilterText}
        namespaces={namespaces} namespace={namespace} onNamespaceChange={setNamespace}
        exportNodeIds={exportNodeIds} exportScope={exportScope}
        pdfLoading={pdfLoading} onExportPdf={pdf.openPdf}
        viewMode={viewMode} onViewModeChange={setViewMode}
      />

      <Box ref={flowHostRef} sx={{ flex: 1, minHeight: 0 }}>
        {ready && topo ? (
          viewMode === 'racks' ? (
            <RackView
              topo={topo} shown={filter.shown} selected={graph.selected}
              mode={mode} onOpenNode={selectDrawerNode} onClearSelection={graph.clearSelection}
            />
          ) : (
          <FlowCanvas
            mode={mode} largeTopology={largeTopology}
            flowNodes={flowModel.flowNodes} flowEdges={flowModel.flowEdges}
            displayNodes={flowModel.displayNodes} displayEdges={flowModel.displayEdges}
            switchIds={graph.switchIds}
            webglEdges={flowModel.webglEdges} useWebglNodeOverview={flowModel.useWebglNodeOverview}
            hasEdgeLinks={links.hasEdgeLinks} edgeLinkMode={links.edgeLinkMode}
            onCycleEdgeLinkMode={links.cycleMode}
            onNodesChange={graph.onNodesChange} onInit={setFlow}
            onSelectionChange={graph.onSelectionChange}
            onOpenNode={selectDrawerNode} onClearSelection={graph.clearSelection}
            onViewportChange={viewport.setLargeViewport}
            onViewportChangeEnd={viewport.settleLargeViewport}
            onWebglUnavailable={flowModel.markWebglEdgesUnavailable}
          />
          )
        ) : (
          <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5, color: 'text.secondary' }}>
            {!topo && !err ? (
              <><CircularProgress size={24} /><Typography variant="body2">Loading…</Typography></>
            ) : (
              <>
                <Typography variant="h6" sx={{ fontWeight: 300 }}>Didn't fetch anything from EDA</Typography>
                {err && <Typography variant="caption" sx={{ color: 'text.disabled' }}>{err}</Typography>}
              </>
            )}
          </Box>
        )}
      </Box>

      <NodeDrawer
        node={openNode} expanded={drawerExpanded} onExpandedChange={setDrawerExpanded}
        resetSizeSignal={drawerResetSizeSignal}
        onOpenNode={selectDrawerNode} mode={mode} topo={topo}
        pdfLoading={pdfLoading} onExportPdf={pdf.openPdf}
        onHeightChange={setDrawerHeight}
      />
    </Box>
  );
}
