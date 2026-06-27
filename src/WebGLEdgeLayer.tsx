import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useViewport, type Edge as RFEdge, type Node as RFNode } from '@xyflow/react';
import { CABLE_COLOR, COMPACT_SWITCH_H, COMPACT_SWITCH_W, LLDP_COLOR, switchPortCenter, type CableKind, type SwitchData } from './graph';
import { useTrace } from './trace';
import type { LldpStatus } from './api';

type EdgeData = { kind?: CableKind; lldp?: LldpStatus; count?: number; forceOn?: boolean };
type Side = 'top' | 'bottom' | 'left' | 'right';
type Point = [number, number];
type Color = [number, number, number, number];
type ProgramInfo = {
  program: WebGLProgram;
  position: number;
  color: number;
  resolution: WebGLUniformLocation;
  translate: WebGLUniformLocation;
  scale: WebGLUniformLocation;
  buffer: WebGLBuffer;
};
const BEND_SEGMENTS = 4;
const SMOOTH_STEP_OFFSET = 20;
const SMOOTH_STEP_RADIUS = 16;
const ENDPOINT_W = 112;
const ENDPOINT_H = 22;
const STRIDE = 6;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext): ProgramInfo {
  const vertex = compile(gl, gl.VERTEX_SHADER, `
    attribute vec2 a_position;
    attribute vec4 a_color;
    uniform vec2 u_resolution;
    uniform vec2 u_translate;
    uniform float u_scale;
    varying vec4 v_color;

    void main() {
      vec2 screen = a_position * u_scale + u_translate;
      vec2 zeroToOne = screen / u_resolution;
      vec2 clip = zeroToOne * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_color = a_color;
    }
  `);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec4 v_color;

    void main() {
      gl_FragColor = v_color;
    }
  `);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  const buffer = gl.createBuffer();
  const resolution = gl.getUniformLocation(program, 'u_resolution');
  const translate = gl.getUniformLocation(program, 'u_translate');
  const scale = gl.getUniformLocation(program, 'u_scale');
  if (!buffer || !resolution || !translate || !scale) throw new Error('missing WebGL program bindings');
  return {
    program,
    position: gl.getAttribLocation(program, 'a_position'),
    color: gl.getAttribLocation(program, 'a_color'),
    resolution,
    translate,
    scale,
    buffer,
  };
}

function resolveColor(value: string): Color {
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();

  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [64, 146, 255, 1];
  return [
    (parts[0] ?? 64) / 255,
    (parts[1] ?? 146) / 255,
    (parts[2] ?? 255) / 255,
    parts[3] ?? 1,
  ];
}

function resolvePalette(_mode: string) {
  return {
    isl: resolveColor(CABLE_COLOR.isl),
    edge: resolveColor(CABLE_COLOR.edge),
    lag: resolveColor(CABLE_COLOR.lag),
    mlag: resolveColor(CABLE_COLOR.mlag),
    ok: resolveColor(LLDP_COLOR.ok),
    mismatch: resolveColor(LLDP_COLOR.mismatch),
    none: resolveColor(LLDP_COLOR.none),
  };
}

function resolveIdleAlpha(_mode: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--edge-idle');
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0.62;
}

function parseSwitchHandle(handle: string | null | undefined): { port: string; channel?: number } | null {
  if (!handle?.startsWith('p')) return null;
  const normalized = handle.slice(1).replace(/t$/, '');
  const [port, channelText] = normalized.split('_');
  if (!port) return null;
  const channel = Number(channelText);
  return { port, channel: Number.isInteger(channel) ? channel : undefined };
}

function nodeSize(node: RFNode, fallbackW: number, fallbackH: number) {
  return {
    width: node.measured?.width ?? node.width ?? fallbackW,
    height: node.measured?.height ?? node.height ?? fallbackH,
  };
}

function handlePoint(node: RFNode, handle: string | null | undefined): Point {
  if (node.type === 'switch') {
    const data = node.data as SwitchData;
    if (data.compact) {
      const bottom = handle?.includes('bottom');
      return [
        node.position.x + COMPACT_SWITCH_W / 2,
        node.position.y + (bottom ? COMPACT_SWITCH_H : 0),
      ];
    }
    const parsed = parseSwitchHandle(handle);
    if (parsed) {
      const center = switchPortCenter(data, parsed.port, parsed.channel);
      if (center) return [node.position.x + center.x, node.position.y + center.y];
    }
  }

  const size = nodeSize(node, ENDPOINT_W, ENDPOINT_H);
  if (handle === 'in' || node.type === 'endpoint') return [node.position.x + size.width / 2, node.position.y + 1];
  const side = sideOf(handle);
  return [
    node.position.x + size.width / 2,
    node.position.y + (side === 'bottom' ? size.height : 0),
  ];
}

function sideOf(handle: string | null | undefined): Side {
  if (handle?.includes('bottom')) return 'bottom';
  if (handle?.includes('left')) return 'left';
  if (handle?.includes('right')) return 'right';
  return 'top';
}

function handleSide(node: RFNode, handle: string | null | undefined): Side {
  if (handle === 'in' || node.type === 'endpoint') return 'top';
  if (node.type === 'switch') {
    const data = node.data as SwitchData;
    if (!data.compact) {
      const parsed = parseSwitchHandle(handle);
      const info = parsed
        ? data.ports.find((port) => port.port === parsed.port && (parsed.channel == null || port.channel === parsed.channel))
        : undefined;
      if (info) return info.side;
    }
  }
  return sideOf(handle);
}

const ctrlOffset = (dist: number, c = 0.25) => (dist >= 0 ? 0.5 * dist : c * 25 * Math.sqrt(-dist));
function control(pos: Side, x1: number, y1: number, x2: number, y2: number): Point {
  switch (pos) {
    case 'left': return [x1 - ctrlOffset(x1 - x2), y1];
    case 'right': return [x1 + ctrlOffset(x2 - x1), y1];
    case 'top': return [x1, y1 - ctrlOffset(y1 - y2)];
    default: return [x1, y1 + ctrlOffset(y2 - y1)];
  }
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function bezierSegmentCount(start: Point, c1: Point, c2: Point, end: Point): number {
  const span = pointDistance(start, c1) + pointDistance(c1, c2) + pointDistance(c2, end);
  return Math.min(72, Math.max(20, Math.round(span / 12)));
}

function curvePoint(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
  ];
}

function bezierPoints(start: Point, c1: Point, c2: Point, end: Point): Point[] {
  const points = [start];
  const segments = bezierSegmentCount(start, c1, c2, end);
  for (let i = 1; i <= segments; i += 1) {
    points.push(curvePoint(i / segments, start, c1, c2, end));
  }
  return points;
}

const directions: Record<Side, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

function direction(source: { x: number; y: number }, sourcePosition: Side, target: { x: number; y: number }) {
  if (sourcePosition === 'left' || sourcePosition === 'right') {
    return source.x < target.x ? { x: 1, y: 0 } : { x: -1, y: 0 };
  }
  return source.y < target.y ? { x: 0, y: 1 } : { x: 0, y: -1 };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function smoothStepBasePoints(sourcePoint: Point, sourcePosition: Side, targetPoint: Point, targetPosition: Side): Point[] {
  const source = { x: sourcePoint[0], y: sourcePoint[1] };
  const target = { x: targetPoint[0], y: targetPoint[1] };
  const sourceDir = directions[sourcePosition];
  const targetDir = directions[targetPosition];
  const sourceGapped = { x: source.x + sourceDir.x * SMOOTH_STEP_OFFSET, y: source.y + sourceDir.y * SMOOTH_STEP_OFFSET };
  const targetGapped = { x: target.x + targetDir.x * SMOOTH_STEP_OFFSET, y: target.y + targetDir.y * SMOOTH_STEP_OFFSET };
  const dir = direction(sourceGapped, sourcePosition, targetGapped);
  const dirAccessor: 'x' | 'y' = dir.x !== 0 ? 'x' : 'y';
  const currDir = dir[dirAccessor];
  let points: Array<{ x: number; y: number }> = [];
  let centerX: number;
  let centerY: number;
  const sourceGapOffset = { x: 0, y: 0 };
  const targetGapOffset = { x: 0, y: 0 };

  if (sourceDir[dirAccessor] * targetDir[dirAccessor] === -1) {
    if (dirAccessor === 'x') {
      centerX = sourceGapped.x + (targetGapped.x - sourceGapped.x) * 0.5;
      centerY = (sourceGapped.y + targetGapped.y) / 2;
    } else {
      centerX = (sourceGapped.x + targetGapped.x) / 2;
      centerY = sourceGapped.y + (targetGapped.y - sourceGapped.y) * 0.5;
    }
    const verticalSplit = [
      { x: centerX, y: sourceGapped.y },
      { x: centerX, y: targetGapped.y },
    ];
    const horizontalSplit = [
      { x: sourceGapped.x, y: centerY },
      { x: targetGapped.x, y: centerY },
    ];
    points = sourceDir[dirAccessor] === currDir
      ? (dirAccessor === 'x' ? verticalSplit : horizontalSplit)
      : (dirAccessor === 'x' ? horizontalSplit : verticalSplit);
  } else {
    const sourceTarget = [{ x: sourceGapped.x, y: targetGapped.y }];
    const targetSource = [{ x: targetGapped.x, y: sourceGapped.y }];
    points = dirAccessor === 'x'
      ? (sourceDir.x === currDir ? targetSource : sourceTarget)
      : (sourceDir.y === currDir ? sourceTarget : targetSource);

    if (sourcePosition === targetPosition) {
      const diff = Math.abs(source[dirAccessor] - target[dirAccessor]);
      if (diff <= SMOOTH_STEP_OFFSET) {
        const gapOffset = Math.min(SMOOTH_STEP_OFFSET - 1, SMOOTH_STEP_OFFSET - diff);
        if (sourceDir[dirAccessor] === currDir) {
          sourceGapOffset[dirAccessor] = (sourceGapped[dirAccessor] > source[dirAccessor] ? -1 : 1) * gapOffset;
        } else {
          targetGapOffset[dirAccessor] = (targetGapped[dirAccessor] > target[dirAccessor] ? -1 : 1) * gapOffset;
        }
      }
    }

    if (sourcePosition !== targetPosition) {
      const opposite: 'x' | 'y' = dirAccessor === 'x' ? 'y' : 'x';
      const isSameDir = sourceDir[dirAccessor] === targetDir[opposite];
      const sourceGtTargetOppo = sourceGapped[opposite] > targetGapped[opposite];
      const sourceLtTargetOppo = sourceGapped[opposite] < targetGapped[opposite];
      const flipSourceTarget = (sourceDir[dirAccessor] === 1 && ((!isSameDir && sourceGtTargetOppo) || (isSameDir && sourceLtTargetOppo))) ||
        (sourceDir[dirAccessor] !== 1 && ((!isSameDir && sourceLtTargetOppo) || (isSameDir && sourceGtTargetOppo)));
      if (flipSourceTarget) points = dirAccessor === 'x' ? sourceTarget : targetSource;
    }
  }

  const gappedSource = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
  const gappedTarget = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
  return [
    [source.x, source.y],
    ...(gappedSource.x !== points[0].x || gappedSource.y !== points[0].y ? [[gappedSource.x, gappedSource.y] as Point] : []),
    ...points.map((p) => [p.x, p.y] as Point),
    ...(gappedTarget.x !== points.at(-1)!.x || gappedTarget.y !== points.at(-1)!.y ? [[gappedTarget.x, gappedTarget.y] as Point] : []),
    [target.x, target.y],
  ];
}

function roundedStepPoints(base: Point[]): Point[] {
  const out: Point[] = [base[0]];
  for (let i = 1; i < base.length - 1; i += 1) {
    const a = { x: base[i - 1][0], y: base[i - 1][1] };
    const b = { x: base[i][0], y: base[i][1] };
    const c = { x: base[i + 1][0], y: base[i + 1][1] };
    const bendSize = Math.min(distance(a, b) / 2, distance(b, c) / 2, SMOOTH_STEP_RADIUS);

    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y) || bendSize <= 0.01) {
      out.push([b.x, b.y]);
      continue;
    }

    let q0: Point;
    let q2: Point;
    if (a.y === b.y) {
      const xDir = a.x < c.x ? -1 : 1;
      const yDir = a.y < c.y ? 1 : -1;
      q0 = [b.x + bendSize * xDir, b.y];
      q2 = [b.x, b.y + bendSize * yDir];
    } else {
      const xDir = a.x < c.x ? 1 : -1;
      const yDir = a.y < c.y ? -1 : 1;
      q0 = [b.x, b.y + bendSize * yDir];
      q2 = [b.x + bendSize * xDir, b.y];
    }
    out.push(q0);
    for (let t = 1; t <= BEND_SEGMENTS; t += 1) {
      const p = t / BEND_SEGMENTS;
      const mt = 1 - p;
      out.push([
        mt * mt * q0[0] + 2 * mt * p * b.x + p * p * q2[0],
        mt * mt * q0[1] + 2 * mt * p * b.y + p * p * q2[1],
      ]);
    }
  }
  out.push(base.at(-1)!);
  return out;
}

function routePoints(start: Point, end: Point, sourceSide: Side, targetSide: Side, kind: CableKind, grouped: boolean): Point[] {
  const peerArch = kind === 'isl' && sourceSide === 'top' && targetSide === 'top';
  if (peerArch) {
    const lift = Math.min(Math.max(Math.abs(end[0] - start[0]) * 0.35, 60), 200);
    return bezierPoints(start, [start[0], start[1] - lift], [end[0], end[1] - lift], end);
  }
  if (grouped) {
    return roundedStepPoints(smoothStepBasePoints(start, sourceSide, end, targetSide));
  }
  return bezierPoints(
    start,
    control(sourceSide, start[0], start[1], end[0], end[1]),
    control(targetSide, end[0], end[1], start[0], start[1]),
    end,
  );
}

function pushVertex(vertices: number[], point: Point, color: Color, alpha: number) {
  vertices.push(point[0], point[1], color[0], color[1], color[2], color[3] * alpha);
}

function appendSegment(vertices: number[], from: Point, to: Point, width: number, color: Color, alpha: number) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len <= 0.001) return;
  const half = width / 2;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  const a: Point = [from[0] + nx, from[1] + ny];
  const b: Point = [from[0] - nx, from[1] - ny];
  const c: Point = [to[0] + nx, to[1] + ny];
  const d: Point = [to[0] - nx, to[1] - ny];
  pushVertex(vertices, a, color, alpha);
  pushVertex(vertices, b, color, alpha);
  pushVertex(vertices, c, color, alpha);
  pushVertex(vertices, b, color, alpha);
  pushVertex(vertices, d, color, alpha);
  pushVertex(vertices, c, color, alpha);
}

function appendPolyline(vertices: number[], points: Point[], width: number, color: Color, alpha: number) {
  for (let i = 1; i < points.length; i += 1) {
    appendSegment(vertices, points[i - 1], points[i], width, color, alpha);
  }
}

function buildVertices(
  nodes: RFNode[],
  edges: RFEdge[],
  colors: ReturnType<typeof resolvePalette>,
  lldp: boolean,
  grouped: boolean,
  idleAlpha: number,
  traceAny: boolean,
  traceEdges: Set<string>,
): Float32Array {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const vertices: number[] = [];

  for (const edge of edges) {
    const source = byId.get(String(edge.source));
    const target = byId.get(String(edge.target));
    if (!source || !target) continue;

    const data = edge.data as EdgeData | undefined;
    const kind = data?.kind ?? 'edge';
    const start = handlePoint(source, edge.sourceHandle);
    const end = handlePoint(target, edge.targetHandle);
    const color = lldp ? colors[data?.lldp ?? 'none'] : colors[kind];
    const on = traceAny && (traceEdges.has(edge.id) || !!data?.forceOn);
    const dim = traceAny && !on;
    const count = data?.count ?? 1;
    const width = (on ? 2.6 : 1.1) + (count > 1 ? 1 : 0);
    const alpha = dim ? 0.12 : on ? 1 : idleAlpha;
    appendPolyline(
      vertices,
      routePoints(start, end, handleSide(source, edge.sourceHandle), handleSide(target, edge.targetHandle), kind, grouped),
      width,
      color,
      alpha,
    );
  }

  return new Float32Array(vertices);
}

function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    const parent = element?.parentElement;
    if (!parent) return;
    const update = () => {
      const rect = parent.getBoundingClientRect();
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function scheduleFrame(callback: () => void) {
  const id = window.requestAnimationFrame(callback);
  return () => window.cancelAnimationFrame(id);
}

export default function WebGLEdgeLayer({
  nodes,
  edges,
  lldp,
  mode,
  grouped,
  onUnavailable,
}: {
  nodes: RFNode[];
  edges: RFEdge[];
  lldp: boolean;
  mode: string;
  grouped: boolean;
  onUnavailable?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const programRef = useRef<ProgramInfo | null>(null);
  const uploadedVerticesRef = useRef<Float32Array | null>(null);
  const buildSeqRef = useRef(0);
  const viewport = useViewport();
  const size = useElementSize(canvasRef);
  const traceAny = useTrace((s) => s.any);
  const traceEdges = useTrace((s) => s.edges);
  const [vertices, setVertices] = useState<Float32Array<ArrayBufferLike>>(() => new Float32Array());

  const colors = useMemo(() => resolvePalette(mode), [mode]);
  const idleAlpha = useMemo(() => resolveIdleAlpha(mode), [mode]);

  useEffect(() => {
    const seq = buildSeqRef.current + 1;
    buildSeqRef.current = seq;
    if (!nodes.length || !edges.length) {
      setVertices(new Float32Array());
      return undefined;
    }
    const cancel = scheduleFrame(() => {
      const next = buildVertices(nodes, edges, colors, lldp, grouped, idleAlpha, traceAny, traceEdges);
      if (buildSeqRef.current === seq) setVertices(next);
    });
    return () => {
      buildSeqRef.current += 1;
      cancel();
    };
  }, [nodes, edges, colors, lldp, grouped, idleAlpha, traceAny, traceEdges]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.width || !size.height) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(size.width * dpr));
    const height = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const gl = canvas.getContext('webgl', { antialias: true, alpha: true });
    if (!gl) {
      onUnavailable?.();
      return;
    }
    let info: ProgramInfo;
    try {
      info = programRef.current ?? createProgram(gl);
    } catch {
      onUnavailable?.();
      return;
    }
    programRef.current = info;

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!vertices.length) {
      uploadedVerticesRef.current = null;
      return;
    }

    gl.useProgram(info.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, info.buffer);
    if (uploadedVerticesRef.current !== vertices) {
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      uploadedVerticesRef.current = vertices;
    }
    gl.uniform2f(info.resolution, width, height);
    gl.uniform2f(info.translate, viewport.x * dpr, viewport.y * dpr);
    gl.uniform1f(info.scale, viewport.zoom * dpr);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const stride = STRIDE * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(info.position);
    gl.vertexAttribPointer(info.position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(info.color);
    gl.vertexAttribPointer(info.color, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / STRIDE);
  }, [vertices, viewport.x, viewport.y, viewport.zoom, size.width, size.height, onUnavailable]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 3,
        pointerEvents: 'none',
      }}
    />
  );
}
