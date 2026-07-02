import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { Breakout } from '../domain/topology/contract';
import type { FrontPanelPortPos } from '../domain/ports/frontPanelMeta';
import type { CableKind } from '../graph';

export type DeviceMesh = THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> & {
  userData: {
    nodeName: string;
    role: string;
    rack: string;
    baseColor: string;
    hasFrontPanel?: boolean;
  };
};

// invisible pick target spanning a whole cabinet; its material lights up on hover
export type RackHitbox = THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> & {
  userData: { rackLabel: string };
};

export type CameraPose = { position: THREE.Vector3; target: THREE.Vector3 };

export type CameraTween = {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
};

export type RackSceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  root: THREE.Group;
  devices: DeviceMesh[];
  deviceCenters: Float32Array;
  anchors: Map<string, DeviceAnchor>;
  rackHitboxes: RackHitbox[];
  labels: THREE.Sprite[];
  cableLayer: LineSegments2 | null;
  cableHighlightLayer: LineSegments2 | null;
  cableEndpointLayer: THREE.Points | null;
  cableRoutes: RackCableRoute[];
  cameraTween: CameraTween | null;
  requestRender: (ms?: number) => void;
};

export type DeviceAnchor = {
  mesh: DeviceMesh;
  rack: string;
  role: string;
  slotted: boolean;
  panelHeight: number;
  layout?: Map<string, FrontPanelPortPos>;
  breakouts?: Record<string, Breakout>;
};

export type CableEndpoint = {
  point: THREE.Vector3;
  front: THREE.Vector3;
  rack: string;
  role: string;
};

export type RackCableRoute = {
  id: string;
  positions: number[];
  center: THREE.Vector3;  // bounding sphere over the route, culls the pick sweep
  radius: number;
};

export type OccupiedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: CableKind;
};

export type PortHit = {
  cage: string;
  channel: number | null;
};

export type HoverTarget =
  | { type: 'device'; nodeName: string; port?: PortHit }
  | { type: 'cable'; linkId: string }
  | { type: 'rack'; rack: string };

export type HoverState = {
  target: HoverTarget;
  x: number;
  y: number;
};

export type HoverPick = {
  key: string;              // dedupe key for pointermove
  traceKey: string | null;  // trace-store key to light up (node:… / cable:…); racks trace nothing
  target: HoverTarget;
};

export type DevicePlacement = {
  rack: string;
  uStart: number;
  uEnd: number;
};

export function formatRackU(placement: DevicePlacement | undefined): string | null {
  if (!placement) return null;
  const units = placement.uStart === placement.uEnd ? `U${placement.uStart}` : `U${placement.uStart}–${placement.uEnd}`;
  return `${placement.rack} · ${units}`;
}

export function placementSuffix(placement: DevicePlacement | undefined): string {
  const formatted = formatRackU(placement);
  return formatted ? ` (${formatted})` : '';
}

export type NavDirection = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down';
