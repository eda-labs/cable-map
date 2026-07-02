import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Topology } from '../domain/topology/contract';
import { type Mode } from '../theme';
import {
  CABLE_ENTRY_Z, CABLE_FRONT_CLEARANCE, CABLE_LINEWIDTH_CLOSE, CABLE_LINEWIDTH_IDLE,
  CABLE_LINEWIDTH_TRACE, CABLE_LINEWIDTH_TRACE_CLOSE, CABLE_TRAY_HEIGHT, scenePalette,
} from './constants';
import { portOffset, stringHash } from './panelPorts';
import type { CableEndpoint, DeviceAnchor, RackCableRoute, RackSceneState } from './types';

export function visibleCableCount(topo: Topology, shown: Set<string> | null): number {
  if (!shown) return topo.links.length;
  let count = 0;
  for (const link of topo.links) {
    if (shown.has(link.source) && shown.has(link.target)) count += 1;
  }
  return count;
}

function cableEndpoint(root: THREE.Group, anchor: DeviceAnchor, port: string): CableEndpoint {
  const { x, y } = portOffset(anchor, port);
  const frontLocal = new THREE.Vector3(x, y, CABLE_ENTRY_Z);
  const frontOutLocal = new THREE.Vector3(x, y, CABLE_ENTRY_Z - 1);
  const worldPoint = anchor.mesh.localToWorld(frontLocal);
  const worldFront = anchor.mesh.localToWorld(frontOutLocal).sub(worldPoint).normalize();
  const point = root.worldToLocal(worldPoint.clone());
  const front = root.worldToLocal(worldPoint.clone().add(worldFront)).sub(point).normalize();
  return { point, front, rack: anchor.rack, role: anchor.role };
}

function compactRoutePoints(points: THREE.Vector3[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const point of points) {
    const last = out.at(-1);
    if (!last || last.distanceToSquared(point) > 0.0001) out.push(point);
  }
  return out;
}

function cableRoutePoints(link: Topology['links'][number], source: CableEndpoint, target: CableEndpoint): THREE.Vector3[] {
  const hash = stringHash(link.id);
  const sameRack = source.rack === target.rack;
  const clearance = sameRack ? CABLE_FRONT_CLEARANCE * 0.72 : CABLE_FRONT_CLEARANCE;
  const sourceOut = source.point.clone().addScaledVector(source.front, clearance);
  const targetOut = target.point.clone().addScaledVector(target.front, clearance);
  const delta = targetOut.clone().sub(sourceOut);
  const lane = ((hash % 11) - 5) * (sameRack ? 0.014 : 0.024);
  const lateral = new THREE.Vector3(delta.z, 0, -delta.x);
  if (lateral.lengthSq() > 0.0001) lateral.normalize().multiplyScalar(lane);
  else lateral.set(lane, 0, 0);

  const laneY = ((Math.floor(hash / 11) % 7) - 3) * 0.018;
  const routeY = sameRack
    ? Math.min(CABLE_TRAY_HEIGHT - 0.1, Math.max(sourceOut.y, targetOut.y) + 0.36 + laneY)
    : CABLE_TRAY_HEIGHT + laneY;
  const sourceLane = sourceOut.clone().add(lateral);
  const targetLane = targetOut.clone().add(lateral);
  const sourceLift = new THREE.Vector3(sourceLane.x, routeY, sourceLane.z);
  const targetLift = new THREE.Vector3(targetLane.x, routeY, targetLane.z);
  const runXFirst = Math.abs(targetLift.x - sourceLift.x) >= Math.abs(targetLift.z - sourceLift.z);
  const trayCorner = runXFirst
    ? new THREE.Vector3(targetLift.x, routeY, sourceLift.z)
    : new THREE.Vector3(sourceLift.x, routeY, targetLift.z);

  return compactRoutePoints([
    source.point,
    sourceOut,
    sourceLane,
    sourceLift,
    trayCorner,
    targetLift,
    targetLane,
    targetOut,
    target.point,
  ]);
}

function routePositions(points: THREE.Vector3[]): number[] {
  const positions: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
  }
  return positions;
}

function lineSegmentsGeometry(positions: number[]): LineSegmentsGeometry {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  return geometry;
}

function setLineMaterialResolution(material: LineMaterial, renderer: THREE.WebGLRenderer) {
  const size = renderer.getSize(new THREE.Vector2());
  material.resolution.set(size.x, size.y);
}

export function setCableLayerResolutions(state: RackSceneState) {
  if (state.cableLayer) setLineMaterialResolution(state.cableLayer.material as LineMaterial, state.renderer);
  if (state.cableHighlightLayer) setLineMaterialResolution(state.cableHighlightLayer.material as LineMaterial, state.renderer);
}

function cableCloseFactor(state: RackSceneState): number {
  const zoomDistance = state.camera.position.distanceTo(state.controls.target);
  let factor = THREE.MathUtils.clamp((18 - zoomDistance) / 12, 0, 1);
  // device positions are static after a build; scan the cached centers instead of
  // recomputing world matrices every frame
  const centers = state.deviceCenters;
  const { x, y, z } = state.camera.position;
  let nearestDeviceSquared = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 2 < centers.length; index += 3) {
    const dx = x - centers[index];
    const dy = y - centers[index + 1];
    const dz = z - centers[index + 2];
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared < nearestDeviceSquared) nearestDeviceSquared = distanceSquared;
  }
  if (Number.isFinite(nearestDeviceSquared)) {
    const nearestDevice = Math.sqrt(nearestDeviceSquared);
    factor = Math.max(factor, THREE.MathUtils.clamp((5.5 - nearestDevice) / 4, 0, 1));
  }
  return factor;
}

