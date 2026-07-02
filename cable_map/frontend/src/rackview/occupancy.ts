import * as THREE from 'three';
import type { Topology } from '../domain/topology/contract';
import { layoutOf, slottedOf } from '../domain/ports/frontPanelMeta';
import { breakoutChannel, cageKey } from '../domain/ports/interfaceNames';
import type { CableKind } from '../graph';
import {
  DEVICE_WIDTH, OCCUPANCY_KIND_COLORS, OCCUPANCY_KIND_ORDER, OCCUPIED_PORT_OPACITY, OCCUPIED_PORT_Z,
} from './constants';
import type { FrontPanelMeasuredLayout } from './frontPanel';
import { fallbackPortOffset, panelLocalOffset } from './panelPorts';
import { disposeObject } from './sceneObjects';
import type { DeviceMesh, OccupiedRect } from './types';

export function rowOccupancyKind(row: Topology['nodes'][number]['table'][number], lags: Topology['lags']): CableKind | null {
  if (row.type === 'interSwitch') return 'isl';
  if (row.type !== 'edge') return null;
  const lag = row.lag ? lags[row.lag] : undefined;
  if (lag?.multihomed) return 'mlag';
  if (row.lag) return 'lag';
  return 'edge';
}

function addOccupiedCage(
  occupied: Map<string, Map<CableKind, Set<number> | null>>,
  cage: string,
  kind: CableKind,
  channel: number | null,
) {
  const byKind = occupied.get(cage) ?? new Map<CableKind, Set<number> | null>();
  occupied.set(cage, byKind);
  if (!channel) {
    byKind.set(kind, null);
    return;
  }
  if (byKind.get(kind) === null) return;
  const channels = byKind.get(kind) ?? new Set<number>();
  channels.add(channel);
  byKind.set(kind, channels);
}

function occupiedCages(
  node: Topology['nodes'][number],
  slotted: boolean,
  lags: Topology['lags'],
): Map<string, Map<CableKind, Set<number> | null>> {
  const occupied = new Map<string, Map<CableKind, Set<number> | null>>();
  for (const row of node.table ?? []) {
    const kind = rowOccupancyKind(row, lags);
    if (!kind) continue;
    const cage = cageKey(row.label, slotted);
    if (!cage) continue;
    const channel = breakoutChannel(row.label);
    addOccupiedCage(occupied, cage, kind, channel);
  }
  return occupied;
}

function occupiedFallbackRect(cage: string, panelHeight: number, kind: CableKind): OccupiedRect {
  const center = fallbackPortOffset(cage);
  return {
    x: center.x,
    y: center.y,
    width: DEVICE_WIDTH / 40,
    height: Math.max(0.018, panelHeight * 0.22),
    kind,
  };
}

function occupiedLayoutRects(
  node: Topology['nodes'][number],
  stencil: string,
  panelHeight: number,
  lags: Topology['lags'],
  measured?: FrontPanelMeasuredLayout | null,
): OccupiedRect[] {
  const slotted = slottedOf(stencil);
  const byCage = occupiedCages(node, slotted, lags);
  if (byCage.size === 0) return [];

  const layout = layoutOf(stencil);
  const positions = measured?.layout.size ? measured.layout : layout ? new Map(layout.map((port) => [port.p, port])) : undefined;
  const rects: OccupiedRect[] = [];
  for (const [cage, byKind] of byCage) {
    const port = positions?.get(cage);
    const breakout = node.breakouts?.[cage];
    if (!port) {
      for (const kind of byKind.keys()) rects.push(occupiedFallbackRect(cage, panelHeight, kind));
      continue;
    }

    const addRect = (kind: CableKind, offsetX: number, offsetY: number, width: number, height: number) => {
      const normalizedX = port.x + offsetX;
      const normalizedY = port.y + offsetY;
      const center = panelLocalOffset(normalizedX, normalizedY, panelHeight);
      rects.push({
        x: center.x,
        y: center.y,
        width: width * DEVICE_WIDTH,
        height: height * panelHeight,
        kind,
      });
    };

    for (const [kind, channels] of byKind) {
      if (!breakout || channels === null) {
        addRect(kind, 0, 0, port.w, port.h);
        continue;
      }

      const channelSet = channels.size > 0 ? channels : new Set(Array.from({ length: breakout.channels }, (_, index) => index + 1));
      for (const channel of channelSet) {
        const channelsCount = Math.max(1, breakout.channels);
        const rows = channelsCount > 4 ? 2 : 1;
        const columns = Math.ceil(channelsCount / rows);
        const safeChannel = Math.max(1, Math.min(channelsCount, channel));
        const column = (safeChannel - 1) % columns;
        const row = Math.floor((safeChannel - 1) / columns);
        const width = port.w / columns;
        const height = port.h / rows;
        addRect(
          kind,
          -port.w / 2 + column * width + width / 2,
          -port.h / 2 + row * height + height / 2,
          width,
          height,
        );
      }
    }
  }
  return rects;
}

function occupancyGeometry(rects: OccupiedRect[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const rect of rects) {
    const x0 = rect.x - rect.width / 2;
    const x1 = rect.x + rect.width / 2;
    const y0 = rect.y - rect.height / 2;
    const y1 = rect.y + rect.height / 2;
    positions.push(
      x0, y0, 0,
      x1, y0, 0,
      x1, y1, 0,
      x0, y0, 0,
      x1, y1, 0,
      x0, y1, 0,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function removeOccupancyOverlay(mesh: DeviceMesh) {
  while (true) {
    const overlay = mesh.children.find((child) => child.userData.occupancyOverlay);
    if (!overlay) return;
    mesh.remove(overlay);
    disposeObject(overlay);
  }
}

export function addOccupancyOverlay(
  mesh: DeviceMesh,
  node: Topology['nodes'][number],
  stencil: string,
  panelHeight: number,
  lags: Topology['lags'],
  measured?: FrontPanelMeasuredLayout | null,
) {
  removeOccupancyOverlay(mesh);
  const rects = occupiedLayoutRects(node, stencil, panelHeight, lags, measured);
  if (rects.length === 0) return;
  for (const kind of OCCUPANCY_KIND_ORDER) {
    const kindRects = rects.filter((rect) => rect.kind === kind);
    if (kindRects.length === 0) continue;
    const overlay = new THREE.Mesh(
      occupancyGeometry(kindRects),
      new THREE.MeshBasicMaterial({
        color: OCCUPANCY_KIND_COLORS[kind],
        transparent: true,
        opacity: OCCUPIED_PORT_OPACITY,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
      }),
    );
    overlay.position.set(0, 0, OCCUPIED_PORT_Z);
    overlay.renderOrder = 7;
    overlay.userData.occupancyOverlay = true;
    mesh.add(overlay);
  }
}
