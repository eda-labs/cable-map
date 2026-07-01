import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrongOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LabelIcon from '@mui/icons-material/LabelOutlined';
import LabelOffIcon from '@mui/icons-material/LabelOffOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import RotateLeftIcon from '@mui/icons-material/RotateLeft';
import RotateRightIcon from '@mui/icons-material/RotateRight';
import type { Breakout, Topology } from '../domain/topology/contract';
import type { FrontPanelPortPos } from '../domain/ports/frontPanelMeta';
import { frontPanelMetaOf, layoutOf, slottedOf } from '../domain/ports/frontPanelMeta';
import { breakoutChannel, cageKey, portIdx } from '../domain/ports/interfaceNames';
import { buildRackGroups, rackLabelOf, roleRank, type RackGroup } from '../domain/topology/racks';
import type { CableKind } from '../graph';
import { trace, useTrace } from '../trace';
import { type Mode } from '../theme';
import { type OpenNodeHandler } from './NodeActionsContext';
import { appPath } from '../api/base';
import { componentsOf, stencilFor } from '../stencil';

const RACK_WIDTH = 1.45;
const RACK_HEIGHT = 6;
const RACK_DEPTH = 1.05;
const UNIT_HEIGHT = RACK_HEIGHT / 42;
const DEVICE_DEPTH = RACK_DEPTH * 0.5;
const DEVICE_WIDTH = RACK_WIDTH - 0.18;
const POINTER_CLICK_TOLERANCE = 5;
const RACK_SPACING = 2.05;
const ROW_SPACING = 2.75;
const ROW_SIDE_OFFSET = 0.82;
const CABLE_FRONT_CLEARANCE = 0.34;
const CABLE_TRAY_HEIGHT = RACK_HEIGHT + 0.34;
const KEYBOARD_MOVE_SPEED_MIN = 2.4;
const KEYBOARD_MOVE_SPEED_MAX = 48;
const KEYBOARD_FAST_MULTIPLIER = 2.4;
const FPS_MOUSE_SENSITIVITY = 0.0023;
const FPS_PITCH_MIN = 0.12;
const FPS_PITCH_MAX = Math.PI - 0.14;
const GIZMO_ROTATE_STEP = 72;
const GIZMO_TILT_STEP = 48;
const CABLE_LINEWIDTH_IDLE = 1.2;
const CABLE_LINEWIDTH_CLOSE = 3.25;
const CABLE_LINEWIDTH_TRACE = 2.8;
const CABLE_LINEWIDTH_TRACE_CLOSE = 5.5;
const OCCUPIED_PORT_COLOR = '#37CC73';
const OCCUPIED_PORT_OPACITY = 0.44;
const OCCUPIED_PORT_Z = -DEVICE_DEPTH / 2 - 0.014;
const CABLE_ENTRY_Z = OCCUPIED_PORT_Z - 0.006;
const OCCUPANCY_KIND_ORDER = ['isl', 'edge', 'lag', 'mlag'] as const satisfies readonly CableKind[];
const OCCUPANCY_KIND_COLORS: Record<CableKind, string> = {
  isl: OCCUPIED_PORT_COLOR,
  edge: '#23ABB6',
  lag: '#F7B737',
  mlag: '#9765FE',
};
const OCCUPANCY_KIND_LABELS: Record<CableKind, string> = {
  isl: 'Fabric',
  edge: 'Edge',
  lag: 'Local LAG',
  mlag: 'Multihome LAG',
};

type DeviceMesh = THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> & {
  userData: {
    nodeName: string;
    role: string;
    rack: string;
    baseColor: string;
    hasFrontPanel?: boolean;
  };
};

type RackSceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  root: THREE.Group;
  devices: DeviceMesh[];
  labels: THREE.Sprite[];
  cableLayer: LineSegments2 | null;
  cableHighlightLayer: LineSegments2 | null;
  cableEndpointLayer: THREE.Points | null;
  cableRoutes: RackCableRoute[];
};

type DeviceAnchor = {
  mesh: DeviceMesh;
  rack: string;
  role: string;
  slotted: boolean;
  panelHeight: number;
  layout?: Map<string, FrontPanelPortPos>;
  breakouts?: Record<string, Breakout>;
};

type CableEndpoint = {
  point: THREE.Vector3;
  front: THREE.Vector3;
  rack: string;
  role: string;
};

type RackCableRoute = {
  id: string;
  positions: number[];
};

type OccupiedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: CableKind;
};

type HoverState = {
  nodeName: string;
  x: number;
  y: number;
};

type NavDirection = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down';

interface RackViewProps {
  topo: Topology;
  shown: Set<string> | null;
  selected: string[];
  mode: Mode;
  onOpenNode: OpenNodeHandler;
  onClearSelection: () => void;
}

function scenePalette(mode: Mode) {
  return mode === 'dark'
    ? {
      background: '#080D14',
      floor: '#101824',
      grid: '#4A5361',
      frame: '#AAB4C2',
      rackBack: '#1A222E',
      cabinetMetal: '#3A4655',
      cabinetPanel: '#1B2531',
      cabinetGlass: '#A9C2D8',
      cabinetRail: '#657386',
      cable: '#45D3FF',
      cableTrace: '#FFD568',
      labelBg: 'rgba(16,24,36,0.78)',
      labelFg: '#FFFFFF',
    }
    : {
      background: '#E7ECF2',
      floor: '#FFFFFF',
      grid: '#8994A3',
      frame: '#4A5361',
      rackBack: '#DFE5ED',
      cabinetMetal: '#748091',
      cabinetPanel: '#CBD5E1',
      cabinetGlass: '#7D91A8',
      cabinetRail: '#566273',
      cable: '#0072CE',
      cableTrace: '#B45F00',
      labelBg: 'rgba(255,255,255,0.86)',
      labelFg: '#101824',
    };
}

function roleColor(role: string, mode: Mode): string {
  const value = role.toLowerCase();
  const dark = mode === 'dark';
  if (value.includes('super')) return dark ? '#E03DCD' : '#A50885';
  if (value.includes('spine')) return dark ? '#9765FE' : '#5A0DD5';
  if (value.includes('border')) return dark ? '#FFA663' : '#AF3903';
  if (value.includes('leaf')) return dark ? '#37CC73' : '#00822B';
  if (value.includes('access')) return dark ? '#50C4D0' : '#027490';
  return dark ? '#8EC2FF' : '#005AFF';
}

function chassisColor(mode: Mode): string {
  return mode === 'dark' ? '#202B38' : '#CED7E1';
}

function panelHeightForStencil(stencil: string, fallbackHeight: number, measured?: FrontPanelMeasuredLayout | null): number {
  if (measured?.aspect) return Math.max(0.06, DEVICE_WIDTH / measured.aspect);
  const meta = frontPanelMetaOf(stencil);
  return meta ? Math.max(0.06, DEVICE_WIDTH / meta.aspect) : fallbackHeight;
}

