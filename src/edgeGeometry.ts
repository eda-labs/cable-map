// Faithful port of React Flow's edge path math (@xyflow/system: bezier-edge + smoothstep-edge),
// adapted to emit a sampled POLYLINE (XY points) instead of an SVG path string — so the WebGL layer
// tessellates the *exact* same curves React Flow's SVG edges draw. The SVG edges keep using React
// Flow's native getBezierPath/getSmoothStepPath (smooth C/Q commands); sampling that same geometry
// here makes the GL cables visually identical. Keep this in sync with the upstream source.
import { Position } from '@xyflow/react';

export type XY = { x: number; y: number };

// ---- shared ---------------------------------------------------------------
const distance = (a: XY, b: XY) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

// ---- bezier (getControlWithCurvature / calculateControlOffset / getBezierPath) ----
const controlOffset = (d: number, c = 0.25) => (d >= 0 ? 0.5 * d : c * 25 * Math.sqrt(-d));
function control(pos: Position, x1: number, y1: number, x2: number, y2: number): XY {
  switch (pos) {
    case Position.Left: return { x: x1 - controlOffset(x1 - x2), y: y1 };
    case Position.Right: return { x: x1 + controlOffset(x2 - x1), y: y1 };
    case Position.Top: return { x: x1, y: y1 - controlOffset(y1 - y2) };
    default: return { x: x1, y: y1 + controlOffset(y2 - y1) }; // Bottom
  }
}
const cubicAt = (p0: number, c1: number, c2: number, p1: number, t: number) => {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * c1 + 3 * m * t * t * c2 + t * t * t * p1;
};
function bezierPolyline(s: XY, sp: Position, t: XY, tp: Position): XY[] {
  const c1 = control(sp, s.x, s.y, t.x, t.y);
  const c2 = control(tp, t.x, t.y, s.x, s.y);
  // sample density from the control-polygon length so long/curvier cables stay smooth
  const span = distance(s, c1) + distance(c1, c2) + distance(c2, t);
  const segs = Math.min(96, Math.max(16, Math.round(span / 11)));
  const out: XY[] = [{ x: s.x, y: s.y }];
  for (let i = 1; i <= segs; i++) {
    const u = i / segs;
    out.push({ x: cubicAt(s.x, c1.x, c2.x, t.x, u), y: cubicAt(s.y, c1.y, c2.y, t.y, u) });
  }
  return out;
}

// ---- smoothstep (handleDirections / getDirection / getPoints / getBend) ----
const handleDirections: Record<Position, XY> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};
const getDirection = (source: XY, sourcePosition: Position, target: XY): XY => {
  if (sourcePosition === Position.Left || sourcePosition === Position.Right) return source.x < target.x ? { x: 1, y: 0 } : { x: -1, y: 0 };
  return source.y < target.y ? { x: 0, y: 1 } : { x: 0, y: -1 };
};

