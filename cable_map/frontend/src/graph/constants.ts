import type { LldpStatus } from '../domain/topology/contract';
import type { CableKind } from './types';

// Tier: smaller = closer to the fabric core (drawn higher up). The backend computes
// node.tier from the cluster's TopologyGrouping; the role map mirrors EDA's bootstrap
// "role" grouping as a fallback for data that predates the tier field (dev fixtures).
const ROLE_TIER: Record<string, number> = { backbone: 1, superspine: 2, spine: 3, borderleaf: 4, leaf: 4 };
export const tierOf = (n: { tier?: number; role?: string }): number => n.tier ?? ROLE_TIER[n.role ?? ''] ?? 4;

export const LARGE_TOPOLOGY_NODE_THRESHOLD = 300;
export const LARGE_TOPOLOGY_ROW_THRESHOLD = 5000;

export const EP_W = 112;
export const EP_H = 22;
export const EP_VGAP = 6;
export const EP_HGAP = 10;
export const EP_COLS = 2;

export const SPINE_Y = 0;
export const LEAF_Y = 320;
export const EP_TOP_GAP = 34;

// edge = plain server cable, lag = local port-channel (all members one box),
// mlag = multihomed/ESI bond (members span two leaves), isl = fabric uplink.
export const CABLE_COLOR: Record<CableKind, string> = {
  isl: 'var(--eda-blue-400)', edge: 'var(--eda-teal-500)', lag: 'var(--eda-yellow-500)', mlag: 'var(--eda-purple-400)',
};

// LLDP overlay palette (used in place of CABLE_COLOR while the overlay is on).
export const LLDP_COLOR: Record<LldpStatus, string> = {
  ok: 'var(--eda-green-500)', mismatch: 'var(--eda-red-500)', none: 'var(--eda-gray-600)',
};

const LLDP_RANK: Record<LldpStatus, number> = { ok: 0, none: 1, mismatch: 2 };
// a bundle/bond takes its worst member status — a mismatch anywhere wins.
export const worseLldp = (a: LldpStatus, b: LldpStatus): LldpStatus => (LLDP_RANK[a] >= LLDP_RANK[b] ? a : b);
