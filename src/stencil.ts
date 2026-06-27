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

// 7750 SR-1 and the modular 7750 SR-1s both have TWO side-by-side MDA bays: stencil is
// "<platform> <mda-slot1>_<mda-slot2>" (a single MDA mirrors into both slots so it still matches).
const TWO_BAY_CHASSIS = new Set(['7750 SR-1', '7750 SR-1s']);
// SR-1se resolves to "<platform> <mda>" for its distinct card faceplate.
const SINGLE_MDA_CHASSIS = new Set(['7750 SR-1se']);

// '/' and '+' are mangled in stencil filenames/URLs (slash = path sep, '+' decodes to space in the
// static-server path), so the composites are written with them flattened to '-'; match that here.
const sanitise = (t: string) => t.replace(/[/+]/g, '-');
const mdaTypes = (components?: Component[]): string[] =>
  (components ?? [])
    .filter((c) => c.kind === 'mda' && c.type)
    .sort((a, b) => (a.slot ?? '').localeCompare(b.slot ?? '', undefined, { numeric: true }))
    .map((c) => sanitise(c.type!));

// The stencil name to render for a node: a card-derived variant for modular chassis when that stencil
// exists, else its platform if that already names a stencil, else the platform unchanged (schematic).
export function stencilFor(platform: string, components?: Component[]): string {
  // 7750 SR-1s also takes a full-width XMA-s (s18/s36) that fills the XCM -> single faceplate;
  // its ms* MDAs pair via the two-bay branch below.
  if (platform === '7750 SR-1s') {
    const xma = mdaTypes(components).find((t) => /^s18|^s36/.test(t));
    if (xma) {
      const v = `7750 SR-1s ${/^s18/.test(xma) ? 's18-100gb-qsfp28' : 's36-400gb-qsfpdd'}`;
      if (KNOWN.has(v)) return v;
    }
  }
  // Two-bay chassis (SR-1, modular SR-1s): place each MDA in its bay; an empty bay -> a blank plate
  // (e.g. one MDA installed -> "<card>_blank" / "blank_<card>").
  if (TWO_BAY_CHASSIS.has(platform)) {
    const bay = new Map<string, string>();
    for (const c of components ?? []) {
      if (c.kind !== 'mda' || !c.type) continue;
      const b = (c.slot ?? '').split('/').pop() || '1';
      if (!bay.has(b)) bay.set(b, sanitise(c.type));
    }
    if (bay.size) {
      const pair = `${platform} ${bay.get('1') ?? 'blank'}_${bay.get('2') ?? 'blank'}`;
      if (KNOWN.has(pair)) return pair;
    }
  }
  // 7750 SR-2se: two stacked XCM slots, each a 36-port XMA or an IOM with 2 MDAs -> "<c1>_<c2>"
  // (5×5 matrix). All 36-port XMA SKUs (x2-s36*/m36*) collapse to one code; mse* map to themselves.
  // NB: per-slot grouping uses the MDA's slot prefix — verify against a real onboarded SR-2se.
  if (platform === '7750 SR-2se') {
    const slotCode = (t: string) => (/^x2-s36|^m36/.test(t) ? 'x2-s36-800g-qsfpdd' : sanitise(t));
    const bySlot = new Map<string, string>();
    for (const c of components ?? []) {
      if (c.kind !== 'mda' || !c.type) continue;
      const slot = (c.slot ?? '').split(/[/-]/)[0];
      if (!bySlot.has(slot)) bySlot.set(slot, slotCode(c.type));
    }
    if (bySlot.size) {
      const pair = `7750 SR-2se ${bySlot.get('1') ?? 'blank'}_${bySlot.get('2') ?? 'blank'}`;
      if (KNOWN.has(pair)) return pair;
    }
  }
  // 7750 SR-2s: same 2-XCM structure as SR-2se -> "<c1>_<c2>" (10×10). Each XCM = a full XMA-s
  // (s18/s36, SKUs collapse to one code each) or an IOM-s with 2 MDA-s. Group MDAs by XCM slot.
  if (platform === '7750 SR-2s') {
    const slotCode = (t: string) =>
      /^s18/.test(t) ? 's18-100gb-qsfp28'
        : /^s36/.test(t) ? 's36-400gb-qsfpdd'
          : t.endsWith('-b') && /^ms16/.test(t) ? 'ms16-100gb-sfpdd-4-100gb-qsfp28' // -b rev, same faceplate
            : t.endsWith('-b') && /^ms8/.test(t) ? 'ms8-100gb-sfpdd-2-100gb-qsfp28'
              : sanitise(t);
    const bySlot = new Map<string, string>();
    for (const c of components ?? []) {
      if (c.kind !== 'mda' || !c.type) continue;
      const slot = (c.slot ?? '').split(/[/-]/)[0];
      if (!bySlot.has(slot)) bySlot.set(slot, slotCode(c.type));
    }
    if (bySlot.size) {
      const pair = `7750 SR-2s ${bySlot.get('1') ?? 'blank'}_${bySlot.get('2') ?? 'blank'}`;
      if (KNOWN.has(pair)) return pair;
    }
  }
  // 7750 SR-1: integrated line-card variants report the bare modular platform -> fixed-variant stencil.
  if (platform === '7750 SR-1') {
    const lineCard = components?.find((c) => c.kind === 'lineCard')?.type;
    if (lineCard && SR1_LINECARD_STENCIL[lineCard]) return SR1_LINECARD_STENCIL[lineCard];
    if (components?.some((c) => c.type === 'cpm-1s')) return '7750 SR-1s';
  }
  if (SINGLE_MDA_CHASSIS.has(platform)) {
    const mda = mdaTypes(components)[0];
    const variant = mda && `${platform} ${mda}`;
    if (variant && KNOWN.has(variant)) return variant;
  }
  if (KNOWN.has(platform)) return platform;
  return platform;
}

// Pull the component list off an embedded TopoNode CR (raw.spec.component) for stencilFor.
export const componentsOf = (raw?: { [k: string]: unknown }): Component[] | undefined =>
  ((raw as { spec?: { component?: Component[] } } | undefined)?.spec?.component) ?? undefined;
