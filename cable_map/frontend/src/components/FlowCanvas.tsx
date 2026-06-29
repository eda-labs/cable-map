import { memo, useMemo } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, ControlButton,
  type Edge as RFEdge, type Node as RFNode, type NodeTypes, type EdgeTypes,
  type ReactFlowInstance, type Viewport, type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PolylineIcon from '@mui/icons-material/PolylineOutlined';
import SwitchNode from '../SwitchNode';
import EndpointNode from '../EndpointNode';
import CableEdge from '../edges/CableEdge';
import TraceHud from '../TraceHud';
import GLEdges from '../edges/GLEdges';
import WebGLNodeLayer from '../WebGLNodeLayer';
import CanvasLegend from './CanvasLegend';
import { trace } from '../trace';
import { edgeRoute, useGroupedEdges } from '../edges/edgeRoute';
import { useLldp } from '../lldp';
import { edgeLinkModeIcon, edgeLinkModeTitle, type EdgeLinkMode } from '../lib/edgeLinks';
import { LARGE_DEFAULT_VIEWPORT, LARGE_MAX_ZOOM, LARGE_MIN_ZOOM } from '../lib/viewport';
import { type Mode } from '../theme';

const nodeTypes: NodeTypes = { switch: SwitchNode, endpoint: EndpointNode };
const edgeTypes: EdgeTypes = { cable: CableEdge };

interface FlowCanvasProps {
  mode: Mode;
  largeTopology: boolean;
  flowNodes: RFNode[];
  flowEdges: RFEdge[];
  displayNodes: RFNode[];
  displayEdges: RFEdge[];
  switchIds: Set<string>;
  webglEdges: boolean;
  useWebglNodeOverview: boolean;
  hasEdgeLinks: boolean;
  edgeLinkMode: EdgeLinkMode;
  onCycleEdgeLinkMode: () => void;
  onNodesChange: OnNodesChange<RFNode>;
  onInit: (flow: ReactFlowInstance) => void;
  onSelectionChange: (sel: { nodes: RFNode[] }) => void;
  onOpenNode: (id: string | null, expand?: boolean) => void;
  onClearSelection: () => void;
  onViewportChange: (v: Viewport) => void;
  onWebglUnavailable: () => void;
}

// Memoized: a search keystroke or other unrelated App state change won't re-render the canvas +
// WebGL layers, since every prop here is a stable callback or memoized value. Internal store reads
// (grouped/lldp) still re-render it when those toggle.
function FlowCanvas({
  mode, largeTopology, flowNodes, flowEdges, displayNodes, displayEdges, switchIds,
  webglEdges, useWebglNodeOverview,
  hasEdgeLinks, edgeLinkMode, onCycleEdgeLinkMode,
  onNodesChange, onInit, onSelectionChange, onOpenNode, onClearSelection,
  onViewportChange, onWebglUnavailable,
}: FlowCanvasProps) {
  const grouped = useGroupedEdges();
  const lldpOn = useLldp();
  const interactiveFlowNodes = useMemo(() => flowNodes.map((n) => (
    n.type === 'switch'
      ? { ...n, data: { ...n.data, onSelectNode: onOpenNode } }
      : n
  )), [flowNodes, onOpenNode]);

  return (
    <ReactFlow
      nodes={interactiveFlowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onInit={onInit}
      colorMode={mode} elevateNodesOnSelect={false} nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onlyRenderVisibleElements={largeTopology}
      minZoom={largeTopology ? LARGE_MIN_ZOOM : 0.15}
      maxZoom={largeTopology ? LARGE_MAX_ZOOM : 4}
      onNodeClick={(event, n) => {
        if (!switchIds.has(n.id)) return;
        if (event.detail > 1) return;
        const k = `node:${n.id}`;
        // single click only toggles the node's trace highlight; opening the drawer is reserved
        // for double-click so lightweight map inspection stays cheap.
        trace.pin(k);
        onOpenNode(n.id);
      }}
      onNodeDoubleClick={(_, n) => {
        if (!switchIds.has(n.id)) return;
        const k = `node:${n.id}`;
        if (trace.getPinned() !== k) trace.pin(k);
        onOpenNode(n.id, true);
      }}
      onEdgeClick={(_, e) => trace.pin(`cable:${e.id}`)}
      onEdgeMouseEnter={(_, e) => trace.hover(`cable:${e.id}`)}
      onEdgeMouseLeave={() => trace.hover(null)}
      onSelectionChange={onSelectionChange}
      onPaneClick={() => { onClearSelection(); trace.clear(); onOpenNode(null); }}
      onMove={largeTopology ? (_, nextViewport) => onViewportChange(nextViewport) : undefined}
      fitView={!largeTopology}
      defaultViewport={largeTopology ? LARGE_DEFAULT_VIEWPORT : undefined}
      fitViewOptions={{ padding: largeTopology ? 0.05 : 0.12, maxZoom: largeTopology ? 0.5 : 1.5 }} panOnDrag selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <TraceHud />
      {webglEdges && (
        <GLEdges nodes={displayNodes} edges={displayEdges} dark={mode === 'dark'} onUnavailable={onWebglUnavailable} />
      )}
      {largeTopology && (
        <WebGLNodeLayer nodes={displayNodes} lldp={lldpOn} mode={mode} visible={useWebglNodeOverview} onUnavailable={onWebglUnavailable} />
      )}
      <Controls position="top-right" showInteractive={false}>
        <ControlButton
          onClick={() => edgeRoute.toggle()}
          title={grouped ? 'Use curved links' : 'Use elbow link style'}
          aria-label="Toggle cable routing"
          style={{
            color: !grouped ? 'var(--eda-blue-400)' : undefined,
            background: !grouped ? 'color-mix(in srgb, var(--eda-blue-400) 12%, transparent)' : undefined,
          }}
        >
          <PolylineIcon htmlColor={!grouped ? 'var(--eda-blue-400)' : undefined} />
        </ControlButton>
        {hasEdgeLinks && (
          <ControlButton
            onClick={onCycleEdgeLinkMode}
            title={edgeLinkModeTitle(edgeLinkMode)}
            aria-label={edgeLinkModeTitle(edgeLinkMode)}
          >
            {edgeLinkModeIcon(edgeLinkMode)}
          </ControlButton>
        )}
      </Controls>
      <CanvasLegend />
    </ReactFlow>
  );
}

export default memo(FlowCanvas);
