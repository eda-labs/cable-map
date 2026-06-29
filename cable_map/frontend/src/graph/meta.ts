import frontpanelMeta from '../frontpanel-meta.json';
import type { PortPos } from './types';

type FpMeta = { ports: number; rows: number; aspect: number; slotted: boolean; layout: PortPos[] };
const FP_META: Record<string, FpMeta> = frontpanelMeta;

// per-platform metadata derived from the stencils' data-port cages, so the canvas panel matches the
// real box: port count, physical cage-row count, cage-box aspect (w/h), and on-panel port layout.
export const rowsOf = (platform: string) => FP_META[platform]?.rows ?? 2;
export const portCountOf = (platform: string) => FP_META[platform]?.ports ?? 32;
export const layoutOf = (platform: string) => { const l = FP_META[platform]?.layout; return l && l.length ? l : undefined; };
export const aspectOf = (platform: string) => FP_META[platform]?.aspect ?? 4;
// modular chassis whose cages are addressed per slot ("<slot>-<port>"); drives cageKey() parsing.
export const slottedOf = (platform: string) => FP_META[platform]?.slotted ?? false;
