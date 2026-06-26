// Resolves the front-panel stencil a node renders. Most platforms already match a stencil name
// 1:1 (fixed chassis, SR Linux); modular chassis report a bare platform (e.g. "7750 SR-1") whose
// panel is determined by the fitted line/MDA card, so we bridge those to one of the pre-generated
// stencil names in frontpanel-meta.json. The stencils/meta are the source of truth — this only maps
// onto them, it doesn't generate them.
import frontpanelMeta from './frontpanel-meta.json';

const KNOWN = new Set(Object.keys(frontpanelMeta));

type Component = { kind?: string; type?: string; slot?: string };

// 7750 SR-1: the integrated forwarding (line) card fixes the faceplate, so each line-card type maps
// to its fixed-variant stencil. EDA reports the variant platform directly for these, so the map only
// kicks in for a node reporting the bare modular "7750 SR-1".
const SR1_LINECARD_STENCIL: Record<string, string> = {
  'i24-800g-qsfpdd-1': '7750 SR-1-24D',
  'i40-200g-sfpdd+6-800g-qsfpdd-1': '7750 SR-1-46S',
  'i48-400g-qsfpdd-1': '7750 SR-1-48D',
  'i80-200g-sfpdd+12-400g-qsfpdd-1': '7750 SR-1-92S',
  'i48-800g-qsfpdd-1x': '7750 SR-1x-48D',
  'i80-200g-sfpdd+12-800g-qsfpdd-1x': '7750 SR-1x-92S',
  'imm36-800g-qsfpdd': '7750 SR-1se',
};

// Modular chassis whose faceplate is fixed by the fitted MDA: the stencil is "<platform> <mda-type>"
// (slash sanitised for the filename), e.g. SR-1s + ms18-100gb-qsfp28 -> "7750 SR-1s ms18-100gb-qsfp28".
const MDA_VARIANT_CHASSIS = new Set(['7750 SR-1', '7750 SR-1s', '7750 SR-1se']);

// The stencil name to render for a node: a card-derived variant for modular chassis when that stencil
// exists, else its platform if that already names a stencil, else the platform unchanged (schematic).
export function stencilFor(platform: string, components?: Component[]): string {
  if (MDA_VARIANT_CHASSIS.has(platform)) {
    const mda = components?.find((c) => c.kind === 'mda')?.type;
    const variant = mda && `${platform} ${mda.replace(/\//g, '-')}`;
    if (variant && KNOWN.has(variant)) return variant;
  }
  if (platform === '7750 SR-1') {
    const lineCard = components?.find((c) => c.kind === 'lineCard')?.type;
    if (lineCard && SR1_LINECARD_STENCIL[lineCard]) return SR1_LINECARD_STENCIL[lineCard];
    if (components?.some((c) => c.type === 'cpm-1s')) return '7750 SR-1s';
  }
  if (KNOWN.has(platform)) return platform;
  return platform;
}

// Pull the component list off an embedded TopoNode CR (raw.spec.component) for stencilFor.
export const componentsOf = (raw?: { [k: string]: unknown }): Component[] | undefined =>
  ((raw as { spec?: { component?: Component[] } } | undefined)?.spec?.component) ?? undefined;
