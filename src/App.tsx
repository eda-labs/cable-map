import { useEffect, useMemo, useState, useCallback } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, Panel, useNodesState, type Node as RFNode, type NodeTypes, type EdgeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AppBar, Toolbar, Typography, Box, Drawer, IconButton, Tooltip, Badge,
  CircularProgress, Chip, Divider, InputBase,
} from '@mui/material';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import { fetchTopology, BASE, type Topology } from './api';
import { buildGraph, CABLE_COLOR } from './graph';
import { trace, setAdjacency } from './trace';
import SwitchNode from './SwitchNode';
import EndpointNode from './EndpointNode';
import CableEdge from './CableEdge';
import NodeView from './NodeView';
import './app.css';

const nodeTypes: NodeTypes = { switch: SwitchNode, endpoint: EndpointNode };
const edgeTypes: EdgeTypes = { cable: CableEdge };

const pdf = (q = '') => window.open(`${BASE}pdf${q}`, '_blank');

const LEGEND: Array<[string, keyof typeof CABLE_COLOR]> = [
  ['Fabric (ISL)', 'isl'], ['Server edge', 'edge'], ['LAG bundle', 'lag'],
];

export default function App() {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
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

  const { nodes: builtNodes, edges, switchIds } = useMemo(() => {
    if (!topo) return { nodes: [] as RFNode[], edges: [], switchIds: new Set<string>() };
    const g = buildGraph(topo);
    setAdjacency(g.adjacency);
    return { nodes: g.nodes, edges: g.edges, switchIds: new Set(topo.nodes.map((n) => n.id)) };
  }, [topo]);

  // nodes live in React Flow state so dragging + selection apply
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  useEffect(() => { setNodes(builtNodes); }, [builtNodes, setNodes]);

  const onSel = useCallback(({ nodes: sel }: { nodes: RFNode[] }) =>
    setSelected(sel.filter((n) => n.type === 'switch').map((n) => n.id)), []);

  // search drives the trace store (debounced via input value)
  useEffect(() => { trace.search(query); }, [query]);

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
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'background.default', px: 1, borderRadius: 1, border: 1, borderColor: 'divider' }}>
              <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              <InputBase value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find node / server / port…"
                sx={{ fontSize: 13, color: 'text.primary', width: 200 }} />
              {query && (
                <IconButton size="small" sx={{ p: 0.25 }} onClick={() => setQuery('')}><CloseIcon sx={{ fontSize: 15 }} /></IconButton>
              )}
            </Box>
          )}
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
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            colorMode="dark" elevateNodesOnSelect={false} nodesConnectable={false}
            minZoom={0.15}
            onNodeClick={(_, n) => { if (switchIds.has(n.id)) setOpen(n.id); }}
            onSelectionChange={onSel}
            onPaneClick={() => { setSelected([]); trace.clear(); setQuery(''); }}
            fitView fitViewOptions={{ padding: 0.12 }} panOnDrag selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls position="top-right" showInteractive={false} />
            <Panel position="bottom-left">
              <Box sx={{ bgcolor: 'rgba(16,24,36,0.92)', border: 1, borderColor: 'divider', borderRadius: 1.5, px: 1.5, py: 1, backdropFilter: 'blur(4px)' }}>
                <Box sx={{ display: 'flex', gap: 2, mb: 0.75 }}>
                  {LEGEND.map(([label, kind]) => (
                    <Box key={kind} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Box sx={{ width: 16, height: 4, borderRadius: 2, bgcolor: CABLE_COLOR[kind] }} />
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{label}</Typography>
                    </Box>
                  ))}
                </Box>
                <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: 10 }}>
                  Hover to trace a cable · click a port to pin · click a switch for its panel
                </Typography>
              </Box>
            </Panel>
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
                occupied={topo?.occupied[openNode.id] || []} showHeader={false} onOpenNode={setOpen} fillHeight
                panelMaxHeight={Math.round(drawerH * 0.4)} />
            </Box>
          </>
        )}
      </Drawer>
    </Box>
  );
}