type FrontPanelTextureEntry =
  | { state: 'pending'; promise: Promise<FrontPanelTexture | null> }
  | { state: 'ready'; panel: FrontPanelTexture }
  | { state: 'missing' };

type FrontPanelTexture = {
  texture: THREE.Texture;
  aspect: number;
};

type FrontPanelMeasuredLayout = {
  aspect: number;
  layout: Map<string, FrontPanelPortPos>;
};

type FrontPanelMeasureEntry =
  | { state: 'pending'; promise: Promise<FrontPanelMeasuredLayout | null> }
  | { state: 'ready'; layout: FrontPanelMeasuredLayout }
  | { state: 'missing' };

const frontPanelTextureCache = new Map<string, FrontPanelTextureEntry>();
const frontPanelMeasureCache = new Map<string, FrontPanelMeasureEntry>();
const frontPanelLoader = new THREE.TextureLoader();

function frontPanelUrl(stencil: string): string {
  return appPath(`frontpanel/${encodeURIComponent(stencil)}.svg`);
}

function textureAspect(texture: THREE.Texture): number {
  const image = texture.image as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number } | undefined;
  const width = image?.naturalWidth || image?.width || 0;
  const height = image?.naturalHeight || image?.height || 0;
  return width > 0 && height > 0 ? width / height : 0;
}

function loadFrontPanelTexture(stencil: string): Promise<FrontPanelTexture | null> {
  const cached = frontPanelTextureCache.get(stencil);
  if (cached?.state === 'ready') return Promise.resolve(cached.panel);
  if (cached?.state === 'missing') return Promise.resolve(null);
  if (cached?.state === 'pending') return cached.promise;

  const promise = new Promise<FrontPanelTexture | null>((resolve) => {
    frontPanelLoader.load(
      frontPanelUrl(stencil),
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        texture.userData.sharedFrontPanel = true;
        const panel = { texture, aspect: textureAspect(texture) || 4 };
        frontPanelTextureCache.set(stencil, { state: 'ready', panel });
        resolve(panel);
      },
      undefined,
      () => {
        frontPanelTextureCache.set(stencil, { state: 'missing' });
        resolve(null);
      },
    );
  });
  frontPanelTextureCache.set(stencil, { state: 'pending', promise });
  return promise;
}

function measureFrontPanelSvg(svgText: string): FrontPanelMeasuredLayout | null {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.left = '-100000px';
  host.style.top = '-100000px';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  host.style.lineHeight = '0';
  host.innerHTML = svgText;

  const svg = host.querySelector('svg') as SVGSVGElement | null;
  if (!svg) return null;

  (document.body ?? document.documentElement).appendChild(host);
  try {
    if (!svg.getAttribute('viewBox')) {
      const bounds = svg.getBBox();
      if (bounds.width > 0 && bounds.height > 0) svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    }
    if (!svg.getAttribute('width') || !svg.getAttribute('height')) {
      const viewBox = svg.viewBox.baseVal;
      if (!svg.getAttribute('width') && viewBox.width > 0) svg.setAttribute('width', String(viewBox.width));
      if (!svg.getAttribute('height') && viewBox.height > 0) svg.setAttribute('height', String(viewBox.height));
    }

    const panel = svg.getBoundingClientRect();
    if (panel.width <= 0 || panel.height <= 0) return null;

    const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
    for (const path of Array.from(svg.querySelectorAll<SVGGraphicsElement>('path[data-port]'))) {
      const port = path.getAttribute('data-port')?.trim();
      if (!port) continue;
      const rect = path.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const x0 = (rect.left - panel.left) / panel.width;
      const y0 = (rect.top - panel.top) / panel.height;
      const x1 = (rect.right - panel.left) / panel.width;
      const y1 = (rect.bottom - panel.top) / panel.height;
      const existing = boxes.get(port);
      boxes.set(port, existing ? {
        x0: Math.min(existing.x0, x0),
        y0: Math.min(existing.y0, y0),
        x1: Math.max(existing.x1, x1),
        y1: Math.max(existing.y1, y1),
      } : { x0, y0, x1, y1 });
    }

    const layout = new Map<string, FrontPanelPortPos>();
    for (const [port, box] of boxes) {
      const width = box.x1 - box.x0;
      const height = box.y1 - box.y0;
      if (width <= 0 || height <= 0) continue;
      layout.set(port, {
        p: port,
        x: box.x0 + width / 2,
        y: box.y0 + height / 2,
        w: width,
        h: height,
      });
    }

    return { aspect: panel.width / panel.height, layout };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

function loadFrontPanelMeasuredLayout(stencil: string): Promise<FrontPanelMeasuredLayout | null> {
  const cached = frontPanelMeasureCache.get(stencil);
  if (cached?.state === 'ready') return Promise.resolve(cached.layout);
  if (cached?.state === 'missing') return Promise.resolve(null);
  if (cached?.state === 'pending') return cached.promise;

  const promise = fetch(frontPanelUrl(stencil))
    .then((response) => {
      if (!response.ok) throw new Error('missing front panel');
      return response.text();
    })
    .then((svg) => measureFrontPanelSvg(svg))
    .then((layout) => {
      if (layout) frontPanelMeasureCache.set(stencil, { state: 'ready', layout });
      else frontPanelMeasureCache.set(stencil, { state: 'missing' });
      return layout;
    })
    .catch(() => {
      frontPanelMeasureCache.set(stencil, { state: 'missing' });
      return null;
    });

  frontPanelMeasureCache.set(stencil, { state: 'pending', promise });
  return promise;
}

async function loadFrontPanelMeasuredLayouts(racks: RackGroup[]): Promise<Map<string, FrontPanelMeasuredLayout | null>> {
  const stencils = new Set<string>();
  for (const rack of racks) {
    for (const device of rack.devices) {
      stencils.add(stencilFor(device.node.platform, componentsOf(device.node.raw)));
    }
  }
  const entries = await Promise.all([...stencils].map(async (stencil) => [stencil, await loadFrontPanelMeasuredLayout(stencil)] as const));
  return new Map(entries);
}

function frontPanelGeometry(width: number, height: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -halfWidth, -halfHeight, 0,
    halfWidth, -halfHeight, 0,
    halfWidth, halfHeight, 0,
    -halfWidth, halfHeight, 0,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    1, 0,
    0, 0,
    0, 1,
    1, 1,
  ], 2));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

function disposeMaterial(material: THREE.Material) {
  const mapped = material as THREE.Material & { map?: THREE.Texture | null };
  if (!mapped.map?.userData.sharedFrontPanel) mapped.map?.dispose();
  material.dispose();
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const maybeMesh = child as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    maybeMesh.geometry?.dispose();
    if (Array.isArray(maybeMesh.material)) {
      for (const material of maybeMesh.material) disposeMaterial(material);
    } else if (maybeMesh.material) disposeMaterial(maybeMesh.material);
  });
}

