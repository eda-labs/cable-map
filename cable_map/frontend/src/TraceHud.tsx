import { Panel } from '@xyflow/react';
import { useTrace } from './trace';

// User-facing selection label (bottom-right): "Nothing selected", a node name, or a link (its two
// endpoints). Reads the trace store; endpoints are only pulled for a cable key (a node key resolves
// to all its neighbours, which we deliberately don't list).
export default function TraceHud() {
  const key = useTrace((s) => s.key);
  const link = useTrace((s) => (s.key?.startsWith('cable:') ? [...s.nodes].join('  ↔  ') : ''));

  let text = 'Nothing selected';
  if (key) {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    if (kind === 'node') text = id;
    else if (kind === 'cable') text = link || 'link';
    else text = id || text;
  }

  return (
    <Panel position="bottom-right">
      <div style={{
        color: 'var(--fg)',
        opacity: 0.85,
        pointerEvents: 'none',
        fontSize: 12,
        fontWeight: 500,
        textShadow: '0 1px 3px rgba(0,0,0,0.55)',
        userSelect: 'none',
      }}>
        {text}
      </div>
    </Panel>
  );
}
