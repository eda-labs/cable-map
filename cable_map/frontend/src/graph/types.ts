import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { Breakout, LldpStatus } from '../api';
import type { Adjacency } from '../trace';

// edge = plain server cable, lag = local port-channel (all members one box),
// mlag = multihomed/ESI bond (members span two leaves), isl = fabric uplink.
export type CableKind = 'isl' | 'edge' | 'lag' | 'mlag';
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

export type PortPos = { p: string; x: number; y: number; w: number; h: number };

export type PortInfo = {
  port: string;         // cage id matching the stencil's data-port ("<port>" or "<slot>-<port>")
  channel?: number;     // breakout channel (1-based) when this cable lands on a broken-out sub-port
  kind: CableKind | 'free';
  side: 'top' | 'bottom';
  remote: string;       // short remote label e.g. "spine1" / "srv03" / "lag-a"
  remotePort: string;
  desc: string;
  cableId: string;      // edge id this port terminates, for hover-to-trace
  lldp?: LldpStatus;    // LLDP cross-check vs the configured remote
};

export type SwitchData = {
  name: string; role: string; platform: string;
  portCount: number;
  rows: number;                      // physical cage rows, mirrored on the canvas
  ports: PortInfo[];                 // occupied ports only (free cells inferred)
  layout?: PortPos[];                // real on-panel port positions (from the stencil); else grid
  aspect?: number;                   // cage-box w/h, to size the layout panel
  breakouts?: Record<string, Breakout>;  // cage id -> breakout split (channels + speed)
  compact?: boolean;                 // large-topology mode: draw a cheap aggregate switch node
  showEdgeStubs?: boolean;           // draw short local downlink stubs instead of remote endpoint chips
  activeEdgeStubPorts?: string[];     // "node:port" ids whose stubs are expanded to full cables
};

export type EndpointData = {
  label: string; full: string; remotePort: string;
  kind: 'edge' | 'lag' | 'mlag';
  members: number;        // member ports summed across every leaf it homes to
  leaves: string[];       // leaves this endpoint attaches to (>1 == multihomed)
  lacp?: boolean;         // LACP vs static (LAGs only)
  mode?: string;          // multihoming mode, e.g. AllActive (ESI only)
  lldp?: LldpStatus;      // worst LLDP status across the bond's member ports
};

export type BuiltGraph = { nodes: RFNode[]; edges: RFEdge[]; adjacency: Adjacency };
export type BuildGraphOptions = { compact?: boolean; tiered?: boolean };
