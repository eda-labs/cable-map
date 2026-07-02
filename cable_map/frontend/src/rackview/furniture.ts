import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RackGroup } from '../domain/topology/racks';
import { type Mode } from '../theme';
import {
  DEVICE_WIDTH, RACK_DEPTH, RACK_HEIGHT, RACK_WIDTH, UNIT_HEIGHT, scenePalette,
} from './constants';

// All static rack furniture (posts, panels, rails, markers…) is collected per material and
// merged into one mesh each, so a hall of hundreds of cabinets stays a handful of draw calls.
export type FurnitureCollector = {
  metal: THREE.BufferGeometry[];
  panel: THREE.BufferGeometry[];
  rail: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  back: THREE.BufferGeometry[];
  base: Map<string, THREE.BufferGeometry[]>; // fill color -> slabs
  markerLines: THREE.BufferGeometry[];
  doorLines: THREE.BufferGeometry[];
  frameLines: THREE.BufferGeometry[];
};

export function createFurnitureCollector(): FurnitureCollector {
  return {
    metal: [], panel: [], rail: [], glass: [], back: [],
    base: new Map(), markerLines: [], doorLines: [], frameLines: [],
  };
}

function collectBox(
  list: THREE.BufferGeometry[],
  width: number, height: number, depth: number,
  x: number, y: number, z: number,
  matrix: THREE.Matrix4,
) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  geometry.applyMatrix4(matrix);
  list.push(geometry);
}

function collectLines(list: THREE.BufferGeometry[], points: number[], matrix: THREE.Matrix4) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.applyMatrix4(matrix);
  list.push(geometry);
}

function mergeCollected(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries);
  for (const geometry of geometries) geometry.dispose();
  return merged;
}

export function collectRackFrame(collector: FurnitureCollector, rack: RackGroup, matrix: THREE.Matrix4) {
  for (const x of [-RACK_WIDTH / 2, RACK_WIDTH / 2]) {
    for (const z of [-RACK_DEPTH / 2, RACK_DEPTH / 2]) {
      collectBox(collector.metal, 0.055, RACK_HEIGHT, 0.055, x, RACK_HEIGHT / 2, z, matrix);
    }
  }
  for (const y of [0.07, RACK_HEIGHT - 0.03]) {
    for (const z of [-RACK_DEPTH / 2, RACK_DEPTH / 2]) {
      collectBox(collector.metal, RACK_WIDTH + 0.13, 0.06, 0.06, 0, y, z, matrix);
    }
    for (const x of [-RACK_WIDTH / 2, RACK_WIDTH / 2]) {
      collectBox(collector.metal, 0.06, 0.06, RACK_DEPTH + 0.12, x, y, 0, matrix);
    }
  }

  collectBox(collector.panel, RACK_WIDTH + 0.1, 0.08, RACK_DEPTH + 0.1, 0, RACK_HEIGHT + 0.04, 0, matrix);
  collectBox(collector.metal, RACK_WIDTH + 0.16, 0.09, RACK_DEPTH + 0.16, 0, 0.015, 0, matrix);
  collectBox(collector.panel, RACK_WIDTH - 0.12, RACK_HEIGHT - 0.24, 0.035, 0, RACK_HEIGHT / 2, RACK_DEPTH / 2 + 0.006, matrix);
  collectBox(collector.glass, 0.018, RACK_HEIGHT - 0.24, RACK_DEPTH - 0.18, -RACK_WIDTH / 2 - 0.012, RACK_HEIGHT / 2, 0.02, matrix);
  collectBox(collector.glass, 0.018, RACK_HEIGHT - 0.24, RACK_DEPTH - 0.18, RACK_WIDTH / 2 + 0.012, RACK_HEIGHT / 2, 0.02, matrix);

  for (const x of [-DEVICE_WIDTH / 2 - 0.045, DEVICE_WIDTH / 2 + 0.045]) {
    collectBox(collector.rail, 0.036, RACK_HEIGHT - 0.22, 0.036, x, RACK_HEIGHT / 2, -RACK_DEPTH / 2 + 0.045, matrix);
  }

  const markerPoints: number[] = [];
  for (const x of [-DEVICE_WIDTH / 2 - 0.045, DEVICE_WIDTH / 2 + 0.045]) {
    for (let unit = 0; unit <= 42; unit += 6) {
      const y = unit * UNIT_HEIGHT;
      markerPoints.push(x - 0.036, y, -RACK_DEPTH / 2 - 0.006, x + 0.036, y, -RACK_DEPTH / 2 - 0.006);
    }
  }
  collectLines(collector.markerLines, markerPoints, matrix);

  const doorX = RACK_WIDTH / 2 + 0.035;
  const doorZ = -RACK_DEPTH / 2 - 0.015;
  collectLines(collector.doorLines, [
    -doorX, 0.08, doorZ, doorX, 0.08, doorZ,
    doorX, 0.08, doorZ, doorX, RACK_HEIGHT - 0.08, doorZ,
    doorX, RACK_HEIGHT - 0.08, doorZ, -doorX, RACK_HEIGHT - 0.08, doorZ,
    -doorX, RACK_HEIGHT - 0.08, doorZ, -doorX, 0.08, doorZ,
  ], matrix);

  collectBox(collector.back, RACK_WIDTH, RACK_HEIGHT, 0.04, 0, RACK_HEIGHT / 2, RACK_DEPTH / 2 + 0.022, matrix);

  const frameEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK_WIDTH, RACK_HEIGHT, RACK_DEPTH));
  frameEdges.translate(0, RACK_HEIGHT / 2, 0);
  frameEdges.applyMatrix4(matrix);
  collector.frameLines.push(frameEdges);

  const fill = Math.min(1, rack.ruUsed / rack.ruCapacity);
  const baseColor = fill > 0.8 ? '#F47F31' : fill > 0.55 ? '#F7B737' : '#37CC73';
  const baseList = collector.base.get(baseColor) ?? [];
  collector.base.set(baseColor, baseList);
  collectBox(baseList, RACK_WIDTH + 0.16, 0.06, RACK_DEPTH + 0.18, 0, -0.045, 0, matrix);
}