function makeLabelSprite(text: string, mode: Mode): THREE.Sprite {
  const palette = scenePalette(mode);
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = palette.labelBg;
  ctx.fillRect(0, 16, canvas.width, 96);

  let size = 46;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  do {
    ctx.font = `600 ${size}px NokiaPureText, Arial, sans-serif`;
    size -= 2;
  } while (ctx.measureText(text).width > 456 && size > 22);

  ctx.fillStyle = palette.labelFg;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.65, 0.42, 1);
  return sprite;
}

type RackLayout = {
  position: THREE.Vector3;
  rotationY: number;
};

type RackRowLayout = {
  row: string;
  z: number;
  minX: number;
  maxX: number;
  hasBackSide: boolean;
};

function rackSort(left: RackGroup, right: RackGroup): number {
  return left.placement.rackIndex - right.placement.rackIndex || left.label.localeCompare(right.label);
}

function addBox(group: THREE.Group, geometry: THREE.BoxGeometry, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  group.add(mesh);
  return mesh;
}

function layoutRackRows(racks: RackGroup[]): { racks: RackLayout[]; rows: RackRowLayout[] } {
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

function visibleCableCount(topo: Topology, shown: Set<string> | null): number {
  if (!shown) return topo.links.length;
  let count = 0;
  for (const link of topo.links) {
    if (shown.has(link.source) && shown.has(link.target)) count += 1;
  }
  return count;
}

function stringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function portOrdinal(port: string): number {
  const index = portIdx(port);
  if (index != null) return index;
  const numbers = port.match(/\d+/g);
  if (!numbers?.length) return (stringHash(port) % 64) + 1;
  const last = Number(numbers[numbers.length - 1]);
  if (!Number.isFinite(last) || last <= 0) return (stringHash(port) % 64) + 1;
  return last;
}

function fallbackPortOffset(port: string): { x: number; y: number } {
  const ordinal = portOrdinal(port);
  const columns = 32;
  const column = (ordinal - 1) % columns;
  const row = Math.floor((ordinal - 1) / columns) % 2;
  const ratio = columns > 1 ? column / (columns - 1) : 0.5;
  return {
    x: (ratio - 0.5) * DEVICE_WIDTH * 0.82,
    y: row === 0 ? 0.024 : -0.024,
  };
}

function breakoutOffset(breakout: Breakout | undefined, channel: number | null, width: number, height: number): { x: number; y: number } {
  if (!breakout || !channel) return { x: 0, y: 0 };
  const channels = Math.max(1, breakout.channels);
  const safeChannel = Math.max(1, Math.min(channels, channel));
  const rows = channels > 4 ? 2 : 1;
  const columns = Math.ceil(channels / rows);
  const column = (safeChannel - 1) % columns;
  const row = Math.floor((safeChannel - 1) / columns);
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  return {
    x: -width / 2 + column * cellWidth + cellWidth / 2,
    y: -height / 2 + row * cellHeight + cellHeight / 2,
  };
}

function panelLocalOffset(normalizedX: number, normalizedY: number, panelHeight: number): { x: number; y: number } {
  return {
    x: (0.5 - normalizedX) * DEVICE_WIDTH,
    y: (0.5 - normalizedY) * panelHeight,
  };
}

function portOffset(anchor: DeviceAnchor, port: string): { x: number; y: number } {
  const cage = cageKey(port, anchor.slotted);
  const panelPort = cage ? anchor.layout?.get(cage) : undefined;
  if (!panelPort) return fallbackPortOffset(port);

  const channel = breakoutChannel(port);
  const offset = breakoutOffset(cage ? anchor.breakouts?.[cage] : undefined, channel, panelPort.w, panelPort.h);
  const normalizedX = panelPort.x + offset.x;
  const normalizedY = panelPort.y + offset.y;
  return panelLocalOffset(normalizedX, normalizedY, anchor.panelHeight);
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

function setCableLayerResolutions(state: RackSceneState) {
  if (state.cableLayer) setLineMaterialResolution(state.cableLayer.material as LineMaterial, state.renderer);
  if (state.cableHighlightLayer) setLineMaterialResolution(state.cableHighlightLayer.material as LineMaterial, state.renderer);
}

function cableCloseFactor(state: RackSceneState): number {
  const zoomDistance = state.camera.position.distanceTo(state.controls.target);
  let factor = THREE.MathUtils.clamp((18 - zoomDistance) / 12, 0, 1);
  let nearestDeviceSquared = Number.POSITIVE_INFINITY;
  const worldPosition = new THREE.Vector3();
  for (const device of state.devices) {
    device.getWorldPosition(worldPosition);
    nearestDeviceSquared = Math.min(nearestDeviceSquared, state.camera.position.distanceToSquared(worldPosition));
  }
  if (Number.isFinite(nearestDeviceSquared)) {
    const nearestDevice = Math.sqrt(nearestDeviceSquared);
    factor = Math.max(factor, THREE.MathUtils.clamp((5.5 - nearestDevice) / 4, 0, 1));
  }
  return factor;
}

function updateCableScaleForDistance(state: RackSceneState) {
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

function addCableLayer(state: RackSceneState, topo: Topology, shown: Set<string> | null, anchors: Map<string, DeviceAnchor>, mode: Mode) {
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
    routes.push({ id: link.id, positions });
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

function updateCableTrace(state: RackSceneState, tracedEdges: Set<string>, traceAny: boolean, mode: Mode) {
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

function addRackFrame(group: THREE.Group, rack: RackGroup, mode: Mode) {
  const palette = scenePalette(mode);
  const metal = new THREE.MeshStandardMaterial({ color: palette.cabinetMetal, roughness: 0.48, metalness: 0.38 });
  const panel = new THREE.MeshStandardMaterial({ color: palette.cabinetPanel, roughness: 0.74, metalness: 0.12 });
  const rail = new THREE.MeshStandardMaterial({ color: palette.cabinetRail, roughness: 0.42, metalness: 0.46 });
  const glass = new THREE.MeshStandardMaterial({
    color: palette.cabinetGlass,
    roughness: 0.18,
    metalness: 0,
    transparent: true,
    opacity: mode === 'dark' ? 0.16 : 0.2,
    depthWrite: false,
  });
  const postGeometry = new THREE.BoxGeometry(0.055, RACK_HEIGHT, 0.055);
  const frontCrossGeometry = new THREE.BoxGeometry(RACK_WIDTH + 0.13, 0.06, 0.06);
  const sideCrossGeometry = new THREE.BoxGeometry(0.06, 0.06, RACK_DEPTH + 0.12);
  const railGeometry = new THREE.BoxGeometry(0.036, RACK_HEIGHT - 0.22, 0.036);
  const sidePanelGeometry = new THREE.BoxGeometry(0.018, RACK_HEIGHT - 0.24, RACK_DEPTH - 0.18);

  for (const x of [-RACK_WIDTH / 2, RACK_WIDTH / 2]) {
    for (const z of [-RACK_DEPTH / 2, RACK_DEPTH / 2]) {
      addBox(group, postGeometry, metal, x, RACK_HEIGHT / 2, z);
    }
  }
  for (const y of [0.07, RACK_HEIGHT - 0.03]) {
    for (const z of [-RACK_DEPTH / 2, RACK_DEPTH / 2]) {
      addBox(group, frontCrossGeometry, metal, 0, y, z);
    }
    for (const x of [-RACK_WIDTH / 2, RACK_WIDTH / 2]) {
      addBox(group, sideCrossGeometry, metal, x, y, 0);
    }
  }

  addBox(group, new THREE.BoxGeometry(RACK_WIDTH + 0.1, 0.08, RACK_DEPTH + 0.1), panel, 0, RACK_HEIGHT + 0.04, 0);
  addBox(group, new THREE.BoxGeometry(RACK_WIDTH + 0.16, 0.09, RACK_DEPTH + 0.16), metal, 0, 0.015, 0);
  addBox(group, new THREE.BoxGeometry(RACK_WIDTH - 0.12, RACK_HEIGHT - 0.24, 0.035), panel, 0, RACK_HEIGHT / 2, RACK_DEPTH / 2 + 0.006);
  addBox(group, sidePanelGeometry, glass, -RACK_WIDTH / 2 - 0.012, RACK_HEIGHT / 2, 0.02);
  addBox(group, sidePanelGeometry, glass, RACK_WIDTH / 2 + 0.012, RACK_HEIGHT / 2, 0.02);

  for (const x of [-DEVICE_WIDTH / 2 - 0.045, DEVICE_WIDTH / 2 + 0.045]) {
    addBox(group, railGeometry, rail, x, RACK_HEIGHT / 2, -RACK_DEPTH / 2 + 0.045);
  }

  const markerPoints: number[] = [];
  for (const x of [-DEVICE_WIDTH / 2 - 0.045, DEVICE_WIDTH / 2 + 0.045]) {
    for (let unit = 0; unit <= 42; unit += 6) {
      const y = unit * UNIT_HEIGHT;
      markerPoints.push(x - 0.036, y, -RACK_DEPTH / 2 - 0.006, x + 0.036, y, -RACK_DEPTH / 2 - 0.006);
    }
  }
  const markerGeometry = new THREE.BufferGeometry();
  markerGeometry.setAttribute('position', new THREE.Float32BufferAttribute(markerPoints, 3));
  const markerMaterial = new THREE.LineBasicMaterial({ color: palette.frame, transparent: true, opacity: 0.42 });
  group.add(new THREE.LineSegments(markerGeometry, markerMaterial));

  const doorOutlineGeometry = new THREE.BufferGeometry();
  const doorX = RACK_WIDTH / 2 + 0.035;
  const doorZ = -RACK_DEPTH / 2 - 0.015;
  doorOutlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -doorX, 0.08, doorZ, doorX, 0.08, doorZ,
    doorX, 0.08, doorZ, doorX, RACK_HEIGHT - 0.08, doorZ,
    doorX, RACK_HEIGHT - 0.08, doorZ, -doorX, RACK_HEIGHT - 0.08, doorZ,
    -doorX, RACK_HEIGHT - 0.08, doorZ, -doorX, 0.08, doorZ,
  ], 3));
  group.add(new THREE.LineSegments(
    doorOutlineGeometry,
    new THREE.LineBasicMaterial({ color: palette.frame, transparent: true, opacity: 0.45 }),
  ));

  const back = new THREE.Mesh(
    new THREE.BoxGeometry(RACK_WIDTH, RACK_HEIGHT, 0.04),
    new THREE.MeshStandardMaterial({ color: palette.rackBack, roughness: 0.74, metalness: 0.04 }),
  );
  back.position.set(0, RACK_HEIGHT / 2, RACK_DEPTH / 2 + 0.022);
  group.add(back);

  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(RACK_WIDTH, RACK_HEIGHT, RACK_DEPTH)),
    new THREE.LineBasicMaterial({ color: palette.frame, transparent: true, opacity: 0.62 }),
  );
  frame.position.set(0, RACK_HEIGHT / 2, 0);
  group.add(frame);

  const fill = Math.min(1, rack.ruUsed / rack.ruCapacity);
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(RACK_WIDTH + 0.16, 0.06, RACK_DEPTH + 0.18),
    new THREE.MeshStandardMaterial({
      color: fill > 0.8 ? '#F47F31' : fill > 0.55 ? '#F7B737' : '#37CC73',
      roughness: 0.68,
      transparent: true,
      opacity: 0.55,
    }),
  );
  base.position.set(0, -0.045, 0);
  group.add(base);
}

