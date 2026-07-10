import type { Breakout, Node } from '../topology/contract';
import { componentsOf } from '../../stencil';
import { slottedOf } from './frontPanelMeta';
import { cageKey, parsePortAddress } from './interfaceNames';

export type ConnectorInfo = {
  cage: string;
  label: string;
  channels: number;
  speed: string;
  physical: string;
};

export type SrosPortModel = {
  connectors: Record<string, ConnectorInfo>;
  breakouts: Record<string, Breakout>;
};

const EMPTY_MODEL: SrosPortModel = { connectors: {}, breakouts: {} };
const connectorTypeRE = /^c(\d+)-(.+)$/i;

// Connector inventory is the SR OS source of truth for physical channel capacity. Building this
// once per node keeps component/address parsing out of the dense per-cage React render path.
export function srosPortModel(node: Node, stencil: string): SrosPortModel {
  if (node.os.toLowerCase() !== 'sros') return EMPTY_MODEL;

  const connectors: Record<string, ConnectorInfo> = {};
  const breakouts: Record<string, Breakout> = {};
  const slotted = slottedOf(stencil);

  for (const component of componentsOf(node.raw) ?? []) {
    if (component.kind !== 'connector' || !component.slot || !component.type) continue;
    const address = parsePortAddress(component.slot);
    const type = connectorTypeRE.exec(component.type.trim());
    if (!address || address.kind !== 'eda-physical' || !type) continue;

    const channels = Number(type[1]);
    if (!Number.isInteger(channels) || channels < 1) continue;
    const cage = cageKey(component.slot, slotted, stencil);
    if (!cage) continue;

    const info: ConnectorInfo = {
      cage,
      label: `c${address.connector ?? address.port}`,
      channels,
      speed: type[2],
      physical: component.slot,
    };
    connectors[cage] = info;
    if (channels > 1) breakouts[cage] = { channels, speed: type[2] };
  }

  return { connectors, breakouts };
}

export function mergeBreakouts(
  explicit: Record<string, Breakout> | undefined,
  connector: Record<string, Breakout>,
  inferred: Record<string, Breakout> | undefined,
): Record<string, Breakout> | undefined {
  const merged = { ...explicit, ...inferred, ...connector };
  return Object.keys(merged).length ? merged : undefined;
}
