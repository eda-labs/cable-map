import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, ControlButton, Panel, useNodesState, getViewportForBounds, type Edge as RFEdge, type Node as RFNode, type NodeTypes, type EdgeTypes, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AppBar, Toolbar, Typography, Box, Drawer, IconButton, Tooltip, Badge,
  CircularProgress, Chip, Divider, TextField, Tabs, Tab, Grow,
  FormControl, InputAdornment, Select, MenuItem, Checkbox, ListItemText,
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
import { buildGraph, CABLE_COLOR, LLDP_COLOR, findSwitchPort, isLargeTopology, switchPortCenter, type SwitchData } from './graph';
import { trace, setAdjacency, useTrace, type Adjacency } from './trace';
import { lldp as lldpStore, useLldp } from './lldp';
import { edgeRoute, useGroupedEdges } from './edgeRoute';
import GLEdges from './GLEdges';
import PolylineIcon from '@mui/icons-material/PolylineOutlined';
import SwitchNode from './SwitchNode';
import EndpointNode from './EndpointNode';
import CableEdge from './CableEdge';
import NodeView from './NodeView';
import NodeDetails from './NodeDetails';
import NamespacePicker from './NamespacePicker';
import WebGLEdgeLayer from './WebGLEdgeLayer';
import WebGLNodeLayer from './WebGLNodeLayer';
import { exportXlsx } from './xlsx';
import { edgeRemote } from './edge-remote';
import './app.css';

const nodeTypes: NodeTypes = { switch: SwitchNode, endpoint: EndpointNode };
// cables render on the WebGL layer (GLEdges); React Flow gets an empty edge list. Stable ref so the
// no-edges path doesn't allocate a new [] each render. Falls back to SVG edges if WebGL is unavailable.
const NO_EDGES: RFEdge[] = [];
const WEBGL_OK = (() => {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch { return false; }
})();
const NO_NODES: RFNode[] = [];
const edgeTypes: EdgeTypes = { cable: CableEdge };

const LEGEND: Array<[string, string]> = [
  ['Fabric (ISL)', CABLE_COLOR.isl], ['Edge', CABLE_COLOR.edge], ['Local LAG', CABLE_COLOR.lag], ['ESI / MH-LAG', CABLE_COLOR.mlag],
];
const LLDP_LEGEND: Array<[string, string]> = [
  ['LLDP confirmed', LLDP_COLOR.ok], ['Mismatch', LLDP_COLOR.mismatch], ['No neighbor', LLDP_COLOR.none],
];

type Mode = 'light' | 'dark';
type EdgeLinkMode = 'enabled' | 'stub' | 'hidden';
const SEARCH_PORT_ZOOM = 3.2;
const EDGE_LINK_MODE_ORDER: EdgeLinkMode[] = ['enabled', 'stub', 'hidden'];
const LARGE_DEFAULT_VIEWPORT: Viewport = { x: 24, y: 24, zoom: 0.35 };
const LARGE_MIN_ZOOM = 0.02;
const LARGE_MAX_ZOOM = 2;
const LARGE_VIEWPORT_PAD = 900;
const LARGE_WEBGL_NODE_ZOOM = 0.2;

type SearchMatcher = {
  raw: string;
  terms: string[];
  isRegex: boolean;
  error?: string;
  matches: (value: string) => boolean;
};

type PortSearchTarget = { x: number; y: number; nodeId: string; port: string };
type SearchHighlight = { nodes: string[]; edges: string[]; ports: string[] };
type FlowBounds = { x: number; y: number; width: number; height: number };
type FitNodesOptions = { padding: number; duration: number; maxZoom?: number };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeNameToken(query: string, name: string): string {
  return query.replace(new RegExp(`(^|\\s)${escapeRegExp(name)}(?=\\s|$)`, 'i'), ' ');
}

function buildSearchMatcher(query: string): SearchMatcher | null {
  const raw = query.trim();
  if (!raw) return null;

  const regexMatch = raw.match(/^\/(.+)\/([dgimsuvy]*)$/);
  if (regexMatch) {
    const flags = [...new Set(regexMatch[2].replace(/[gy]/g, '').split(''))].join('');
    const normalizedFlags = flags.includes('i') ? flags : `${flags}i`;
    try {
      const regex = new RegExp(regexMatch[1], normalizedFlags);
      return { raw, terms: [], isRegex: true, matches: (value) => regex.test(value) };
    } catch (e) {
      return {
        raw,
        terms: [],
        isRegex: true,
        error: String((e as Error).message || e),
        matches: () => false,
      };
    }
  }

  const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    raw,
    terms,
    isRegex: false,
    matches: (value) => {
      const hay = value.toLowerCase();
      return terms.every((term) => hay.includes(term));
    },
  };
}