// getPoints — orthogonal waypoints (verbatim port; center is always default, label/offset dropped)
function getPoints(source: XY, sourcePosition: Position, target: XY, targetPosition: Position, offset: number, stepPosition: number): XY[] {
  const sourceDir = handleDirections[sourcePosition];
  const targetDir = handleDirections[targetPosition];
  const sourceGapped: XY = { x: source.x + sourceDir.x * offset, y: source.y + sourceDir.y * offset };
  const targetGapped: XY = { x: target.x + targetDir.x * offset, y: target.y + targetDir.y * offset };
  const dir = getDirection(sourceGapped, sourcePosition, targetGapped);
  const dirAccessor: 'x' | 'y' = dir.x !== 0 ? 'x' : 'y';
  const currDir = dir[dirAccessor];
  let points: XY[] = [];
  const sourceGapOffset: XY = { x: 0, y: 0 };
  const targetGapOffset: XY = { x: 0, y: 0 };

  if (sourceDir[dirAccessor] * targetDir[dirAccessor] === -1) {
    // opposite handle positions (default case)
    let centerX: number, centerY: number;
    if (dirAccessor === 'x') {
      centerX = sourceGapped.x + (targetGapped.x - sourceGapped.x) * stepPosition;
      centerY = (sourceGapped.y + targetGapped.y) / 2;
    } else {
      centerX = (sourceGapped.x + targetGapped.x) / 2;
      centerY = sourceGapped.y + (targetGapped.y - sourceGapped.y) * stepPosition;
    }
    const verticalSplit: XY[] = [{ x: centerX, y: sourceGapped.y }, { x: centerX, y: targetGapped.y }];
    const horizontalSplit: XY[] = [{ x: sourceGapped.x, y: centerY }, { x: targetGapped.x, y: centerY }];
    if (sourceDir[dirAccessor] === currDir) points = dirAccessor === 'x' ? verticalSplit : horizontalSplit;
    else points = dirAccessor === 'x' ? horizontalSplit : verticalSplit;
  } else {
    const sourceTarget: XY[] = [{ x: sourceGapped.x, y: targetGapped.y }];
    const targetSource: XY[] = [{ x: targetGapped.x, y: sourceGapped.y }];
    if (dirAccessor === 'x') points = sourceDir.x === currDir ? targetSource : sourceTarget;
    else points = sourceDir.y === currDir ? sourceTarget : targetSource;

    if (sourcePosition === targetPosition) {
      const diff = Math.abs(source[dirAccessor] - target[dirAccessor]);
      if (diff <= offset) {
        const gapOffset = Math.min(offset - 1, offset - diff);
        if (sourceDir[dirAccessor] === currDir) sourceGapOffset[dirAccessor] = (sourceGapped[dirAccessor] > source[dirAccessor] ? -1 : 1) * gapOffset;
        else targetGapOffset[dirAccessor] = (targetGapped[dirAccessor] > target[dirAccessor] ? -1 : 1) * gapOffset;
      }
    }
    if (sourcePosition !== targetPosition) {
      const opp: 'x' | 'y' = dirAccessor === 'x' ? 'y' : 'x';
      const isSameDir = sourceDir[dirAccessor] === targetDir[opp];
      const sourceGtTargetOppo = sourceGapped[opp] > targetGapped[opp];
      const sourceLtTargetOppo = sourceGapped[opp] < targetGapped[opp];
      const flip = (sourceDir[dirAccessor] === 1 && ((!isSameDir && sourceGtTargetOppo) || (isSameDir && sourceLtTargetOppo))) ||
        (sourceDir[dirAccessor] !== 1 && ((!isSameDir && sourceLtTargetOppo) || (isSameDir && sourceGtTargetOppo)));
      if (flip) points = dirAccessor === 'x' ? sourceTarget : targetSource;
    }
  }

  const gappedSource: XY = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
  const gappedTarget: XY = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
  return [
    source,
    ...(gappedSource.x !== points[0].x || gappedSource.y !== points[0].y ? [gappedSource] : []),
    ...points,
    ...(gappedTarget.x !== points[points.length - 1].x || gappedTarget.y !== points[points.length - 1].y ? [gappedTarget] : []),
    target,
  ];
}

