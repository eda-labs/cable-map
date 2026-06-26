import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, useStoreApi, useReactFlow, useNodesInitialized, Position, type Edge as RFEdge, type InternalNode, type Node as RFNode } from '@xyflow/react';
import { CABLE_COLOR, LLDP_COLOR, type CableKind } from './graph';
import type { LldpStatus } from './api';
import { trace, useTrace } from './trace';
import { useLldp } from './lldp';
import { useGroupedEdges } from './edgeRoute';
import { cablePolyline, pointAtFraction, distToPolyline, type XY } from './edgeGeometry';

// Experimental WebGL edge layer (drop-in, like CanvasEdges but GPU). Nodes/store/interaction stay
// React Flow; only the cables move to GL. Each cable is tessellated into a thick-line triangle strip
// in FLOW coordinates and uploaded once to a GPU buffer — pan/zoom is then just a uniform update +
// one draw call (no per-frame CPU work). Geometry rebuilds only on data / drag / trace / route / theme.
// Thick lines are expanded in the vertex shader (screen-space offset) so width is constant in px and
// the buffer stays valid across zoom. Curve geometry is React Flow's exact path math (edgeGeometry.ts).
// Cable hover/click is hit-tested off the polylines (pane pointer events); the ×N + traced-endpoint
// labels render as a small HTML overlay (crisp text, only the active few) over the GL lines.

type Data = { kind: CableKind; a?: string; b?: string; count?: number; lldp?: LldpStatus; forceOn?: boolean };
type Pt = { x: number; y: number; pos: Position };
type Hit = { id: string; pts: XY[] };
type Label = { key: string; x: number; y: number; text: string; color: string; badge: boolean };
type PointerState = { active: boolean; x: number; y: number; overNode: boolean; lastHover: string | null };

const FLOATS = 9;       // a_pos(2) a_norm(2) a_color(4) a_half(1)

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

// resolve a CSS color (incl. var(--x), theme-dependent) to [r,g,b] 0..1 via a 1px 2d probe
const colorCache = new Map<string, [number, number, number]>();
let probe: CanvasRenderingContext2D | null = null;
function resolveColor(css: string, themeKey: string): [number, number, number] {
  const key = `${themeKey}|${css}`;
  const hit = colorCache.get(key);
  if (hit) return hit;
  let s = css;
  const m = /var\((--[^)]+)\)/.exec(css);
  if (m) s = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || '#888888';
  probe ??= document.createElement('canvas').getContext('2d');
  let rgb: [number, number, number] = [0.5, 0.5, 0.5];
  if (probe) {
    probe.fillStyle = '#000000';
    probe.fillStyle = s;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    rgb = [d[0] / 255, d[1] / 255, d[2] / 255];
  }
  colorCache.set(key, rgb);
  return rgb;
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

