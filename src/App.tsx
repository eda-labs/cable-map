import { useEffect, useMemo, useState, useCallback } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, ControlButton, Panel, useNodesState, type Node as RFNode, type NodeTypes, type EdgeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AppBar, Toolbar, Typography, Box, Drawer, IconButton, Tooltip, Badge,
  CircularProgress, Chip, Divider, TextField, Tabs, Tab,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/CloseOutlined';
import SearchIcon from '@mui/icons-material/SearchOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import SensorsIcon from '@mui/icons-material/SensorsOutlined';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOffOutlined';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernetOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SvgGlyph from './icons/SvgGlyph';
import pdfIcon from './icons/pdf.svg?raw';
import excelIcon from './icons/excel.svg?raw';
import { streamTopology, streamNamespaces, BASE, type Topology } from './api';
import { buildGraph, CABLE_COLOR, LLDP_COLOR } from './graph';
import { trace, setAdjacency, useTrace } from './trace';
import { lldp as lldpStore, useLldp } from './lldp';
import SwitchNode from './SwitchNode';
import EndpointNode from './EndpointNode';
import CableEdge from './CableEdge';
import NodeView from './NodeView';
import NodeDetails from './NodeDetails';
import NamespacePicker from './NamespacePicker';
import { exportXlsx } from './xlsx';
import { edgeRemote } from './edge-remote';
import './app.css';

