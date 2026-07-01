import type { Node, Topology } from './contract';
import { labelOf } from './labels';

const rackLabelKeys = [
  'eda.nokia.com/rack',
  'eda.nokia.com/rack-label',
  'eda.nokia.com/racklabel',
  'topology.eda.nokia.com/rack',
  'rack',
  'rackLabel',
  'racklabel',
  'rack.label',
];

const rackRowLabelKeys = [
  'eda.nokia.com/rack-row',
  'eda.nokia.com/row',
  'eda.nokia.com/aisle',
  'topology.eda.nokia.com/rack-row',
  'rack.row',
  'rackRow',
  'row',
  'aisle',
];

const rackRowIndexLabelKeys = [
  'eda.nokia.com/rack-row-index',
  'eda.nokia.com/row-index',
  'topology.eda.nokia.com/rack-row-index',
  'rack.rowIndex',
  'rowIndex',
];

const rackPositionLabelKeys = [
  'eda.nokia.com/rack-position',
  'eda.nokia.com/rack-index',
  'eda.nokia.com/rack-number',
  'topology.eda.nokia.com/rack-position',
  'rack.position',
  'rack.index',
  'rackPosition',
  'position',
];

const rackSideLabelKeys = [
  'eda.nokia.com/rack-side',
  'eda.nokia.com/rack-facing',
  'topology.eda.nokia.com/rack-side',
  'rack.side',
  'rackSide',
  'side',
];

const rackUnitStartLabelKeys = [
  'eda.nokia.com/rack-u',
  'eda.nokia.com/rack-unit',
  'eda.nokia.com/rack-u-start',
  'topology.eda.nokia.com/rack-u',
  'rack.u',
  'rackUnit',
  'u',
];

const rackUnitCountLabelKeys = [
  'eda.nokia.com/rack-units',
  'eda.nokia.com/rack-ru',
  'eda.nokia.com/ru',
  'topology.eda.nokia.com/rack-units',
  'rack.units',
  'rackUnits',
  'ru',
];

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const pad2 = (value: number) => String(value).padStart(2, '0');

export type RackSide = 'front' | 'back';

export type RackPlacement = {
  row: string;
  rowIndex: number;
  rackIndex: number;
  side: RackSide;
  explicit: boolean;
};

export type RackDevice = {
  node: Node;
  rack: string;
  ru: number;
  uStart: number;
  uEnd: number;
};

export type RackGroup = {
  label: string;
  devices: RackDevice[];
  placement: RackPlacement;
  ruCapacity: number;
  ruUsed: number;
};

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const out = String(value).trim();
  return out || undefined;
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function labelValue(node: Node, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = labelOf(node, key);
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function intValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\d+/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numbersOf(value: string): number[] {
  return (value.match(/\d+/g) ?? [])
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function firstNumber(value: string): number | undefined {
  return numbersOf(value)[0];
}

function lastNumber(value: string): number | undefined {
  return numbersOf(value).at(-1);
}

function letterIndex(value: string): number | undefined {
  const match = /(?:^|[-_\s])([a-z])$/i.exec(value.trim());
  if (!match) return undefined;
  return match[1].toUpperCase().charCodeAt(0) - 64;
}

function semanticRowIndex(value: string): number | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes('core')) return 1;
  if (normalized.includes('spine') || normalized.includes('network') || normalized.includes('net')) return 2;
  if (normalized.includes('edge') || normalized.includes('border')) return 3;
  return undefined;
}

function sideValue(value: string | undefined): RackSide | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['b', 'back', 'rear', 'south', 'right'].includes(normalized)) return 'back';
  if (['a', 'front', 'north', 'left'].includes(normalized)) return 'front';
  return undefined;
}

function rackRowOf(node: Node, rack: string, fallbackIndex: number): { row: string; rowIndex: number; explicit: boolean } {
  const explicitIndex = intValue(labelValue(node, rackRowIndexLabelKeys));
  const value = labelValue(node, rackRowLabelKeys);
  if (value) {
    return {
      row: value,
      rowIndex: explicitIndex ?? firstNumber(value) ?? letterIndex(value) ?? semanticRowIndex(value) ?? fallbackIndex + 1,
      explicit: true,
    };
  }

  const pod = labelOf(node, 'eda.nokia.com/pod');
  if (pod) {
    return { row: pod, rowIndex: explicitIndex ?? firstNumber(pod) ?? letterIndex(pod) ?? fallbackIndex + 1, explicit: true };
  }

  const numeric = firstNumber(rack);
  const rackParts = numbersOf(rack);
  if (rackParts.length >= 2) {
    const rowIndex = rackParts[0];
    return { row: `row-${pad2(rowIndex)}`, rowIndex, explicit: false };
  }

  if (numeric != null) {
    const rowIndex = Math.floor((numeric - 1) / 16) + 1;
    return { row: `row-${pad2(rowIndex)}`, rowIndex, explicit: false };
  }

  return { row: 'row-01', rowIndex: fallbackIndex + 1, explicit: false };
}

