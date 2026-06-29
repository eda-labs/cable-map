import { CABLE_COLOR, LLDP_COLOR } from '../graph/constants';

export type RgbColor = [number, number, number];
export type RgbaColor = [number, number, number, number];

const colorCache = new Map<string, RgbaColor>();
let probe: CanvasRenderingContext2D | null = null;

export function resolveRgbaColor(css: string, themeKey = ''): RgbaColor {
  const key = `${themeKey}|${css}`;
  const hit = colorCache.get(key);
  if (hit) return hit;

  let value = css;
  const variable = /var\((--[^)]+)\)/.exec(css);
  if (variable) value = getComputedStyle(document.documentElement).getPropertyValue(variable[1]).trim() || '#888888';

  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  let rgba: RgbaColor = [0.5, 0.5, 0.5, 1];
  if (probe) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000000';
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const data = probe.getImageData(0, 0, 1, 1).data;
    rgba = [data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255];
  }
  colorCache.set(key, rgba);
  return rgba;
}

export function resolveRgbColor(css: string, themeKey = ''): RgbColor {
  const [r, g, b] = resolveRgbaColor(css, themeKey);
  return [r, g, b];
}

export function resolveNodePalette(themeKey: string) {
  return {
    panel: resolveRgbaColor('var(--panel)', themeKey),
    line: resolveRgbaColor('var(--line)', themeKey),
    free: resolveRgbaColor('var(--cell-free-bg)', themeKey),
    isl: resolveRgbaColor(CABLE_COLOR.isl, themeKey),
    edge: resolveRgbaColor(CABLE_COLOR.edge, themeKey),
    lag: resolveRgbaColor(CABLE_COLOR.lag, themeKey),
    mlag: resolveRgbaColor(CABLE_COLOR.mlag, themeKey),
    ok: resolveRgbaColor(LLDP_COLOR.ok, themeKey),
    mismatch: resolveRgbaColor(LLDP_COLOR.mismatch, themeKey),
    none: resolveRgbaColor(LLDP_COLOR.none, themeKey),
  };
}

export type NodePalette = ReturnType<typeof resolveNodePalette>;
