import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, Position, type EdgeProps } from '@xyflow/react';
import { CABLE_COLOR, LLDP_COLOR, type CableKind } from '../graph';
import { useTrace, type Mode } from '../trace';
import { useLldp } from '../lldp';
import { useGroupedEdges } from './edgeRoute';
import type { LldpStatus } from '../domain/topology/contract';
import { cableRoute } from './edgeGeometry';

type Data = { kind: CableKind; a: string; b: string; count?: number; lldp?: LldpStatus; forceOn?: boolean; fast?: boolean };

// One physical cable. Routed handle-to-handle (port cell -> port cell / endpoint).
// Idle: a thin coloured thread. Traced: thick + fully opaque with both end labels shown
// right at their ports so the cabling tech can read source and destination at once.
function CableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const d = data as Data;
  const traceBits = useTrace((s) => [
    s.any ? '1' : '0',
    s.edges.has(id) ? '1' : '0',
    s.edges.size <= 4 ? '1' : '0',
    !id.startsWith('stub|') || s.key === `cable:${id}` ? '1' : '0',
  ].join(''));
  const traceAny = traceBits[0] === '1';
  const traced = traceBits[1] === '1';
  const smallTrace = traceBits[2] === '1';
  const remoteVisible = traceBits[3] === '1';
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
  const route = cableRoute({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, grouped, peerArch });

  const on = mode === 'on', dim = mode === 'dim';
  const count = d.count ?? 1;   // ISL port-channel: parallel members drawn as one ×N cable

  return (
    <>
      <BaseEdge id={id} path={route.path} interactionWidth={14}
        style={{
          stroke: color,
          strokeWidth: (on ? 2.6 : 1.1) + (count > 1 ? 1 : 0),
          opacity: dim ? 0.12 : on ? 1 : 'var(--edge-idle)',
          transition: 'stroke-width 120ms, opacity 120ms',
        }} />
      {count > 1 && (!d.fast || on) && (
        <EdgeLabelRenderer>
          <div style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${route.midpoint.x}px, ${route.midpoint.y}px)`,
            fontSize: 9, fontWeight: 800, lineHeight: 1.4, padding: '0 5px', borderRadius: 8,
            background: color, color: '#000', border: '1px solid rgba(0,0,0,0.35)',
            opacity: dim ? 0.2 : 1, pointerEvents: 'none', zIndex: 9,
          }}>×{count}</div>
        </EdgeLabelRenderer>
      )}
      {on && showLabel && (
        <EdgeLabelRenderer>
          <CableLabel x={route.sourceLabel.x} y={route.sourceLabel.y} text={d.a} color={color} />
          {remoteVisible && <CableLabel x={route.targetLabel.x} y={route.targetLabel.y} text={d.b} color={color} />}
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
