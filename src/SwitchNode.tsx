import { memo, useMemo, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CABLE_COLOR, LLDP_COLOR, panelDims, portHandle, type PortInfo, type SwitchData } from './graph';
import type { Breakout } from './api';
import { trace, useTrace, modeFor } from './trace';
import { useLldp } from './lldp';
import spineIcon from './icons/spine.svg?raw';
import leafIcon from './icons/leaf.svg?raw';
import superspineIcon from './icons/superspine.svg?raw';

const RoleIcons: Record<string, string> = {
  spine: spineIcon, superspine: superspineIcon, leaf: leafIcon, borderleaf: leafIcon,
};

const CELL = 13, CELL_GAP = 3;
// occupied cells fill with their cable-kind colour, or their LLDP status while the overlay is on
const fillFor = (info: PortInfo, lldp: boolean) =>
  info.kind === 'free' ? 'transparent' : lldp ? LLDP_COLOR[info.lldp ?? 'none'] : CABLE_COLOR[info.kind];

type Box = { left: number; top: number; width: number; height: number };
// A single front-panel cage (or one breakout channel sliver). Occupied ports carry the handles
// cables attach to, and gain a highlight ring when their cable is being traced. `box`
// absolutely-positions it (real-layout mode); `label`/`title` override the default cage number/tooltip.
function PortCell({ info, hot, lldp, box, label, title }:
  { info: PortInfo; hot: boolean; lldp: boolean; box?: Box; label?: ReactNode; title?: string }) {
  const free = info.kind === 'free';
  const fill = fillFor(info, lldp);
  const side = info.side === 'top' ? Position.Top : Position.Bottom;
  const id = portHandle(info.port, info.channel);
  // responsive label: fit the number to the cell in BOTH axes (digit-aware) so dense composite panels
  // never overflow their tiny cages; it scales up with canvas zoom. grid mode stays at a flat 7px.
  const digits = Math.max(1, String(label ?? info.port).length);
  const fontSize = box ? Math.max(4, Math.min(13, box.height * 0.9, box.width / (digits * 0.62))) : 7;
  return (
    <div
      data-port={info.port}
      onMouseEnter={free ? undefined : (e) => { e.stopPropagation(); trace.hover(`cable:${info.cableId}`); }}
      onClick={free ? undefined : (e) => { e.stopPropagation(); trace.pin(`cable:${info.cableId}`); }}
      title={title ?? (free ? `port ${info.port} · free` : `${info.port} → ${info.remote} ${info.remotePort}`)}
      style={{
        ...(box ? { position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height }
          : { position: 'relative', width: CELL, height: CELL }),
        borderRadius: 2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"NokiaPureText", sans-serif',   // match the SVG silkscreen labels
        fontSize, lineHeight: 1, fontWeight: 700,
        ...(box ? { overflow: 'hidden' } : null),
        color: free ? 'var(--cell-free-fg)' : 'var(--bg)',
        background: free ? 'var(--cell-free-bg)' : fill,
        // occupied ports ring in their own cable colour; the traced port rings white
        outline: hot ? '1.5px solid white' : free ? '1px solid var(--cell-free-line)' : `1px solid ${fill}`,
        outlineOffset: hot ? 0 : -1,
        cursor: free ? 'default' : 'pointer', zIndex: hot ? 2 : 1,
      }}
    >
      {!free && (label ?? info.port)}
      {!free && (
        <>
          <Handle type="source" id={id} position={side} isConnectable={false}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'none', minWidth: 0, minHeight: 0, border: 0, opacity: 0, background: 'transparent', borderRadius: 0 }} />
          <Handle type="target" id={`${id}t`} position={side} isConnectable={false}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'none', minWidth: 0, minHeight: 0, border: 0, opacity: 0, background: 'transparent', borderRadius: 0 }} />
        </>
      )}
    </div>
  );
}

// A broken-out cage: the cage box is split into `bo.channels` equal channel slivers (left→right),
// each cabled channel slotting into its own sliver with its own handle. `box` is the cage's
// absolute rect (real-layout) or undefined for a CELL-sized grid cage.
function BreakoutCage({ cage, infos, bo, hot, lldp, box }:
  { cage: string; infos: PortInfo[]; bo: Breakout; hot: boolean; lldp: boolean; box?: Box }) {
  const n = Math.max(1, bo.channels);
  const W = box?.width ?? CELL, H = box?.height ?? CELL;
  const gap = n > 2 ? 0.5 : 1;
  const sw = (W - gap * (n - 1)) / n;
  const byCh = new Map(infos.map((i) => [i.channel ?? 1, i]));
  return (
    <div
      title={`port ${cage} · ${n}×${bo.speed} breakout`}
      style={box
        ? { position: 'absolute', left: box.left, top: box.top, width: W, height: H }
        : { position: 'relative', width: CELL, height: CELL }}
    >
      {Array.from({ length: n }, (_, i) => {
        const ch = i + 1;
        const info = byCh.get(ch) ?? freeCell(cage);
        const occ = info.kind !== 'free';
        return (
          <PortCell key={ch} info={info} hot={hot} lldp={lldp} label="" box={{ left: i * (sw + gap), top: 0, width: sw, height: H }}
            title={occ ? `${cage}/${ch} → ${info.remote} ${info.remotePort}` : `port ${cage}/${ch} · free · ${bo.speed}`} />
        );
      })}
    </div>
  );
}

