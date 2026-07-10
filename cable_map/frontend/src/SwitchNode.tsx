import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  CABLE_COLOR, LLDP_COLOR, COMPACT_SWITCH_H, COMPACT_SWITCH_W,
  breakoutCellBox, breakoutGrid, compactSwitchHandle, panelDims, portHandle, type PortInfo, type SwitchData,
} from './graph';
import type { Breakout } from './domain/topology/contract';
import type { ConnectorInfo } from './domain/ports/srosPorts';
import { detailedPortLabel } from './domain/ports/interfaceNames';
import { trace, useTrace, modeFor } from './trace';
import { useLldp } from './lldp';
import spineIcon from './assets/icons/spine.svg?raw';
import leafIcon from './assets/icons/leaf.svg?raw';
import superspineIcon from './assets/icons/superspine.svg?raw';
import { useOpenNode } from './components/NodeActionsContext';

const RoleIcons: Record<string, string> = {
  spine: spineIcon, superspine: superspineIcon, leaf: leafIcon, borderleaf: leafIcon,
};

type RoleIconStyle = CSSProperties & {
  '--color-icon-bg': string;
  '--color-icon-fg': string;
};

const roleIconStyle = (size: number, synced?: boolean): RoleIconStyle => ({
  lineHeight: 0,
  width: size,
  height: size,
  flexShrink: 0,
  '--color-icon-bg': synced ? 'var(--eda-green-600)' : 'var(--cell-free-bg)',
  '--color-icon-fg': synced ? '#fff' : 'var(--muted)',
});

function RoleIcon({ icon, size, role, nodeState, synced }: { icon?: string; size: number; role: string; nodeState?: string; synced?: boolean }) {
  if (!icon) return null;
  const state = nodeState ? ` · node-state: ${nodeState}` : '';
  return (
    <span
      title={`${role}${state}`}
      style={roleIconStyle(size, synced)}
      dangerouslySetInnerHTML={{ __html: icon.replace(/width="\d+"/, `width="${size}"`).replace(/height="\d+"/, `height="${size}"`) }}
    />
  );
}

const CELL = 13, CELL_GAP = 3;
// occupied cells fill with their cable-kind colour, or their LLDP status while the overlay is on
const fillFor = (info: PortInfo, lldp: boolean) =>
  info.kind === 'free' ? 'transparent' : lldp ? LLDP_COLOR[info.lldp ?? 'none'] : CABLE_COLOR[info.kind];
const showsEdgeStub = (info: PortInfo, enabled: boolean) => enabled && info.kind !== 'free' && info.kind !== 'isl';

function cssColor(css: string): string {
  const variable = /var\((--[^)]+)\)/.exec(css);
  if (!variable) return css;
  return getComputedStyle(document.documentElement).getPropertyValue(variable[1]).trim() || '#888888';
}

function occupiedCages(ports: PortInfo[]): PortInfo[] {
  const byCage = new Map<string, PortInfo>();
  for (const port of ports) {
    if (!byCage.has(port.port)) byCage.set(port.port, port);
  }
  return [...byCage.values()];
}

