import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, useStoreApi, useReactFlow, useNodesInitialized, Position, type Edge as RFEdge, type InternalNode, type Node as RFNode } from '@xyflow/react';
import { COMPACT_SWITCH_H, COMPACT_SWITCH_W, switchPortCenter, type CableKind, type SwitchData } from '../graph';
import type { LldpStatus } from '../domain/topology/contract';
import { trace, useTrace } from '../trace';
import { useLldp } from '../lldp';
import { useGroupedEdges } from './edgeRoute';
import { cablePolyline, distToPolyline, type XY } from './edgeGeometry';
import { resizeCanvasToDisplaySize } from '../webgl/canvas';
import {
  buildEdgeVertices, EDGE_VERTEX_STRIDE, sameEdgeLabels,
  type EdgeDrawGeometry, type EdgeDrawLabel,
} from '../webgl/edgeVertices';
import { linkProgram } from '../webgl/program';

// WebGL cable layer: nodes/store/interaction stay React Flow; only the cables render on the GPU.
// Each cable is tessellated into a thick-line triangle strip
// in FLOW coordinates and uploaded once to a GPU buffer — pan/zoom is then just a uniform update +
// one draw call (no per-frame CPU work). Geometry rebuilds only on data / drag / trace / route / theme.
// Thick lines are expanded in the vertex shader (screen-space offset) so width is constant in px and
// the buffer stays valid across zoom. Curve geometry is React Flow's exact path math (edgeGeometry.ts).
// Cable hover/click is hit-tested off the polylines (pane pointer events); the ×N + traced-endpoint
// labels render as a small HTML overlay (crisp text, only the active few) over the GL lines.

type Data = { kind: CableKind; a?: string; b?: string; count?: number; lldp?: LldpStatus; forceOn?: boolean };
type Pt = { x: number; y: number; pos: Position };
type Hit = { id: string; pts: XY[] };
type PointerState = { active: boolean; x: number; y: number; overNode: boolean; lastHover: string | null };

