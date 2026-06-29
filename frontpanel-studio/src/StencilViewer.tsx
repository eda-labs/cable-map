// Stencil inspector. Inlines a stencil SVG and works directly on its paths. Port numbers are baked
// into the SVGs (cN
// <text>), so this just renders them; it adds:
//   - "fill cages": fills every path[data-port] green (coverage: no missing / decoy cages)
//   - hover any path -> red outline;  click any path -> blue + its info (data-port, fill, centre in
//     SVG user units, full `d` copied to clipboard) for (re)positioning a cage.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Checkbox, FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, Paper, Select, Stack, TextField, Typography,
} from '@mui/material';
import { ChevronLeft, ChevronRight } from '@mui/icons-material';
import { ReactFlow, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { appPath } from '@app/api/base';
import { frontPanelMetaOf, frontPanelPlatforms, type FrontPanelMeta } from '@app/domain/ports/frontPanelMeta';
import SwitchNode from '@app/SwitchNode';
import type { SwitchData } from '@app/graph';

const ALL = frontPanelPlatforms().toSorted();
const BASE_SUB = '— base —';

// split a stencil name into [platform group, variant subtype]. Only the modular chassis fan out into
// card-config subtypes ("<family> <config>"); every fixed platform (7220 IXR-D3L, 7750 SR-1-24D, …) is
// its own group. Order families specific-first so "SR-2se"/"SR-1s" win over "SR-2s"/"SR-1".
const MODULAR_FAMILIES = ['7750 SR-2se', '7750 SR-2s', '7750 SR-1s', '7750 SR-1'];
function classify(name: string): [string, string] {
  for (const g of MODULAR_FAMILIES) {
    if (name === g) return [g, BASE_SUB];
    if (name.startsWith(`${g} `)) return [g, name.slice(g.length + 1)];
  }
  return [name, BASE_SUB];
}
// group -> sorted subtypes [{ sub, name }]
const GROUPS = (() => {
  const map = new Map<string, { sub: string; name: string }[]>();
  for (const name of ALL) {
    const [g, sub] = classify(name);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push({ sub, name });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.sub.localeCompare(b.sub, undefined, { numeric: true }));
  return map;
})();
const GROUP_NAMES = [...GROUPS.keys()].toSorted();

const nodeTypes = { switch: SwitchNode };

// the real canvas node: render the actual SwitchNode inside a minimal ReactFlow so it looks exactly as
// it would on the topology canvas (all ports free / uncabled, since this is just the stencil preview).
function CanvasNode({ name }: { name: string }) {
  const m = frontPanelMetaOf(name) as FrontPanelMeta;
  // the canvas header shows the chassis family, not the full composite/permutation name
  const data: SwitchData = {
    name: classify(name)[0], role: 'leaf', platform: '',
    portCount: m.ports, rows: m.rows, aspect: m.aspect,
    ports: [], layout: m.layout, breakouts: {}, compact: false,
  };
  const node = { id: 'n', type: 'switch', position: { x: 0, y: 0 }, data } as Node;
  return (
    <Box sx={{ height: 300, border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', '& .react-flow__attribution': { display: 'none' } }}>
      <ReactFlow
        key={name}
        nodes={[node]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.4 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        minZoom={0.1}
        maxZoom={12}
        proOptions={{ hideAttribution: true }}
      />
    </Box>
  );
}

type Pick = { port: string | null; d: string; fill: string; cx: number; cy: number; w: number; h: number };

// centre + bbox of a path in the SVG's own user-coordinate system (handles per-path / group transforms)
function userBox(svg: SVGSVGElement, p: SVGGraphicsElement) {
  const bb = p.getBBox();
  const m = p.getScreenCTM();
  const sm = svg.getScreenCTM();
  if (!m || !sm) return { cx: bb.x + bb.width / 2, cy: bb.y + bb.height / 2, w: bb.width, h: bb.height };
  const inv = sm.inverse();
  const mid = svg.createSVGPoint(); mid.x = bb.x + bb.width / 2; mid.y = bb.y + bb.height / 2;
  const c = mid.matrixTransform(m).matrixTransform(inv);
  const o = svg.createSVGPoint(); o.x = bb.x; o.y = bb.y;
  const oo = o.matrixTransform(m).matrixTransform(inv);
  const e = svg.createSVGPoint(); e.x = bb.x + bb.width; e.y = bb.y + bb.height;
  const ee = e.matrixTransform(m).matrixTransform(inv);
  return { cx: c.x, cy: c.y, w: Math.abs(ee.x - oo.x), h: Math.abs(ee.y - oo.y) };
}

function Inspector({ name, fillCages, rev, onPick }: { name: string; fillCages: boolean; rev: number; onPick: (p: Pick | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const sel = useRef<{ el: SVGPathElement; fill: string } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const paintCages = (svg: SVGSVGElement) => {
    for (const p of svg.querySelectorAll<SVGPathElement>('path[data-port]')) {
      if (sel.current?.el === p) continue;
      if (fillCages) {
        // raise the cage above the connector pins but keep it BELOW the baked cN labels (which sit
        // last in the parent) so the white text stays readable over the fill.
        const parent = p.parentNode as Element | null;
        const label = parent?.querySelector(':scope > text[data-added]');
        if (label) parent!.insertBefore(p, label); else parent?.appendChild(p);
        p.style.fill = '#00A87E'; p.style.fillOpacity = '1';
      } else { p.style.fill = ''; p.style.fillOpacity = ''; }
    }
  };

  // inline the svg for `name`
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    sel.current = null;
    onPick(null);
    el.innerHTML = '<div style="padding:24px;color:#888;font:13px system-ui">loading…</div>';
    // rev bumps on a frontpanel-hmr ping; the query busts the browser cache so the edited SVG reloads
    fetch(`${appPath(`frontpanel/${encodeURIComponent(name)}.svg`)}${rev ? `?v=${rev}` : ''}`)
      .then((r) => r.text())
      .then((txt) => {
        if (cancelled) return;
        el.innerHTML = txt;
        const svg = el.querySelector('svg');
        if (!svg) { el.innerHTML = '<div style="padding:24px;color:#c33">no &lt;svg&gt;</div>'; return; }
        if (!svg.getAttribute('viewBox')) {
          try { const b = svg.getBBox(); svg.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`); } catch { /* not laid out */ }
        }
        svg.removeAttribute('width'); svg.removeAttribute('height');
        svg.style.width = '100%'; svg.style.height = 'auto'; svg.style.display = 'block';
        paintCages(svg);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, rev]);

  // toggle cage fill without refetch
  useEffect(() => {
    const svg = ref.current?.querySelector('svg') as SVGSVGElement | null;
    if (svg) paintCages(svg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillCages]);

  // hover outline + click pick (event delegation)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let hov: SVGPathElement | null = null;
    const clearHov = () => {
      if (hov && hov !== sel.current?.el) { hov.style.stroke = ''; hov.style.strokeWidth = ''; }
      hov = null;
    };
    const onMove = (e: MouseEvent) => {
      const path = (e.target as Element).closest('path') as SVGPathElement | null;
      if (path === hov) return;
      clearHov();
      if (path && path !== sel.current?.el) {
        hov = path;
        path.style.stroke = '#FF3B30';
        path.style.strokeWidth = '0.7px';
        path.style.vectorEffect = 'non-scaling-stroke';
      }
    };
    const onClick = (e: MouseEvent) => {
      const path = (e.target as Element).closest('path') as SVGPathElement | null;
      const svg = el.querySelector('svg') as SVGSVGElement | null;
      if (!path || !svg) return;
      if (sel.current) sel.current.el.style.fill = sel.current.fill;
      sel.current = { el: path, fill: path.style.fill };
      path.style.fill = '#2E78FF';
      path.style.stroke = ''; path.style.strokeWidth = '';
      const c = userBox(svg, path);
      const fill = path.getAttribute('style')?.match(/fill\s*:\s*[^;]+/)?.[0] || path.getAttribute('fill') || '(none)';
      const d = path.getAttribute('d') || '';
      navigator.clipboard?.writeText(d).catch(() => {});
      onPickRef.current({ port: path.getAttribute('data-port'), d, fill, cx: +c.cx.toFixed(2), cy: +c.cy.toFixed(2), w: +c.w.toFixed(2), h: +c.h.toFixed(2) });
    };
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', clearHov);
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', clearHov);
      el.removeEventListener('click', onClick);
    };
  }, []);

  return (
    <Paper variant="outlined" sx={{ bgcolor: '#fff', borderRadius: 1.5, p: 1 }}>
      <Box ref={ref} sx={{ cursor: 'crosshair' }} />
    </Paper>
  );
}

export default function StencilViewer() {
  const [fillCages, setFillCages] = useState(true);
  const [group, setGroup] = useState(GROUP_NAMES.includes('7750 SR-1') ? '7750 SR-1' : GROUP_NAMES[0]);
  const subs = GROUPS.get(group) ?? [];
  const [sub, setSub] = useState(subs[0]?.sub ?? BASE_SUB);
  const [pick, setPick] = useState<Pick | null>(null);
  const [rev, setRev] = useState(0);
  const name = useMemo(() => {
    const list = GROUPS.get(group) ?? [];
    return (list.find((s) => s.sub === sub) ?? list[0])?.name ?? ALL[0];
  }, [group, sub]);
  const subIdx = subs.findIndex((s) => s.sub === sub);

  // hot-reload: re-fetch the current panel in place when its SVG is regenerated (keeps the selection)
  useEffect(() => {
    if (!import.meta.hot) return;
    const bump = () => setRev((r) => r + 1);
    import.meta.hot.on('cable-map:frontpanel', bump);
    return () => import.meta.hot?.off('cable-map:frontpanel', bump);
  }, []);

  const onGroup = (g: string) => { setGroup(g); setSub((GROUPS.get(g) ?? [])[0]?.sub ?? BASE_SUB); };

  return (
    <Box sx={{ p: 2, minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">Stencil inspector</Typography>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel>platform group</InputLabel>
          <Select label="platform group" value={group} onChange={(e) => onGroup(e.target.value)}>
            {GROUP_NAMES.map((g) => (
              <MenuItem key={g} value={g}>{g} ({GROUPS.get(g)!.length})</MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ width: 260 }} disabled={subs.length <= 1}>
          <InputLabel>subtype</InputLabel>
          <Select
            label="subtype"
            value={sub}
            onChange={(e) => setSub(e.target.value)}
            sx={{ '& .MuiSelect-select': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }}
            MenuProps={{ slotProps: { paper: { sx: { maxWidth: 260 } } } }}
          >
            {subs.map((s) => (
              <MenuItem key={s.sub} value={s.sub} sx={{ overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{s.sub}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <Box sx={{ display: 'flex', ml: -1 }}>
          <IconButton size="small" disabled={subIdx <= 0} onClick={() => setSub(subs[subIdx - 1].sub)} title="previous subtype"><ChevronLeft /></IconButton>
          <IconButton size="small" disabled={subIdx >= subs.length - 1} onClick={() => setSub(subs[subIdx + 1].sub)} title="next subtype"><ChevronRight /></IconButton>
        </Box>
        <FormControlLabel control={<Checkbox size="small" checked={fillCages} onChange={(e) => setFillCages(e.target.checked)} />} label="fill cages" />
        <Typography variant="caption" color="text.secondary">click a path → copies its d</Typography>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 2, alignItems: 'start' }}>
        <Box>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>{name}</Typography>
          <Inspector name={name} fillCages={fillCages} rev={rev} onPick={setPick} />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, mb: 0.5 }}>canvas node</Typography>
          <CanvasNode name={name} />
        </Box>
        <Paper variant="outlined" sx={{ p: 2, position: 'sticky', top: 12 }}>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>picked path</Typography>
          {!pick ? (
            <Typography color="text.secondary" variant="body2">click any path in the stencil</Typography>
          ) : (
            <Stack spacing={0.75}>
              <Typography variant="body2">
                data-port:{' '}
                {pick.port
                  ? <Box component="span" sx={{ color: 'success.main', fontWeight: 700 }}>{pick.port}</Box>
                  : <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>UNTAGGED</Box>}
              </Typography>
              <Typography variant="body2">centre: <code>{pick.cx}, {pick.cy}</code></Typography>
              <Typography variant="body2">size: <code>{pick.w} × {pick.h}</code></Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>fill: <code>{pick.fill}</code></Typography>
              <Typography variant="caption" color="text.secondary">d (copied to clipboard):</Typography>
              <TextField
                value={pick.d}
                multiline
                minRows={5}
                maxRows={10}
                slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 10 } } }}
              />
            </Stack>
          )}
        </Paper>
      </Box>
    </Box>
  );
}
