import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CABLE_COLOR, type EndpointData } from './graph';
import { trace, useTrace, modeFor } from './trace';

// A server / LAG peer hanging off a leaf's edge port. LAGs collapse their members
// into one chip with a member count so a 2-cable bond reads as a single endpoint.
function EndpointNode({ id, data }: NodeProps) {
  const d = data as EndpointData;
  const color = d.kind === 'lag' ? CABLE_COLOR.lag : CABLE_COLOR.edge;
  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const ports = d.localPorts.join(', ');

  return (
    <div
      data-mode={mode}
      onMouseEnter={() => trace.hover(`node:${id}`)}
      onMouseLeave={() => trace.hover(null)}
      onClick={(e) => { e.stopPropagation(); trace.pin(`node:${id}`); }}
      title={`${d.full} · ${d.remotePort}\nleaf ports ${ports}`}
      style={{
        position: 'relative', width: 112, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px',
        borderRadius: 5, background: 'var(--panel)',
        border: `1px solid ${mode === 'on' ? color : 'var(--line)'}`,
        borderLeft: `3px solid ${color}`,
        opacity: mode === 'dim' ? 0.3 : 1, transition: 'opacity 140ms, border-color 140ms',
        boxShadow: mode === 'on' ? `0 0 8px -1px ${color}` : 'none', cursor: 'pointer',
      }}
    >
      <Handle type="target" id="in" position={Position.Top} isConnectable={false}
        style={{ width: 6, height: 6, background: color, border: 0, top: -2 }} />
      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</span>
      <span style={{ flex: 1 }} />
      {d.kind === 'lag'
        ? <span style={{ fontSize: 8, fontWeight: 700, color: '#000', background: color, borderRadius: 3, padding: '0 4px' }}>LAG×{d.members}</span>
        : <span style={{ fontSize: 8.5, color: 'var(--muted)' }}>{d.remotePort}</span>}
    </div>
  );
}

export default memo(EndpointNode);