function rackPositionOf(node: Node, rack: string, fallbackIndex: number): number {
  return intValue(labelValue(node, rackPositionLabelKeys))
    ?? (numbersOf(rack).length >= 2 ? lastNumber(rack) : firstNumber(rack))
    ?? fallbackIndex + 1;
}

function rackSideOf(node: Node): RackSide {
  return sideValue(labelValue(node, rackSideLabelKeys)) ?? 'front';
}

export function rackLabelOf(node: Node): string | undefined {
  const labelled = labelValue(node, rackLabelKeys);
  if (labelled) return labelled;

  const raw = rawRecord(node.raw);
  const spec = rawRecord(raw?.spec);
  const status = rawRecord(raw?.status);
  return stringValue(spec?.rack)
    ?? stringValue(spec?.rackLabel)
    ?? stringValue(spec?.racklabel)
    ?? stringValue(spec?.rackName)
    ?? stringValue(status?.rack)
    ?? stringValue(status?.rackLabel);
}

function inferredRackLabel(_node: Node, index: number): string {
  const sequence = index + 1;
  const rowIndex = Math.floor((sequence - 1) / 16) + 1;
  const position = ((sequence - 1) % 16) + 1;
  return `rack-${pad2(rowIndex)}-${pad2(position)}`;
}

export function deviceRu(node: Node): number {
  const raw = rawRecord(node.raw);
  const spec = rawRecord(raw?.spec);
  const platform = `${node.platform} ${stringValue(spec?.platform) ?? ''}`;
  const explicit = labelValue(node, rackUnitCountLabelKeys) ?? stringValue(spec?.rackUnits) ?? stringValue(spec?.ru);
  if (explicit) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 12);
  }

  const hMatch = /\bH(\d+)\b/i.exec(platform);
  if (hMatch) return Math.min(Number.parseInt(hMatch[1], 10), 8);
  const srMatch = /\bSR-(\d+)/i.exec(platform);
  if (srMatch) return Math.min(Math.max(Number.parseInt(srMatch[1], 10), 1), 8);
  return 1;
}

function deviceUStart(node: Node): number | undefined {
  const raw = rawRecord(node.raw);
  const spec = rawRecord(raw?.spec);
  const explicit = labelValue(node, rackUnitStartLabelKeys)
    ?? stringValue(spec?.rackU)
    ?? stringValue(spec?.rackUnit)
    ?? stringValue(spec?.ruStart);
  const parsed = intValue(explicit);
  if (parsed == null) return undefined;
  return Math.min(Math.max(parsed, 1), 42);
}

export function roleRank(role: string): number {
  const value = role.toLowerCase();
  if (value.includes('super')) return 0;
  if (value.includes('spine')) return 1;
  if (value.includes('border')) return 2;
  if (value.includes('leaf')) return 3;
  return 4;
}

export function buildRackGroups(topo: Topology, shown: Set<string> | null): RackGroup[] {
  const groups = new Map<string, Node[]>();
  for (const [index, node] of topo.nodes.entries()) {
    if (shown && !shown.has(node.name)) continue;
    const rack = rackLabelOf(node) ?? inferredRackLabel(node, index);
    const list = groups.get(rack) ?? [];
    list.push(node);
    groups.set(rack, list);
  }

  return [...groups.entries()]
    .toSorted(([left], [right]) => natural.compare(left, right))
    .map(([label, nodes], index) => {
      let cursorTop = 42;
      const placementNode = nodes[0];
      const row = rackRowOf(placementNode, label, index);
      const placement: RackPlacement = {
        row: row.row,
        rowIndex: row.rowIndex,
        rackIndex: rackPositionOf(placementNode, label, index),
        side: rackSideOf(placementNode),
        explicit: row.explicit || !!labelValue(placementNode, rackPositionLabelKeys),
      };
      const devices = nodes
        .toSorted((left, right) => roleRank(left.role) - roleRank(right.role) || natural.compare(left.name, right.name))
        .map((node) => {
          const ru = deviceRu(node);
          const explicitU = deviceUStart(node);
          const uStart = explicitU ?? Math.max(1, cursorTop - ru + 1);
          const uEnd = Math.min(42, uStart + ru - 1);
          if (explicitU == null) cursorTop = uStart - 1;
          return { node, rack: label, ru, uStart, uEnd };
        });
      return {
        label,
        devices,
        placement,
        ruCapacity: 42,
        ruUsed: devices.reduce((sum, device) => sum + device.ru, 0),
      };
    });
}
