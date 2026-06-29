import { cageKey } from '../domain/ports/interfaceNames';
import { aspectOf, layoutOf, rowsOf } from '../domain/ports/frontPanelMeta';
import type { SwitchData } from './types';

// ---- node sizing --------------------------------------------------------
const CELL = 13, CELL_GAP = 3, HEAD_H = 32;
export const STRIP_PAD = 8;
export const COMPACT_SWITCH_W = 132;
export const COMPACT_SWITCH_H = 46;
export const compactSwitchHandle = (side: 'top' | 'bottom', target = false) => `compact-${side}${target ? 't' : ''}`;

const colsOf = (portCount: number, rows: number) => Math.max(1, Math.ceil(portCount / rows));
export const switchW = (portCount: number, rows: number) =>
  Math.max(196, colsOf(portCount, rows) * (CELL + CELL_GAP) + STRIP_PAD * 2);
const switchH = (rows: number) => HEAD_H + rows * CELL + (rows - 1) * CELL_GAP + STRIP_PAD * 2;

// real-layout panel: sized by cage rows (so port numbers stay legible), width from the cage-box aspect.
const LAYOUT_ROW = 19;
export const panelDims = (rows: number, aspect: number) => ({ w: rows * LAYOUT_ROW * aspect, h: rows * LAYOUT_ROW });
export const switchHOf = (platform: string) =>
  layoutOf(platform)
    ? HEAD_H + panelDims(rowsOf(platform), aspectOf(platform)).h + STRIP_PAD * 2
    : switchH(rowsOf(platform));

const SWITCH_HEADER_H = 20, SWITCH_HEADER_MB = 6;
const SWITCH_PANEL_X = STRIP_PAD, SWITCH_PANEL_Y = STRIP_PAD + SWITCH_HEADER_H + SWITCH_HEADER_MB;

// ---- ports --------------------------------------------------------------
// React Flow handle id for a port (and breakout channel) — channelised so each sub-port's cable
// attaches to its own sliver rather than all converging on the cage.
export const portHandle = (port: string, channel?: number) => (channel ? `p${port}_${channel}` : `p${port}`);

export function breakoutGrid(channels: number): { cols: number; rows: number } {
  const n = Math.max(1, channels);
  const rows = n > 4 ? 2 : 1;
  return { cols: Math.ceil(n / rows), rows };
}

function switchCages(d: SwitchData): string[] {
  return d.layout ? d.layout.map((p) => p.p) : Array.from({ length: d.portCount }, (_, i) => String(i + 1));
}

export function findSwitchPort(d: SwitchData, text: string): string | null {
  const cages = switchCages(d);
  const cageSet = new Set(cages);
  const slotted = cages.some((cage) => cage.includes('-'));
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = new Set<string>();

  for (const token of [text.toLowerCase(), ...tokens]) {
    const key = cageKey(token, slotted);
    if (key) candidates.add(key);

    const normalized = token
      .replace(/^ethernet-/, '')
      .replace(/^et-/, '')
      .replace(/\//g, '-')
      .replace(/[^a-z0-9-]+/g, '');
    if (normalized) candidates.add(normalized);

    const numbers = token.match(/\d+/g) ?? [];
    if (numbers.length >= 2) candidates.add(`${numbers[0]}-${numbers[1]}`);
    if (numbers.length >= 1) candidates.add(numbers.at(-1)!);
  }

  for (const candidate of candidates) {
    if (cageSet.has(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate)) continue;
    const match = cages.find((cage) => cage === candidate || cage.endsWith(`-${candidate}`));
    if (match) return match;
  }
  return null;
}

export function switchPortCenter(d: SwitchData, port: string, channel?: number): { x: number; y: number } | null {
  const channelOffset = (width: number, height: number) => {
    const bo = d.breakouts?.[port];
    if (!bo || !channel) return { x: 0, y: 0 };
    const n = Math.max(1, bo.channels);
    const ch = Math.max(1, Math.min(n, channel));
    const { cols, rows } = breakoutGrid(n);
    const col = (ch - 1) % cols;
    const row = Math.floor((ch - 1) / cols);
    const colGap = cols > 2 ? 0.5 : 1;
    const rowGap = rows > 1 ? 0.5 : 0;
    const sw = (width - colGap * (cols - 1)) / cols;
    const sh = (height - rowGap * (rows - 1)) / rows;
    return {
      x: -width / 2 + col * (sw + colGap) + sw / 2,
      y: -height / 2 + row * (sh + rowGap) + sh / 2,
    };
  };

  if (d.compact) {
    const numbered = Number(port.split('-').at(-1));
    const index = Number.isFinite(numbered) ? Math.max(0, Math.min(d.portCount - 1, numbered - 1)) : 0;
    const used = d.ports.find((p) => p.port === port);
    return {
      x: 10 + ((index + 0.5) / Math.max(1, d.portCount)) * (COMPACT_SWITCH_W - 20),
      y: used?.side === 'bottom' ? COMPACT_SWITCH_H - 2 : 2,
    };
  }

  const rows = Math.max(1, d.rows);
  if (d.layout) {
    const p = d.layout.find((pos) => pos.p === port);
    if (!p) return null;
    const { w: W, h: H } = panelDims(rows, d.aspect ?? 4);
    const offset = channelOffset(Math.max(3, p.w * W), Math.max(3, p.h * H));
    return { x: SWITCH_PANEL_X + p.x * W + offset.x, y: SWITCH_PANEL_Y + p.y * H + offset.y };
  }

  const index = Number(port) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= d.portCount) return null;
  const row = index % rows;
  const col = Math.floor(index / rows);
  const offset = channelOffset(CELL, CELL);
  return {
    x: SWITCH_PANEL_X + col * (CELL + CELL_GAP) + CELL / 2 + offset.x,
    y: SWITCH_PANEL_Y + row * (CELL + CELL_GAP) + CELL / 2 + offset.y,
  };
}