const VERT = `
precision highp float;
attribute vec2 a_pos;
attribute vec2 a_norm;
attribute vec4 a_color;
attribute float a_half;
uniform vec2 u_translate;
uniform float u_zoom;
uniform float u_dpr;
uniform vec2 u_resolution;
varying vec4 v_color;
void main() {
  vec2 screen = a_pos * u_zoom + u_translate + a_norm * a_half; // CSS px (half-width offset in screen space)
  vec2 clip = (screen * u_dpr) / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;

const FRAG = `
precision highp float;
varying vec4 v_color;
void main() { gl_FragColor = vec4(v_color.rgb * v_color.a, v_color.a); }`;

function handlePoint(node: InternalNode<RFNode> | undefined, handleId: string | null | undefined, kind: 'source' | 'target'): Pt | null {
  if (!node) return null;
  const list = node.internals.handleBounds?.[kind];
  // require the EXACT handle. A center/first-handle fallback draws garbage geometry and can spuriously
  // flip the routing (both ends defaulting to Top -> peer-arch) while handles are mid-(re)measure on an
  // EDA update. Returning null skips the cable for that frame; it redraws once handles are back.
  const h = handleId ? list?.find((b) => b.id === handleId) : list?.[0];
  if (!h) return null;
  const abs = node.internals.positionAbsolute;
  return { x: abs.x + h.x + h.width / 2, y: abs.y + h.y + h.height / 2, pos: h.position };
}

// parse a switch handle id (`pN`, `pN_C`, `pNt`) into its port + optional breakout channel
function parseSwitchHandle(handle: string | null | undefined): { port: string; channel?: number } | null {
  if (!handle?.startsWith('p')) return null;
  const [port, channelText] = handle.slice(1).replace(/t$/, '').split('_');
  if (!port) return null;
  const channel = Number(channelText);
  return { port, channel: Number.isInteger(channel) ? channel : undefined };
}

function sideOf(handle: string | null | undefined): Position {
  if (handle?.includes('bottom')) return Position.Bottom;
  if (handle?.includes('left')) return Position.Left;
  if (handle?.includes('right')) return Position.Right;
  return Position.Top;
}

// Endpoint computed from node DATA (not measured handles) — for nodes the live store lacks because
// they're culled or hidden behind the node overview on a large fabric. The cell centre equals the
// rendered handle centre, so this matches `handlePoint` for measured nodes.
function computedPoint(node: RFNode | undefined, handle: string | null | undefined): Pt | null {
  if (!node) return null;
  if (node.type === 'switch') {
    const data = node.data as SwitchData;
    if (data.compact) {
      const bottom = handle?.includes('bottom');
      return { x: node.position.x + COMPACT_SWITCH_W / 2, y: node.position.y + (bottom ? COMPACT_SWITCH_H : 0), pos: bottom ? Position.Bottom : Position.Top };
    }
    const parsed = parseSwitchHandle(handle);
    if (parsed) {
      const center = switchPortCenter(data, parsed.port, parsed.channel);
      if (center) {
        const info = data.ports.find((p) => p.port === parsed.port && (parsed.channel == null || p.channel === parsed.channel));
        return { x: node.position.x + center.x, y: node.position.y + center.y, pos: info?.side === 'bottom' ? Position.Bottom : Position.Top };
      }
    }
  }
  const w = node.measured?.width ?? node.width ?? 112;
  const h = node.measured?.height ?? node.height ?? 22;
  if (handle === 'in' || node.type === 'endpoint') return { x: node.position.x + w / 2, y: node.position.y + 1, pos: Position.Top };
  const pos = sideOf(handle);
  return { x: node.position.x + w / 2, y: node.position.y + (pos === Position.Bottom ? h : 0), pos };
}

// Per-port elbow-stem offset: ports stacked in the same column are spread across the port width so
// their vertical stems don't overlap on the way to the bus — 2 stacked -> ±width/4 (gap width/2),
// 4 stacked -> gap width/4, etc. Keyed by source-handle id (`pN`); target handles (`pNt`) strip the 't'.
function buildStemOffsets(handles: { id?: string | null; x: number; y: number; width: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  const cols = new Map<number, { id: string; y: number; w: number }[]>();
  for (const h of handles) {
    if (!h.id) continue;
    const k = Math.round(h.x);
    (cols.get(k) ?? cols.set(k, []).get(k)!).push({ id: h.id, y: h.y, w: h.width });
  }
  for (const g of cols.values()) {
    g.sort((a, b) => a.y - b.y);
    const n = g.length, w = g[0].w;
    g.forEach((p, i) => m.set(p.id, n > 1 ? (i - (n - 1) / 2) * (w / n) : 0));
  }
  return m;
}

// One WebGL cable layer for both regimes. Normal fabrics resolve endpoints from React Flow's measured
// handles (exact, interactive). `lite` (large fabrics) computes endpoints from node data instead — so
// it works for culled / overview nodes the store doesn't hold — and drops hover/click + labels.
export default function GLEdges({ edges, dark, nodes, lite = false, onUnavailable }: {
  edges: RFEdge[]; dark: boolean; nodes: RFNode[]; lite?: boolean; onUnavailable?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const store = useStoreApi();
  const rf = useReactFlow();
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // A complete signature of everything an edge endpoint depends on: node position AND handle
  // measurement. Edge geometry = node position + handle offset, so both must drive the rebuild.
  // Folding the per-node source/target handle counts (cheap, O(nodes), no per-handle iteration so
  // pan/zoom stays free) makes this change the instant a newly-shown node's handles are measured —
  // so toggling label filters / hiding edges always rebuilds correctly once handles settle, rather
  // than racing un-measured nodes and dropping their cables. Stable across pan/zoom (no transform read).
  const posHash = useStore((s) => {
    let h = 0;
    for (const n of s.nodeLookup.values()) {
      const p = n.internals.positionAbsolute;
      const hb = n.internals.handleBounds;
      h = (h * 31 + p.x + p.y * 7 + (hb?.source?.length ?? 0) * 13 + (hb?.target?.length ?? 0) * 17) | 0;
    }
    return h;
  });
  const lldpOn = useLldp();
  const grouped = useGroupedEdges();
  const nodesReady = useNodesInitialized();
  const tracedEdges = useTrace((s) => s.edges);
  const traceAny = useTrace((s) => s.any);

  const gl = useRef<WebGLRenderingContext | null>(null);
  const prog = useRef<WebGLProgram | null>(null);
  const buf = useRef<WebGLBuffer | null>(null);
  const loc = useRef<Record<string, number | WebGLUniformLocation | null>>({});
  const count = useRef(0);
  const hitRef = useRef<Hit[]>([]);            // per-cable polylines for hover/click hit-testing
  // cached geometry: recomputed only when edges/positions/routing change (NOT on hover/trace)
  const geomCache = useRef<{ edges: RFEdge[]; nodes: RFNode[]; posHash: number; grouped: boolean; geom: EdgeDrawGeometry[] } | null>(null);
  const pointerRef = useRef<PointerState>({ active: false, x: 0, y: 0, overNode: false, lastHover: null });
  const repickRef = useRef<(() => void) | null>(null);
  const [labels, setLabels] = useState<EdgeDrawLabel[]>([]);  // ×N + traced-endpoint labels (HTML overlay)

  // one-time GL init
  useLayoutEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('webgl', { antialias: true, premultipliedAlpha: true, alpha: true });
    if (!canvas || !context) { onUnavailable?.(); return; }
    gl.current = context;
    let p: WebGLProgram;
    try {
      p = linkProgram(context, VERT, FRAG);
    } catch (error) {
      console.warn('[GLEdges] program link failed:', error);
      onUnavailable?.();
      return;
    }
    prog.current = p;
    buf.current = context.createBuffer();
    loc.current = {
      a_pos: context.getAttribLocation(p, 'a_pos'),
      a_norm: context.getAttribLocation(p, 'a_norm'),
      a_color: context.getAttribLocation(p, 'a_color'),
      a_half: context.getAttribLocation(p, 'a_half'),
      u_translate: context.getUniformLocation(p, 'u_translate'),
      u_zoom: context.getUniformLocation(p, 'u_zoom'),
      u_dpr: context.getUniformLocation(p, 'u_dpr'),
      u_resolution: context.getUniformLocation(p, 'u_resolution'),
    };
    context.enable(context.BLEND);
    context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA); // premultiplied
    return () => { context.deleteProgram(p); if (buf.current) context.deleteBuffer(buf.current); };
  }, [onUnavailable]);

  const rebuild = useCallback(() => {
    const context = gl.current;
    if (!context) return;
    // Normal mode draws from measured handles, so wait for measurement; lite mode computes endpoints
    // from node data, so it does not need to wait for React Flow handle bounds.
    if (!nodesReady && !lite) return;
    const { nodeLookup } = store.getState();

    // --- GEOMETRY pass (cached) -----------------------------------------------------------------
    // Resolving endpoints, sampling each cable's polyline (bezier/elbow) and computing the miter
    // normals is the expensive work — and none of it depends on the trace/hover state. Recompute it
    // only when the edge set, node positions/handles, or routing change; a hover reuses the cache.
    const c = geomCache.current;
    if (!c || c.edges !== edges || c.nodes !== nodes || c.posHash !== posHash || c.grouped !== grouped) {
      const offsetCache = new Map<string, Map<string, number>>();
      const stemOffsets = (nodeId: string) => {
        let m = offsetCache.get(nodeId);
        if (!m) { m = buildStemOffsets(nodeLookup.get(nodeId)?.internals.handleBounds?.source ?? []); offsetCache.set(nodeId, m); }
        return m;
      };
      const geom: EdgeDrawGeometry[] = [];
      for (const e of edges) {
        const s = handlePoint(nodeLookup.get(e.source), e.sourceHandle, 'source') ?? computedPoint(nodesById.get(String(e.source)), e.sourceHandle);
        const t = handlePoint(nodeLookup.get(e.target), e.targetHandle, 'target') ?? computedPoint(nodesById.get(String(e.target)), e.targetHandle);
        if (!s || !t) continue;
        const d = e.data as Data | undefined;
        const peerArch = d?.kind === 'isl' && s.pos === Position.Top && t.pos === Position.Top;
        const sDx = grouped ? (stemOffsets(e.source).get(e.sourceHandle ?? '') ?? 0) : 0;
        const tDx = grouped ? (stemOffsets(e.target).get((e.targetHandle ?? '').replace(/t$/, '')) ?? 0) : 0;
        const pts = cablePolyline({ x: s.x, y: s.y }, s.pos, { x: t.x, y: t.y }, t.pos, grouped, peerArch, sDx, tDx);
        if (pts.length < 2) continue;
        const n = Math.min(pts.length, 512);
        // per-vertex miter normal + length factor (the width-independent geometry of the join)
        const mnx = new Float64Array(n), mny = new Float64Array(n), ml = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          let inx = 0, iny = 0, outx = 0, outy = 0;
          if (i > 0) { const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y, l = Math.hypot(dx, dy) || 1; inx = -dy / l; iny = dx / l; }
          if (i < n - 1) { const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, l = Math.hypot(dx, dy) || 1; outx = -dy / l; outy = dx / l; }
          if (i === 0) { mnx[i] = outx; mny[i] = outy; ml[i] = 1; }
          else if (i === n - 1) { mnx[i] = inx; mny[i] = iny; ml[i] = 1; }
          else {
            let mx = inx + outx, my = iny + outy;
            const l = Math.hypot(mx, my);
            if (l < 1e-6) { mnx[i] = outx; mny[i] = outy; ml[i] = 1; }
            else { mx /= l; my /= l; const cos = mx * outx + my * outy; mnx[i] = mx; mny[i] = my; ml[i] = 1 / (cos < 0.25 ? 0.25 : cos); if (ml[i] > 4) ml[i] = 4; } // miter limit
          }
        }
        geom.push({ id: e.id, pts, n, mnx, mny, ml, kind: d?.kind, lldp: d?.lldp, cnt: d?.count ?? 1, forceOn: !!d?.forceOn, a: d?.a, b: d?.b });
      }
      hitRef.current = lite ? [] : geom.map((g) => ({ id: g.id, pts: g.pts }));
      geomCache.current = { edges, nodes, posHash, grouped, geom };
    }
    const geom = geomCache.current!.geom;

    // --- APPEARANCE pass (runs on every hover — cheap: colour/alpha/width + buffer write only) ---
    const { vertices, vertexCount, labels: labelOut } = buildEdgeVertices({
      geometry: geom,
      tracedEdges,
      traceAny,
      lldpOn,
      dark,
      lite,
    });
    setLabels((prev) => sameEdgeLabels(prev, labelOut) ? prev : labelOut);
    count.current = vertexCount;
    context.bindBuffer(context.ARRAY_BUFFER, buf.current);
    context.bufferData(context.ARRAY_BUFFER, vertices, context.DYNAMIC_DRAW);
    // posHash isn't read directly (positions come from the live store) but retriggers rebuild on node move
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, grouped, tracedEdges, traceAny, lldpOn, dark, posHash, nodesReady, store, nodes, nodesById, lite]);

  const draw = useCallback(() => {
    const context = gl.current, p = prog.current, l = loc.current;
    if (!context || !p) return;
    const canvas = ref.current;
    if (!canvas) return;
    const { width: bw, height: bh, dpr } = resizeCanvasToDisplaySize(canvas, width, height);
    const [tx, ty, zoom] = store.getState().transform;
    context.viewport(0, 0, bw, bh);
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    if (!count.current) return;
    context.useProgram(p);
    context.bindBuffer(context.ARRAY_BUFFER, buf.current);
    const stride = EDGE_VERTEX_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    const a = l as Record<string, number>;
    context.enableVertexAttribArray(a.a_pos); context.vertexAttribPointer(a.a_pos, 2, context.FLOAT, false, stride, 0);
    context.enableVertexAttribArray(a.a_norm); context.vertexAttribPointer(a.a_norm, 2, context.FLOAT, false, stride, 8);
    context.enableVertexAttribArray(a.a_color); context.vertexAttribPointer(a.a_color, 4, context.FLOAT, false, stride, 16);
    context.enableVertexAttribArray(a.a_half); context.vertexAttribPointer(a.a_half, 1, context.FLOAT, false, stride, 32);
    context.uniform2f(l.u_translate as WebGLUniformLocation, tx, ty);
    context.uniform1f(l.u_zoom as WebGLUniformLocation, zoom);
    context.uniform1f(l.u_dpr as WebGLUniformLocation, dpr);
    context.uniform2f(l.u_resolution as WebGLUniformLocation, bw, bh);
    context.drawArrays(context.TRIANGLES, 0, count.current);
  }, [width, height, store]);

  // rebuild geometry exactly when geometry deps change (data / drag / route / trace / theme), then draw.
  // Layout timing keeps hover highlights in the same paint as the trace state update.
  useLayoutEffect(() => { rebuild(); draw(); repickRef.current?.(); }, [rebuild, draw]);
  // pan/zoom (and resize): geometry is current, just re-issue uniforms + one draw call
  useEffect(() => { draw(); }, [transform, draw]);

  // cable hover/click: the canvas is pointerEvents:none, so hit-test the pointer against the polylines
  // on React Flow's pane (which receives events over empty space — exactly where cables live).
  useEffect(() => {
    const pane = ref.current?.closest('.react-flow')?.querySelector<HTMLElement>('.react-flow__pane');
    if (!pane) return;
    const pick = (clientX: number, clientY: number): string | null => {
      const p = rf.screenToFlowPosition({ x: clientX, y: clientY }, { snapToGrid: false });
      const zoom = store.getState().transform[2];
      const tolerance = 8 / zoom; // ~8px tolerance (matches the SVG interactionWidth)
      const current = pointerRef.current.lastHover;
      let best: string | null = null, bestD = tolerance, currentD = Number.POSITIVE_INFINITY;
      for (const h of hitRef.current) {
        const d = distToPolyline(h.pts, p.x, p.y);
        if (h.id === current) currentD = d;
        if (d < bestD) { bestD = d; best = h.id; }
      }
      if (current && currentD <= tolerance && currentD <= bestD + (0.5 / zoom)) return current;
      return best;
    };
    const setHover = (id: string | null) => {
      const p = pointerRef.current;
      if (id === p.lastHover) return;
      p.lastHover = id;
      trace.hover(id ? `cable:${id}` : null);
    };
    // ports/nodes own the hover when the pointer is on them — never let a cable under a port win
    const overNode = (t: EventTarget | null) => !!(t as Element | null)?.closest?.('.react-flow__node');
    const clearLocalHover = () => {
      pointerRef.current.lastHover = null;
      pane.style.cursor = '';
    };
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const p = pointerRef.current;
      if (trace.isHoverSuspended()) { clearLocalHover(); return; }
      p.active = true;
      p.x = e.clientX;
      p.y = e.clientY;
      p.overNode = overNode(e.target);
      if (p.overNode) { pane.style.cursor = ''; setHover(null); return; }
      if (e.buttons) { pane.style.cursor = ''; setHover(null); return; } // panning: let React Flow own the cursor
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (trace.isHoverSuspended()) { clearLocalHover(); return; }
        const latest = pointerRef.current;
        if (!latest.active || latest.overNode) return;
        const id = pick(latest.x, latest.y);
        pane.style.cursor = id ? 'pointer' : ''; // pointer over a cable, like React Flow's SVG edges
        setHover(id);
      });
    };
    const onLeave = () => {
      pointerRef.current.active = false;
      pointerRef.current.overNode = false;
      pane.style.cursor = '';
      setHover(null);
    };
    const onClick = (e: MouseEvent) => { if (overNode(e.target)) return; const id = pick(e.clientX, e.clientY); if (id) { e.stopPropagation(); trace.pin(`cable:${id}`); } };
    repickRef.current = () => {
      const p = pointerRef.current;
      if (trace.isHoverSuspended()) { clearLocalHover(); return; }
      if (!p.active || p.overNode) return;
      const id = pick(p.x, p.y);
      pane.style.cursor = id ? 'pointer' : '';
      setHover(id);
    };
    pane.addEventListener('pointermove', onMove);
    pane.addEventListener('pointerleave', onLeave);
    pane.addEventListener('click', onClick, true); // capture: pin before React Flow's onPaneClick clears
    return () => {
      if (raf) cancelAnimationFrame(raf);
      pane.style.cursor = '';
      if (pointerRef.current.lastHover) trace.hover(null);
      pointerRef.current = { active: false, x: 0, y: 0, overNode: false, lastHover: null };
      repickRef.current = null;
      pane.removeEventListener('pointermove', onMove);
      pane.removeEventListener('pointerleave', onLeave);
      pane.removeEventListener('click', onClick, true);
    };
  }, [store, rf]);

  const [vtx, vty, vzoom] = transform;
  return (
    <>
      <canvas ref={ref} style={{ position: 'absolute', inset: 0, width, height, pointerEvents: 'none', zIndex: 0 }} />
      {labels.map((lab) => (
        <div key={lab.key} style={{
          position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap',
          transform: `translate(-50%, -50%) translate(${lab.x * vzoom + vtx}px, ${lab.y * vzoom + vty}px)`,
          ...(lab.badge
            ? { fontSize: 9, fontWeight: 800, lineHeight: 1.4, padding: '0 5px', borderRadius: 8, background: lab.color, color: '#000', border: '1px solid rgba(0,0,0,0.35)' }
            : { fontSize: 10, fontWeight: 600, lineHeight: 1.3, padding: '1px 6px', borderRadius: 4, background: 'var(--label-bg)', color: 'var(--fg)', border: `1px solid ${lab.color}` }),
        }}>{lab.text}</div>
      ))}
    </>
  );
}