function switchSearchText(node: RFNode, data: SwitchData): string {
  return [node.id, data.name, data.role, data.platform].join(' ').toLowerCase();
}

function removeOneTerm(terms: string[], index: number): string[] {
  return terms.filter((_, i) => i !== index);
}

function portSearchTarget(matcher: SearchMatcher | null, nodes: RFNode[]): PortSearchTarget | null {
  if (!matcher || matcher.error || matcher.isRegex) return null;
  const normalized = matcher.raw.toLowerCase();
  const tokens = new Set(matcher.terms);
  const switches = nodes
    .filter((node) => node.type === 'switch')
    .map((node) => {
      const data = node.data as SwitchData;
      const names = [...new Set([node.id, data.name].filter(Boolean).map((name) => name.toLowerCase()))];
      return { node, data, names };
    });

  const exactCandidates = switches
    .filter(({ names }) => names.some((name) => tokens.has(name)))
    .toSorted((left, right) => Math.max(...right.names.map((name) => name.length)) - Math.max(...left.names.map((name) => name.length)));

  for (const { node, data, names } of exactCandidates) {
    let portText = normalized;
    for (const name of names) portText = removeNameToken(portText, name);
    const port = findSwitchPort(data, portText);
    if (!port) continue;
    const center = switchPortCenter(data, port);
    if (!center) continue;
    return { x: node.position.x + center.x, y: node.position.y + center.y, nodeId: node.id, port };
  }

  const numericTerms = matcher.terms
    .map((term, index) => ({ term, index }))
    .filter(({ term }) => /\d/.test(term))
    .toReversed();
  for (const { node, data } of switches) {
    const nodeText = switchSearchText(node, data);
    for (const { term, index } of numericTerms) {
      const nodeTerms = removeOneTerm(matcher.terms, index);
      if (!nodeTerms.length || !nodeTerms.every((nodeTerm) => nodeText.includes(nodeTerm))) continue;
      const port = findSwitchPort(data, term);
      if (!port) continue;
      const center = switchPortCenter(data, port);
      if (!center) continue;
      return { x: node.position.x + center.x, y: node.position.y + center.y, nodeId: node.id, port };
    }
  }
  return null;
}

function edgesForPort(adjacency: Adjacency, nodeId: string, port: string): string[] {
  const key = `${nodeId}:${port}`;
  const edges: string[] = [];
  for (const [edgeId, ports] of adjacency.edgePorts) {
    if (ports.includes(key)) edges.push(edgeId);
  }
  return edges;
}

function searchHighlight(
  matcher: SearchMatcher | null,
  displayNodes: RFNode[],
  adjacency: Adjacency,
  shown: Set<string> | null,
  portTarget: PortSearchTarget | null,
): SearchHighlight {
  if (!matcher || matcher.error) return { nodes: [], edges: [], ports: [] };
  if (portTarget) {
    return {
      nodes: [portTarget.nodeId],
      edges: edgesForPort(adjacency, portTarget.nodeId, portTarget.port),
      ports: [`${portTarget.nodeId}:${portTarget.port}`],
    };
  }

  const displayNodeIds = new Set(displayNodes.map((node) => node.id));
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const [id, hay] of adjacency.search) {
    if (shown && !shown.has(id)) continue;
    if (!matcher.matches(hay)) continue;
    if (displayNodeIds.has(id)) nodes.add(id);
    for (const edgeId of adjacency.nodeEdges.get(id) ?? []) edges.add(edgeId);
  }
  return { nodes: [...nodes], edges: [...edges], ports: [] };
}

function isStubEdge(id: string): boolean {
  return id.startsWith('stub|');
}

function edgeVisibleForShown(edgeId: string, shown: Set<string> | null, adjacency: Adjacency): boolean {
  if (!shown) return true;
  const ends = adjacency.edgeEnds.get(edgeId);
  return !!ends && shown.has(ends[0]) && shown.has(ends[1]);
}

