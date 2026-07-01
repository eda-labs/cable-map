import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CABLE_COLOR, LLDP_COLOR, type EndpointData } from './graph';
import { trace, useTrace, modeFor } from './trace';
import { useLldp } from './lldp';

// A server / LAG peer hanging off a leaf's edge port. LAGs collapse their members into
// one chip with a member count; a multihomed (ESI) bond is one shared chip whose stubs
// fan up to every leaf it homes to, so the dual-homing reads at a glance.
function EndpointNode({ id, data }: NodeProps) {
  const d = data as EndpointData;
  const renderHandles = d.renderHandles !== false;
  const lldpOn = useLldp();
  const color = lldpOn ? LLDP_COLOR[d.lldp ?? 'none'] : CABLE_COLOR[d.kind];
  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const kindWord = d.kind === 'mlag' ? 'ESI / multihomed' : d.kind === 'lag' ? 'local LAG' : 'edge';
  const title =
    `${d.full}\n${kindWord}${d.lacp ? ' · LACP' : ''}${d.mode ? ' · ' + d.mode : ''}` +
    `\n${d.members} member${d.members > 1 ? 's' : ''} → ${d.leaves.join(', ')}`;

  return (
    <div
      data-mode={mode}
      onMouseEnter={() => trace.hover(`node:${id}`)}
      onMouseLeave={() => trace.hover(null)}
      onClick={(e) => { e.stopPropagation(); trace.pin(`node:${id}`); }}
      title={title}
      style={{
        position: 'relative', width: 112, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px',
        borderRadius: 5, background: 'var(--panel)',
        border: `1px solid ${mode === 'on' ? color : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.3 : 1, transition: 'opacity 140ms, border-color 140ms',
        cursor: 'pointer',
      }}
    >
      {renderHandles && (
        <Handle type="target" id="in" position={Position.Top} isConnectable={false}
          style={{ width: 6, height: 6, background: color, border: 0, top: -2 }} />
      )}
      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</span>
      <span style={{ flex: 1 }} />
      {d.kind === 'edge'
        ? <span style={{ fontSize: 8.5, color: 'var(--muted)' }}>{d.remotePort}</span>
        : <span style={{ fontSize: 8, fontWeight: 700, color: '#000', background: color, borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>
            {d.kind === 'mlag' ? 'ESI' : 'LAG'}×{d.members}
          </span>}
    </div>
  );
}

export default memo(EndpointNode);
