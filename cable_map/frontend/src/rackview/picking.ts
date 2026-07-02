import * as THREE from 'three';
import type { Row } from '../domain/topology/contract';
import type { FrontPanelPortPos } from '../domain/ports/frontPanelMeta';
import { breakoutChannel } from '../domain/ports/interfaceNames';
import {
  endKey, islTraceIdFromRow, stubTraceId,
  type LinkIndex,
} from '../domain/topology/linkIndex';
import {
  CABLE_PICK_MAX_THRESHOLD, CABLE_PICK_MIN_THRESHOLD, CABLE_PICK_ROUTE_LIMIT, DEVICE_DEPTH, DEVICE_WIDTH,
} from './constants';
import type { DeviceAnchor, PortHit, RackSceneState } from './types';

export function updatePointerRay(state: RackSceneState, clientX: number, clientY: number): boolean {
  const rect = state.renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  state.pointer.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  state.raycaster.setFromCamera(state.pointer, state.camera);
  return true;
}

export function pickDevice(state: RackSceneState): THREE.Intersection | null {
  return state.raycaster.intersectObjects(state.devices, false)[0] ?? null;
}

export type CablePick = {
  linkId: string;
  rayDistance: number; // along the ray, to arbitrate against a device hit behind the cable
};

function cablePickThreshold(state: RackSceneState): number {
  const distance = state.camera.position.distanceTo(state.controls.target);
  return THREE.MathUtils.clamp(distance * 0.009, CABLE_PICK_MIN_THRESHOLD, CABLE_PICK_MAX_THRESHOLD);
}

const pickSegmentStart = new THREE.Vector3();
const pickSegmentEnd = new THREE.Vector3();
const pickPointOnRay = new THREE.Vector3();
const pickPointOnSegment = new THREE.Vector3();

export function pickCable(state: RackSceneState, maxRayDistance: number): CablePick | null {
  const routes = state.cableRoutes;
  if (routes.length === 0 || routes.length > CABLE_PICK_ROUTE_LIMIT) return null;
  const ray = state.raycaster.ray;
  const threshold = cablePickThreshold(state);
  let best: CablePick | null = null;
  let bestDistanceSq = threshold * threshold;
  for (const route of routes) {
    const reach = route.radius + threshold;
    if (ray.distanceSqToPoint(route.center) > reach * reach) continue;
    const positions = route.positions;
    for (let index = 0; index + 5 < positions.length; index += 6) {
      pickSegmentStart.set(positions[index], positions[index + 1], positions[index + 2]);
      pickSegmentEnd.set(positions[index + 3], positions[index + 4], positions[index + 5]);
      const distanceSq = ray.distanceSqToSegment(pickSegmentStart, pickSegmentEnd, pickPointOnRay, pickPointOnSegment);
      if (distanceSq >= bestDistanceSq) continue;
      const rayDistance = pickPointOnRay.distanceTo(ray.origin);
      if (rayDistance > maxRayDistance) continue;
      bestDistanceSq = distanceSq;
      best = { linkId: route.id, rayDistance };
    }
  }
  return best;
}

// Maps a raycast hit on a device's front face back to the front-panel cage (and breakout
// channel) under the cursor, so hover can name the exact port a tech is looking at.
export function pickDevicePort(anchor: DeviceAnchor, worldPoint: THREE.Vector3): PortHit | null {
  if (!anchor.layout?.size) return null;
  const local = anchor.mesh.worldToLocal(worldPoint.clone());
  if (local.z > -DEVICE_DEPTH / 2 + 0.02) return null; // ports live on the front face only
  const normalizedX = 0.5 - local.x / DEVICE_WIDTH;
  const normalizedY = 0.5 - local.y / anchor.panelHeight;
  let best: FrontPanelPortPos | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const port of anchor.layout.values()) {
    const dx = Math.abs(normalizedX - port.x);
    const dy = Math.abs(normalizedY - port.y);
    if (dx > port.w / 2 + 0.004 || dy > port.h / 2 + 0.008) continue;
    const score = dx / Math.max(port.w, 0.001) + dy / Math.max(port.h, 0.001);
    if (score < bestScore) {
      bestScore = score;
      best = port;
    }
  }
  if (!best) return null;

  const breakout = anchor.breakouts?.[best.p];
  if (!breakout || breakout.channels <= 1) return { cage: best.p, channel: null };
  const channels = Math.max(1, breakout.channels);
  const rows = channels > 4 ? 2 : 1;
  const columns = Math.ceil(channels / rows);
  const relX = THREE.MathUtils.clamp((normalizedX - (best.x - best.w / 2)) / best.w, 0, 0.999);
  const relY = THREE.MathUtils.clamp((normalizedY - (best.y - best.h / 2)) / best.h, 0, 0.999);
  const channel = Math.min(channels, Math.floor(relY * rows) * columns + Math.floor(relX * columns) + 1);
  return { cage: best.p, channel };
}

// The table row a cage+channel hit lands on: exact breakout channel first, else the
// cage's only row. Ambiguous multi-row cages return null (hover falls back to the node).
export function portHitRow(linkIndex: LinkIndex, nodeName: string, port: PortHit): Row | null {
  const rows = linkIndex.rowsByCage.get(endKey(nodeName, port.cage));
  if (!rows?.length) return null;
  if (port.channel != null) {
    const exact = rows.find((row) => breakoutChannel(row.label) === port.channel);
    if (exact) return exact;
  }
  return rows.length === 1 ? rows[0] : null;
}

// Trace-store key for a port hover/click: the cable trace when the port terminates one
// (kept in the 2D graph's id scheme so both views light up), else the whole node.
export function portTraceKey(linkIndex: LinkIndex, nodeName: string, port: PortHit): string | null {
  const row = portHitRow(linkIndex, nodeName, port);
  if (!row) return null;
  const link = linkIndex.linkByEnd.get(endKey(nodeName, row.label));
  if (link) return `cable:${linkIndex.traceIdByLinkId.get(link.id) ?? link.id}`;
  if (row.type === 'edge') return `cable:${stubTraceId(nodeName, port.cage, breakoutChannel(row.label))}`;
  if (row.type === 'interSwitch' && row.remoteNode) return `cable:${islTraceIdFromRow(nodeName, row)}`;
  return null;
}