export function addRackFurniture(root: THREE.Group, collector: FurnitureCollector, mode: Mode) {
  const palette = scenePalette(mode);
  const addMerged = (geometries: THREE.BufferGeometry[], material: THREE.Material) => {
    const merged = mergeCollected(geometries);
    if (merged) root.add(new THREE.Mesh(merged, material));
  };
  const addMergedLines = (geometries: THREE.BufferGeometry[], opacity: number) => {
    const merged = mergeCollected(geometries);
    if (merged) root.add(new THREE.LineSegments(merged, new THREE.LineBasicMaterial({ color: palette.frame, transparent: true, opacity })));
  };

  addMerged(collector.metal, new THREE.MeshStandardMaterial({ color: palette.cabinetMetal, roughness: 0.48, metalness: 0.38 }));
  addMerged(collector.panel, new THREE.MeshStandardMaterial({ color: palette.cabinetPanel, roughness: 0.74, metalness: 0.12 }));
  addMerged(collector.rail, new THREE.MeshStandardMaterial({ color: palette.cabinetRail, roughness: 0.42, metalness: 0.46 }));
  addMerged(collector.back, new THREE.MeshStandardMaterial({ color: palette.rackBack, roughness: 0.74, metalness: 0.04 }));
  addMerged(collector.glass, new THREE.MeshStandardMaterial({
    color: palette.cabinetGlass,
    roughness: 0.18,
    metalness: 0,
    transparent: true,
    opacity: mode === 'dark' ? 0.16 : 0.2,
    depthWrite: false,
  }));
  for (const [color, geometries] of collector.base) {
    addMerged(geometries, new THREE.MeshStandardMaterial({ color, roughness: 0.68, transparent: true, opacity: 0.55 }));
  }
  addMergedLines(collector.markerLines, 0.42);
  addMergedLines(collector.doorLines, 0.45);
  addMergedLines(collector.frameLines, 0.62);
}
