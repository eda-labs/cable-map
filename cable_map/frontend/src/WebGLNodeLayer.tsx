import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useViewport, type Node as RFNode } from '@xyflow/react';
import { resolveNodePalette } from './webgl/color';
import { resizeCanvasToDisplaySize } from './webgl/canvas';
import { buildNodeVertices, NODE_VERTEX_STRIDE } from './webgl/nodeVertices';
import { linkProgram } from './webgl/program';

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

function createProgram(gl: WebGLRenderingContext): ProgramInfo {
  const program = linkProgram(gl, `
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
  `, `
    precision mediump float;
    varying vec4 v_color;

    void main() {
      gl_FragColor = v_color;
    }
  `);
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
  const palette = useMemo(() => resolveNodePalette(mode), [mode]);

  useEffect(() => {
    const seq = buildSeqRef.current + 1;
    buildSeqRef.current = seq;
    const cancel = scheduleIdle(() => {
      const next = buildNodeVertices(nodes, palette, lldp);
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
    const { width, height, dpr } = resizeCanvasToDisplaySize(canvas, size.width, size.height);

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

    const stride = NODE_VERTEX_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(info.position);
    gl.vertexAttribPointer(info.position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(info.color);
    gl.vertexAttribPointer(info.color, 4, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / NODE_VERTEX_STRIDE);
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