function rowOccupancyKind(row: Topology['nodes'][number]['table'][number], lags: Topology['lags']): CableKind | null {
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

function addOccupancyOverlay(
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

function addDevice(
  group: THREE.Group,
  rack: RackGroup,
  deviceIndex: number,
  mode: Mode,
  lags: Topology['lags'],
  measured?: FrontPanelMeasuredLayout | null,
): DeviceMesh {
  const device = rack.devices[deviceIndex];
  const visibleStart = Math.min(device.uStart, 42);
  const visibleEnd = Math.min(device.uEnd, 42);
  const units = Math.max(1, visibleEnd - visibleStart + 1);
  const fallbackHeight = Math.max(0.09, units * UNIT_HEIGHT - 0.018);
  const bottom = (visibleStart - 1) * UNIT_HEIGHT;
  const color = roleColor(device.node.role, mode);
  const stencil = stencilFor(device.node.platform, componentsOf(device.node.raw));
  const height = panelHeightForStencil(stencil, fallbackHeight, measured);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.08,
    transparent: true,
    opacity: 0.92,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(DEVICE_WIDTH, height, DEVICE_DEPTH), material) as DeviceMesh;
  mesh.position.set(
    0,
    bottom + height / 2,
    -RACK_DEPTH / 2 + DEVICE_DEPTH / 2,
  );
  mesh.userData = {
    nodeName: device.node.name,
    role: device.node.role,
    rack: rack.label,
    baseColor: color,
  };
  group.add(mesh);
  addOccupancyOverlay(mesh, device.node, stencil, height, lags, measured);

  void loadFrontPanelTexture(stencil).then((panelTexture) => {
    if (!mesh.parent || !group.parent?.parent) return;
    if (!panelTexture) {
      addOccupancyOverlay(mesh, device.node, stencil, height, lags, measured);
      return;
    }
    const panelHeight = panelHeightForStencil(stencil, fallbackHeight, measured ?? { aspect: panelTexture.aspect, layout: new Map() });
    mesh.geometry.dispose();
    mesh.geometry = new THREE.BoxGeometry(DEVICE_WIDTH, panelHeight, DEVICE_DEPTH);
    mesh.position.y = bottom + panelHeight / 2;
    addOccupancyOverlay(mesh, device.node, stencil, panelHeight, lags, measured);
    const panel = new THREE.Mesh(
      frontPanelGeometry(DEVICE_WIDTH, panelHeight),
      new THREE.MeshBasicMaterial({
        map: panelTexture.texture,
        transparent: true,
        side: THREE.FrontSide,
        toneMapped: false,
      }),
    );
    panel.position.set(0, 0, -DEVICE_DEPTH / 2 - 0.006);
    mesh.add(panel);
    mesh.userData.hasFrontPanel = true;
    mesh.userData.baseColor = chassisColor(mode);
    mesh.material.color.set(mesh.userData.baseColor);
    mesh.material.opacity = 0.72;
    mesh.material.needsUpdate = true;
  });
  return mesh;
}

function setDeviceOpacity(mesh: DeviceMesh, opacity: number) {
  mesh.material.opacity = opacity;
  mesh.traverse((child) => {
    if (child === mesh) return;
    if (child.userData.occupancyOverlay) return;
    const material = (child as THREE.Mesh).material;
    if (material instanceof THREE.MeshBasicMaterial) {
      material.opacity = opacity;
    }
  });
}

function frameCamera(state: RackSceneState) {
  state.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(state.root);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z, size.y, 8);
  state.controls.target.set(center.x, Math.max(2.5, center.y * 0.35), center.z);
  state.camera.position.set(center.x + maxDim * 0.78, Math.max(7.5, maxDim * 0.42), center.z - maxDim * 0.92);
  state.camera.near = 0.1;
  state.camera.far = Math.max(400, maxDim * 8);
  state.camera.updateProjectionMatrix();
  state.controls.update();
}

