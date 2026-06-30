import type { LldpStatus } from '../domain/topology/contract';
import { pointAtFraction, type XY } from '../edges/edgeGeometry';
import { CABLE_COLOR, LLDP_COLOR } from '../graph/constants';
import type { CableKind } from '../graph/types';
import { resolveRgbColor } from './color';

export const EDGE_VERTEX_STRIDE = 9; // a_pos(2) a_norm(2) a_color(4) a_half(1)

export type EdgeDrawGeometry = {
  id: string;
  pts: XY[];
  n: number;
  mnx: Float64Array;
  mny: Float64Array;
  ml: Float64Array;
  kind?: CableKind;
  lldp?: LldpStatus;
  cnt: number;
  forceOn: boolean;
  a?: string;
  b?: string;
};

export type EdgeDrawLabel = {
  key: string;
  x: number;
  y: number;
  text: string;
  color: string;
  badge: boolean;
};

export function sameEdgeLabels(left: EdgeDrawLabel[], right: EdgeDrawLabel[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i], b = right[i];
    if (a.key !== b.key || a.x !== b.x || a.y !== b.y || a.text !== b.text || a.color !== b.color || a.badge !== b.badge) return false;
  }
  return true;
}

export function buildEdgeVertices({
  geometry,
  tracedEdges,
  traceAny,
  lldpOn,
  dark,
  lite,
}: {
  geometry: EdgeDrawGeometry[];
  tracedEdges: Set<string>;
  traceAny: boolean;
  lldpOn: boolean;
  dark: boolean;
  lite: boolean;
}): { vertices: Float32Array; vertexCount: number; labels: EdgeDrawLabel[] } {
  const theme = dark ? 'd' : 'l';
  const ordered = geometry.toSorted((a, b) => Number(tracedEdges.has(a.id)) - Number(tracedEdges.has(b.id))); // traced last
  const smallTrace = tracedEdges.size <= 4;
  let totalVerts = 0;
  for (const g of ordered) totalVerts += (g.n - 1) * 6;

  const vertices = new Float32Array(totalVerts * EDGE_VERTEX_STRIDE);
  let o = 0;
  const push = (x: number, y: number, nx: number, ny: number, col: [number, number, number], alpha: number, half: number) => {
    vertices[o++] = x;
    vertices[o++] = y;
    vertices[o++] = nx;
    vertices[o++] = ny;
    vertices[o++] = col[0];
    vertices[o++] = col[1];
    vertices[o++] = col[2];
    vertices[o++] = alpha;
    vertices[o++] = half;
  };

  const labels: EdgeDrawLabel[] = [];
  for (const g of ordered) {
    const on = tracedEdges.has(g.id) || g.forceOn;
    const dim = traceAny && !on;
    const css = lldpOn ? LLDP_COLOR[g.lldp ?? 'none'] : CABLE_COLOR[g.kind ?? 'isl'];
    const col = resolveRgbColor(css, theme);
    const alpha = dim ? 0.12 : on ? 1 : 0.55;
    const half = ((on ? 2.6 : 1.1) + (g.cnt > 1 ? 1 : 0)) / 2;
    const { pts, mnx, mny, ml, n } = g;
    for (let i = 0; i < n - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const mi = half * ml[i], mj = half * ml[i + 1];
      push(p.x, p.y, mnx[i], mny[i], col, alpha, mi);
      push(p.x, p.y, -mnx[i], -mny[i], col, alpha, mi);
      push(q.x, q.y, mnx[i + 1], mny[i + 1], col, alpha, mj);
      push(p.x, p.y, -mnx[i], -mny[i], col, alpha, mi);
      push(q.x, q.y, -mnx[i + 1], -mny[i + 1], col, alpha, mj);
      push(q.x, q.y, mnx[i + 1], mny[i + 1], col, alpha, mj);
    }
    if (lite) continue;
    if (g.cnt > 1) {
      const m = pointAtFraction(pts, 0.5);
      labels.push({ key: `${g.id}:n`, x: m.x, y: m.y, text: `×${g.cnt}`, color: css, badge: true });
    }
    if (on && smallTrace) {
      const pa = pointAtFraction(pts, 0.18), pb = pointAtFraction(pts, 0.82);
      if (g.a) labels.push({ key: `${g.id}:a`, x: pa.x, y: pa.y, text: g.a, color: css, badge: false });
      if (g.b) labels.push({ key: `${g.id}:b`, x: pb.x, y: pb.y, text: g.b, color: css, badge: false });
    }
  }

  return { vertices: vertices.subarray(0, o), vertexCount: o / EDGE_VERTEX_STRIDE, labels };
}
