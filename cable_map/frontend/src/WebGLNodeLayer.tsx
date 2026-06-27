import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useViewport, type Node as RFNode } from '@xyflow/react';
import {
  CABLE_COLOR, LLDP_COLOR, switchPortCenter,
  type CableKind, type EndpointData, type PortInfo, type SwitchData,
} from './graph';

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
type IdleScheduler = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

const STRIDE = 6;
const ENDPOINT_W = 112;
const ENDPOINT_H = 22;

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
    panel: resolveColor('var(--panel)'),
    line: resolveColor('var(--line)'),
    free: resolveColor('var(--cell-free-bg)'),
    isl: resolveColor(CABLE_COLOR.isl),
    edge: resolveColor(CABLE_COLOR.edge),
    lag: resolveColor(CABLE_COLOR.lag),
    mlag: resolveColor(CABLE_COLOR.mlag),
    ok: resolveColor(LLDP_COLOR.ok),
    mismatch: resolveColor(LLDP_COLOR.mismatch),
    none: resolveColor(LLDP_COLOR.none),
  };
}

function pushVertex(vertices: number[], x: number, y: number, color: Color, alpha = 1) {
  vertices.push(x, y, color[0], color[1], color[2], color[3] * alpha);
}

function pushRect(vertices: number[], x: number, y: number, width: number, height: number, color: Color, alpha = 1) {
  if (width <= 0 || height <= 0) return;
  pushVertex(vertices, x, y, color, alpha);
  pushVertex(vertices, x, y + height, color, alpha);
  pushVertex(vertices, x + width, y, color, alpha);
  pushVertex(vertices, x, y + height, color, alpha);
  pushVertex(vertices, x + width, y + height, color, alpha);
  pushVertex(vertices, x + width, y, color, alpha);
}

function pushBorder(vertices: number[], x: number, y: number, width: number, height: number, color: Color) {
  const s = 1.5;
  pushRect(vertices, x, y, width, s, color, 0.8);
  pushRect(vertices, x, y + height - s, width, s, color, 0.8);
  pushRect(vertices, x, y, s, height, color, 0.8);
  pushRect(vertices, x + width - s, y, s, height, color, 0.8);
}

function colorForPort(info: PortInfo, palette: ReturnType<typeof resolvePalette>, lldp: boolean): Color {
  if (lldp && (info.lldp === 'ok' || info.lldp === 'mismatch' || info.lldp === 'none')) return palette[info.lldp];
  if (info.kind in CABLE_COLOR) return palette[info.kind as CableKind];
  return palette.free;
}

function colorForEndpoint(data: EndpointData, palette: ReturnType<typeof resolvePalette>, lldp: boolean): Color {
  if (lldp && (data.lldp === 'ok' || data.lldp === 'mismatch' || data.lldp === 'none')) return palette[data.lldp];
  return palette[data.kind];
}

function buildVertices(nodes: RFNode[], palette: ReturnType<typeof resolvePalette>, lldp: boolean): Float32Array {
  const vertices: number[] = [];

  for (const node of nodes) {
    const width = node.width ?? node.measured?.width ?? (node.type === 'endpoint' ? ENDPOINT_W : 180);
    const height = node.height ?? node.measured?.height ?? (node.type === 'endpoint' ? ENDPOINT_H : 80);
    const x = node.position.x;
    const y = node.position.y;

    if (node.type === 'endpoint') {
      const data = node.data as EndpointData;
      const color = colorForEndpoint(data, palette, lldp);
      pushRect(vertices, x, y, width, height, palette.line, 0.22);
      pushRect(vertices, x, y, width, 4, color, 1);
      pushBorder(vertices, x, y, width, height, color);
      continue;
    }

    const data = node.data as SwitchData;
    pushRect(vertices, x, y, width, height, palette.line, 0.2);
    pushRect(vertices, x + 1, y + 1, width - 2, Math.min(18, height * 0.28), palette.free, 0.65);
    pushBorder(vertices, x, y, width, height, palette.line);

    for (const port of data.ports) {
      const center = switchPortCenter(data, port.port, port.channel);
      if (!center) continue;
      const color = colorForPort(port, palette, lldp);
      const portW = port.channel ? 3.5 : 5.5;
      const portH = 4.5;
      pushRect(vertices, x + center.x - portW / 2, y + center.y - portH / 2, portW, portH, color, 1);
    }
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

function scheduleIdle(callback: () => void) {
  const scheduler = window as IdleScheduler;
  if (scheduler.requestIdleCallback && scheduler.cancelIdleCallback) {
    const id = scheduler.requestIdleCallback(callback, { timeout: 450 });
    return () => scheduler.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, 0);
  return () => window.clearTimeout(id);
}

export default function WebGLNodeLayer({
  nodes,
  lldp,
  mode,
  visible,
  onUnavailable,
}: {
  nodes: RFNode[];
  lldp: boolean;
  mode: string;
  visible: boolean;
  onUnavailable?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const programRef = useRef<ProgramInfo | null>(null);
  const uploadedVerticesRef = useRef<Float32Array | null>(null);
  const buildSeqRef = useRef(0);
  const viewport = useViewport();
  const size = useElementSize(canvasRef);
  const [vertices, setVertices] = useState<Float32Array<ArrayBufferLike>>(() => new Float32Array());
  const palette = useMemo(() => resolvePalette(mode), [mode]);

  useEffect(() => {
    const seq = buildSeqRef.current + 1;
    buildSeqRef.current = seq;
    const cancel = scheduleIdle(() => {
      const next = buildVertices(nodes, palette, lldp);
      if (buildSeqRef.current === seq) setVertices(next);
    });
    return () => {
      buildSeqRef.current += 1;
      cancel();
    };
  }, [nodes, palette, lldp]);

  useEffect(() => {
    if (!visible) return;
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
    if (!vertices.length) return;

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
  }, [visible, vertices, viewport.x, viewport.y, viewport.zoom, size.width, size.height, onUnavailable]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-layer="webgl-nodes"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 4,
        opacity: visible ? 1 : 0,
        pointerEvents: 'none',
      }}
    />
  );
}
