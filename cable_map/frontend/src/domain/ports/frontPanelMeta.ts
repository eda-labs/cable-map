import frontpanelMeta from '../../generated/frontpanel-meta.json';
import frontpanelLabels from '../../generated/frontpanel-labels.json';

export type FrontPanelPortPos = { p: string; x: number; y: number; w: number; h: number };
export type FrontPanelMeta = {
  ports: number;
  rows: number;
  aspect: number;
  slotted: boolean;
  layout: FrontPanelPortPos[];
};

const FP_META = frontpanelMeta as Record<string, FrontPanelMeta>;
const FP_LABEL_STYLE = frontpanelLabels as Record<string, Record<string, 'c' | ''>>;
const PORT_LABEL_CACHE = new Map<string, Record<string, string>>();

export const frontPanelPlatforms = (): string[] => Object.keys(FP_META);
export const frontPanelMetaOf = (platform: string): FrontPanelMeta | undefined => FP_META[platform];
export const hasFrontPanelMeta = (platform: string): boolean => Object.hasOwn(FP_META, platform);

// per-platform metadata derived from the stencils' data-port cages, so the canvas panel matches the
// real box: port count, physical cage-row count, cage-box aspect (w/h), and on-panel port layout.
export const rowsOf = (platform: string): number => FP_META[platform]?.rows ?? 2;
export const portCountOf = (platform: string): number => FP_META[platform]?.ports ?? 32;
export const layoutOf = (platform: string): FrontPanelPortPos[] | undefined => {
  const layout = FP_META[platform]?.layout;
  return layout && layout.length ? layout : undefined;
};
export const aspectOf = (platform: string): number => FP_META[platform]?.aspect ?? 4;
// modular chassis whose cages are addressed per slot ("<slot>-<port>"); drives cageKey() parsing.
export const slottedOf = (platform: string): boolean => FP_META[platform]?.slotted ?? false;

// User-facing cage labels copied from the stencil's baked silkscreen. The layout key remains the
// unique internal address (e.g. "2-1"), while the visible label is "c1" or "1" for that card.
export const portLabelsOf = (platform: string): Record<string, string> => {
  const cached = PORT_LABEL_CACHE.get(platform);
  if (cached) return cached;
  const styles = FP_LABEL_STYLE[platform];
  const labels: Record<string, string> = {};
  for (const port of FP_META[platform]?.layout ?? []) {
    const parts = port.p.split('-');
    const number = parts.at(-1)!;
    const slot = parts.length > 1 ? parts.slice(0, -1).join('-') : '';
    labels[port.p] = `${styles?.[slot] ?? ''}${number}`;
  }
  PORT_LABEL_CACHE.set(platform, labels);
  return labels;
};