const freeCell = (port: string): PortInfo => ({ port, kind: 'free', side: 'bottom', remote: '', remotePort: '', desc: '', cableId: '' });

// One cage: a breakout splits into channel slivers, otherwise it's a single cell (free if uncabled).
function renderCage(cage: string, infos: PortInfo[] | undefined, bo: Breakout | undefined, hot: boolean, lldp: boolean, box?: Box) {
  if (bo) return <BreakoutCage key={cage} cage={cage} infos={infos ?? []} bo={bo} hot={hot} lldp={lldp} box={box} />;
  return <PortCell key={cage} info={infos?.[0] ?? freeCell(cage)} hot={hot} lldp={lldp} box={box} />;
}

function SwitchNode({ id, data, selected }: NodeProps) {
  const d = data as SwitchData;
  const rows = Math.max(1, d.rows);
  const cols = Math.ceil(d.portCount / rows);
  const icon = RoleIcons[d.role];

  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const lldp = useLldp();
  // which of THIS node's ports are part of the active trace (one subscription)
  const activeStr = useTrace((s) => {
    if (!s.any) return '';
    const out: string[] = [];
    for (const p of s.ports) if (p.startsWith(`${id}:`)) out.push(p.slice(id.length + 1));
    return out.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('\n');
  });
  const hotPorts = useMemo(() => new Set(activeStr ? activeStr.split('\n') : []), [activeStr]);

  // cage -> its cables (>1 when the cage is broken out into channels)
  const byPort = useMemo(() => {
    const m = new Map<string, PortInfo[]>();
    for (const p of d.ports) (m.get(p.port) ?? m.set(p.port, []).get(p.port)!).push(p);
    return m;
  }, [d.ports]);
  // cage ids in panel order: the real layout's ids ("<slot>-<port>" on composites) else a 1..N range
  const cages = useMemo(() => d.layout ? d.layout.map((l) => l.p) : Array.from({ length: d.portCount }, (_, i) => String(i + 1)), [d.layout, d.portCount]);
  const used = d.ports.length;
  // real-layout mode: place each cell at its on-panel position from the stencil
  const panel = useMemo(() => {
    if (!d.layout) return null;
    const { w: W, h: H } = panelDims(rows, d.aspect ?? 4);
    const pos = new Map(d.layout.map((p) => [p.p, p]));
    return { W, H, pos };
  }, [d.layout, d.aspect, rows]);

  return (
    <div
      className="switch-node"
      data-mode={mode}
      onMouseEnter={() => trace.hover(`node:${id}`)}
      onMouseLeave={() => trace.hover(null)}
      style={{
        background: 'var(--panel)', borderRadius: 8, padding: 8,
        border: `1.5px solid ${selected ? 'var(--eda-blue-400)' : mode === 'on' ? 'var(--eda-gray-600)' : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.32 : 1, transition: 'opacity 140ms, border-color 140ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, height: 20 }}>
        {icon && <span style={{ lineHeight: 0, width: 18, height: 18 }} dangerouslySetInnerHTML={{ __html: icon.replace(/width="\d+"/, 'width="18"').replace(/height="\d+"/, 'height="18"') }} />}
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)' }}>{d.name}</span>
        <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 400 }}>{d.platform}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 8.5, color: 'var(--muted)' }}>{used}/{d.portCount}</span>
      </div>
      {panel ? (
        <div style={{ position: 'relative', width: panel.W, height: panel.H }}>
          {cages.map((cage) => {
            const p = panel.pos.get(cage); if (!p) return null;
            const cw = Math.max(3, p.w * panel.W), ch = Math.max(3, p.h * panel.H);
            const box = { left: p.x * panel.W - cw / 2, top: p.y * panel.H - ch / 2, width: cw, height: ch };
            return renderCage(cage, byPort.get(cage), d.breakouts?.[cage], hotPorts.has(cage), lldp, box);
          })}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${CELL}px)`, gridTemplateRows: `repeat(${rows}, ${CELL}px)`, gridAutoFlow: 'column', gap: CELL_GAP }}>
          {cages.map((cage) => renderCage(cage, byPort.get(cage), d.breakouts?.[cage], hotPorts.has(cage), lldp))}
        </div>
      )}
    </div>
  );
}

export default memo(SwitchNode);