function isBundledStubEdge(edge: { id: string; data?: unknown }): boolean {
  if (!isStubEdge(edge.id)) return false;
  const kind = (edge.data as { kind?: string } | undefined)?.kind;
  return kind === 'lag' || kind === 'mlag';
}

function expandActiveStubEdges(edges: RFEdge[], active: Set<string>): Set<string> {
  if (!active.size) return active;
  const byTarget = new Map<string, string[]>();
  for (const edge of edges) {
    if (!isStubEdge(edge.id)) continue;
    const target = String(edge.target);
    const ids = byTarget.get(target) ?? [];
    ids.push(edge.id);
    byTarget.set(target, ids);
  }

  const out = new Set(active);
  for (const edge of edges) {
    if (!active.has(edge.id) || !isBundledStubEdge(edge)) continue;
    for (const sibling of byTarget.get(String(edge.target)) ?? []) out.add(sibling);
  }
  return out;
}

function activeStubPorts(edgeIds: Set<string>, adjacency: Adjacency, switchIds: Set<string>): string[] {
  const out = new Set<string>();
  for (const edgeId of edgeIds) {
    for (const port of adjacency.edgePorts.get(edgeId) ?? []) {
      const sep = port.indexOf(':');
      if (sep <= 0) continue;
      if (switchIds.has(port.slice(0, sep))) out.add(port);
    }
  }
  return [...out];
}

function nextEdgeLinkMode(mode: EdgeLinkMode): EdgeLinkMode {
  const index = EDGE_LINK_MODE_ORDER.indexOf(mode);
  return EDGE_LINK_MODE_ORDER[(index + 1) % EDGE_LINK_MODE_ORDER.length];
}

function edgeLinkModeTitle(mode: EdgeLinkMode): string {
  switch (mode) {
    case 'enabled':
      return 'Edge links enabled — click for stubs';
    case 'stub':
      return 'Edge link stubs — click to hide';
    case 'hidden':
      return 'Edge links hidden — click to show';
  }
}

function edgeLinkModeIcon(mode: EdgeLinkMode) {
  switch (mode) {
    case 'enabled':
      return <VisibilityIcon />;
    case 'stub':
      return <SettingsEthernetIcon />;
    case 'hidden':
      return <VisibilityOffIcon />;
  }
}

function nodeIntersectsViewport(node: RFNode, viewport: Viewport, width: number, height: number): boolean {
  const nodeWidth = node.width ?? node.measured?.width ?? 160;
  const nodeHeight = node.height ?? node.measured?.height ?? 80;
  const left = node.position.x * viewport.zoom + viewport.x;
  const top = node.position.y * viewport.zoom + viewport.y;
  const right = (node.position.x + nodeWidth) * viewport.zoom + viewport.x;
  const bottom = (node.position.y + nodeHeight) * viewport.zoom + viewport.y;
  return right >= -LARGE_VIEWPORT_PAD &&
    left <= width + LARGE_VIEWPORT_PAD &&
    bottom >= -LARGE_VIEWPORT_PAD &&
    top <= height + LARGE_VIEWPORT_PAD;
}

function nodeBounds(node: RFNode): FlowBounds {
  const width = node.measured?.width ?? node.width ?? node.initialWidth ?? 160;
  const height = node.measured?.height ?? node.height ?? node.initialHeight ?? 80;
  return { x: node.position.x, y: node.position.y, width, height };
}

function nodesBounds(nodes: RFNode[]): FlowBounds | null {
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const bounds = nodeBounds(node);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return size;
}

