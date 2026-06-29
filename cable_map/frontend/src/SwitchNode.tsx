import { memo, useMemo, useState, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  CABLE_COLOR, LLDP_COLOR, COMPACT_SWITCH_H, COMPACT_SWITCH_W,
  breakoutGrid, compactSwitchHandle, panelDims, portHandle, type PortInfo, type SwitchData,
} from './graph';
import type { Breakout } from './domain/topology/contract';
import { trace, useTrace, modeFor } from './trace';
import { useLldp } from './lldp';
import spineIcon from './assets/icons/spine.svg?raw';
import leafIcon from './assets/icons/leaf.svg?raw';
import superspineIcon from './assets/icons/superspine.svg?raw';

const RoleIcons: Record<string, string> = {
  spine: spineIcon, superspine: superspineIcon, leaf: leafIcon, borderleaf: leafIcon,
};

const CELL = 13, CELL_GAP = 3;
// occupied cells fill with their cable-kind colour, or their LLDP status while the overlay is on
const fillFor = (info: PortInfo, lldp: boolean) =>
  info.kind === 'free' ? 'transparent' : lldp ? LLDP_COLOR[info.lldp ?? 'none'] : CABLE_COLOR[info.kind];
const showsEdgeStub = (info: PortInfo, enabled: boolean) => enabled && info.kind !== 'free' && info.kind !== 'isl';