export function updateCableScaleForDistance(state: RackSceneState) {
  const factor = cableCloseFactor(state);
  if (state.cableLayer) {
    const material = state.cableLayer.material as LineMaterial;
    material.linewidth = THREE.MathUtils.lerp(CABLE_LINEWIDTH_IDLE, CABLE_LINEWIDTH_CLOSE, factor);
  }
  if (state.cableHighlightLayer) {
    const material = state.cableHighlightLayer.material as LineMaterial;
    material.linewidth = THREE.MathUtils.lerp(CABLE_LINEWIDTH_TRACE, CABLE_LINEWIDTH_TRACE_CLOSE, factor);
  }
  if (state.cableEndpointLayer) {
    const material = state.cableEndpointLayer.material as THREE.PointsMaterial;
    material.opacity = factor * 0.72;
    material.size = THREE.MathUtils.lerp(0.025, 0.075, factor);
    state.cableEndpointLayer.visible = factor > 0.08;
  }
}

export function addCableLayer(state: RackSceneState, topo: Topology, shown: Set<string> | null, anchors: Map<string, DeviceAnchor>, mode: Mode) {
  const palette = scenePalette(mode);
  const allPositions: number[] = [];
  const endpointPositions: number[] = [];
  const routes: RackCableRoute[] = [];

  for (const link of topo.links) {
    if (shown && (!shown.has(link.source) || !shown.has(link.target))) continue;
    const sourceAnchor = anchors.get(link.source);
    const targetAnchor = anchors.get(link.target);
    if (!sourceAnchor || !targetAnchor) continue;
    const sourceEndpoint = cableEndpoint(state.root, sourceAnchor, link.sourcePort);
    const targetEndpoint = cableEndpoint(state.root, targetAnchor, link.targetPort);
    const points = cableRoutePoints(link, sourceEndpoint, targetEndpoint);
    const positions = routePositions(points);
    const sphere = new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
    routes.push({ id: link.id, positions, center: sphere.center, radius: sphere.radius });
    allPositions.push(...positions);
    endpointPositions.push(
      sourceEndpoint.point.x, sourceEndpoint.point.y, sourceEndpoint.point.z,
      targetEndpoint.point.x, targetEndpoint.point.y, targetEndpoint.point.z,
    );
  }

  state.cableRoutes = routes;
  if (allPositions.length === 0) return;

  const geometry = lineSegmentsGeometry(allPositions);
  const idleOpacity = routes.length > 6000 ? 0.05 : routes.length > 3500 ? 0.085 : routes.length > 1200 ? 0.16 : 0.3;
  const material = new LineMaterial({
    color: palette.cable,
    linewidth: CABLE_LINEWIDTH_IDLE,
    transparent: true,
    opacity: idleOpacity,
    depthWrite: false,
  });
  setLineMaterialResolution(material, state.renderer);
  material.userData.idleOpacity = idleOpacity;

  const layer = new LineSegments2(geometry, material);
  layer.frustumCulled = false;
  layer.renderOrder = 8;
  state.root.add(layer);
  state.cableLayer = layer;

  const highlightGeometry = lineSegmentsGeometry([]);
  const highlightMaterial = new LineMaterial({
    color: palette.cableTrace,
    linewidth: CABLE_LINEWIDTH_TRACE,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });
  setLineMaterialResolution(highlightMaterial, state.renderer);
  const highlightLayer = new LineSegments2(highlightGeometry, highlightMaterial);
  highlightLayer.frustumCulled = false;
  highlightLayer.renderOrder = 30;
  state.root.add(highlightLayer);
  state.cableHighlightLayer = highlightLayer;

  const endpointGeometry = new THREE.BufferGeometry();
  endpointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(endpointPositions, 3));
  const endpointMaterial = new THREE.PointsMaterial({
    color: palette.cable,
    size: 0.025,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: true,
  });
  const endpoints = new THREE.Points(endpointGeometry, endpointMaterial);
  endpoints.frustumCulled = false;
  endpoints.renderOrder = 29;
  endpoints.visible = false;
  state.root.add(endpoints);
  state.cableEndpointLayer = endpoints;
  updateCableScaleForDistance(state);
}

export function updateCableTrace(state: RackSceneState, tracedEdges: Set<string>, traceAny: boolean, mode: Mode) {
  if (state.cableLayer) {
    const material = state.cableLayer.material as LineMaterial;
    const idleOpacity = typeof material.userData.idleOpacity === 'number' ? material.userData.idleOpacity : 0.2;
    material.opacity = traceAny ? idleOpacity * 0.38 : idleOpacity;
    material.needsUpdate = true;
  }

  if (!state.cableHighlightLayer) return;
  const positions: number[] = [];
  if (traceAny) {
    for (const route of state.cableRoutes) {
      if (tracedEdges.has(route.id)) positions.push(...route.positions);
    }
  }

  const geometry = lineSegmentsGeometry(positions);
  state.cableHighlightLayer.geometry.dispose();
  state.cableHighlightLayer.geometry = geometry;

  const material = state.cableHighlightLayer.material as LineMaterial;
  material.color.set(scenePalette(mode).cableTrace);
  material.opacity = positions.length > 0 ? 0.95 : 0;
  material.needsUpdate = true;
}
