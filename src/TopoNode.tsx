import { useCallback } from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { facingSide } from './edgeUtils';
import spineIcon from './icons/spine.svg?raw';
import leafIcon from './icons/leaf.svg?raw';
import superspineIcon from './icons/superspine.svg?raw';

// role -> device icon, same mapping topo-builder uses
const RoleIcons: Record<string, string> = {
  spine: spineIcon, superspine: superspineIcon, leaf: leafIcon, borderleaf: leafIcon,
};

const SIDES: [string, Position][] = [
  ['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom], ['left', Position.Left],
];

// Node icon + name, styled after topo-builder's BaseNode. Handle dots show on the
// sides that actually have a link (computed from node geometry, like floating edges).
export default function TopoNode({ id, data, selected }: NodeProps) {
  const { name, role } = data as { name: string; role: string };
  const icon = RoleIcons[role];

  // which sides have a connected edge — primitive string keeps the selector stable
  const connectedStr = useStore(useCallback((s) => {
    const me = s.nodeLookup.get(id);
    if (!me) return '';
    const sides = new Set<string>();
    for (const e of s.edges) {
      const otherId = e.source === id ? e.target : e.target === id ? e.source : null;
      if (!otherId) continue;
      const other = s.nodeLookup.get(otherId);
      if (other) sides.add(facingSide(me, other));
    }
    return [...sides].toSorted().join(',');
  }, [id]));
  const connected = new Set(connectedStr ? connectedStr.split(',') : []);

  return (
    <div className="topo-node" style={{
      width: 80, height: 80, background: 'var(--color-node-bg)', borderRadius: 8,
      border: `1px solid ${selected ? 'var(--color-node-border-selected)' : 'var(--color-node-border)'}`,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
    }}>
      {SIDES.map(([hid, pos]) => (
        <Handle key={hid} type="source" id={hid} position={pos} className="topo-handle-src" style={{
          width: 10, height: 10, borderRadius: '50%', background: 'var(--color-handle-bg)',
          border: '1px solid var(--color-node-border)', transition: 'opacity 150ms',
          opacity: selected || connected.has(pos) ? 1 : 0,
        }} />
      ))}
      {SIDES.map(([hid, pos]) => (
        <Handle key={`${hid}-t`} type="target" id={`${hid}-target`} position={pos}
          style={{ width: 10, height: 10, opacity: 0, minWidth: 0, minHeight: 0, border: 0, background: 'transparent' }} />
      ))}
      {icon && <span style={{ pointerEvents: 'none', lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: icon }} />}
      <div title={name} style={{
        maxWidth: 76, fontSize: 12, lineHeight: '16px', fontWeight: 700, color: 'var(--color-node-text)',
        textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none',
      }}>{name}</div>
    </div>
  );
}
