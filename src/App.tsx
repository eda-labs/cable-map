import { useEffect, useMemo, useState, useCallback } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, useNodesState, type Node as RFNode, type Edge as RFEdge, type NodeTypes, type EdgeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AppBar, Toolbar, Typography, Box, Drawer, IconButton, Tooltip, Badge,
  CircularProgress, Chip, Divider,
} from '@mui/material';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import CloseIcon from '@mui/icons-material/Close';
import { fetchTopology, BASE, type Topology, type Node } from './api';
import TopoNode from './TopoNode';
import PortEdge from './PortEdge';
import NodeView from './NodeView';
import './app.css';

const nodeTypes: NodeTypes = { topoNode: TopoNode };
const edgeTypes: EdgeTypes = { portEdge: PortEdge };
type Pos = Record<string, { x: number; y: number }>;

const shortPort = (iface: string) => iface.replace(/^ethernet-/, '');   // ethernet-1-1 -> 1-1

// role-tiered auto-layout: superspine/spine on top, leaves below; rows centered.
const TIER: Record<string, number> = { superspine: 0, spine: 1, borderleaf: 2, leaf: 3 };
function layout(nodes: Node[]): Pos {
  const tiers = new Map<number, Node[]>();
  for (const n of nodes) { const t = TIER[n.role] ?? 4; (tiers.get(t) ?? tiers.set(t, []).get(t)!).push(n); }
  const CX = 480, GAPX = 240, GAPY = 200;
  const pos: Pos = {};
  [...tiers.keys()].sort((a, b) => a - b).forEach((t, ti) => {
    const row = tiers.get(t)!;
    const startX = CX - ((row.length - 1) * GAPX) / 2;
    row.forEach((n, i) => { pos[n.id] = { x: startX + i * GAPX, y: 80 + ti * GAPY }; });
  });
  return pos;
}

// aggregate ISL links per node-pair; collect each node's local ports for end labels.
// Edges are floating (PortEdge derives geometry from node positions), so no handles.
function buildEdges(t: Topology): RFEdge[] {
  const pairs = new Map<string, { a: string; b: string; pa: Set<string>; pb: Set<string> }>();
  for (const l of t.links) {
    const [a, b] = [l.source, l.target].sort();
    const key = `${a}|${b}`;
    let e = pairs.get(key);
    if (!e) { e = { a, b, pa: new Set(), pb: new Set() }; pairs.set(key, e); }
    const [aPort, bPort] = l.source === a ? [l.sourcePort, l.targetPort] : [l.targetPort, l.sourcePort];
    e.pa.add(shortPort(aPort)); e.pb.add(shortPort(bPort));
  }
  const num = (s: string) => Number(s.split('-').pop());
  const fmt = (set: Set<string>) => {
    const a = [...set].sort((x, y) => num(x) - num(y));
    return a.length <= 4 ? a.join(', ') : `${a[0]}…${a[a.length - 1]} (${a.length})`;
  };
  return [...pairs.values()].map(({ a, b, pa, pb }) => ({
    id: `${a}|${b}`, source: a, target: b, type: 'portEdge',
    data: { sourcePorts: fmt(pa), targetPorts: fmt(pb) },
  }));
}

export default function App() {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [drawerH, setDrawerH] = useState(() => Math.round(window.innerHeight * 0.6));

  // drag the top edge of the drawer to resize its height
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) =>
      setDrawerH(Math.max(180, Math.min(window.innerHeight - 56, window.innerHeight - ev.clientY)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => { fetchTopology().then(setTopo).catch((e) => setErr(String(e.message || e))); }, []);

  // nodes live in React Flow state (via onNodesChange) so dragging, selection, and
  // deselect-on-pane-click all apply — same as topo-builder.
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  useEffect(() => {
    if (!topo) return;
    const pos = layout(topo.nodes);
    setNodes(topo.nodes.map((n) => ({
      id: n.id, type: 'topoNode', position: pos[n.id] ?? { x: 0, y: 0 }, data: { name: n.name, role: n.role },
    })));
  }, [topo, setNodes]);
  const rfEdges = useMemo(() => (topo ? buildEdges(topo) : []), [topo]);
  const onSel = useCallback(({ nodes: sel }: { nodes: RFNode[] }) => setSelected(sel.map((n) => n.id)), []);

  // Ctrl/Cmd+A selects all nodes (ignored while typing in an input)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
      const el = document.activeElement;
      if (el && /^(input|textarea)$/i.test(el.tagName)) return;
      e.preventDefault();
      setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setNodes]);
  const pdf = (q = '') => window.open(`${BASE}pdf${q}`, '_blank');

  const ready = !!topo && topo.nodes.length > 0;
  const openNode = topo?.nodes.find((n) => n.id === open);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" sx={{ gap: 1.5 }}>
          <img src={`${BASE}eda.svg`} alt="EDA" style={{ height: 26 }} />
          <Typography variant="h6" sx={{ fontWeight: 200, color: 'text.primary' }}>EDA Cable Map</Typography>
          <Box sx={{ flex: 1 }} />
          {ready && (
            <Tooltip title={selected.length ? `Download PDF (${selected.length} selected)` : 'Download PDF (all nodes)'}>
              <IconButton size="small" sx={{ color: 'text.primary' }}
                onClick={() => pdf(selected.length ? `?nodes=${selected.join(',')}` : '')}>
                <Badge badgeContent={selected.length} color="primary">
                  <PictureAsPdfIcon />
                </Badge>
              </IconButton>
            </Tooltip>
          )}
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <ReactFlow
            nodes={nodes} edges={rfEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            colorMode="dark" defaultEdgeOptions={{ type: 'portEdge' }} elevateNodesOnSelect={false}
            onNodeClick={(_, n) => setOpen(n.id)}
            onSelectionChange={onSel}
            onPaneClick={() => setSelected([])}
            fitView panOnDrag selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls position="top-right" />
          </ReactFlow>
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

      <Drawer anchor="bottom" open={!!openNode} onClose={() => setOpen(null)}
        slotProps={{ paper: { sx: { height: drawerH, borderTopLeftRadius: 12, borderTopRightRadius: 12,
          display: 'flex', flexDirection: 'column' } } }}>
        {openNode && (
          <>
            <Box onPointerDown={startResize} title="Drag to resize"
              sx={{ cursor: 'ns-resize', py: 0.75, display: 'flex', justifyContent: 'center',
                '&:hover .puller': { bgcolor: 'text.secondary' } }}>
              <Box className="puller" sx={{ width: 40, height: 4, bgcolor: 'divider', borderRadius: 2 }} />
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 3, py: 1.5 }}>
              <Typography variant="h6">{openNode.name}</Typography>
              <Chip size="small" label={openNode.platform} />
              <Box sx={{ flex: 1 }} />
              <Tooltip title="Download PDF">
                <IconButton size="small" sx={{ color: 'text.primary' }}
                  onClick={() => pdf(`?nodes=${openNode.id}`)}>
                  <PictureAsPdfIcon />
                </IconButton>
              </Tooltip>
              <IconButton onClick={() => setOpen(null)} size="small"><CloseIcon /></IconButton>
            </Box>
            <Divider />
            <Box sx={{ flex: 1, minHeight: 0, px: 3, py: 2, display: 'flex', flexDirection: 'column' }}>
              <NodeView node={openNode} rows={topo?.tables[openNode.id] || []}
                occupied={topo?.occupied[openNode.id] || []} showHeader={false} onOpenNode={setOpen} fillHeight />
            </Box>
          </>
        )}
      </Drawer>
    </Box>
  );
}