type Box = { left: number; top: number; width: number; height: number };
// A single front-panel cage (or one breakout channel sliver). Occupied ports carry the handles
// cables attach to, and gain a highlight ring when their cable is being traced. `box`
// absolutely-positions it (real-layout mode); `label`/`title` override the default cage number/tooltip.
function PortCell({ info, hot, dim, lldp, showEdgeStub, box, label, title, visualHidden = false, channel = false, onSelectNode }:
  { info: PortInfo; hot: boolean; dim: boolean; lldp: boolean; showEdgeStub: boolean; box?: Box; label?: ReactNode; title?: string; visualHidden?: boolean; channel?: boolean; onSelectNode?: (expand?: boolean) => void }) {
  const free = info.kind === 'free';
  const fill = fillFor(info, lldp);
  const side = info.side === 'top' ? Position.Top : Position.Bottom;
  const id = portHandle(info.port, info.channel);
  const stubVisible = showsEdgeStub(info, showEdgeStub) && !hot;
  // responsive label: fit the number to the cell in BOTH axes (digit-aware) so dense composite panels
  // never overflow their tiny cages; it scales up with canvas zoom. grid mode stays at a flat 7px.
  const digits = Math.max(1, String(label ?? info.port).length);
  const fontSize = box ? Math.max(4, Math.min(13, box.height * 0.9, box.width / (digits * 0.62))) : 7;
  return (
    <div
      data-port={info.port}
      onMouseEnter={free ? undefined : (e) => { e.stopPropagation(); trace.hover(`cable:${info.cableId}`); }}
      onClick={free ? undefined : (e) => {
        e.stopPropagation();
        if (e.detail > 1) return;
        onSelectNode?.();
        trace.pin(`cable:${info.cableId}`);
      }}
      onDoubleClick={free ? undefined : (e) => { e.stopPropagation(); onSelectNode?.(true); }}
      title={title ?? (free ? `port ${info.port} · free` : `${info.port} → ${info.remote} ${info.remotePort}`)}
      style={{
        ...(box ? { position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height }
          : { position: 'relative', width: CELL, height: CELL }),
        // breakout channels carry no ring of their own — the cage draws one ring around all of them
        // and the gaps between them read as thin light dividers (see BreakoutCage).
        borderRadius: channel ? 0 : 2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"NokiaPureText", sans-serif',   // match the SVG silkscreen labels
        fontSize, lineHeight: 1, fontWeight: 700,
        overflow: 'visible',
        color: free ? 'var(--cell-free-fg)' : 'var(--bg)',
        background: free ? 'var(--cell-free-bg)' : fill,
        // occupied ports ring in their own cable colour; the traced port rings white
        outline: channel ? 'none' : hot ? '1.5px solid white' : free ? '1px solid var(--cell-free-line)' : `1px solid ${fill}`,
        outlineOffset: hot ? 0 : -1,
        cursor: free ? 'default' : 'pointer',
        opacity: visualHidden ? 0 : dim ? (free ? 0.18 : 0.24) : 1,
        pointerEvents: visualHidden ? 'none' : undefined,
        transition: 'opacity 120ms, outline-color 120ms',
        zIndex: hot ? 2 : dim ? 0 : 1,
      }}
    >
      {stubVisible && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: '50%',
            top: '100%',
            width: hot ? 2 : 1.25,
            height: hot ? 52 : 44,   // past the node's bottom edge, but short enough to not stack with the row below
            transform: 'translateX(-50%)',
            background: fill,
            borderRadius: 999,
            opacity: dim ? 0.2 : hot ? 1 : 0.72,
            boxShadow: hot ? `0 0 0 1px ${fill}66` : undefined,
            pointerEvents: 'none',
          }}
        />
      )}
      {(channel || !free) && (label ?? info.port)}
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
function BreakoutCage({ cage, infos, bo, hot, selected, dim, lldp, showEdgeStubs, box, onSelectNode }:
  { cage: string; infos: PortInfo[]; bo: Breakout; hot: boolean; selected: boolean; dim: boolean; lldp: boolean; showEdgeStubs: boolean; box?: Box; onSelectNode?: (expand?: boolean) => void }) {
  const [hovered, setHovered] = useState(false);
  // per-channel trace state: each channel highlights/dims on its OWN cable, not the whole cage
  const tracedEdges = useTrace((s) => s.edges);
  const traceAny = useTrace((s) => s.any);
  const n = Math.max(1, bo.channels);
  const W = box?.width ?? CELL, H = box?.height ?? CELL;
  const { cols, rows } = breakoutGrid(n);
  const colGap = cols > 2 ? 0.5 : 1;
  const rowGap = rows > 1 ? 0.5 : 0;
  const sw = (W - colGap * (cols - 1)) / cols;
  const sh = (H - rowGap * (rows - 1)) / rows;
  const byCh = new Map(infos.map((i) => [i.channel ?? 1, i]));
  // any channel of this cage in the active trace -> the whole cage rings white (one ring, like a port)
  const anyHot = hot || infos.some((i) => !!i.cableId && tracedEdges.has(i.cableId));
  const label = bo.speed ? `${n}×${bo.speed} breakout` : `${n}-channel breakout`;
  const digits = Math.max(1, cage.length);
  const fontSize = box ? Math.max(4, Math.min(13, H * 0.9, W / (digits * 0.62))) : 7;
  const expanded = hovered || anyHot || selected;
  const primary = infos[0] ?? freeCell(cage);
  const collapsed = infos.length
    ? { ...primary, channel: undefined, remote: `${infos.length}/${n} channels`, remotePort: '' }
    : freeCell(cage);
  const collapsedFill = fillFor(collapsed, lldp);
  const collapsedFree = collapsed.kind === 'free';
  return (
    <div
      title={`port ${cage} · ${label}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...(box
          ? { position: 'absolute', left: box.left, top: box.top, width: W, height: H }
          : { position: 'relative', width: CELL, height: CELL }),
        // expanded: one ring around the whole QSFP-sized port (white when traced), with the channel
        // gaps reading as thin light dividers via the cage background showing through.
        ...(expanded && {
          borderRadius: 3,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.6)',
          // constant ring — only the colour changes when traced (white), never the size/offset
          outline: `1.5px solid ${anyHot ? 'white' : collapsedFree ? 'var(--cell-free-line)' : collapsedFill}`,
          outlineOffset: 0,
        }),
      }}
    >
      {Array.from({ length: n }, (_, i) => {
        const ch = i + 1;
        const info = byCh.get(ch) ?? freeCell(cage);
        const occ = info.kind !== 'free';
        const col = i % cols;
        const row = Math.floor(i / cols);
        // this channel is hot when its own cable is traced; dim when the cage is dimmed (cage not in
        // the trace) or a trace is active and this channel's cable isn't part of it.
        const chHot = !!info.cableId && tracedEdges.has(info.cableId);
        const chDim = dim || (traceAny && !chHot);
        return (
          <PortCell key={ch} info={info} hot={chHot} lldp={lldp} channel label={String(ch)} box={{ left: col * (sw + colGap), top: row * (sh + rowGap), width: sw, height: sh }}
            dim={chDim}
            showEdgeStub={showEdgeStubs}
            onSelectNode={onSelectNode}
            visualHidden={!expanded}
            title={occ ? `${cage}/${ch} → ${info.remote} ${info.remotePort}` : `port ${cage}/${ch} · free${bo.speed ? ` · ${bo.speed}` : ''}`} />
        );
      })}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 2,
          background: collapsedFree ? 'var(--cell-free-bg)' : collapsedFill,
          outline: collapsedFree ? '1px solid var(--cell-free-line)' : `1px solid ${collapsedFill}`,
          outlineOffset: -1,
          fontSize,
          lineHeight: 1,
          fontWeight: 700,
          color: collapsedFree ? 'var(--cell-free-fg)' : 'var(--bg)',
          opacity: expanded ? 0 : dim ? 0.24 : 1,
          pointerEvents: expanded ? 'none' : 'auto',
          cursor: 'pointer',
          transition: 'opacity 120ms, outline-color 120ms',
          zIndex: 3,
        }}
      >
        {!collapsedFree && cage}
      </div>
    </div>
  );
}

const freeCell = (port: string): PortInfo => ({ port, kind: 'free', side: 'bottom', remote: '', remotePort: '', desc: '', cableId: '' });

// One cage: a breakout splits into channel slivers, otherwise it's a single cell (free if uncabled).
function renderCage(cage: string, infos: PortInfo[] | undefined, bo: Breakout | undefined, hot: boolean, selected: boolean, dim: boolean, lldp: boolean, showEdgeStubs: boolean, box?: Box, onSelectNode?: (expand?: boolean) => void) {
  if (bo) return <BreakoutCage key={cage} cage={cage} infos={infos ?? []} bo={bo} hot={hot} selected={selected} dim={dim} lldp={lldp} showEdgeStubs={showEdgeStubs} box={box} onSelectNode={onSelectNode} />;
  return <PortCell key={cage} info={infos?.[0] ?? freeCell(cage)} hot={hot} dim={dim && !hot} lldp={lldp} showEdgeStub={showEdgeStubs} box={box} onSelectNode={onSelectNode} />;
}

function CompactSwitchNode({ id, data, selected }: NodeProps) {
  const d = data as SwitchData;
  const icon = RoleIcons[d.role];
  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const lldp = useLldp();
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const p of d.ports) {
      const key = lldp ? p.lldp ?? 'none' : p.kind;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return [...out.entries()];
  }, [d.ports, lldp]);
  const used = d.ports.length;
  const colorOf = (key: string) => {
    if (lldp && (key === 'ok' || key === 'mismatch' || key === 'none')) return LLDP_COLOR[key];
    return key in CABLE_COLOR ? CABLE_COLOR[key as keyof typeof CABLE_COLOR] : CABLE_COLOR.edge;
  };
  const handleStyle = {
    opacity: 0,
    border: 0,
    background: 'transparent',
    width: COMPACT_SWITCH_W,
    height: 10,
    left: '50%',
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
  } as const;

  return (
    <div
      className="switch-node"
      data-mode={mode}
      onMouseEnter={() => trace.hover(`node:${id}`)}
      onMouseLeave={() => trace.hover(null)}
      onClick={() => d.onSelectNode?.(id)}
      style={{
        position: 'relative',
        width: COMPACT_SWITCH_W,
        height: COMPACT_SWITCH_H,
        background: 'var(--panel)',
        borderRadius: 6,
        padding: '6px 7px',
        border: `1.5px solid ${selected ? 'var(--eda-blue-400)' : mode === 'on' ? 'var(--eda-gray-600)' : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.32 : 1,
        transition: 'opacity 120ms, border-color 120ms',
        boxShadow: mode === 'on' ? '0 0 0 1px var(--eda-blue-400)' : undefined,
      }}
    >
      <Handle type="source" id={compactSwitchHandle('top')} position={Position.Top} isConnectable={false}
        style={{ ...handleStyle, top: -5 }} />
      <Handle type="target" id={compactSwitchHandle('top', true)} position={Position.Top} isConnectable={false}
        style={{ ...handleStyle, top: -5 }} />
      <Handle type="source" id={compactSwitchHandle('bottom')} position={Position.Bottom} isConnectable={false}
        style={{ ...handleStyle, bottom: -5, top: 'auto' }} />
      <Handle type="target" id={compactSwitchHandle('bottom', true)} position={Position.Bottom} isConnectable={false}
        style={{ ...handleStyle, bottom: -5, top: 'auto' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        {icon && <span style={{ lineHeight: 0, width: 15, height: 15, flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: icon.replace(/width="\d+"/, 'width="15"').replace(/height="\d+"/, 'height="15"') }} />}
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
        <span style={{ fontSize: 8.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{d.role}</span>
        <span style={{ fontSize: 8.5, color: 'var(--muted)', fontWeight: 700 }}>{used}/{d.portCount}</span>
      </div>
      <div style={{ display: 'flex', height: 4, marginTop: 5, borderRadius: 999, overflow: 'hidden', background: 'var(--cell-free-bg)' }}>
        {counts.map(([key, count]) => (
          <span key={key} style={{ width: `${(count / Math.max(1, used)) * 100}%`, background: colorOf(key) }} />
        ))}
      </div>
    </div>
  );
}

function DetailedSwitchNode({ id, data, selected }: NodeProps) {
  const d = data as SwitchData;
  const rows = Math.max(1, d.rows);
  const cols = Math.ceil(d.portCount / rows);
  const icon = RoleIcons[d.role];

  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const traceAny = useTrace((s) => s.any);
  const lldp = useLldp();
  // which of THIS node's ports are part of the active trace (one subscription)
  const activeStr = useTrace((s) => {
    if (!s.any) return '';
    const out: string[] = [];
    for (const p of s.ports) if (p.startsWith(`${id}:`)) out.push(p.slice(id.length + 1));
    return out.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('\n');
  });
  const expandedStubStr = useMemo(() => {
    const out: string[] = [];
    for (const p of d.activeEdgeStubPorts ?? []) {
      if (p.startsWith(`${id}:`)) out.push(p.slice(id.length + 1));
    }
    return out.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('\n');
  }, [d.activeEdgeStubPorts, id]);
  const hotPorts = useMemo(() => {
    const out = new Set<string>();
    for (const p of activeStr ? activeStr.split('\n') : []) out.add(p);
    for (const p of expandedStubStr ? expandedStubStr.split('\n') : []) out.add(p);
    return out;
  }, [activeStr, expandedStubStr]);
  const dimInactivePorts = mode === 'on' && traceAny && hotPorts.size > 0;

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
      onMouseEnter={() => { if (!d.showEdgeStubs) trace.hover(`node:${id}`); }}
      onMouseLeave={() => trace.hover(null)}
      onClick={() => d.onSelectNode?.(id)}
      style={{
        background: 'var(--panel)', borderRadius: 8, padding: 8,
        border: `1.5px solid ${selected ? 'var(--eda-blue-400)' : mode === 'on' ? 'var(--eda-gray-600)' : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.32 : 1, transition: 'opacity 140ms, border-color 140ms',
        contentVisibility: d.showEdgeStubs ? 'visible' : 'auto',
        containIntrinsicSize: panel ? `${panel.W + 16}px ${panel.H + 44}px` : '220px 96px',
        // real-layout: pin the node to the port-panel width (matches graph.ts swW) so a long platform
        // name in the header can't widen it past the furthest ports — the header truncates instead.
        ...(panel ? { width: panel.W + 16, boxSizing: 'border-box' as const } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, height: 20 }}>
        {icon && <span style={{ lineHeight: 0, width: 18, height: 18, flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: icon.replace(/width="\d+"/, 'width="18"').replace(/height="\d+"/, 'height="18"') }} />}
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '60%' }}>{d.name}</span>
        <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{d.platform}</span>
        <span style={{ flex: 1, minWidth: 0 }} />
        <span style={{ fontSize: 8.5, color: 'var(--muted)', flexShrink: 0 }}>{used}/{d.portCount}</span>
      </div>
      {panel ? (
        <div style={{ position: 'relative', width: panel.W, height: panel.H }}>
          {cages.map((cage) => {
            const p = panel.pos.get(cage); if (!p) return null;
            const cw = Math.max(3, p.w * panel.W), ch = Math.max(3, p.h * panel.H);
            const box = { left: p.x * panel.W - cw / 2, top: p.y * panel.H - ch / 2, width: cw, height: ch };
            const hot = hotPorts.has(cage);
            return renderCage(cage, byPort.get(cage), d.breakouts?.[cage], hot, selected, dimInactivePorts && !hot, lldp, !!d.showEdgeStubs, box, (expand) => d.onSelectNode?.(id, expand));
          })}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${CELL}px)`, gridTemplateRows: `repeat(${rows}, ${CELL}px)`, gridAutoFlow: 'column', gap: CELL_GAP }}>
          {cages.map((cage) => {
            const hot = hotPorts.has(cage);
            return renderCage(cage, byPort.get(cage), d.breakouts?.[cage], hot, selected, dimInactivePorts && !hot, lldp, !!d.showEdgeStubs, undefined, (expand) => d.onSelectNode?.(id, expand));
          })}
        </div>
      )}
    </div>
  );
}

function SwitchNode(props: NodeProps) {
  const d = props.data as SwitchData;
  return d.compact ? <CompactSwitchNode {...props} /> : <DetailedSwitchNode {...props} />;
}

export default memo(SwitchNode);