function resetRoot(state: RackSceneState) {
  state.scene.remove(state.root);
  disposeObject(state.root);
  state.root = new THREE.Group();
  state.devices = [];
  state.labels = [];
  state.cableLayer = null;
  state.cableHighlightLayer = null;
  state.cableEndpointLayer = null;
  state.cableRoutes = [];
  state.scene.add(state.root);
}

async function buildScene(
  state: RackSceneState,
  topo: Topology,
  racks: RackGroup[],
  shown: Set<string> | null,
  mode: Mode,
  labelsVisible: boolean,
  isCancelled: () => boolean,
) {
  const measuredLayouts = await loadFrontPanelMeasuredLayouts(racks);
  if (isCancelled()) return;

  resetRoot(state);
  const palette = scenePalette(mode);
  state.scene.background = new THREE.Color(palette.background);
  state.renderer.setClearColor(palette.background, 1);

  const layout = layoutRackRows(racks);
  const bounds = layout.racks.reduce((box, rack) => box.expandByPoint(rack.position), new THREE.Box3());
  if (bounds.isEmpty()) bounds.expandByPoint(new THREE.Vector3(0, 0, 0));
  const floorWidth = Math.max(12, (bounds.max.x - bounds.min.x) + 5);
  const floorDepth = Math.max(10, (bounds.max.z - bounds.min.z) + 5);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorWidth, floorDepth),
    new THREE.MeshStandardMaterial({ color: palette.floor, roughness: 0.9, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.08;
  state.root.add(floor);

  const grid = new THREE.GridHelper(Math.max(floorWidth, floorDepth), 24, palette.grid, palette.grid);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = mode === 'dark' ? 0.18 : 0.24;
  grid.position.y = -0.065;
  state.root.add(grid);

  for (const row of layout.rows) {
    const band = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(4, row.maxX - row.minX + 3.2), row.hasBackSide ? 1.45 : 0.42),
      new THREE.MeshBasicMaterial({ color: mode === 'dark' ? '#4092FF' : '#005AFF', transparent: true, opacity: mode === 'dark' ? 0.08 : 0.06 }),
    );
    band.rotation.x = -Math.PI / 2;
    band.position.set((row.minX + row.maxX) / 2, -0.052, row.z);
    state.root.add(band);
    if (labelsVisible) {
      const rowLabel = makeLabelSprite(row.row, mode);
      rowLabel.scale.set(1.25, 0.32, 1);
      rowLabel.position.set(row.minX - 1.7, 0.35, row.z);
      state.root.add(rowLabel);
      state.labels.push(rowLabel);
    }
  }

  const anchors = new Map<string, DeviceAnchor>();
  racks.forEach((rack, index) => {
    const rackGroup = new THREE.Group();
    rackGroup.position.copy(layout.racks[index].position);
    rackGroup.rotation.y = layout.racks[index].rotationY;
    addRackFrame(rackGroup, rack, mode);
    for (let deviceIndex = 0; deviceIndex < rack.devices.length; deviceIndex += 1) {
      const device = rack.devices[deviceIndex];
      const stencil = stencilFor(device.node.platform, componentsOf(device.node.raw));
      const panelLayout = layoutOf(stencil);
      const measured = measuredLayouts.get(stencil);
      const mesh = addDevice(rackGroup, rack, deviceIndex, mode, topo.lags, measured);
      state.devices.push(mesh);
      anchors.set(mesh.userData.nodeName, {
        mesh,
        rack: rack.label,
        role: mesh.userData.role,
        slotted: slottedOf(stencil),
        panelHeight: panelHeightForStencil(stencil, mesh.geometry.parameters.height, measured),
        layout: measured?.layout.size ? measured.layout : panelLayout ? new Map(panelLayout.map((port) => [port.p, port])) : undefined,
        breakouts: device.node.breakouts,
      });
    }
    if (labelsVisible) {
      const label = makeLabelSprite(rack.label, mode);
      label.position.set(0, RACK_HEIGHT + 0.44, -RACK_DEPTH / 2 - 0.08);
      rackGroup.add(label);
      state.labels.push(label);
    }
    state.root.add(rackGroup);
  });
  state.root.updateMatrixWorld(true);
  addCableLayer(state, topo, shown, anchors, mode);
  frameCamera(state);
}

function isKeyboardInputTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return !!element?.closest('input, textarea, select, button, a[href], [contenteditable="true"], [role="textbox"], [role="menu"], [role="listbox"], [role="option"]');
}

function navigationKey(event: KeyboardEvent): NavDirection | null {
  if (event.code === 'KeyW' || event.key === 'ArrowUp') return 'forward';
  if (event.code === 'KeyS' || event.key === 'ArrowDown') return 'back';
  if (event.code === 'KeyA' || event.key === 'ArrowLeft') return 'left';
  if (event.code === 'KeyD' || event.key === 'ArrowRight') return 'right';
  if (event.code === 'KeyE' || event.code === 'Space' || event.key === 'PageUp') return 'up';
  if (event.code === 'KeyQ' || event.code === 'KeyC' || event.key === 'PageDown') return 'down';
  return null;
}

