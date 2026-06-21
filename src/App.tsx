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
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import SensorsIcon from '@mui/icons-material/Sensors';
import { streamTopology, streamNamespaces, BASE, type Topology } from './api';
import { buildGraph, CABLE_COLOR, LLDP_COLOR } from './graph';
import { trace, setAdjacency } from './trace';
import { lldp as lldpStore, useLldp } from './lldp';
import SwitchNode from './SwitchNode';
import EndpointNode from './EndpointNode';
import CableEdge from './CableEdge';
import NodeView from './NodeView';
import NamespacePicker from './NamespacePicker';
import './app.css';

const nodeTypes: NodeTypes = { switch: SwitchNode, endpoint: EndpointNode };
const edgeTypes: EdgeTypes = { cable: CableEdge };

const pdf = (q = '') => window.open(`${BASE}pdf${q}`, '_blank');

const LEGEND: Array<[string, string]> = [
  ['Fabric (ISL)', CABLE_COLOR.isl], ['Edge', CABLE_COLOR.edge], ['Local LAG', CABLE_COLOR.lag], ['ESI / MH-LAG', CABLE_COLOR.mlag],
];
const LLDP_LEGEND: Array<[string, string]> = [
  ['LLDP confirmed', LLDP_COLOR.ok], ['Mismatch', LLDP_COLOR.mismatch], ['No neighbor', LLDP_COLOR.none],
];

type Mode = 'light' | 'dark';

export default function App({ mode, onToggleMode }: { mode: Mode; onToggleMode: () => void }) {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [namespace, setNamespace] = useState('');     // '' == All Namespaces
  const [namespaces, setNamespaces] = useState<string[]>([]);
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

  // the EDA namespaces to choose from — streamed so the picker updates live
  useEffect(() => streamNamespaces(setNamespaces), []);

  // live topology stream for the selected namespace — pushes the snapshot then live updates.
  // Reconnects when the namespace changes; clears first so stale data never lingers.
  useEffect(() => {
    setTopo(null);
    return streamTopology(namespace, (t) => { setTopo(t); setErr(''); }, setErr);
  }, [namespace]);

  const { nodes: builtNodes, edges, switchIds } = useMemo(() => {
    if (!topo) return { nodes: [] as RFNode[], edges: [], switchIds: new Set<string>() };
    const g = buildGraph(topo);
    setAdjacency(g.adjacency);
    return { nodes: g.nodes, edges: g.edges, switchIds: new Set(topo.nodes.map((n) => n.id)) };
  }, [topo]);

  // nodes live in React Flow state so dragging + selection apply. On a live update we keep
  // each existing node's current position (so a stream tick never snaps a dragged node back)
  // while taking the rebuilt data; new nodes adopt their computed layout position.
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  useEffect(() => {
    setNodes((prev) => {
      const pos = new Map(prev.map((n) => [n.id, n.position]));
      return builtNodes.map((n) => { const p = pos.get(n.id); return p ? { ...n, position: p } : n; });
    });
  }, [builtNodes, setNodes]);

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
  const lldpOn = useLldp();

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
          {namespaces.length > 0 && (
            <NamespacePicker value={namespace} options={namespaces} onChange={setNamespace} />
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
          {ready && (
            <Tooltip title={lldpOn ? 'Hide LLDP overlay' : 'Show LLDP overlay (neighbour match / mismatch)'}>
              <IconButton size="small" sx={{ color: lldpOn ? 'success.main' : 'text.primary' }} onClick={() => lldpStore.toggle()}>
                <SensorsIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <IconButton size="small" sx={{ color: 'text.primary' }} onClick={onToggleMode}>
              {mode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            colorMode={mode} elevateNodesOnSelect={false} nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            minZoom={0.15}
            onNodeClick={(_, n) => { if (switchIds.has(n.id)) setOpen(n.id); }}
            onEdgeClick={(_, e) => trace.pin(`cable:${e.id}`)}
            onEdgeMouseEnter={(_, e) => trace.hover(`cable:${e.id}`)}
            onEdgeMouseLeave={() => trace.hover(null)}
            onSelectionChange={onSel}
            onPaneClick={() => { setSelected([]); trace.clear(); setQuery(''); }}
            fitView fitViewOptions={{ padding: 0.12 }} panOnDrag selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls position="top-right" showInteractive={false} />
            <Panel position="bottom-left">
              <Box sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1.5, px: 1.5, py: 1, boxShadow: 2 }}>
                <Box sx={{ display: 'flex', gap: 2, mb: 0.75 }}>
                  {(lldpOn ? LLDP_LEGEND : LEGEND).map(([label, swatch]) => (
                    <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Box sx={{ width: 14, height: 6, borderRadius: 2, bgcolor: swatch }} />
                      <Typography variant="caption" sx={{ color: 'text.primary', fontWeight: 500 }}>{label}</Typography>
                    </Box>
                  ))}
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
                  {lldpOn
                    ? 'LLDP overlay — cables coloured by neighbour match vs the configured remote'
                    : 'Hover to trace · click a cable or port to pin · click a switch for its panel'}
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