const nodeTypes: NodeTypes = { switch: SwitchNode, endpoint: EndpointNode };
const edgeTypes: EdgeTypes = { cable: CableEdge };

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
  const [hideEdges, setHideEdges] = useState(false);
  const [drawerTab, setDrawerTab] = useState(0);      // 0 = Ports, 1 = Details
  useEffect(() => { setDrawerTab(0); }, [open]);      // reset to Ports when a new node opens
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

  const hasEdgeLinks = useMemo(() => edges.some((e) => e.id.startsWith('stub|')), [edges]);
  const displayNodes = useMemo(() => hideEdges ? nodes.filter((n) => n.type !== 'endpoint') : nodes, [hideEdges, nodes]);
  const traceKey = useTrace((s) => s.key);
  const elevatedEdge = traceKey?.startsWith('cable:') ? traceKey.slice(6) : null;
  const displayEdges = useMemo(() => {
    const base = hideEdges ? edges.filter((e) => !e.id.startsWith('stub|')) : edges;
    return elevatedEdge ? base.map((e) => (e.id === elevatedEdge ? { ...e, zIndex: 1 } : e)) : base;
  }, [hideEdges, edges, elevatedEdge]);

  const ready = !!topo && topo.nodes.length > 0;
  const openNode = topo?.nodes.find((n) => n.id === open);
  const lldpOn = useLldp();

  const openPdf = (ids: string[]) => {
    const targets = ids.length ? ids : (topo?.nodes.map((n) => n.id) ?? []);
    const params = new URLSearchParams();
    if (ids.length) params.set('nodes', ids.join(','));
    const sub = edgeRemote.subset(targets);
    if (Object.keys(sub).length) params.set('remote', JSON.stringify(sub));
    const qs = params.toString();
    window.open(`${BASE}pdf${qs ? `?${qs}` : ''}`, '_blank');
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" sx={{ gap: 1.5, position: 'relative' }}>
          <img src={`${BASE}eda.svg`} alt="EDA" style={{ height: 26 }} />
          <Typography variant="h6" sx={{ fontWeight: 200, color: 'text.primary' }}>EDA Cable Map</Typography>
          <Box sx={{ flex: 1 }} />
          {ready && (
            <Box sx={{ position: 'absolute', left: '50%', top: 0, bottom: 0, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center' }}>
              <TextField variant="standard" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Find node / server / port…" sx={{ width: 280 }}
                slotProps={{ input: {
                  sx: { fontSize: 13, color: 'text.primary' },
                  startAdornment: <SearchIcon sx={{ fontSize: 18, color: 'text.secondary', mr: 1 }} />,
                  endAdornment: query
                    ? <IconButton size="small" sx={{ p: 0.25 }} onClick={() => setQuery('')}><CloseIcon sx={{ fontSize: 15 }} /></IconButton>
                    : null,
                } }} />
            </Box>
          )}
          {namespaces.length > 0 && (
            <NamespacePicker value={namespace} options={namespaces} onChange={setNamespace} />
          )}
          {ready && (
            <Tooltip title={selected.length ? `Download PDF (${selected.length} selected)` : 'Download PDF (all nodes)'}>
              <IconButton size="small" sx={{ color: 'text.primary' }}
                onClick={() => openPdf(selected)}>
                <Badge badgeContent={selected.length} color="primary">
                  <SvgGlyph src={pdfIcon} />
                </Badge>
              </IconButton>
            </Tooltip>
          )}
          {ready && topo && (
            <Tooltip title={selected.length ? `Download XLSX (${selected.length} selected)` : 'Download XLSX (all nodes)'}>
              <IconButton size="small" sx={{ color: 'text.primary' }}
                onClick={() => { void exportXlsx(topo, selected.length ? selected : topo.nodes.map((n) => n.id)).catch(console.error); }}>
                <Badge badgeContent={selected.length} color="primary">
                  <SvgGlyph src={excelIcon} />
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
            nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
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
            <Controls position="top-right" showInteractive={false}>
              {hasEdgeLinks && (
                <ControlButton
                  onClick={() => setHideEdges((v) => !v)}
                  title={hideEdges ? 'Show edge links' : 'Hide edge links'}
                >
                  {hideEdges ? <VisibilityOffIcon /> : <VisibilityIcon />}
                </ControlButton>
              )}
            </Controls>
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
          // EDA form-panel surface (formBody) so the drawer + Monaco editor blend like EDA;
          // backgroundImage:none kills MUI's dark elevation overlay that lightens the paper
          bgcolor: mode === 'dark' ? '#1A222E' : '#FFFFFF', backgroundImage: 'none',
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
                  onClick={() => openPdf([openNode.id])}>
                  <SvgGlyph src={pdfIcon} />
                </IconButton>
              </Tooltip>
              {topo && (
                <Tooltip title="Download XLSX">
                  <IconButton size="small" sx={{ color: 'text.primary' }}
                    onClick={() => { void exportXlsx(topo, [openNode.id]).catch(console.error); }}>
                    <SvgGlyph src={excelIcon} />
                  </IconButton>
                </Tooltip>
              )}
              <IconButton onClick={() => setOpen(null)} size="small"><CloseIcon /></IconButton>
            </Box>
            <Divider />
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <Tabs orientation="vertical" value={drawerTab} onChange={(_, v) => setDrawerTab(v)}
                sx={{ borderRight: 1, borderColor: 'divider', minWidth: 44, flexShrink: 0,
                  '& .MuiTab-root': { minWidth: 44, minHeight: 44 },
                  '& .MuiSvgIcon-root': { fontSize: 18 } }}>
                <Tab icon={<SettingsEthernetIcon />} aria-label="Ports" />
                <Tab icon={<InfoOutlinedIcon />} aria-label="Details" />
              </Tabs>
              {drawerTab === 0 ? (
                <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, px: 3, py: 2, display: 'flex', flexDirection: 'column' }}>
                  <NodeView node={openNode} rows={topo?.tables[openNode.id] || []}
                    occupied={topo?.occupied[openNode.id] || []} showHeader={false} onOpenNode={setOpen} fillHeight
                    panelMaxHeight={Math.round(drawerH * 0.4)} />
                </Box>
              ) : (
                <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                  <NodeDetails node={openNode} dark={mode === 'dark'} />
                </Box>
              )}
            </Box>
          </>
        )}
      </Drawer>
    </Box>
  );
}
