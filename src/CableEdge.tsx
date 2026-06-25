import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, Position, type EdgeProps } from '@xyflow/react';
import { CABLE_COLOR, LLDP_COLOR, type CableKind } from './graph';
import { useTrace, type Mode } from './trace';
import { useLldp } from './lldp';
import { useGroupedEdges } from './edgeRoute';
import type { LldpStatus } from './api';

type Data = { kind: CableKind; a: string; b: string; count?: number; lldp?: LldpStatus; forceOn?: boolean };

const ctrlOffset = (dist: number, c = 0.25) => (dist >= 0 ? 0.5 * dist : c * 25 * Math.sqrt(-dist));
function control(pos: Position, x1: number, y1: number, x2: number, y2: number): [number, number] {
  switch (pos) {
    case Position.Left: return [x1 - ctrlOffset(x1 - x2), y1];
    case Position.Right: return [x1 + ctrlOffset(x2 - x1), y1];
    case Position.Top: return [x1, y1 - ctrlOffset(y1 - y2)];
    default: return [x1, y1 + ctrlOffset(y2 - y1)];
  }
}

// One physical cable. Routed handle-to-handle (port cell -> port cell / endpoint).
// Idle: a thin coloured thread. Traced: thick + fully opaque with both end labels shown
// right at their ports so the cabling tech can read source and destination at once.
function CableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const d = data as Data;
  const traced = useTrace((s) => s.edges.has(id));
  const traceAny = useTrace((s) => s.any);
  const smallTrace = useTrace((s) => s.edges.size <= 4);
  const remoteVisible = useTrace((s) => !id.startsWith('stub|') || s.key === `cable:${id}`);
  const mode: Mode = !traceAny ? 'idle' : traced || d.forceOn ? 'on' : 'dim';
  // only label when a SMALL trace is active (single cable / LAG) — tracing a whole
  // switch lights 8-20 cables and stacked end labels would just be noise.
  const showLabel = (traced || !!d.forceOn) && smallTrace;
  // LLDP overlay recolours every cable by neighbour-confirmation status instead of kind.
  const lldpOn = useLldp();
  const color = lldpOn ? LLDP_COLOR[d.lldp ?? 'none'] : CABLE_COLOR[d.kind];
  const grouped = useGroupedEdges();

  // A same-tier peer link (leaf↔leaf ISL) has both ends on the top side at the same height,
  // where getBezierPath collapses to a flat line buried under the panels — arch it up over the
  // open space instead. Every other link is a plain bezier curve.
  // labelX/labelY is the path midpoint, used to anchor the bundle ×N badge onto the curve.
  const peerArch = d.kind === 'isl' && sourcePosition === Position.Top && targetPosition === Position.Top;
  const lift = peerArch ? Math.min(Math.max(Math.abs(targetX - sourceX) * 0.35, 60), 200) : 0;
  let path: string, labelX: number, labelY: number, c1x: number, c1y: number, c2x: number, c2y: number;
  if (peerArch) {
    c1x = sourceX; c1y = sourceY - lift; c2x = targetX; c2y = targetY - lift;
    path = `M${sourceX},${sourceY} C${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = (sourceY + targetY) / 2 - lift * 0.75;
  } else if (grouped) {
    // Shared-bus routing: orthogonal stems straight out of each port into a common horizontal
    // corridor at the vertical midpoint (rounded corners), collapsing dense diagonals into a tidy bus.
    const midY = (sourceY + targetY) / 2;
    c1x = sourceX; c1y = midY; c2x = targetX; c2y = midY;   // approx control points for the label sampler
    const [sp, lx, ly] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 16 });
    path = sp; labelX = lx; labelY = ly;
  } else {
    [c1x, c1y] = control(sourcePosition, sourceX, sourceY, targetX, targetY);
    [c2x, c2y] = control(targetPosition, targetX, targetY, sourceX, sourceY);
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  }

  const on = mode === 'on', dim = mode === 'dim';
  const count = d.count ?? 1;   // ISL port-channel: parallel members drawn as one ×N cable
  const at = (t: number) => {
    const mt = 1 - t, w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
    return {
      x: w0 * sourceX + w1 * c1x + w2 * c2x + w3 * targetX,
      y: w0 * sourceY + w1 * c1y + w2 * c2y + w3 * targetY,
    };
  };

  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={14}
        style={{
          stroke: color,
          strokeWidth: (on ? 2.6 : 1.1) + (count > 1 ? 1 : 0),
          opacity: dim ? 0.12 : on ? 1 : 'var(--edge-idle)',
          transition: 'stroke-width 120ms, opacity 120ms',
        }} />
      {count > 1 && (
        <EdgeLabelRenderer>
          <div style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            fontSize: 9, fontWeight: 800, lineHeight: 1.4, padding: '0 5px', borderRadius: 8,
            background: color, color: '#000', border: '1px solid rgba(0,0,0,0.35)',
            opacity: dim ? 0.2 : 1, pointerEvents: 'none', zIndex: 9,
          }}>×{count}</div>
        </EdgeLabelRenderer>
      )}
      {on && showLabel && (
        <EdgeLabelRenderer>
          <CableLabel x={at(0.18).x} y={at(0.18).y} text={d.a} color={color} />
          {remoteVisible && <CableLabel x={at(0.82).x} y={at(0.82).y} text={d.b} color={color} />}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function CableLabel({ x, y, text, color }: { x: number; y: number; text: string; color: string }) {
  return (
    <div style={{
      position: 'absolute', transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
      fontSize: 10, fontWeight: 600, lineHeight: 1.3, padding: '1px 6px', borderRadius: 4,
      background: 'var(--label-bg)', color: 'var(--fg)',
      border: `1px solid ${color}`,
      whiteSpace: 'nowrap', pointerEvents: 'none', zIndex: 10,
    }}>{text}</div>
  );
}

export default memo(CableEdge);
