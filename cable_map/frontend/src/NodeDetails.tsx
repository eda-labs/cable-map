import { lazy, Suspense, useCallback, useMemo, useRef, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import { dump } from 'js-yaml';
import type { editor } from 'monaco-editor';
import type { Node } from './api';

const NodeRawEditor = lazy(() => import('./NodeRawEditor'));

type Obj = Record<string, unknown>;
type Cr = { metadata?: Obj; spec?: Obj; status?: Obj };

const val = (o: Obj | undefined, k: string): string | undefined => {
  const v = o?.[k];
  if (v == null || v === '' || typeof v === 'object') return undefined;
  return String(v);
};

// EDA form section: a full-width header rule (edge to edge) over its padded fields.
function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography sx={{ px: 3, pb: 0.75, mb: desc ? 0.75 : 1.5, fontSize: '0.95rem', fontWeight: 600, color: 'text.primary', borderBottom: 1, borderColor: 'divider' }}>
        {title}
      </Typography>
      <Box sx={{ px: 3 }}>
        {desc && <Typography sx={{ fontSize: '0.8125rem', color: 'text.disabled', mb: 1.5, lineHeight: 1.35 }}>{desc}</Typography>}
        {children}
      </Box>
    </Box>
  );
}

// EDA read-only form field: label, filled value, muted help text. Hidden if empty.
function Field({ label, value, desc }: { label: string; value?: string; desc?: string }) {
  if (value == null) return null;
  return (
    <Box sx={{ mb: 1.75 }}>
      <Typography component="div" sx={{ fontSize: '0.8125rem', color: 'text.secondary', mb: 0.5 }}>
        {label}
      </Typography>
      <Box sx={(t) => ({
        bgcolor: t.palette.mode === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)',
        borderRadius: '0.5rem', px: 1.25, py: 0.75, fontSize: '0.875rem', color: 'text.primary', wordBreak: 'break-all',
      })}>
        {value}
      </Box>
      {desc && <Typography sx={{ mt: 0.5, fontSize: '0.75rem', color: 'text.disabled', lineHeight: 1.3 }}>{desc}</Typography>}
    </Box>
  );
}

// Details tab: an EDA-style form (Metadata / Status / Specification) on the left, the raw TopoNode
// resource (Monaco, read-only YAML) on the right — both render from the node's embedded CR (node.raw).
export default function NodeDetails({ node, dark }: { node: Node; dark: boolean }) {
  const cr = (node.raw ?? null) as Cr | null;
  const yaml = useMemo(() => (node.raw ? dump(node.raw) : ''), [node.raw]);

  const spec = cr?.spec, status = cr?.status;
  const npp = spec?.npp as Obj | undefined;
  const labels = Object.entries(node.labels ?? {}).toSorted(([a], [b]) => a.localeCompare(b));

  // Proportional scroll-sync between the form pane (native) and the Monaco editor. The lock guards
  // against feedback; positions converge since both map by the same ratio.
  const leftRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const lock = useRef(false);

  const onLeftScroll = useCallback(() => {
    const el = leftRef.current, ed = edRef.current;
    if (!el || !ed || lock.current) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    const edMax = Math.max(0, ed.getScrollHeight() - ed.getLayoutInfo().height);
    lock.current = true;
    ed.setScrollTop(ratio * edMax);
    requestAnimationFrame(() => { lock.current = false; });
  }, []);

  const handleEditor = useCallback((ed: editor.IStandaloneCodeEditor) => {
    edRef.current = ed;
    ed.onDidScrollChange(() => {
      const el = leftRef.current;
      if (!el || lock.current) return;
      const edMax = Math.max(0, ed.getScrollHeight() - ed.getLayoutInfo().height);
      const ratio = edMax > 0 ? ed.getScrollTop() / edMax : 0;
      const max = el.scrollHeight - el.clientHeight;
      lock.current = true;
      el.scrollTop = ratio * Math.max(0, max);
      requestAnimationFrame(() => { lock.current = false; });
    });
  }, []);

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <Box ref={leftRef} onScroll={onLeftScroll} sx={{ flex: 65, minWidth: 0, overflow: 'auto', py: 2.5 }}>
        <Section title="Metadata">
          <Field label="Name" value={node.name} />
          <Field label="Namespace" value={node.namespace} />
          {labels.length > 0 && (
            <Box sx={{ mb: 1.75 }}>
              <Typography sx={{ fontSize: '0.8125rem', color: 'text.secondary', mb: 0.5 }}>Labels</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {labels.map(([k, v]) => <Chip key={k} size="small" label={`${k}=${v}`} />)}
              </Box>
            </Box>
          )}
        </Section>

        <Section title="Status" desc="TopoNodeStatus defines the observed state of TopoNode">
          <Field label="NPP" value={val(status, 'npp-state')} desc="The current state of the connection between ConfigEngine and NPP." />
          <Field label="NPP Pod" value={val(status, 'npp-pod')} desc="NPP pod name" />
          <Field label="NPP Address" value={val(status, 'npp-details')} desc="NPP address and port for this TopoNode." />
          <Field label="Node" value={val(status, 'node-state')} desc="Connection state between EDA and the node" />
          <Field label="Node Address" value={val(status, 'node-details')} desc="Address and port used to connected to the node." />
          <Field label="Operating System" value={val(status, 'operatingSystem')} desc="Operational operating system running on this TopoNode, e.g. srl, sros." />
          <Field label="Version" value={val(status, 'version')} desc="Operational software version of this TopoNode, e.g. 24.7.1 (for srl), or 24.7.r1 (for sros)." />
          <Field label="Platform" value={val(status, 'platform')} desc="Operational platform type of this TopoNode, e.g. 7220 IXR-D3L." />
          <Field label="Simulate" value={val(status, 'simulate')} desc="Simulate using CX - if true CX is responsible for generating the TargetNode resource." />
        </Section>

        <Section title="Specification" desc="A managed network element is represented via a TopoNode resource, describing characteristics of a specific element in the topology.">
          <Field label="Node Profile" value={val(spec, 'nodeProfile')} desc="Reference to a NodeProfile to use with this TopoNode." />
          <Field label="Platform" value={val(spec, 'platform')} desc="Platform type of this TopoNode, e.g. 7220 IXR-D3L." />
          <Field label="Operating System" value={val(spec, 'operatingSystem')} desc="Operating system running on this TopoNode, e.g. srl." />
          <Field label="Version" value={val(spec, 'version')} desc="Software version of this TopoNode, e.g. 24.7.1 (for srl), or 24.7.r1 (for sros)." />
          <Field label="Onboarded" value={val(spec, 'onBoarded')} desc="Indicates if this TopoNode has been bootstrapped or is reachable via configured credentials." />
          <Field label="NPP Mode" value={val(npp, 'mode')} desc="EDA to Node communication mode" />
        </Section>
      </Box>

      <Box sx={{ flex: 35, minWidth: 0, borderLeft: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column' }}>
        <Typography variant="overline" color="text.secondary" sx={{ px: 2, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
          TopoNode resource
        </Typography>
        <Box sx={{ flex: 1, minHeight: 0 }}>
          {node.raw ? (
            <Suspense fallback={<Box sx={{ p: 2 }}><CircularProgress size={16} /></Box>}>
              <NodeRawEditor value={yaml} dark={dark} onEditorMount={handleEditor} />
            </Suspense>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>no resource data</Typography>
          )}
        </Box>
      </Box>
    </Box>
  );
}
