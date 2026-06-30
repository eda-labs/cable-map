import frontpanelMeta from '../../generated/frontpanel-meta.json';

export type FrontPanelPortPos = { p: string; x: number; y: number; w: number; h: number };
export type FrontPanelMeta = {
  ports: number;
  rows: number;
  aspect: number;
  slotted: boolean;
  layout: FrontPanelPortPos[];
};

const FP_META = frontpanelMeta as Record<string, FrontPanelMeta>;

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