const quadAt = (p0: XY, c: XY, p1: XY, t: number): XY => {
  const m = 1 - t;
  return { x: m * m * p0.x + 2 * m * t * c.x + t * t * p1.x, y: m * m * p0.y + 2 * m * t * c.y + t * t * p1.y };
};
// getBend — emit the rounded corner as points (the `L lead-in` + sampled `Q b lead-out`)
function pushBend(out: XY[], a: XY, b: XY, c: XY, size: number) {
  const bendSize = Math.min(distance(a, b) / 2, distance(b, c) / 2, size);
  const { x, y } = b;
  if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) { out.push({ x, y }); return; } // collinear: no bend
  let leadIn: XY, leadOut: XY;
  if (a.y === y) { // first segment horizontal
    leadIn = { x: x + bendSize * (a.x < c.x ? -1 : 1), y };
    leadOut = { x, y: y + bendSize * (a.y < c.y ? 1 : -1) };
  } else {
    leadIn = { x, y: y + bendSize * (a.y < c.y ? -1 : 1) };
    leadOut = { x: x + bendSize * (a.x < c.x ? 1 : -1), y };
  }
  out.push(leadIn);
  const k = Math.max(3, Math.min(16, Math.round(bendSize / 2)));
  for (let i = 1; i <= k; i++) out.push(quadAt(leadIn, b, leadOut, i / k));
}
function roundedPolyline(wp: XY[], borderRadius: number): XY[] {
  const pts = wp.filter((p, i) => i === 0 || p.x !== wp[i - 1].x || p.y !== wp[i - 1].y); // drop dupes
  const out: XY[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) pushBend(out, pts[i - 1], pts[i], pts[i + 1], borderRadius);
  out.push(pts[pts.length - 1]);
  return out;
}
function smoothStepPolyline(s: XY, sp: Position, t: XY, tp: Position, borderRadius: number, sDx: number, tDx: number): XY[] {
  const sDir = handleDirections[sp], tDir = handleDirections[tp];
  const vertical = sDir.x === 0 && tDir.x === 0 && sDir.y * tDir.y === -1; // Top<->Bottom elbow
  // offset the vertical stems with an ORTHOGONAL jog (out of the port, step sideways, then straight to
  // the bus) so stacked ports separate without an angled lead-out. Only for the vertical opposite case;
  // otherwise fall back to React Flow's faithful smoothstep.
  if (vertical && (sDx || tDx)) {
    const off = 5;                                 // step right at the port edge (compact, not a long stem)
    const sGapY = s.y + sDir.y * off, tGapY = t.y + tDir.y * off;
    const midY = (s.y + t.y) / 2;                  // bus midpoint
    // short out-of-port segments keep the step corners tight; the long stem->bus corners get the full radius
    return roundedPolyline([
      s, { x: s.x, y: sGapY }, { x: s.x + sDx, y: sGapY }, { x: s.x + sDx, y: midY },
      { x: t.x + tDx, y: midY }, { x: t.x + tDx, y: tGapY }, { x: t.x, y: tGapY }, t,
    ], borderRadius);
  }
  return roundedPolyline(getPoints(s, sp, t, tp, 20, 0.5), borderRadius);
}

// peer-arch: same-tier ISL (both ports on Top) arched up over the open gap, instead of a flat bezier
// buried under the panels. Matches CableEdge's control points + lift formula.
function archPolyline(s: XY, t: XY): XY[] {
  const lift = Math.min(Math.max(Math.abs(t.x - s.x) * 0.35, 60), 200);
  const c1: XY = { x: s.x, y: s.y - lift }, c2: XY = { x: t.x, y: t.y - lift };
  const span = distance(s, c1) + distance(c1, c2) + distance(c2, t);
  const segs = Math.min(96, Math.max(16, Math.round(span / 11)));
  const out: XY[] = [{ x: s.x, y: s.y }];
  for (let i = 1; i <= segs; i++) {
    const u = i / segs;
    out.push({ x: cubicAt(s.x, c1.x, c2.x, t.x, u), y: cubicAt(s.y, c1.y, c2.y, t.y, u) });
  }
  return out;
}

// Public: the polyline for one cable, matching the SVG edge's routing. Precedence mirrors CableEdge:
// peer-arch first, then grouped (smoothstep), else bezier.
export function cablePolyline(s: XY, sp: Position, t: XY, tp: Position, grouped: boolean, peerArch = false, sDx = 0, tDx = 0, borderRadius = 16): XY[] {
  if (peerArch) return archPolyline(s, t);
  return grouped ? smoothStepPolyline(s, sp, t, tp, borderRadius, sDx, tDx) : bezierPolyline(s, sp, t, tp);
}

// point at arc-length fraction f along a polyline (for label anchoring: 0.5 = midpoint, 0.18/0.82 = ends)
export function pointAtFraction(pts: XY[], f: number): XY {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = distance(pts[i], pts[i + 1]); seg.push(l); total += l; }
  let target = total * f, acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= target) { const u = seg[i] ? (target - acc) / seg[i] : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * u, y: pts[i].y + (pts[i + 1].y - pts[i].y) * u }; }
    acc += seg[i];
  }
  return pts[pts.length - 1];
}

// nearest distance from a point to a polyline (for cable hover hit-testing)
export function distToPolyline(pts: XY[], px: number, py: number): number {
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, ay = pts[i].y, dx = pts[i + 1].x - ax, dy = pts[i + 1].y - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy, d = (px - cx) ** 2 + (py - cy) ** 2;
    if (d < min) min = d;
  }
  return Math.sqrt(min);
}