export default function App({ mode, onToggleMode }: { mode: Mode; onToggleMode: () => void }) {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selectedNodeLabels, setSelectedNodeLabels] = useState<string[]>([]); // [] = no filter
  const [namespace, setNamespace] = useState('');
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespacesReady, setNamespacesReady] = useState(false);
  const [edgeLinkMode, setEdgeLinkMode] = useState<EdgeLinkMode>('enabled');
  const [legendOpen, setLegendOpen] = useState(true);
  const [hideEdges, setHideEdges] = useState(false); // dev: drop all cables to isolate edge render cost
  const [webglEdgesUnavailable, setWebglEdgesUnavailable] = useState(false);
  const grouped = useGroupedEdges();
  const [drawerTab, setDrawerTab] = useState(0);      // 0 = Ports, 1 = Details
  useEffect(() => { setDrawerTab(0); }, [open]);      // reset to Ports when a new node opens
  const [drawerH, setDrawerH] = useState(() => Math.round(window.innerHeight * 0.6));
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const flowHostRef = useRef<HTMLDivElement | null>(null);
  const [largeViewport, setLargeViewport] = useState<Viewport>(LARGE_DEFAULT_VIEWPORT);
  const windowSize = useWindowSize();
  const markWebglEdgesUnavailable = useCallback(() => setWebglEdgesUnavailable(true), []);

  // drag the top edge of the drawer to resize its height
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) =>
      setDrawerH(Math.max(180, Math.min(window.innerHeight - 56, window.innerHeight - ev.clientY)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // the EDA namespaces to choose from — streamed so the picker updates live.
  useEffect(() => streamNamespaces((next) => {
    setNamespaces(next);
    setNamespacesReady(true);
    setErr('');
    setNamespace((current) => (current && next.includes(current) ? current : (next[0] ?? '')));
  }, (msg) => {
    setNamespacesReady(true);
    setErr(msg);
  }), []);

  // live topology stream for the selected namespace — pushes the snapshot then live updates.
  // Reconnects when the namespace changes; clears first so stale data never lingers.
  useEffect(() => {
    setTopo(null);
    setWebglEdgesUnavailable(false);
    if (!namespace) {
      setErr((current) => current || (namespacesReady ? 'no namespaces with topology resources' : ''));
      return;
    }
    return streamTopology(namespace, (t) => { setTopo(t); setErr(''); }, setErr);
  }, [namespace, namespacesReady]);

  const largeTopology = useMemo(() => topo ? isLargeTopology(topo) : false, [topo]);
  const effectiveEdgeLinkMode: EdgeLinkMode = edgeLinkMode;

  useEffect(() => {
    if (largeTopology) setLargeViewport(LARGE_DEFAULT_VIEWPORT);
  }, [largeTopology, namespace]);

  const fitNodes = useCallback((targetNodes: RFNode[], options: FitNodesOptions) => {
    if (!flow || targetNodes.length === 0) return;
    if (!largeTopology) {
      void flow.fitView({ nodes: targetNodes, ...options });
      return;
    }

    const bounds = nodesBounds(targetNodes);
    const rect = flowHostRef.current?.getBoundingClientRect();
    if (!bounds || !rect?.width || !rect.height) return;

    const viewport = getViewportForBounds(
      bounds,
      rect.width,
      rect.height,
      LARGE_MIN_ZOOM,
      options.maxZoom ?? LARGE_MAX_ZOOM,
      options.padding,
    );
    void flow.setViewport(viewport, { duration: options.duration }).then((ok) => {
      if (ok) setLargeViewport(flow.getViewport());
    });
  }, [flow, largeTopology]);

  const { nodes: builtNodes, edges, switchIds, adjacency } = useMemo(() => {
    const empty: Adjacency = { nodeEdges: new Map(), edgeEnds: new Map(), edgePorts: new Map(), search: new Map(), nodeLabels: new Map() };
    if (!topo) return { nodes: [] as RFNode[], edges: [], switchIds: new Set<string>(), adjacency: empty };
    const g = buildGraph(topo, { compact: false, tiered: largeTopology });
    setAdjacency(g.adjacency);
    return { nodes: g.nodes, edges: g.edges, switchIds: new Set(topo.nodes.map((n) => n.name)), adjacency: g.adjacency };
  }, [topo, largeTopology]);

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

  const nodeLabelFilterOptions = useMemo(
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
    setSelectedNodeLabels([]);
  }, [namespace]);

  // drop any selected labels that no longer exist (e.g. after a namespace/topology change)
  useEffect(() => {
    setSelectedNodeLabels((prev) => {
      const next = prev.filter((v) => nodeLabelFilterOptions.includes(v));
      return next.length === prev.length ? prev : next;
    });
  }, [nodeLabelFilterOptions]);

  // the label filter HIDES everything that doesn't match: a node must carry ANY selected label.
  // A matched switch keeps its endpoint chips (servers) so its cabling stays intact.
  // null = no filter (show everything).
  const filterActive = selectedNodeLabels.length > 0;
  const shown = useMemo<Set<string> | null>(() => {
    if (!filterActive) return null;
    const sel = new Set(selectedNodeLabels);
    const out = new Set<string>();
    for (const [id, set] of adjacency.nodeLabels) {
      let match = false;
      for (const s of sel) if (set.has(s)) { match = true; break; }
      if (!match) continue;
      out.add(id);
    }
    // keep a matched node's directly-attached context: a switch pulls in its endpoint chips (servers),
    // an endpoint pulls in the switch(es) it lands on. Peer switches across an ISL stay hidden.
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot the seed matches before adding context nodes.
    for (const id of [...out]) {
      const idIsSwitch = switchIds.has(id);
      for (const ed of adjacency.nodeEdges.get(id) ?? []) {
        const ends = adjacency.edgeEnds.get(ed);
        if (!ends) continue;
        const other = ends[0] === id ? ends[1] : ends[0];
        if (idIsSwitch !== switchIds.has(other)) out.add(other);   // only across a switch↔endpoint edge
      }
    }
    return out;
  }, [filterActive, selectedNodeLabels, adjacency, switchIds]);

  // read the latest `shown` via a ref so the auto-fit effect (below) fires on the user's label
  // selection, not on every data refresh that recomputes `shown`.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

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

  const hasEdgeLinks = useMemo(() => edges.some((e) => isStubEdge(e.id)), [edges]);
  const ready = !!topo && topo.nodes.length > 0;

  // auto-fit the canvas to the matched nodes whenever the label selection changes
  useEffect(() => {
    if (!flow || !ready) return;
    const target = shownRef.current;
    const handle = window.setTimeout(() => {
      if (!target || target.size === 0) {
        fitNodes(nodesRef.current, { padding: 0.12, duration: 400, maxZoom: largeTopology ? 0.5 : undefined });
        return;
      }
      fitNodes(nodesRef.current.filter((node) => target.has(node.id)), { padding: 0.2, duration: 400, maxZoom: 1.4 });
    }, 60);
    return () => window.clearTimeout(handle);
  }, [selectedNodeLabels, flow, ready, fitNodes, largeTopology]);
  const activeStubEdgeIds = useTrace((s) => {
    if (!s.edges.size) return '';
    const out: string[] = [];
    for (const edgeId of s.edges) if (isStubEdge(edgeId)) out.push(edgeId);
    return out.toSorted().join('\n');
  });
  const directlyActiveStubEdges = useMemo(() => new Set(activeStubEdgeIds ? activeStubEdgeIds.split('\n') : []), [activeStubEdgeIds]);
  const activeStubEdges = useMemo(
    () => effectiveEdgeLinkMode === 'stub' ? expandActiveStubEdges(edges, directlyActiveStubEdges) : directlyActiveStubEdges,
    [effectiveEdgeLinkMode, edges, directlyActiveStubEdges],
  );
  const activeStubPortIds = useMemo(
    () => effectiveEdgeLinkMode === 'stub' ? activeStubPorts(activeStubEdges, adjacency, switchIds) : [],
    [effectiveEdgeLinkMode, activeStubEdges, adjacency, switchIds],
  );
  const activeStubEndpointIds = useMemo(() => {
    const out = new Set<string>();
    if (effectiveEdgeLinkMode !== 'stub') return out;
    for (const edgeId of activeStubEdges) {
      if (!edgeVisibleForShown(edgeId, shown, adjacency)) continue;
      const ends = adjacency.edgeEnds.get(edgeId);
      if (!ends) continue;
      for (const id of ends) {
        if (!switchIds.has(id)) out.add(id);
      }
    }
    return out;
  }, [effectiveEdgeLinkMode, activeStubEdges, shown, adjacency, switchIds]);
  const displayNodes = useMemo(() => {
    let ns = effectiveEdgeLinkMode === 'enabled'
      ? nodes
      : nodes.filter((n) => n.type !== 'endpoint' || activeStubEndpointIds.has(n.id));
    if (shown) ns = ns.filter((n) => shown.has(n.id));
    if (effectiveEdgeLinkMode !== 'stub') return ns;
    const out: RFNode[] = [];
    for (const node of ns) {
      out.push(node.type === 'switch'
        ? Object.assign({}, node, { data: Object.assign({}, node.data, { showEdgeStubs: true, activeEdgeStubPorts: activeStubPortIds }) })
        : node);
    }
    return out;
  }, [effectiveEdgeLinkMode, nodes, shown, activeStubEndpointIds, activeStubPortIds]);
  const searchMatcher = useMemo(() => buildSearchMatcher(query), [query]);
  const displayNodeIds = useMemo(() => new Set(displayNodes.map((n) => n.id)), [displayNodes]);
  const searchTargetIds = useMemo(() => {
    if (!searchMatcher || searchMatcher.error) return [];

    const targets = new Set<string>();
    for (const [id, hay] of adjacency.search) {
      if (!searchMatcher.matches(hay)) continue;
      if (shown && !shown.has(id)) continue;
      if (displayNodeIds.has(id)) {
        targets.add(id);
        continue;
      }

      for (const edgeId of adjacency.nodeEdges.get(id) ?? []) {
        const ends = adjacency.edgeEnds.get(edgeId);
        if (!ends) continue;
        const other = ends[0] === id ? ends[1] : ends[0];
        if (displayNodeIds.has(other)) targets.add(other);
      }
    }
    return [...targets];
  }, [searchMatcher, adjacency, shown, displayNodeIds]);
  const searchTargetNodes = useMemo(
    () => displayNodes.filter((node) => searchTargetIds.includes(node.id)),
    [displayNodes, searchTargetIds],
  );
  const searchPortTarget = useMemo(() => portSearchTarget(searchMatcher, displayNodes), [searchMatcher, displayNodes]);
  const highlightedSearch = useMemo(
    () => searchHighlight(searchMatcher, displayNodes, adjacency, shown, searchPortTarget),
    [searchMatcher, displayNodes, adjacency, shown, searchPortTarget],
  );
  useEffect(() => {
    if (!ready || !searchMatcher || searchMatcher.error) {
      trace.clearSearch();
      return;
    }
    trace.highlight(highlightedSearch.nodes, highlightedSearch.edges, highlightedSearch.ports);
  }, [ready, searchMatcher, highlightedSearch]);
  useEffect(() => {
    if (!flow || !ready || !searchMatcher || searchMatcher.error) return;
    const handle = window.setTimeout(() => {
      if (searchPortTarget) {
        void flow.setCenter(searchPortTarget.x, searchPortTarget.y, {
          zoom: SEARCH_PORT_ZOOM,
          duration: 350,
        }).then((ok) => {
          if (ok && largeTopology) setLargeViewport(flow.getViewport());
        });
        return;
      }
      if (searchTargetNodes.length === 0) return;
      fitNodes(searchTargetNodes, {
        padding: searchTargetNodes.length === 1 ? 0.45 : 0.25,
        duration: 350,
        maxZoom: 1.4,
      });
    }, 160);
    return () => window.clearTimeout(handle);
  }, [flow, ready, searchMatcher, searchPortTarget, searchTargetNodes, fitNodes, largeTopology]);
  const traceKey = useTrace((s) => s.key);
  const elevatedEdge = traceKey?.startsWith('cable:') ? traceKey.slice(6) : null;
  const displayEdges = useMemo(() => {
    let base = edges;
    if (effectiveEdgeLinkMode === 'stub') {
      base = edges
        .filter((e) => !isStubEdge(e.id) || activeStubEdges.has(e.id))
        .map((e) => activeStubEdges.has(e.id)
          ? Object.assign({}, e, { data: Object.assign({}, e.data, { forceOn: true }) })
          : e);
    } else if (effectiveEdgeLinkMode === 'hidden') {
      base = edges.filter((e) => !isStubEdge(e.id));
    }
    if (shown) base = base.filter((e) => edgeVisibleForShown(e.id, shown, adjacency));
    return elevatedEdge ? base.map((e) => (e.id === elevatedEdge ? { ...e, zIndex: 1 } : e)) : base;
  }, [effectiveEdgeLinkMode, edges, activeStubEdges, elevatedEdge, shown, adjacency]);

  const openNode = topo?.nodes.find((n) => n.name === open);
  const lldpOn = useLldp();
  const useWebglEdges = largeTopology && WEBGL_OK && !hideEdges && !webglEdgesUnavailable;
  const usePolishGlEdges = !largeTopology && WEBGL_OK && !hideEdges;
  const useWebglNodeOverview = largeTopology && WEBGL_OK && !webglEdgesUnavailable && largeViewport.zoom < LARGE_WEBGL_NODE_ZOOM;
  const flowNodes = useMemo(
    () => useWebglNodeOverview
      ? NO_NODES
      : largeTopology
        ? displayNodes.filter((node) => nodeIntersectsViewport(node, largeViewport, windowSize.width, windowSize.height))
        : displayNodes,
    [useWebglNodeOverview, largeTopology, displayNodes, largeViewport, windowSize],
  );
  const flowNodeIds = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes]);
  const flowEdges = useMemo(() => {
    if (useWebglEdges || usePolishGlEdges) return NO_EDGES;
    if (!largeTopology) return displayEdges;
    return displayEdges.filter((edge) => flowNodeIds.has(String(edge.source)) && flowNodeIds.has(String(edge.target)));
  }, [useWebglEdges, usePolishGlEdges, largeTopology, displayEdges, flowNodeIds]);

  const openPdf = (ids: string[]) => {
    const targets = ids.length ? ids : (topo?.nodes.map((n) => n.name) ?? []);
    const params = new URLSearchParams();
    if (ids.length) params.set('nodes', ids.join(','));
    if (namespace) params.set('ns', namespace);
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
            <Box sx={{ position: 'absolute', left: '50%', top: 0, bottom: 0, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 0.75, width: 400, maxWidth: 400, overflow: 'hidden' }}>
              {/* Search locates matches by fitting the viewport; filtering is handled by the label dropdown. */}
              <TextField size="small" variant="outlined" value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search node / port · /regex/"
                error={!!searchMatcher?.error}
                title={searchMatcher?.error}
                slotProps={{ input: { startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                  </InputAdornment>
                ) } }}
                sx={{
                  flex: 1, minWidth: 0,
                  '& .MuiOutlinedInput-root': { height: 31 },
                  '& .MuiInputBase-input': { py: '3px' },
                }}
              />
            </Box>
          )}
          {ready && nodeLabelFilterOptions.length > 0 && (
            <FormControl size="small" sx={{ width: 260 }}>
              <Select
                multiple
                displayEmpty
                value={selectedNodeLabels}
                onChange={(e) => setSelectedNodeLabels(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
                renderValue={(sel) => sel.length === 0
                  ? <Box component="span" sx={{ color: 'text.secondary' }}>Label filter</Box>
                  : sel.length === 1 ? sel[0] : `${sel.length} labels`}
                inputProps={{ 'aria-label': 'Label filter' }}
                MenuProps={{ slotProps: { paper: { sx: { maxHeight: 360 } } } }}
                sx={{ height: 31 }}
              >
                {nodeLabelFilterOptions.map((value) => (
                  <MenuItem key={value} value={value} dense>
                    <Checkbox size="small" checked={selectedNodeLabels.includes(value)} sx={{ py: 0, mr: 0.5 }} />
                    <ListItemText primary={value} slotProps={{ primary: { noWrap: true } }} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          {namespaces.length > 1 && namespace && (
            <NamespacePicker value={namespace} options={namespaces} onChange={setNamespace} />
          )}
          {namespaces.length === 1 && namespace && (
            <Chip size="small" variant="outlined" label={namespace} sx={{ maxWidth: 180 }} />
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
                onClick={() => { void exportXlsx(topo, selected.length ? selected : topo.nodes.map((n) => n.name)).catch(console.error); }}>
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

      <Box ref={flowHostRef} sx={{ flex: 1, minHeight: 0 }}>
        {ready ? (
          <ReactFlow
            nodes={flowNodes} edges={hideEdges ? NO_EDGES : flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onInit={setFlow}
            colorMode={mode} elevateNodesOnSelect={false} nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onlyRenderVisibleElements={largeTopology}
            minZoom={largeTopology ? LARGE_MIN_ZOOM : 0.15}
            maxZoom={largeTopology ? LARGE_MAX_ZOOM : 4}
            onNodeClick={(_, n) => { if (switchIds.has(n.id)) setOpen(n.id); }}
            onEdgeClick={(_, e) => trace.pin(`cable:${e.id}`)}
            onEdgeMouseEnter={(_, e) => trace.hover(`cable:${e.id}`)}
            onEdgeMouseLeave={() => trace.hover(null)}
            onSelectionChange={onSel}
            onPaneClick={() => { setSelected([]); trace.clear(); }}
            onMove={largeTopology ? (_, nextViewport) => setLargeViewport(nextViewport) : undefined}
            fitView={!largeTopology}
            defaultViewport={largeTopology ? LARGE_DEFAULT_VIEWPORT : undefined}
            fitViewOptions={{ padding: largeTopology ? 0.05 : 0.12, maxZoom: largeTopology ? 0.5 : 1.5 }} panOnDrag selectionKeyCode="Shift" multiSelectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            {usePolishGlEdges && <GLEdges edges={displayEdges} dark={mode === 'dark'} />}
            {useWebglEdges && (
              <WebGLEdgeLayer nodes={displayNodes} edges={displayEdges} lldp={lldpOn} mode={mode} grouped={grouped} onUnavailable={markWebglEdgesUnavailable} />
            )}
            {largeTopology && (
              <WebGLNodeLayer nodes={displayNodes} lldp={lldpOn} mode={mode} visible={useWebglNodeOverview} onUnavailable={markWebglEdgesUnavailable} />
            )}
            <Controls position="top-right" showInteractive={false}>
              <ControlButton
                onClick={() => edgeRoute.toggle()}
                title={grouped ? 'Use direct links' : 'Use elbow link style'}
                aria-label="Toggle cable routing"
              >
                <PolylineIcon style={{ color: grouped ? 'var(--eda-blue-400)' : undefined }} />
              </ControlButton>
              {import.meta.env.DEV && (
                <ControlButton
                  onClick={() => setHideEdges((v) => !v)}
                  title={hideEdges ? 'Show links (dev)' : 'Hide links — perf test (dev)'}
                  aria-label="Toggle links (dev)"
                >
                  <SettingsEthernetIcon style={{ opacity: hideEdges ? 0.4 : 1 }} />
                </ControlButton>
              )}
              {hasEdgeLinks && (
                <ControlButton
                  onClick={() => setEdgeLinkMode((current) => nextEdgeLinkMode(current))}
                  title={edgeLinkModeTitle(edgeLinkMode)}
                  aria-label={edgeLinkModeTitle(edgeLinkMode)}
                >
                  {edgeLinkModeIcon(effectiveEdgeLinkMode)}
                </ControlButton>
              )}
            </Controls>
            <Panel position="bottom-left">
              {/* both states grow/shrink from the bottom-left corner (transformOrigin); the expanded
                  box drives the footprint, the collapsed icon is absolute so it adds no layout */}
              <Box sx={{ position: 'relative' }}>
                <Grow in={legendOpen} style={{ transformOrigin: 'bottom left' }} unmountOnExit>
                  <Box sx={{ position: 'relative', bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1.5, pl: 1.5, pr: 3.5, py: 1, boxShadow: 2 }}>
                    <Tooltip title="Hide legend">
                      <IconButton size="small" onClick={() => setLegendOpen(false)} sx={{ position: 'absolute', top: 2, right: 2, p: 0.25 }}>
                        <CloseIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                      </IconButton>
                    </Tooltip>
                    <Box sx={{ display: 'flex', gap: 2, mb: 0.75 }}>
                      {(lldpOn ? LLDP_LEGEND : LEGEND).map(([label, swatch]) => (
                        <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                          <Box sx={{ width: 14, height: 6, borderRadius: 2, bgcolor: swatch }} />
                          <Typography variant="caption" sx={{ color: 'text.primary', fontWeight: 500 }}>{label}</Typography>
                        </Box>
                      ))}
                    </Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {lldpOn
                        ? 'LLDP overlay — cables coloured by neighbour match vs the configured remote'
                        : 'Hover to trace · click a cable or port to pin · click a switch for its panel'}
                    </Typography>
                  </Box>
                </Grow>
                <Grow in={!legendOpen} style={{ transformOrigin: 'bottom left' }} unmountOnExit>
                  <Box sx={{ position: 'absolute', bottom: 0, left: 0 }}>
                    <Tooltip title="Show legend">
                      <IconButton size="small" onClick={() => setLegendOpen(true)}
                        sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2, '&:hover': { bgcolor: 'background.paper' } }}>
                        <InfoOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Grow>
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
                  onClick={() => openPdf([openNode.name])}>
                  <SvgGlyph src={pdfIcon} />
                </IconButton>
              </Tooltip>
              {topo && (
                <Tooltip title="Download XLSX">
                  <IconButton size="small" sx={{ color: 'text.primary' }}
                    onClick={() => { void exportXlsx(topo, [openNode.name]).catch(console.error); }}>
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
                  <NodeView node={openNode} rows={openNode.table}
                    showHeader={false} onOpenNode={setOpen} fillHeight
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