export default function GLEdges({ edges, dark }: { edges: RFEdge[]; dark: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const store = useStoreApi();
  const rf = useReactFlow();
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // a cheap signature of node positions: changes on drag/data, NOT on pan/zoom -> drives geometry rebuilds
  const posHash = useStore((s) => {
    let h = 0;
    for (const n of s.nodeLookup.values()) { const p = n.internals.positionAbsolute; h = (h * 31 + p.x + p.y * 7) | 0; }
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
  const pointerRef = useRef<PointerState>({ active: false, x: 0, y: 0, overNode: false, lastHover: null });
  const repickRef = useRef<(() => void) | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);  // ×N + traced-endpoint labels (HTML overlay)

  // one-time GL init
  useLayoutEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('webgl', { antialias: true, premultipliedAlpha: true, alpha: true });
    if (!canvas || !context) return;
    gl.current = context;
    const p = context.createProgram()!;
    const vs = compile(context, context.VERTEX_SHADER, VERT), fs = compile(context, context.FRAGMENT_SHADER, FRAG);
    context.attachShader(p, vs); context.attachShader(p, fs);
    context.linkProgram(p);
    if (!context.getProgramParameter(p, context.LINK_STATUS)) {
      console.warn('[GLEdges] program link failed:', context.getProgramInfoLog(p), context.getShaderInfoLog(vs), context.getShaderInfoLog(fs));
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
  }, []);

  const rebuild = useCallback(() => {
    const context = gl.current;
    if (!context) return;
    // don't rebuild against un-measured nodes (handles missing) — keep the last good buffer; the
    // nodesReady dep re-runs this once measurement settles, so an EDA update can't draw garbage.
    if (!nodesReady) return;
    const { nodeLookup } = store.getState();
    const theme = dark ? 'd' : 'l';
    const ordered = edges.toSorted((a, b) => Number(tracedEdges.has(a.id)) - Number(tracedEdges.has(b.id))); // traced last (on top)
    // pass 1: resolve endpoints/style + the exact React Flow polyline; sum verts for an exact allocation.
    // also collect per-cable hit-test polylines and the few HTML labels (×N badges + traced endpoints).
    type Item = { id: string; pts: XY[]; col: [number, number, number]; alpha: number; half: number };
    const items: Item[] = [];
    const labelOut: Label[] = [];
    const smallTrace = tracedEdges.size <= 4;   // matches the SVG edge: only label a small trace
    let totalVerts = 0;
    const offsetCache = new Map<string, Map<string, number>>();
    const stemOffsets = (nodeId: string) => {
      let m = offsetCache.get(nodeId);
      if (!m) { m = buildStemOffsets(nodeLookup.get(nodeId)?.internals.handleBounds?.source ?? []); offsetCache.set(nodeId, m); }
      return m;
    };
    for (const e of ordered) {
      const s = handlePoint(nodeLookup.get(e.source), e.sourceHandle, 'source');
      const t = handlePoint(nodeLookup.get(e.target), e.targetHandle, 'target');
      if (!s || !t) continue;
      const d = e.data as Data | undefined;
      const on = tracedEdges.has(e.id) || !!d?.forceOn;
      const dim = traceAny && !on;
      const css = lldpOn ? LLDP_COLOR[d?.lldp ?? 'none'] : CABLE_COLOR[d?.kind ?? 'isl'];
      const col = resolveColor(css, theme);
      const alpha = dim ? 0.12 : on ? 1 : 0.55;
      const cnt = d?.count ?? 1;
      const half = ((on ? 2.6 : 1.1) + (cnt > 1 ? 1 : 0)) / 2;
      const peerArch = d?.kind === 'isl' && s.pos === Position.Top && t.pos === Position.Top;
      const sDx = grouped ? (stemOffsets(e.source).get(e.sourceHandle ?? '') ?? 0) : 0;
      const tDx = grouped ? (stemOffsets(e.target).get((e.targetHandle ?? '').replace(/t$/, '')) ?? 0) : 0;
      const pts = cablePolyline({ x: s.x, y: s.y }, s.pos, { x: t.x, y: t.y }, t.pos, grouped, peerArch, sDx, tDx);
      if (pts.length < 2) continue;
      items.push({ id: e.id, pts, col, alpha, half });
      totalVerts += (pts.length - 1) * 6;
      if (cnt > 1) { const m = pointAtFraction(pts, 0.5); labelOut.push({ key: `${e.id}:n`, x: m.x, y: m.y, text: `×${cnt}`, color: css, badge: true }); }
      if (on && smallTrace) {
        const pa = pointAtFraction(pts, 0.18), pb = pointAtFraction(pts, 0.82);
        if (d?.a) labelOut.push({ key: `${e.id}:a`, x: pa.x, y: pa.y, text: d.a, color: css, badge: false });
        if (d?.b) labelOut.push({ key: `${e.id}:b`, x: pb.x, y: pb.y, text: d.b, color: css, badge: false });
      }
    }
    hitRef.current = items.map((it) => ({ id: it.id, pts: it.pts }));
    setLabels(labelOut);
    const data = new Float32Array(totalVerts * FLOATS);
    let o = 0;
    const push = (x: number, y: number, nx: number, ny: number, col: [number, number, number], a: number, half: number) => {
      data[o++] = x; data[o++] = y; data[o++] = nx; data[o++] = ny;
      data[o++] = col[0]; data[o++] = col[1]; data[o++] = col[2]; data[o++] = a; data[o++] = half;
    };
    // pass 2: tessellate each polyline into a thick-line triangle list with MITER joins — one shared
    // normal per vertex, scaled by 1/cos(half-angle) so the line keeps a constant screen-space width
    // through curves (matches the SVG stroke; per-segment normals would notch/wobble at every bend).
    const mnx = new Float64Array(512), mny = new Float64Array(512), mmag = new Float64Array(512);
    for (const { pts, col, alpha, half } of items) {
      const n = Math.min(pts.length, 512);
      for (let i = 0; i < n; i++) {
        let inx = 0, iny = 0, outx = 0, outy = 0;
        if (i > 0) { const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y, l = Math.hypot(dx, dy) || 1; inx = -dy / l; iny = dx / l; }
        if (i < n - 1) { const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, l = Math.hypot(dx, dy) || 1; outx = -dy / l; outy = dx / l; }
        let mx: number, my: number, ml: number;
        if (i === 0) { mx = outx; my = outy; ml = 1; }
        else if (i === n - 1) { mx = inx; my = iny; ml = 1; }
        else {
          mx = inx + outx; my = iny + outy;
          const l = Math.hypot(mx, my);
          if (l < 1e-6) { mx = outx; my = outy; ml = 1; }
          else { mx /= l; my /= l; const cos = mx * outx + my * outy; ml = 1 / (cos < 0.25 ? 0.25 : cos); if (ml > 4) ml = 4; } // miter limit
        }
        mnx[i] = mx; mny[i] = my; mmag[i] = half * ml;
      }
      for (let i = 0; i < n - 1; i++) {
        const p = pts[i], q = pts[i + 1];
        push(p.x, p.y, mnx[i], mny[i], col, alpha, mmag[i]); push(p.x, p.y, -mnx[i], -mny[i], col, alpha, mmag[i]); push(q.x, q.y, mnx[i + 1], mny[i + 1], col, alpha, mmag[i + 1]);
        push(p.x, p.y, -mnx[i], -mny[i], col, alpha, mmag[i]); push(q.x, q.y, -mnx[i + 1], -mny[i + 1], col, alpha, mmag[i + 1]); push(q.x, q.y, mnx[i + 1], mny[i + 1], col, alpha, mmag[i + 1]);
      }
    }
    count.current = o / FLOATS;
    context.bindBuffer(context.ARRAY_BUFFER, buf.current);
    context.bufferData(context.ARRAY_BUFFER, data.subarray(0, o), context.DYNAMIC_DRAW);
    // posHash isn't read directly (positions come from the live store) but retriggers rebuild on node move
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, grouped, tracedEdges, traceAny, lldpOn, dark, posHash, nodesReady, store]);

  const draw = useCallback(() => {
    const context = gl.current, p = prog.current, l = loc.current;
    if (!context || !p) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(width * dpr), bh = Math.round(height * dpr);
    const canvas = ref.current!;
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    const [tx, ty, zoom] = store.getState().transform;
    context.viewport(0, 0, bw, bh);
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    if (!count.current) return;
    context.useProgram(p);
    context.bindBuffer(context.ARRAY_BUFFER, buf.current);
    const stride = FLOATS * 4;
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
      let best: string | null = null, bestD = 8 / zoom; // ~8px tolerance (matches the SVG interactionWidth)
      for (const h of hitRef.current) { const d = distToPolyline(h.pts, p.x, p.y); if (d < bestD) { bestD = d; best = h.id; } }
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
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const p = pointerRef.current;
      p.active = true;
      p.x = e.clientX;
      p.y = e.clientY;
      p.overNode = overNode(e.target);
      if (p.overNode) { pane.style.cursor = ''; setHover(null); return; }
      if (e.buttons) { pane.style.cursor = ''; setHover(null); return; } // panning: let React Flow own the cursor
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
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
