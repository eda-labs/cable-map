import { memo, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CABLE_COLOR, type PortInfo, type SwitchData } from './graph';
import { trace, useTrace, modeFor } from './trace';
import spineIcon from './icons/spine.svg?raw';
import leafIcon from './icons/leaf.svg?raw';
import superspineIcon from './icons/superspine.svg?raw';

const RoleIcons: Record<string, string> = {
  spine: spineIcon, superspine: superspineIcon, leaf: leafIcon, borderleaf: leafIcon,
};

const CELL = 13, CELL_GAP = 3;
const fillFor = (kind: PortInfo['kind']) => (kind === 'free' ? 'transparent' : CABLE_COLOR[kind]);

// A single front-panel cage. Occupied ports carry the handles cables attach to,
// and glow when their cable is being traced.
function PortCell({ info, hot }: { info: PortInfo; hot: boolean }) {
  const free = info.kind === 'free';
  const side = info.side === 'top' ? Position.Top : Position.Bottom;
  return (
    <div
      data-port={info.port}
      onMouseEnter={free ? undefined : (e) => { e.stopPropagation(); trace.hover(`cable:${info.cableId}`); }}
      onClick={free ? undefined : (e) => { e.stopPropagation(); trace.pin(`cable:${info.cableId}`); }}
      title={free ? `port ${info.port} · free` : `${info.port} → ${info.remote} ${info.remotePort}`}
      style={{
        position: 'relative', width: CELL, height: CELL, borderRadius: 2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 7, lineHeight: 1, fontWeight: 700,
        color: free ? 'var(--cell-free-fg)' : 'rgba(0,0,0,0.78)',
        background: free ? 'var(--cell-free-bg)' : fillFor(info.kind),
        outline: hot ? '2px solid var(--port-hot-ring)' : free ? '1px solid var(--cell-free-line)' : '1px solid rgba(0,0,0,0.35)',
        outlineOffset: hot ? 0 : -1,
        boxShadow: hot ? `0 0 8px 1px ${fillFor(info.kind)}` : 'none',
        cursor: free ? 'default' : 'pointer', zIndex: hot ? 2 : 1,
      }}
    >
      {!free && info.port}
      {!free && (
        <>
          <Handle type="source" id={`p${info.port}`} position={side} isConnectable={false}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'none', minWidth: 0, minHeight: 0, border: 0, opacity: 0, background: 'transparent', borderRadius: 0 }} />
          <Handle type="target" id={`p${info.port}t`} position={side} isConnectable={false}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'none', minWidth: 0, minHeight: 0, border: 0, opacity: 0, background: 'transparent', borderRadius: 0 }} />
        </>
      )}
    </div>
  );
}

function SwitchNode({ id, data, selected }: NodeProps) {
  const d = data as SwitchData;
  const rows = Math.max(1, d.rows);
  const cols = Math.ceil(d.portCount / rows);
  const icon = RoleIcons[d.role];

  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  // which of THIS node's ports are part of the active trace (one subscription)
  const activeStr = useTrace((s) => {
    if (!s.any) return '';
    const out: number[] = [];
    for (const p of s.ports) if (p.startsWith(`${id}:`)) out.push(Number(p.slice(id.length + 1)));
    return out.toSorted((a, b) => a - b).join(',');
  });
  const hotPorts = useMemo(() => new Set(activeStr ? activeStr.split(',').map(Number) : []), [activeStr]);

  const byPort = useMemo(() => new Map(d.ports.map((p) => [p.port, p])), [d.ports]);
  const cells = useMemo(
    () => Array.from({ length: d.portCount }, (_, i): PortInfo =>
      byPort.get(i + 1) ?? { port: i + 1, kind: 'free', side: 'bottom', remote: '', remotePort: '', desc: '', cableId: '' }),
    [d.portCount, byPort],
  );
  const used = d.ports.length;

  return (
    <div
      className="switch-node"
      data-mode={mode}
      onMouseEnter={() => trace.hover(`node:${id}`)}
      onMouseLeave={() => trace.hover(null)}
      style={{
        background: 'var(--panel)', borderRadius: 8, padding: 8,
        border: `1.5px solid ${selected ? '#5B9BFF' : mode === 'on' ? 'var(--node-ring)' : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.32 : 1, transition: 'opacity 140ms, border-color 140ms',
        boxShadow: mode === 'on' ? '0 0 0 1px var(--node-ring-soft)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, height: 20 }}>
        {icon && <span style={{ lineHeight: 0, width: 18, height: 18 }} dangerouslySetInnerHTML={{ __html: icon.replace(/width="\d+"/, 'width="18"').replace(/height="\d+"/, 'height="18"') }} />}
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)' }}>{d.name}</span>
        <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 400 }}>{d.platform}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 8.5, color: 'var(--muted)' }}>{used}/{d.portCount}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${CELL}px)`, gridTemplateRows: `repeat(${rows}, ${CELL}px)`, gridAutoFlow: 'column', gap: CELL_GAP }}>
        {cells.map((info) => (
          <PortCell key={info.port} info={info} hot={hotPorts.has(info.port)} />
        ))}
      </div>
    </div>
  );
}

export default memo(SwitchNode);