function applyMouseLook(state: RackSceneState, deltaX: number, deltaY: number) {
  const offset = state.controls.target.clone().sub(state.camera.position);
  const distance = Math.max(1, offset.length());
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= deltaX * FPS_MOUSE_SENSITIVITY;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi + deltaY * FPS_MOUSE_SENSITIVITY, FPS_PITCH_MIN, FPS_PITCH_MAX);
  offset.setFromSpherical(spherical).setLength(distance);
  state.controls.target.copy(state.camera.position).add(offset);
}

function applyKeyboardNavigation(state: RackSceneState, pressedKeys: Set<NavDirection>, deltaSeconds: number, fast: boolean) {
  let forwardAmount = 0;
  let rightAmount = 0;
  let upAmount = 0;
  if (pressedKeys.has('forward')) forwardAmount += 1;
  if (pressedKeys.has('back')) forwardAmount -= 1;
  if (pressedKeys.has('right')) rightAmount += 1;
  if (pressedKeys.has('left')) rightAmount -= 1;
  if (pressedKeys.has('up')) upAmount += 1;
  if (pressedKeys.has('down')) upAmount -= 1;
  if (forwardAmount === 0 && rightAmount === 0 && upAmount === 0) return;

  const forward = state.camera.getWorldDirection(new THREE.Vector3());
  if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, state.camera.up).setY(0);
  if (right.lengthSq() < 0.0001) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3(0, 1, 0);

  const move = forward.multiplyScalar(forwardAmount)
    .add(right.multiplyScalar(rightAmount))
    .add(up.multiplyScalar(upAmount));
  if (move.lengthSq() < 0.0001) return;
  move.normalize();

  const distance = state.camera.position.distanceTo(state.controls.target);
  const speed = Math.max(KEYBOARD_MOVE_SPEED_MIN, Math.min(KEYBOARD_MOVE_SPEED_MAX, distance * 0.45));
  move.multiplyScalar(speed * (fast ? KEYBOARD_FAST_MULTIPLIER : 1) * deltaSeconds);
  state.camera.position.add(move);
  state.controls.target.add(move);
}

function panView(state: RackSceneState, rightAmount: number, upAmount: number) {
  if (rightAmount === 0 && upAmount === 0) return;
  const forward = state.camera.getWorldDirection(new THREE.Vector3());
  if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, state.camera.up).setY(0);
  if (right.lengthSq() < 0.0001) right.set(1, 0, 0);
  right.normalize();
  const move = right.multiplyScalar(rightAmount).add(new THREE.Vector3(0, upAmount, 0));
  if (move.lengthSq() < 0.0001) return;
  move.normalize();

  const distance = state.camera.position.distanceTo(state.controls.target);
  const step = THREE.MathUtils.clamp(distance * 0.16, 0.3, 4.2);
  move.multiplyScalar(step);
  state.camera.position.add(move);
  state.controls.target.add(move);
}

function zoomView(state: RackSceneState, zoomIn: boolean) {
  const offset = state.camera.position.clone().sub(state.controls.target);
  const distance = offset.length();
  if (distance < 0.001) return;
  const scale = zoomIn ? 0.82 : 1.22;
  const nextDistance = THREE.MathUtils.clamp(distance * scale, state.controls.minDistance, state.controls.maxDistance);
  state.camera.position.copy(state.controls.target).addScaledVector(offset.normalize(), nextDistance);
}

function pickDevice(state: RackSceneState, event: MouseEvent | PointerEvent): DeviceMesh | null {
  const rect = state.renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  state.pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  state.raycaster.setFromCamera(state.pointer, state.camera);
  return (state.raycaster.intersectObjects(state.devices, false)[0]?.object as DeviceMesh | undefined) ?? null;
}

