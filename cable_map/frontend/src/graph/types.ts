import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { Breakout, LldpStatus } from '../domain/topology/contract';
import type { ConnectorInfo } from '../domain/ports/srosPorts';
import type { Adjacency } from './adjacency';

export type CableKind = 'isl' | 'edge' | 'lag' | 'mlag';

export type PortPos = { p: string; x: number; y: number; w: number; h: number };

export type PortInfo = {
  port: string;         // cage id matching the stencil's data-port ("<port>" or "<slot>-<port>")
  channel?: number;     // breakout channel (1-based) when this cable lands on a broken-out sub-port
  interfaceLabel?: string; // native interface name shown first in hover details
  physicalAlias?: string;  // EDA physical SR OS alias (e.g. 1-a-1-1)
  kind: CableKind | 'free';
  side: 'top' | 'bottom';
  remote: string;       // short remote label e.g. "spine1" / "srv03" / "lag-a"
  remotePort: string;
  desc: string;
  cableId: string;      // edge id this port terminates, for hover-to-trace
  lldp?: LldpStatus;    // LLDP cross-check vs the configured remote
};

export type SwitchDetailLevel = 'full' | 'labeled' | 'summary';

export type SwitchData = {
  name: string; role: string; platform: string;
  nodeState?: string;
  synced?: boolean;
  portCount: number;
  rows: number;                      // physical cage rows, mirrored on the canvas
  ports: PortInfo[];                 // occupied ports only (free cells inferred)
  layout?: PortPos[];                // real on-panel port positions (from the stencil); else grid
  aspect?: number;                   // cage-box w/h, to size the layout panel
  breakouts?: Record<string, Breakout>;  // cage id -> breakout split (channels + speed)
  connectors?: Record<string, ConnectorInfo>; // SR OS connector inventory keyed by panel cage
  portLabels?: Record<string, string>;   // stencil silkscreen label keyed by internal cage id
  compact?: boolean;                 // large-topology mode: draw a cheap aggregate switch node
  renderHandles?: boolean;           // false when WebGL computes cable endpoints from node data
  detailLevel?: SwitchDetailLevel;   // adaptive detail: labeled/summary draw the panel into one canvas
  selected?: boolean;                // programmatic focus/selection mirrored outside React Flow's transient selection store
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
  renderHandles?: boolean;
};

export type GraphEndpoint = { id: string; leaves: string[]; data: EndpointData };

export type BuiltGraph = { nodes: RFNode[]; edges: RFEdge[]; adjacency: Adjacency };
export type BuildGraphOptions = { compact?: boolean; tiered?: boolean };
