import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { CABLE_COLOR, type CableKind } from './graph';
import { useTrace, modeFor, type Mode } from './trace';

type Data = { kind: CableKind; a: string; b: string };

// One physical cable. Routed handle-to-handle (port cell -> port cell / endpoint).
// Idle: a thin coloured thread. Traced: thick + glowing with both end labels shown
// right at their ports so the cabling tech can read source and destination at once.
function CableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const d = data as Data;
  const mode: Mode = useTrace(modeFor((s) => s.edges.has(id)));
  // only label when a SMALL trace is active (single cable / LAG) — tracing a whole
  // switch lights 8-20 cables and stacked end labels would just be noise.
  const showLabel = useTrace((s) => s.edges.has(id) && s.edges.size <= 4);
  const color = CABLE_COLOR[d.kind];

  // ISL fabric cables curve; short server stubs use a tidy stepped drop.
  const [path] = d.kind === 'isl'
    ? getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
    : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 6 });

  const on = mode === 'on', dim = mode === 'dim';
  const lerp = (t: number) => ({ x: sourceX + (targetX - sourceX) * t, y: sourceY + (targetY - sourceY) * t });

  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={14}
        style={{
          stroke: color,
          strokeWidth: on ? 2.6 : 1.1,
          opacity: dim ? 0.12 : on ? 1 : 0.62,
          filter: on ? `drop-shadow(0 0 3px ${color})` : 'none',
          transition: 'stroke-width 120ms, opacity 120ms',
        }} />
      {on && showLabel && (
        <EdgeLabelRenderer>
          <CableLabel x={lerp(0.18).x} y={lerp(0.18).y} text={d.a} color={color} />
          <CableLabel x={lerp(0.82).x} y={lerp(0.82).y} text={d.b} color={color} />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function CableLabel({ x, y, text, color }: { x: number; y: number; text: string; color: string }) {
  return (
    <div style={{
      position: 'absolute', transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
      fontSize: 10, fontWeight: 700, lineHeight: 1.3, padding: '1px 5px', borderRadius: 4,
      background: '#0B1119', color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
      pointerEvents: 'none', zIndex: 10,
    }}>{text}</div>
  );
}

export default memo(CableEdge);