function RackView({ topo, shown, selected, mode, onOpenNode, onClearSelection }: RackViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<RackSceneState | null>(null);
  const callbacksRef = useRef({ onOpenNode, onClearSelection });
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [hover, setHover] = useState<HoverState | null>(null);
  const traceAny = useTrace((s) => s.any);
  const tracedNodes = useTrace((s) => s.nodes);
  const tracedEdges = useTrace((s) => s.edges);

  useEffect(() => {
    callbacksRef.current = { onOpenNode, onClearSelection };
  }, [onOpenNode, onClearSelection]);

  const racks = useMemo(() => buildRackGroups(topo, shown), [topo, shown]);
  const nodeByName = useMemo(() => new Map(topo.nodes.map((node) => [node.name, node])), [topo]);
  const totalRackLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const node of topo.nodes) {
      const rack = rackLabelOf(node);
      if (rack) labels.add(rack);
    }
    return labels.size;
  }, [topo]);
  const visibleDevices = useMemo(() => racks.reduce((sum, rack) => sum + rack.devices.length, 0), [racks]);
  const visibleCables = useMemo(() => visibleCableCount(topo, shown), [topo, shown]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedCableIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedSet.size === 0) return ids;
    for (const link of topo.links) {
      if (selectedSet.has(link.source) || selectedSet.has(link.target)) ids.add(link.id);
    }
    return ids;
  }, [topo.links, selectedSet]);
  const highlightedCableIds = useMemo(() => {
    if (selectedCableIds.size === 0) return tracedEdges;
    const ids = new Set(tracedEdges);
    for (const id of selectedCableIds) ids.add(id);
    return ids;
  }, [selectedCableIds, tracedEdges]);
  const cableHighlightAny = traceAny || selectedCableIds.size > 0;
  const legendRoles = useMemo(() => {
    const roles = new Set<string>();
    for (const rack of racks) for (const device of rack.devices) roles.add(device.node.role || 'node');
    return [...roles].toSorted((left, right) => roleRank(left) - roleRank(right) || left.localeCompare(right)).slice(0, 6);
  }, [racks]);
  const legendPortKinds = useMemo(() => {
    const kinds = new Set<CableKind>();
    for (const rack of racks) {
      for (const device of rack.devices) {
        for (const row of device.node.table ?? []) {
          const kind = rowOccupancyKind(row, topo.lags);
          if (kind && kind !== 'isl') kinds.add(kind);
        }
      }
    }
    return OCCUPANCY_KIND_ORDER.filter((kind) => kind !== 'isl' && kinds.has(kind));
  }, [racks, topo.lags]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '3D rack view');
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enableRotate = false;
    controls.enablePan = false;
    controls.minDistance = 5;
    controls.maxDistance = 220;
    controls.minPolarAngle = FPS_PITCH_MIN;
    controls.maxPolarAngle = FPS_PITCH_MAX;
    controls.target.set(0, 2.5, 0);

    scene.add(new THREE.HemisphereLight('#FFFFFF', '#233247', 1.55));
    const keyLight = new THREE.DirectionalLight('#FFFFFF', 2.1);
    keyLight.position.set(24, 42, 18);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#8EC2FF', 0.65);
    fillLight.position.set(-18, 14, -24);
    scene.add(fillLight);

    const root = new THREE.Group();
    scene.add(root);
    const state: RackSceneState = {
      renderer,
      scene,
      camera,
      controls,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      root,
      devices: [],
      labels: [],
      cableLayer: null,
      cableHighlightLayer: null,
      cableEndpointLayer: null,
      cableRoutes: [],
    };
    sceneRef.current = state;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      setCableLayerResolutions(state);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const pressedKeys = new Set<NavDirection>();
    let keyboardFast = false;
    let frame = 0;
    let lastFrameTime = performance.now();
    const render = (time = performance.now()) => {
      const deltaSeconds = Math.min(0.06, Math.max(0, (time - lastFrameTime) / 1000));
      lastFrameTime = time;
      applyKeyboardNavigation(state, pressedKeys, deltaSeconds, keyboardFast);
      updateCableScaleForDistance(state);
      controls.update();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(render);
    };
    render();

    let lastHover: string | null = null;
    const pointerDown = { x: 0, y: 0 };
    const mouseLook = { down: false, active: false, lastX: 0, lastY: 0, pointerId: -1 };
    const onPointerDown = (event: PointerEvent) => {
      renderer.domElement.focus({ preventScroll: true });
      pointerDown.x = event.clientX;
      pointerDown.y = event.clientY;
      if (event.button === 0) {
        mouseLook.down = true;
        mouseLook.active = false;
        mouseLook.lastX = event.clientX;
        mouseLook.lastY = event.clientY;
        mouseLook.pointerId = event.pointerId;
        renderer.domElement.setPointerCapture(event.pointerId);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isKeyboardInputTarget(event.target)) return;
      const key = navigationKey(event);
      if (!key) return;
      event.preventDefault();
      pressedKeys.add(key);
      keyboardFast = event.shiftKey;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keyboardFast = event.shiftKey;
      const key = navigationKey(event);
      if (!key) return;
      event.preventDefault();
      pressedKeys.delete(key);
    };
    const clearPressedKeys = () => {
      pressedKeys.clear();
      keyboardFast = false;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (mouseLook.down && (event.buttons & 1) === 1) {
        const deltaX = event.clientX - mouseLook.lastX;
        const deltaY = event.clientY - mouseLook.lastY;
        mouseLook.lastX = event.clientX;
        mouseLook.lastY = event.clientY;
        const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
        if (mouseLook.active || moved > POINTER_CLICK_TOLERANCE) {
          mouseLook.active = true;
          event.preventDefault();
          renderer.domElement.style.cursor = 'grabbing';
          lastHover = null;
          trace.hover(null);
          setHover(null);
          applyMouseLook(state, deltaX, deltaY);
          return;
        }
      }
      const hit = pickDevice(state, event);
      const nodeName = hit?.userData.nodeName ?? null;
      renderer.domElement.style.cursor = nodeName ? 'pointer' : 'grab';
      if (nodeName === lastHover) {
        if (nodeName) setHover({ nodeName, x: event.clientX, y: event.clientY });
        return;
      }
      lastHover = nodeName;
      if (nodeName) {
        trace.hover(`node:${nodeName}`);
        setHover({ nodeName, x: event.clientX, y: event.clientY });
      } else {
        trace.hover(null);
        setHover(null);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== mouseLook.pointerId) return;
      mouseLook.down = false;
      mouseLook.active = false;
      mouseLook.pointerId = -1;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      renderer.domElement.style.cursor = 'grab';
    };
    const onPointerLeave = () => {
      if (mouseLook.active) return;
      lastHover = null;
      renderer.domElement.style.cursor = 'grab';
      trace.hover(null);
      setHover(null);
    };
    const onClick = (event: MouseEvent) => {
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
      if (moved > POINTER_CLICK_TOLERANCE) return;
      const hit = pickDevice(state, event);
      if (hit) {
        const nodeName = hit.userData.nodeName;
        trace.pin(`node:${nodeName}`);
        callbacksRef.current.onOpenNode(nodeName, { select: true });
        return;
      }
      trace.clear();
      callbacksRef.current.onClearSelection();
      callbacksRef.current.onOpenNode(null);
    };
    const onDoubleClick = (event: MouseEvent) => {
      const hit = pickDevice(state, event);
      if (!hit) return;
      const nodeName = hit.userData.nodeName;
      trace.pin(`node:${nodeName}`, true);
      callbacksRef.current.onOpenNode(nodeName, { expand: true, select: true });
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('dblclick', onDoubleClick);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearPressedKeys);

    return () => {
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('dblclick', onDoubleClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearPressedKeys);
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      controls.dispose();
      disposeObject(root);
      renderer.dispose();
      renderer.domElement.remove();
      if (sceneRef.current === state) sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    let cancelled = false;
    void buildScene(state, topo, racks, shown, mode, labelsVisible, () => cancelled);
    return () => { cancelled = true; };
  }, [topo, racks, shown, mode, labelsVisible]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    for (const mesh of state.devices) {
      const isSelected = selectedSet.has(mesh.userData.nodeName);
      const isTraced = tracedNodes.has(mesh.userData.nodeName);
      const dim = traceAny && !isTraced && !isSelected;
      mesh.material.color.set(mesh.userData.baseColor);
      setDeviceOpacity(mesh, dim ? 0.2 : isSelected || isTraced ? 1 : mesh.userData.hasFrontPanel ? 0.72 : 0.92);
      mesh.material.emissive.set(isSelected ? '#FFD568' : isTraced ? '#4092FF' : '#000000');
      mesh.material.emissiveIntensity = isSelected ? 0.35 : isTraced ? 0.22 : 0;
      mesh.scale.z = isSelected || isTraced ? 1.28 : 1;
    }
    updateCableTrace(state, highlightedCableIds, cableHighlightAny, mode);
  }, [selectedSet, traceAny, tracedNodes, highlightedCableIds, cableHighlightAny, mode, racks, labelsVisible]);

  const nudgeLook = useCallback((deltaX: number, deltaY: number) => {
    const state = sceneRef.current;
    if (!state) return;
    applyMouseLook(state, deltaX, deltaY);
    state.controls.update();
  }, []);

  const nudgePan = useCallback((rightAmount: number, upAmount: number) => {
    const state = sceneRef.current;
    if (!state) return;
    panView(state, rightAmount, upAmount);
    state.controls.update();
  }, []);

  const nudgeZoom = useCallback((zoomIn: boolean) => {
    const state = sceneRef.current;
    if (!state) return;
    zoomView(state, zoomIn);
    state.controls.update();
  }, []);

  const resetCamera = useCallback(() => {
    const state = sceneRef.current;
    if (state) {
      frameCamera(state);
      state.controls.update();
    }
  }, []);

  const hoverNode = hover ? nodeByName.get(hover.nodeName) : undefined;
  const gizmoButtonSx = {
    width: 30,
    height: 30,
    minWidth: 30,
    color: 'text.primary',
    border: 1,
    borderColor: 'divider',
    bgcolor: 'background.paper',
    '&:hover': { bgcolor: 'action.hover' },
  };

  return (
    <Box ref={hostRef} sx={{ position: 'relative', height: '100%', width: '100%', overflow: 'hidden', bgcolor: 'background.default' }}>
      <Box sx={{ position: 'absolute', top: 12, left: 12, zIndex: 1, px: 1.25, py: 1, minWidth: 190,
        bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Rack View</Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{racks.length} racks · {visibleDevices} devices · {visibleCables} cables</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {totalRackLabels > 0 ? `${totalRackLabels} rack labels in namespace` : 'No rack labels in namespace'}
        </Typography>
      </Box>

      <Box sx={{ position: 'absolute', top: 12, right: 12, zIndex: 1, display: 'flex', gap: 0.5,
        bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2, p: 0.5 }}>
        <Tooltip title="Reset rack view">
          <IconButton size="small" onClick={resetCamera} sx={{ color: 'text.primary' }}>
            <CenterFocusStrongIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={labelsVisible ? 'Hide rack labels' : 'Show rack labels'}>
          <IconButton size="small" onClick={() => setLabelsVisible((value) => !value)} sx={{ color: 'text.primary' }}>
            {labelsVisible ? <LabelIcon fontSize="small" /> : <LabelOffIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ position: 'absolute', right: 12, bottom: { xs: 68, sm: 12 }, zIndex: 1,
        width: 132, px: 0.75, py: 0.75, bgcolor: 'background.paper', border: 1,
        borderColor: 'divider', boxShadow: 2 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '30px 30px 30px 30px', gridTemplateRows: '30px 30px',
          gap: 0.5, alignItems: 'center', justifyContent: 'center' }}>
          <Tooltip title="Tilt up">
            <IconButton size="small" aria-label="Tilt rack view up" onClick={(event) => {
              event.stopPropagation();
              nudgeLook(0, -GIZMO_TILT_STEP);
            }} sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 1 }}>
              <KeyboardArrowUpIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Rotate left">
            <IconButton size="small" aria-label="Rotate rack view left" onClick={(event) => {
              event.stopPropagation();
              nudgeLook(-GIZMO_ROTATE_STEP, 0);
            }} sx={{ ...gizmoButtonSx, gridColumn: 1, gridRow: 2 }}>
              <RotateLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Tilt down">
            <IconButton size="small" aria-label="Tilt rack view down" onClick={(event) => {
              event.stopPropagation();
              nudgeLook(0, GIZMO_TILT_STEP);
            }} sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 2 }}>
              <KeyboardArrowDownIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Rotate right">
            <IconButton size="small" aria-label="Rotate rack view right" onClick={(event) => {
              event.stopPropagation();
              nudgeLook(GIZMO_ROTATE_STEP, 0);
            }} sx={{ ...gizmoButtonSx, gridColumn: 3, gridRow: 2 }}>
              <RotateRightIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Zoom in">
            <IconButton size="small" aria-label="Zoom rack view in" onClick={(event) => {
              event.stopPropagation();
              nudgeZoom(true);
            }} sx={{ ...gizmoButtonSx, gridColumn: 4, gridRow: 1 }}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Zoom out">
            <IconButton size="small" aria-label="Zoom rack view out" onClick={(event) => {
              event.stopPropagation();
              nudgeZoom(false);
            }} sx={{ ...gizmoButtonSx, gridColumn: 4, gridRow: 2 }}>
              <RemoveIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={{ height: 1, bgcolor: 'divider', opacity: 0.72, my: 0.75 }} />
        <Box sx={{ display: 'grid', gridTemplateColumns: '30px 30px 30px', gridTemplateRows: '30px 30px',
          gap: 0.5, justifyContent: 'center' }}>
          <Tooltip title="Pan up">
            <IconButton size="small" aria-label="Pan rack view up" onClick={(event) => {
              event.stopPropagation();
              nudgePan(0, 1);
            }} sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 1 }}>
              <KeyboardArrowUpIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Pan left">
            <IconButton size="small" aria-label="Pan rack view left" onClick={(event) => {
              event.stopPropagation();
              nudgePan(-1, 0);
            }} sx={{ ...gizmoButtonSx, gridColumn: 1, gridRow: 2 }}>
              <KeyboardArrowLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Pan down">
            <IconButton size="small" aria-label="Pan rack view down" onClick={(event) => {
              event.stopPropagation();
              nudgePan(0, -1);
            }} sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 2 }}>
              <KeyboardArrowDownIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Pan right">
            <IconButton size="small" aria-label="Pan rack view right" onClick={(event) => {
              event.stopPropagation();
              nudgePan(1, 0);
            }} sx={{ ...gizmoButtonSx, gridColumn: 3, gridRow: 2 }}>
              <KeyboardArrowRightIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {(legendRoles.length > 0 || legendPortKinds.length > 0) && (
        <Box sx={{ position: 'absolute', bottom: { xs: 68, sm: 12 }, left: 12, zIndex: 1, px: 1.25, py: 1,
          bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
          {legendRoles.length > 0 && (
            <>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.75 }}>Roles</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxWidth: 360 }}>
                {legendRoles.map((role) => (
                  <Box key={role} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Box sx={{ width: 10, height: 10, bgcolor: roleColor(role, mode), border: 1, borderColor: 'divider' }} />
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{role}</Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
          {legendPortKinds.length > 0 && (
            <>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: legendRoles.length ? 1 : 0, mb: 0.75 }}>Ports</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxWidth: 360 }}>
                {legendPortKinds.map((kind) => (
                  <Box key={kind} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Box sx={{ width: 10, height: 10, bgcolor: OCCUPANCY_KIND_COLORS[kind], border: 1, borderColor: 'divider' }} />
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{OCCUPANCY_KIND_LABELS[kind]}</Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </Box>
      )}

      {racks.length === 0 && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Box sx={{ px: 2, py: 1.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>No devices match the current rack filter.</Typography>
          </Box>
        </Box>
      )}

      {hover && hoverNode && (
        <Box sx={{ position: 'fixed', left: hover.x + 14, top: hover.y + 14, zIndex: 2, pointerEvents: 'none',
          px: 1.25, py: 1, maxWidth: 280, bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 4 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{hoverNode.name}</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
            {rackLabelOf(hoverNode) ?? 'Inferred rack'} · {hoverNode.role || 'node'}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
            {hoverNode.platform}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

export default memo(RackView);
