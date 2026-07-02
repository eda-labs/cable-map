import * as THREE from 'three';
import type { RackGroup } from '../domain/topology/racks';
import { RACK_SPACING, ROW_SIDE_OFFSET, ROW_SPACING } from './constants';

export type RackLayout = {
  position: THREE.Vector3;
  rotationY: number;
};

export type RackRowLayout = {
  row: string;
  z: number;
  minX: number;
  maxX: number;
  hasBackSide: boolean;
};

function rackSort(left: RackGroup, right: RackGroup): number {
  return left.placement.rackIndex - right.placement.rackIndex || left.label.localeCompare(right.label);
}

export function layoutRackRows(racks: RackGroup[]): { racks: RackLayout[]; rows: RackRowLayout[] } {
  const rowEntries = new Map<string, { rowIndex: number; racks: { rack: RackGroup; index: number }[] }>();
  racks.forEach((rack, index) => {
    const current = rowEntries.get(rack.placement.row) ?? { rowIndex: rack.placement.rowIndex, racks: [] };
    current.rowIndex = Math.min(current.rowIndex, rack.placement.rowIndex);
    current.racks.push({ rack, index });
    rowEntries.set(rack.placement.row, current);
  });

  const layouts: RackLayout[] = [];
  const rows: RackRowLayout[] = [];
  const orderedRows = [...rowEntries.entries()]
    .toSorted(([leftLabel, left], [rightLabel, right]) => left.rowIndex - right.rowIndex || leftLabel.localeCompare(rightLabel));

  orderedRows.forEach(([row, entry], rowOrder) => {
    const orderedRacks = entry.racks.toSorted((left, right) => rackSort(left.rack, right.rack));
    const rackIndexes = orderedRacks.map(({ rack }) => rack.placement.rackIndex);
    const rowCenter = (Math.min(...rackIndexes) + Math.max(...rackIndexes)) / 2;
    const rowZ = (rowOrder - (orderedRows.length - 1) / 2) * ROW_SPACING;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let hasBackSide = false;

    for (const { rack, index } of orderedRacks) {
      const sideOffset = rack.placement.side === 'back' ? ROW_SIDE_OFFSET : -ROW_SIDE_OFFSET;
      const x = (rack.placement.rackIndex - rowCenter) * RACK_SPACING;
      const z = rowZ + sideOffset;
      layouts[index] = {
        position: new THREE.Vector3(x, 0, z),
        rotationY: rack.placement.side === 'back' ? Math.PI : 0,
      };
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      hasBackSide ||= rack.placement.side === 'back';
    }

    rows.push({ row, z: rowZ, minX, maxX, hasBackSide });
  });

  return { racks: layouts, rows };
}