type Box = { left: number; top: number; width: number; height: number };
// A single front-panel cage (or one breakout channel sliver). Occupied ports carry the handles
// cables attach to, and gain a highlight ring when their cable is being traced. `box`
// absolutely-positions it (real-layout mode); `label`/`title` override the default cage number/tooltip.
function PortCell({ info, hot, dim, lldp, showEdgeStub, box, label, title, visualHidden = false, channel = false, onSelectNode, renderHandles }:
  { info: PortInfo; hot: boolean; dim: boolean; lldp: boolean; showEdgeStub: boolean; box?: Box; label?: ReactNode; title?: string; visualHidden?: boolean; channel?: boolean; onSelectNode?: (expand?: boolean) => void; renderHandles?: boolean }) {
  const free = info.kind === 'free';
  const fill = fillFor(info, lldp);
  const side = info.side === 'top' ? Position.Top : Position.Bottom;
  const id = portHandle(info.port, info.channel);
  const stubVisible = showsEdgeStub(info, showEdgeStub) && !hot;
  // responsive label: fit the number to the cell in BOTH axes (digit-aware) so dense composite panels
  // never overflow their tiny cages. Breakout channel text is deliberately smaller than a cage label.
  const digits = Math.max(1, String(label ?? info.port).length);
  const minFont = channel ? 3 : 4;
  const maxFont = channel ? 6.5 : 13;
  const fontSize = box ? Math.max(minFont, Math.min(maxFont, box.height * 0.8, box.width / (digits * 0.62))) : channel ? 5 : 7;
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
      title={title ?? (free
        ? `port ${info.port} · free`
        : `${info.interfaceLabel ?? info.port}${info.physicalAlias ? ` (${info.physicalAlias})` : ''} → ${info.remote} ${detailedPortLabel(info.remotePort)}`)}
      style={{
        ...(box ? { position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height }
          : { position: 'relative', width: CELL, height: CELL }),
        // breakout channels carry no ring of their own — the cage draws one ring around all of them
        // and the gaps between them read as thin light dividers (see BreakoutCage).
        borderRadius: channel ? 0 : 2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"NokiaPureText", sans-serif',   // match the SVG silkscreen labels
        fontSize, lineHeight: 1, fontWeight: 700,
        overflow: channel ? 'hidden' : 'visible',
        color: free ? 'var(--muted)' : 'var(--bg)',
        background: free ? 'var(--cell-free-bg)' : fill,
        // occupied ports ring in their own cable colour; the traced port rings white
        outline: channel ? 'none' : hot ? '1.5px solid white' : free ? '1px solid var(--cell-free-line)' : `1px solid ${fill}`,
        outlineOffset: -1,
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
      {(label != null || channel || !free) && (label ?? info.port)}
      {!free && renderHandles !== false && (
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
function BreakoutCage({ cage, displayLabel, infos, bo, connector, hot, selected, dim, lldp, showEdgeStubs, box, onSelectNode, renderHandles }:
  { cage: string; displayLabel: string; infos: PortInfo[]; bo: Breakout; connector?: ConnectorInfo; hot: boolean; selected: boolean; dim: boolean; lldp: boolean; showEdgeStubs: boolean; box?: Box; onSelectNode?: (expand?: boolean) => void; renderHandles?: boolean }) {
  const [hovered, setHovered] = useState(false);
  // Per-channel trace state: subscribe to a primitive derived from this cage's cables, so unrelated
  // trace updates don't re-render every breakout cage.
  const activeCableStr = useTrace((s) => {
    if (!s.any) return '';
    let out = '';
    for (const info of infos) {
      if (info.cableId && s.edges.has(info.cableId)) out += `${info.cableId}\n`;
    }
    return out;
  });
  const activeCableIds = useMemo(
    () => new Set(activeCableStr ? activeCableStr.trimEnd().split('\n') : []),
    [activeCableStr],
  );
  const n = Math.max(1, bo.channels);
  const W = box?.width ?? CELL, H = box?.height ?? CELL;
  const { cols, rows } = breakoutGrid(n);
  const byCh = useMemo(() => new Map(infos.map((i) => [i.channel ?? 1, i])), [infos]);
  // any channel of this cage in the active trace -> the whole cage rings white (one ring, like a port)
  const anyHot = hot || activeCableStr.length > 0;
  const label = bo.speed ? `${n}×${bo.speed} breakout` : `${n}-channel breakout`;
  const digits = Math.max(1, displayLabel.length);
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
      data-connector={connector?.label}
      title={`${displayLabel} · ${label}${connector ? ` · ${connector.label} · ${connector.physical}` : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={box
        ? { position: 'absolute', left: box.left, top: box.top, width: W, height: H }
        : { position: 'relative', width: CELL, height: CELL }}
    >
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 3, overflow: 'hidden',
        ...(expanded && {
          outline: `1.5px solid ${anyHot ? 'white' : collapsedFree ? 'var(--cell-free-line)' : collapsedFill}`,
          outlineOffset: -1,
        }),
      }}>
        {Array.from({ length: n }, (_, i) => {
          const ch = i + 1;
          const info = byCh.get(ch) ?? freeCell(cage);
          const occ = info.kind !== 'free';
          const chHot = !!info.cableId && activeCableIds.has(info.cableId);
          const chDim = dim || (activeCableStr.length > 0 && !chHot);
          const showChannelLabel = occ || hovered || selected || anyHot;
          return (
            <PortCell key={ch} info={info} hot={chHot} lldp={lldp} channel label={showChannelLabel ? String(ch) : ''} box={breakoutCellBox(n, ch, W, H)}
              dim={chDim}
              showEdgeStub={showEdgeStubs}
              onSelectNode={onSelectNode}
              renderHandles={renderHandles}
              visualHidden={!expanded}
              title={occ
                ? `${info.interfaceLabel ?? `${connector?.label ?? cage}/${ch}`}${info.physicalAlias ? ` (${info.physicalAlias})` : ''} → ${info.remote} ${detailedPortLabel(info.remotePort)}`
                : `${connector?.label ?? displayLabel}/${ch} · free${bo.speed ? ` · ${bo.speed}` : ''}`} />
          );
        })}
        {expanded && Array.from({ length: cols - 1 }, (_, i) => (
          <span key={`v${i}`} aria-hidden style={{
            position: 'absolute', top: 0, bottom: 0, left: `${((i + 1) / cols) * 100}%`,
            width: 0.35, transform: 'translateX(-50%)', background: 'var(--line)', opacity: 0.55,
            pointerEvents: 'none', zIndex: 2,
          }} />
        ))}
        {expanded && Array.from({ length: rows - 1 }, (_, i) => (
          <span key={`h${i}`} aria-hidden style={{
            position: 'absolute', left: 0, right: 0, top: `${((i + 1) / rows) * 100}%`,
            height: 0.35, transform: 'translateY(-50%)', background: 'var(--line)', opacity: 0.55,
            pointerEvents: 'none', zIndex: 2,
          }} />
        ))}
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
            color: collapsedFree ? 'var(--muted)' : 'var(--bg)',
            opacity: expanded ? 0 : dim ? 0.24 : 1,
            pointerEvents: expanded ? 'none' : 'auto',
            cursor: 'pointer',
            transition: 'opacity 120ms, outline-color 120ms',
            zIndex: 3,
          }}
        >
          {displayLabel}
        </div>
      </div>
      {expanded && box && H >= 10 && (
        <div aria-hidden style={{
          position: 'absolute', left: '50%', top: -7, zIndex: 5,
          transform: 'translateX(-50%)', padding: '0 1.5px', borderRadius: 2,
          color: 'var(--fg)', background: 'var(--panel)',
          fontSize: 5.5, lineHeight: 1, fontWeight: 700, whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}>
          {displayLabel}
        </div>
      )}
    </div>
  );
}

const freeCell = (port: string): PortInfo => ({ port, kind: 'free', side: 'bottom', remote: '', remotePort: '', desc: '', cableId: '' });

// One cage: a breakout splits into channel slivers, otherwise it's a single cell (free if uncabled).
function renderCage(cage: string, displayLabel: string, infos: PortInfo[] | undefined, bo: Breakout | undefined, connector: ConnectorInfo | undefined, hot: boolean, selected: boolean, dim: boolean, lldp: boolean, showEdgeStubs: boolean, box?: Box, onSelectNode?: (expand?: boolean) => void, renderHandles?: boolean) {
  if (bo && bo.channels > 1) return <BreakoutCage key={cage} cage={cage} displayLabel={displayLabel} infos={infos ?? []} bo={bo} connector={connector} hot={hot} selected={selected} dim={dim} lldp={lldp} showEdgeStubs={showEdgeStubs} box={box} onSelectNode={onSelectNode} renderHandles={renderHandles} />;
  return <PortCell key={cage} info={infos?.[0] ?? freeCell(cage)} label={displayLabel} title={connector && !infos?.length ? `${displayLabel} · ${connector.label} · ${connector.physical} · free · ${connector.speed}` : undefined} hot={hot} dim={dim && !hot} lldp={lldp} showEdgeStub={showEdgeStubs} box={box} onSelectNode={onSelectNode} renderHandles={renderHandles} />;
}

function CompactSwitchNode({ id, data, selected }: NodeProps) {
  const d = data as SwitchData;
  const isSelected = typeof d.selected === 'boolean' ? d.selected : selected;
  const icon = RoleIcons[d.role];
  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const lldp = useLldp();
  const renderHandles = d.renderHandles !== false;
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const p of occupiedCages(d.ports)) {
      const key = lldp ? p.lldp ?? 'none' : p.kind;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return [...out.entries()];
  }, [d.ports, lldp]);
  const used = useMemo(() => occupiedCages(d.ports).length, [d.ports]);
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
      style={{
        position: 'relative',
        width: COMPACT_SWITCH_W,
        height: COMPACT_SWITCH_H,
        background: 'var(--panel)',
        borderRadius: 6,
        padding: '6px 7px',
        border: `1.5px solid ${isSelected ? 'var(--eda-blue-400)' : mode === 'on' ? 'var(--eda-gray-600)' : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.32 : 1,
        transition: 'opacity 120ms, border-color 120ms',
        boxShadow: mode === 'on' ? '0 0 0 1px var(--eda-blue-400)' : undefined,
      }}
    >
      {renderHandles && (
        <>
          <Handle type="source" id={compactSwitchHandle('top')} position={Position.Top} isConnectable={false}
            style={{ ...handleStyle, top: -5 }} />
          <Handle type="target" id={compactSwitchHandle('top', true)} position={Position.Top} isConnectable={false}
            style={{ ...handleStyle, top: -5 }} />
          <Handle type="source" id={compactSwitchHandle('bottom')} position={Position.Bottom} isConnectable={false}
            style={{ ...handleStyle, bottom: -5, top: 'auto' }} />
          <Handle type="target" id={compactSwitchHandle('bottom', true)} position={Position.Bottom} isConnectable={false}
            style={{ ...handleStyle, bottom: -5, top: 'auto' }} />
        </>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <RoleIcon icon={icon} size={15} role={d.role} nodeState={d.nodeState} synced={d.synced} />
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

function SummaryPanelCanvas({ data, lldp, width, height, showLabels }: { data: SwitchData; lldp: boolean; width: number; height: number; showLabels: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const byPort = useMemo(() => {
    const m = new Map<string, PortInfo[]>();
    for (const p of data.ports) (m.get(p.port) ?? m.set(p.port, []).get(p.port)!).push(p);
    return m;
  }, [data.ports]);
  const layoutKey = useMemo(
    () => data.layout?.map((p) => `${p.p}:${p.x}:${p.y}:${p.w}:${p.h}`).join('|') ?? '',
    [data.layout],
  );

  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const colors = new Map<string, string>();
    const resolveColor = (css: string) => {
      const cached = colors.get(css);
      if (cached) return cached;
      const resolved = cssColor(css);
      colors.set(css, resolved);
      return resolved;
    };
    const freeBg = resolveColor('var(--cell-free-bg)');
    const freeLine = resolveColor('var(--cell-free-line)');
    const freeText = resolveColor('var(--muted)');
    const occupiedText = resolveColor('var(--bg)');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const drawCell = (port: string, x: number, y: number, w: number, h: number) => {
      const infos = byPort.get(port) ?? [];
      const info = infos[0];
      const connector = data.connectors?.[port];
      const fill = info ? resolveColor(fillFor(info, lldp)) : freeBg;
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = info ? fill : freeLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      if (!showLabels || w < 5 || h < 5) return;
      const label = data.portLabels?.[port] ?? connector?.label ?? String(port).split('-').at(-1)!;
      const fontSize = Math.max(4, Math.min(9, h * 0.72, w / (Math.max(1, label.length) * 0.62)));
      ctx.font = `700 ${fontSize}px sans-serif`;
      ctx.fillStyle = info ? occupiedText : freeText;
      ctx.fillText(label, x + w / 2, y + h / 2 + 0.2, Math.max(1, w - 1));
    };

    if (data.layout?.length) {
      for (const p of data.layout) {
        const w = Math.max(3, p.w * width);
        const h = Math.max(3, p.h * height);
        drawCell(p.p, p.x * width - w / 2, p.y * height - h / 2, w, h);
      }
      return;
    }

    const rows = Math.max(1, data.rows);
    for (let i = 0; i < data.portCount; i += 1) {
      const row = i % rows;
      const col = Math.floor(i / rows);
      drawCell(String(i + 1), col * (CELL + CELL_GAP), row * (CELL + CELL_GAP), CELL, CELL);
    }
  }, [byPort, data.breakouts, data.connectors, data.layout, data.portCount, data.portLabels, data.rows, height, layoutKey, lldp, showLabels, width]);

  return <canvas ref={ref} aria-hidden style={{ display: 'block', pointerEvents: 'none' }} />;
}

function SummarySwitchNode({ id, data, selected }: NodeProps) {
  const d = data as SwitchData;
  const isSelected = typeof d.selected === 'boolean' ? d.selected : selected;
  const rows = Math.max(1, d.rows);
  const cols = Math.ceil(d.portCount / rows);
  const icon = RoleIcons[d.role];
  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const lldp = useLldp();
  const used = useMemo(() => occupiedCages(d.ports).length, [d.ports]);
  const panel = useMemo(() => {
    if (!d.layout) return null;
    const { w: W, h: H } = panelDims(rows, d.aspect ?? 4);
    return { W, H };
  }, [d.layout, d.aspect, rows]);
  const panelW = panel?.W ?? (cols * CELL + Math.max(0, cols - 1) * CELL_GAP);
  const panelH = panel?.H ?? (rows * CELL + Math.max(0, rows - 1) * CELL_GAP);

  return (
    <div
      className="switch-node"
      data-mode={mode}
      data-detail-level={d.detailLevel ?? 'summary'}
      onMouseEnter={() => trace.hover(`node:${id}`)}
      onMouseLeave={() => trace.hover(null)}
      style={{
        background: 'var(--panel)', borderRadius: 8, padding: 8,
        border: `1.5px solid ${isSelected ? 'var(--eda-blue-400)' : mode === 'on' ? 'var(--eda-gray-600)' : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.32 : 1, transition: 'opacity 140ms, border-color 140ms',
        contain: 'layout paint style',
        ...(panel ? { width: panel.W + 16, boxSizing: 'border-box' as const } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, height: 20 }}>
        <RoleIcon icon={icon} size={18} role={d.role} nodeState={d.nodeState} synced={d.synced} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: '60%' }}>{d.name}</span>
        <span style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{d.platform}</span>
        <span style={{ flex: 1, minWidth: 0 }} />
        <span style={{ fontSize: 8.5, color: 'var(--muted)', flexShrink: 0 }}>{used}/{d.portCount}</span>
      </div>
      <SummaryPanelCanvas data={d} lldp={lldp} width={panelW} height={panelH} showLabels={d.detailLevel === 'labeled'} />
    </div>
  );
}

function DetailedSwitchNode({ id, data, selected }: NodeProps) {
  const d = data as SwitchData;
  const isSelected = typeof d.selected === 'boolean' ? d.selected : selected;
  const openNode = useOpenNode();
  const openThisNode = useCallback((expand?: boolean) => openNode(id, { expand }), [id, openNode]);
  const rows = Math.max(1, d.rows);
  const cols = Math.ceil(d.portCount / rows);
  const icon = RoleIcons[d.role];

  const mode = useTrace(modeFor((s) => s.nodes.has(id)));
  const traceAny = useTrace((s) => s.any);
  const lldp = useLldp();
  const renderHandles = d.renderHandles !== false;
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
    const add = (port: string) => {
      out.add(port);
      const channelSep = port.lastIndexOf('_');
      if (channelSep > 0) out.add(port.slice(0, channelSep));
    };
    for (const p of activeStr ? activeStr.split('\n') : []) add(p);
    for (const p of expandedStubStr ? expandedStubStr.split('\n') : []) add(p);
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
  const used = useMemo(() => occupiedCages(d.ports).length, [d.ports]);
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
      data-detail-level={d.detailLevel ?? 'full'}
      onMouseEnter={() => { if (!d.showEdgeStubs) trace.hover(`node:${id}`); }}
      onMouseLeave={() => trace.hover(null)}
      style={{
        background: 'var(--panel)', borderRadius: 8, padding: 8,
        border: `1.5px solid ${isSelected ? 'var(--eda-blue-400)' : mode === 'on' ? 'var(--eda-gray-600)' : 'var(--line)'}`,
        opacity: mode === 'dim' ? 0.32 : 1, transition: 'opacity 140ms, border-color 140ms',
        contentVisibility: d.showEdgeStubs ? 'visible' : 'auto',
        containIntrinsicSize: panel ? `${panel.W + 16}px ${panel.H + 44}px` : '220px 96px',
        // real-layout: pin the node to the port-panel width (matches graph.ts swW) so a long platform
        // name in the header can't widen it past the furthest ports — the header truncates instead.
        ...(panel ? { width: panel.W + 16, boxSizing: 'border-box' as const } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, height: 20 }}>
        <RoleIcon icon={icon} size={18} role={d.role} nodeState={d.nodeState} synced={d.synced} />
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
            const displayLabel = d.portLabels?.[cage] ?? d.connectors?.[cage]?.label ?? cage.split('-').at(-1)!;
            return renderCage(cage, displayLabel, byPort.get(cage), d.breakouts?.[cage], d.connectors?.[cage], hot, isSelected, dimInactivePorts && !hot, lldp, !!d.showEdgeStubs, box, openThisNode, renderHandles);
          })}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${CELL}px)`, gridTemplateRows: `repeat(${rows}, ${CELL}px)`, gridAutoFlow: 'column', gap: CELL_GAP }}>
          {cages.map((cage) => {
            const hot = hotPorts.has(cage);
            const displayLabel = d.portLabels?.[cage] ?? d.connectors?.[cage]?.label ?? cage.split('-').at(-1)!;
            return renderCage(cage, displayLabel, byPort.get(cage), d.breakouts?.[cage], d.connectors?.[cage], hot, isSelected, dimInactivePorts && !hot, lldp, !!d.showEdgeStubs, undefined, openThisNode, renderHandles);
          })}
        </div>
      )}
    </div>
  );
}

function SwitchNode(props: NodeProps) {
  const d = props.data as SwitchData;
  if (!d.compact && (d.detailLevel === 'summary' || d.detailLevel === 'labeled')) return <SummarySwitchNode {...props} />;
  return d.compact ? <CompactSwitchNode {...props} /> : <DetailedSwitchNode {...props} />;
}

export default memo(SwitchNode);
