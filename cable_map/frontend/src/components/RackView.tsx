import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import type { SxProps, Theme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrongOutlined';
import DirectionsWalkIcon from '@mui/icons-material/DirectionsWalk';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LabelIcon from '@mui/icons-material/LabelOutlined';
import LabelOffIcon from '@mui/icons-material/LabelOffOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import RotateLeftIcon from '@mui/icons-material/RotateLeft';
import RotateRightIcon from '@mui/icons-material/RotateRight';
import ViewColumnIcon from '@mui/icons-material/ViewColumnOutlined';
import type { Breakout, Row, Topology } from '../domain/topology/contract';
import type { FrontPanelPortPos } from '../domain/ports/frontPanelMeta';
import { frontPanelMetaOf, layoutOf, slottedOf } from '../domain/ports/frontPanelMeta';
import { breakoutChannel, cageKey, portIdx, shortPortLabel } from '../domain/ports/interfaceNames';
import { buildRackGroups, rackLabelOf, roleRank, type RackGroup } from '../domain/topology/racks';
import {
  buildLinkIndex, endKey, islTraceIdFromRow, stubTraceId,
  type LinkIndex,
} from '../domain/topology/linkIndex';
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
// gizmo buttons: a tap applies one step, holding glides continuously at the hold speed
const GIZMO_ROTATE_STEP = 72;
const GIZMO_TILT_STEP = 48;
const GIZMO_ROTATE_HOLD_SPEED = 620;
const GIZMO_TILT_HOLD_SPEED = 400;
const GIZMO_PAN_STEP = 120;
const GIZMO_PAN_HOLD_SPEED = 660;
const GIZMO_ZOOM_STEP = 0.82;
const GIZMO_ZOOM_HOLD_RATE = 0.4; // distance factor per second while held
const GIZMO_HOLD_DELAY_MS = 240;
const FLY_DURATION_MS = 750;
const CABLE_LINEWIDTH_IDLE = 1.2;
const CABLE_LINEWIDTH_CLOSE = 3.25;
const CABLE_LINEWIDTH_TRACE = 2.8;
const CABLE_LINEWIDTH_TRACE_CLOSE = 5.5;
// hover hit-testing: pick radius grows with camera distance; above the route limit the
// per-segment sweep is skipped entirely (matches the 2D canvas's large-topology cutoff)
const CABLE_PICK_ROUTE_LIMIT = 5000;
const CABLE_PICK_MIN_THRESHOLD = 0.035;
const CABLE_PICK_MAX_THRESHOLD = 0.17;
// demand rendering: how long one interaction keeps frames flowing before the loop idles
const RENDER_ACTIVE_MS = 400;
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

// invisible pick target spanning a whole cabinet; its material lights up on hover
type RackHitbox = THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> & {
  userData: { rackLabel: string };
};

type CameraPose = { position: THREE.Vector3; target: THREE.Vector3 };

type CameraTween = {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
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
  center: THREE.Vector3;  // bounding sphere over the route, culls the pick sweep
  radius: number;
};

type OccupiedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: CableKind;
};

type PortHit = {
  cage: string;
  channel: number | null;
};

type HoverTarget =
  | { type: 'device'; nodeName: string; port?: PortHit }
  | { type: 'cable'; linkId: string }
  | { type: 'rack'; rack: string };

type HoverState = {
  target: HoverTarget;
  x: number;
  y: number;
};

type HoverPick = {
  key: string;              // dedupe key for pointermove
  traceKey: string | null;  // trace-store key to light up (node:… / cable:…); racks trace nothing
  target: HoverTarget;
};

type DevicePlacement = {
  rack: string;
  uStart: number;
  uEnd: number;
};

function formatRackU(placement: DevicePlacement | undefined): string | null {
  if (!placement) return null;
  const units = placement.uStart === placement.uEnd ? `U${placement.uStart}` : `U${placement.uStart}–${placement.uEnd}`;
  return `${placement.rack} · ${units}`;
}

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

// All static rack furniture (posts, panels, rails, markers…) is collected per material and
// merged into one mesh each, so a hall of hundreds of cabinets stays a handful of draw calls.
type FurnitureCollector = {
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

function createFurnitureCollector(): FurnitureCollector {
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

function collectRackFrame(collector: FurnitureCollector, rack: RackGroup, matrix: THREE.Matrix4) {
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

function addRackFurniture(root: THREE.Group, collector: FurnitureCollector, mode: Mode) {
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
  measured: FrontPanelMeasuredLayout | null | undefined,
  onUpdate: () => void,
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
    onUpdate();
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

function frameOverview(state: RackSceneState): { pose: CameraPose; maxDim: number } | null {
  state.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(state.root);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z, size.y, 8);
  return {
    maxDim,
    pose: {
      target: new THREE.Vector3(center.x, Math.max(2.5, center.y * 0.35), center.z),
      position: new THREE.Vector3(center.x + maxDim * 0.78, Math.max(7.5, maxDim * 0.42), center.z - maxDim * 0.92),
    },
  };
}

function frameCamera(state: RackSceneState) {
  const overview = frameOverview(state);
  if (!overview) return;
  state.controls.target.copy(overview.pose.target);
  state.camera.position.copy(overview.pose.position);
  state.camera.near = 0.1;
  state.camera.far = Math.max(400, overview.maxDim * 8);
  state.camera.updateProjectionMatrix();
  state.controls.update();
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Smooth camera transition to a pose; any direct input (drag, wheel, keys, gizmo) cancels it.
function flyTo(state: RackSceneState, pose: CameraPose, duration = FLY_DURATION_MS) {
  state.cameraTween = {
    fromPosition: state.camera.position.clone(),
    toPosition: pose.position.clone(),
    fromTarget: state.controls.target.clone(),
    toTarget: pose.target.clone(),
    start: performance.now(),
    duration,
  };
  state.requestRender(duration + 150);
}

function stepCameraTween(state: RackSceneState, time: number) {
  const tween = state.cameraTween;
  if (!tween) return;
  const t = Math.min(1, (time - tween.start) / tween.duration);
  const k = easeInOutCubic(t);
  state.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, k);
  state.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
  if (t >= 1) state.cameraTween = null;
  else state.requestRender();
}

// Distance at which a width×height face fills the frustum (whichever axis binds).
function fitDistance(camera: THREE.PerspectiveCamera, width: number, height: number): number {
  const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanHorizontal = tanVertical * Math.max(0.4, camera.aspect);
  return Math.max(width / (2 * tanHorizontal), height / (2 * tanVertical));
}

// Straight-on pose in front of a device's panel: target on the panel, camera along its normal.
function deviceFocusPose(state: RackSceneState, nodeName: string): CameraPose | null {
  const anchor = state.anchors.get(nodeName);
  if (!anchor) return null;
  anchor.mesh.updateWorldMatrix(true, false);
  const front = new THREE.Vector3(0, 0, -1).applyQuaternion(anchor.mesh.getWorldQuaternion(new THREE.Quaternion()));
  const target = anchor.mesh.getWorldPosition(new THREE.Vector3()).addScaledVector(front, DEVICE_DEPTH / 2);
  const distance = THREE.MathUtils.clamp(
    fitDistance(state.camera, DEVICE_WIDTH * 1.35, Math.max(anchor.panelHeight * 3.2, 0.5)),
    0.9,
    4,
  );
  return { position: target.clone().addScaledVector(front, distance), target };
}

function rackFocusPose(state: RackSceneState, rackLabel: string): CameraPose | null {
  const hitbox = state.rackHitboxes.find((mesh) => mesh.userData.rackLabel === rackLabel);
  if (!hitbox) return null;
  hitbox.updateWorldMatrix(true, false);
  const front = new THREE.Vector3(0, 0, -1).applyQuaternion(hitbox.getWorldQuaternion(new THREE.Quaternion()));
  const target = hitbox.getWorldPosition(new THREE.Vector3()).addScaledVector(front, RACK_DEPTH / 2);
  const distance = THREE.MathUtils.clamp(
    fitDistance(state.camera, RACK_WIDTH * 2.4, RACK_HEIGHT * 1.18),
    4,
    16,
  );
  return { position: target.clone().addScaledVector(front, distance), target };
}

// Elevation of the whole hall from the front-row side; rows face the camera head-on.
function hallFrontPose(state: RackSceneState): CameraPose | null {
  if (state.rackHitboxes.length === 0) return null;
  const bounds = new THREE.Box3();
  const worldPosition = new THREE.Vector3();
  for (const hitbox of state.rackHitboxes) bounds.expandByPoint(hitbox.getWorldPosition(worldPosition));
  const center = bounds.getCenter(new THREE.Vector3());
  const width = bounds.max.x - bounds.min.x + RACK_SPACING;
  const distance = THREE.MathUtils.clamp(
    fitDistance(state.camera, width * 1.08, RACK_HEIGHT * 1.35),
    8,
    state.controls.maxDistance,
  );
  return {
    target: new THREE.Vector3(center.x, RACK_HEIGHT * 0.45, center.z),
    position: new THREE.Vector3(center.x, RACK_HEIGHT * 0.55, bounds.min.z - RACK_DEPTH - distance),
  };
}

function resetRoot(state: RackSceneState) {
  state.scene.remove(state.root);
  disposeObject(state.root);
  state.root = new THREE.Group();
  state.devices = [];
  state.deviceCenters = new Float32Array(0);
  state.anchors = new Map();
  state.rackHitboxes = [];
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
  frame: boolean,
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
    const rowLabel = makeLabelSprite(row.row, mode);
    rowLabel.scale.set(1.25, 0.32, 1);
    rowLabel.position.set(row.minX - 1.7, 0.35, row.z);
    rowLabel.visible = labelsVisible;
    state.root.add(rowLabel);
    state.labels.push(rowLabel);
  }

  const furniture = createFurnitureCollector();
  const rackMatrix = new THREE.Matrix4();
  racks.forEach((rack, index) => {
    const rackGroup = new THREE.Group();
    rackGroup.position.copy(layout.racks[index].position);
    rackGroup.rotation.y = layout.racks[index].rotationY;
    rackMatrix.makeRotationY(layout.racks[index].rotationY).setPosition(layout.racks[index].position);
    collectRackFrame(furniture, rack, rackMatrix);
    for (let deviceIndex = 0; deviceIndex < rack.devices.length; deviceIndex += 1) {
      const device = rack.devices[deviceIndex];
      const stencil = stencilFor(device.node.platform, componentsOf(device.node.raw));
      const panelLayout = layoutOf(stencil);
      const measured = measuredLayouts.get(stencil);
      const mesh = addDevice(rackGroup, rack, deviceIndex, mode, topo.lags, measured, () => state.requestRender());
      state.devices.push(mesh);
      state.anchors.set(mesh.userData.nodeName, {
        mesh,
        rack: rack.label,
        role: mesh.userData.role,
        slotted: slottedOf(stencil),
        panelHeight: panelHeightForStencil(stencil, mesh.geometry.parameters.height, measured),
        layout: measured?.layout.size ? measured.layout : panelLayout ? new Map(panelLayout.map((port) => [port.p, port])) : undefined,
        breakouts: device.node.breakouts,
      });
    }
    const label = makeLabelSprite(rack.label, mode);
    label.position.set(0, RACK_HEIGHT + 0.44, -RACK_DEPTH / 2 - 0.08);
    label.visible = labelsVisible;
    rackGroup.add(label);
    state.labels.push(label);
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(RACK_WIDTH + 0.22, RACK_HEIGHT + 0.2, RACK_DEPTH + 0.24),
      new THREE.MeshBasicMaterial({
        color: mode === 'dark' ? '#4092FF' : '#005AFF',
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    ) as RackHitbox;
    hitbox.position.y = RACK_HEIGHT / 2;
    hitbox.renderOrder = 6;
    hitbox.userData = { rackLabel: rack.label };
    rackGroup.add(hitbox);
    state.rackHitboxes.push(hitbox);
    state.root.add(rackGroup);
  });
  addRackFurniture(state.root, furniture, mode);
  state.root.updateMatrixWorld(true);
  const centers = new Float32Array(state.devices.length * 3);
  const worldPosition = new THREE.Vector3();
  state.devices.forEach((device, index) => {
    device.getWorldPosition(worldPosition);
    centers[index * 3] = worldPosition.x;
    centers[index * 3 + 1] = worldPosition.y;
    centers[index * 3 + 2] = worldPosition.z;
  });
  state.deviceCenters = centers;
  addCableLayer(state, topo, shown, state.anchors, mode);
  if (frame) frameCamera(state);
  state.requestRender();
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

// Screen-space pan in pixels: what sits under the orbit target moves exactly that many
// pixels, so a right-drag feels like grabbing the rack face.
function panView(state: RackSceneState, rightPx: number, upPx: number) {
  if (rightPx === 0 && upPx === 0) return;
  const height = state.renderer.domElement.clientHeight || 1;
  const distance = Math.max(1.2, state.camera.position.distanceTo(state.controls.target));
  const worldPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(state.camera.fov) / 2)) / height;
  state.camera.updateMatrix();
  const move = new THREE.Vector3().setFromMatrixColumn(state.camera.matrix, 0).multiplyScalar(rightPx * worldPerPixel)
    .addScaledVector(new THREE.Vector3().setFromMatrixColumn(state.camera.matrix, 1), upPx * worldPerPixel);
  state.camera.position.add(move);
  state.controls.target.add(move);
}

function zoomView(state: RackSceneState, factor: number) {
  const offset = state.camera.position.clone().sub(state.controls.target);
  const distance = offset.length();
  if (distance < 0.001) return;
  const nextDistance = THREE.MathUtils.clamp(distance * factor, state.controls.minDistance, state.controls.maxDistance);
  state.camera.position.copy(state.controls.target).addScaledVector(offset.normalize(), nextDistance);
}

function updatePointerRay(state: RackSceneState, clientX: number, clientY: number): boolean {
  const rect = state.renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  state.pointer.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  state.raycaster.setFromCamera(state.pointer, state.camera);
  return true;
}

function pickDevice(state: RackSceneState): THREE.Intersection | null {
  return state.raycaster.intersectObjects(state.devices, false)[0] ?? null;
}

type CablePick = {
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

function pickCable(state: RackSceneState, maxRayDistance: number): CablePick | null {
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
function pickDevicePort(anchor: DeviceAnchor, worldPoint: THREE.Vector3): PortHit | null {
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
function portHitRow(linkIndex: LinkIndex, nodeName: string, port: PortHit): Row | null {
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
function portTraceKey(linkIndex: LinkIndex, nodeName: string, port: PortHit): string | null {
  const row = portHitRow(linkIndex, nodeName, port);
  if (!row) return null;
  const link = linkIndex.linkByEnd.get(endKey(nodeName, row.label));
  if (link) return `cable:${linkIndex.traceIdByLinkId.get(link.id) ?? link.id}`;
  if (row.type === 'edge') return `cable:${stubTraceId(nodeName, port.cage, breakoutChannel(row.label))}`;
  if (row.type === 'interSwitch' && row.remoteNode) return `cable:${islTraceIdFromRow(nodeName, row)}`;
  return null;
}

function placementSuffix(placement: DevicePlacement | undefined): string {
  const formatted = formatRackU(placement);
  return formatted ? ` (${formatted})` : '';
}

// Cursor-following card naming exactly what's under the pointer: a cable (both ends with
// rack + U position), a front-panel port (peer, LAG, LLDP, breakout channel) or a device.
function HoverCard({ hover, nodeByName, placements, rackByLabel, linkIndex, lags }: {
  hover: HoverState;
  nodeByName: Map<string, Topology['nodes'][number]>;
  placements: Map<string, DevicePlacement>;
  rackByLabel: Map<string, RackGroup>;
  linkIndex: LinkIndex;
  lags: Topology['lags'];
}) {
  const flipX = hover.x > window.innerWidth - 360;
  const flipY = hover.y > window.innerHeight - 280;
  const style = {
    left: flipX ? hover.x - 14 : hover.x + 14,
    top: flipY ? hover.y - 12 : hover.y + 14,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
  };
  const frameSx = {
    position: 'fixed', zIndex: 2, pointerEvents: 'none', px: 1.25, py: 1, maxWidth: 320,
    bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 4,
  } as const;

  if (hover.target.type === 'rack') {
    const rack = rackByLabel.get(hover.target.rack);
    if (!rack) return null;
    return (
      <Box sx={frameSx} style={style}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{rack.label}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          {rack.placement.row} · {rack.devices.length} device{rack.devices.length === 1 ? '' : 's'}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          {rack.ruUsed} / {rack.ruCapacity} U used
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>
          Click to face this rack
        </Typography>
      </Box>
    );
  }

  if (hover.target.type === 'cable') {
    const link = linkIndex.linkById.get(hover.target.linkId);
    if (!link) return null;
    const row = linkIndex.rowByEnd.get(endKey(link.source, link.sourcePort))
      ?? linkIndex.rowByEnd.get(endKey(link.target, link.targetPort));
    const kind = (row && rowOccupancyKind(row, lags)) || 'isl';
    const ends = [
      { node: link.source, port: link.sourcePort },
      { node: link.target, port: link.targetPort },
    ];
    return (
      <Box sx={frameSx} style={style}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box sx={{ width: 8, height: 8, flex: 'none', bgcolor: OCCUPANCY_KIND_COLORS[kind] }} />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{OCCUPANCY_KIND_LABELS[kind]} cable</Typography>
        </Box>
        {ends.map((end) => (
          <Box key={`${end.node}|${end.port}`} sx={{ mt: 0.5 }}>
            <Typography variant="body2">{end.node} · {shortPortLabel(end.port)}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
              {formatRackU(placements.get(end.node)) ?? 'not racked'}
            </Typography>
          </Box>
        ))}
        {row?.lag && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>LAG {row.lag}</Typography>
        )}
        {row?.lldpStatus === 'mismatch' && (
          <Typography variant="caption" sx={{ color: 'warning.main', display: 'block' }}>
            LLDP mismatch{row.lldpPeer ? ` · sees ${row.lldpPeer}` : ''}
          </Typography>
        )}
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>Click to pin this cable</Typography>
      </Box>
    );
  }

  const node = nodeByName.get(hover.target.nodeName);
  if (!node) return null;
  const placement = formatRackU(placements.get(node.name));
  const port = hover.target.port;
  const cageRows = port ? linkIndex.rowsByCage.get(endKey(node.name, port.cage)) ?? [] : [];
  const exact = port ? portHitRow(linkIndex, node.name, port) : null;
  const portRows = exact ? [exact] : cageRows.slice(0, 4);
  const breakout = port ? node.breakouts?.[port.cage] : undefined;
  const connected = (node.table ?? []).filter((row) => row.type === 'interSwitch' || row.type === 'edge').length;
  return (
    <Box sx={frameSx} style={style}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{node.name}</Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
        {placement ?? 'Inferred rack'} · {node.role || 'node'}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
        {node.platform}{!port ? ` · ${connected} cabled port${connected === 1 ? '' : 's'}` : ''}
      </Typography>
      {port && (
        <Box sx={{ mt: 0.75, pt: 0.75, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="caption" sx={{ fontWeight: 600, display: 'block' }}>
            Port {port.cage}
            {breakout ? ` · ${breakout.channels}×${breakout.speed}${port.channel ? ` · ch ${port.channel}` : ''}` : ''}
          </Typography>
          {portRows.length === 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>not cabled</Typography>
          )}
          {portRows.map((row) => {
            const kind = rowOccupancyKind(row, lags);
            const remote = row.remoteNode || row.peer || '—';
            const remotePlacement = row.remoteNode ? formatRackU(placements.get(row.remoteNode)) : null;
            return (
              <Box key={row.label} sx={{ mt: 0.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {kind && <Box sx={{ width: 8, height: 8, flex: 'none', bgcolor: OCCUPANCY_KIND_COLORS[kind] }} />}
                  <Typography variant="caption">
                    {shortPortLabel(row.label)} → {remote}{row.remotePort ? ` · ${shortPortLabel(row.remotePort)}` : ''}
                  </Typography>
                </Box>
                {remotePlacement && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', pl: kind ? 1.5 : 0 }}>
                    {remotePlacement}
                  </Typography>
                )}
              </Box>
            );
          })}
          {exact?.lag && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>LAG {exact.lag}</Typography>}
          {exact?.lldpStatus === 'mismatch' && (
            <Typography variant="caption" sx={{ color: 'warning.main', display: 'block' }}>
              LLDP mismatch{exact.lldpPeer ? ` · sees ${exact.lldpPeer}` : ''}
            </Typography>
          )}
          {exact?.desc && <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>{exact.desc}</Typography>}
        </Box>
      )}
      <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>
        {port ? 'Click to pin · F to face device' : 'Click to face front panel'}
      </Typography>
    </Box>
  );
}

// Gizmo control: a tap applies one nudge; keeping it pressed glides continuously
// (onHold receives per-frame delta seconds) until the pointer lifts.
function GizmoButton({ title, ariaLabel, onNudge, onHold, sx, children }: {
  title: string;
  ariaLabel: string;
  onNudge: () => void;
  onHold: (deltaSeconds: number) => void;
  sx: SxProps<Theme>;
  children: ReactNode;
}) {
  const holdRef = useRef<{ timeout: number; raf: number; last: number } | null>(null);
  const stopHold = useCallback(() => {
    const hold = holdRef.current;
    if (!hold) return;
    window.clearTimeout(hold.timeout);
    window.cancelAnimationFrame(hold.raf);
    holdRef.current = null;
  }, []);
  useEffect(() => stopHold, [stopHold]);

  const startHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    stopHold();
    onNudge();
    const hold = { timeout: 0, raf: 0, last: 0 };
    const step = (time: number) => {
      onHold(Math.min(0.05, Math.max(0, (time - hold.last) / 1000)));
      hold.last = time;
      hold.raf = window.requestAnimationFrame(step);
    };
    hold.timeout = window.setTimeout(() => {
      hold.last = performance.now();
      hold.raf = window.requestAnimationFrame(step);
    }, GIZMO_HOLD_DELAY_MS);
    holdRef.current = hold;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <Tooltip title={title} disableInteractive>
      <IconButton
        size="small"
        aria-label={ariaLabel}
        onPointerDown={startHold}
        onPointerUp={stopHold}
        onPointerCancel={stopHold}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail === 0) onNudge(); // keyboard activation
        }}
        sx={sx}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

function RackView({ topo, shown, selected, mode, onOpenNode, onClearSelection }: RackViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<RackSceneState | null>(null);
  const callbacksRef = useRef({ onOpenNode, onClearSelection });
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [fpsMode, setFpsMode] = useState(false);
  const [hover, setHover] = useState<HoverState | null>(null);
  const traceAny = useTrace((s) => s.any);
  const tracedNodes = useTrace((s) => s.nodes);
  const tracedEdges = useTrace((s) => s.edges);
  const pinnedTraceKey = useTrace((s) => (s.pinned ? s.key : null));

  useEffect(() => {
    callbacksRef.current = { onOpenNode, onClearSelection };
  }, [onOpenNode, onClearSelection]);

  const racks = useMemo(() => buildRackGroups(topo, shown), [topo, shown]);
  const rackByLabel = useMemo(() => new Map(racks.map((rack) => [rack.label, rack])), [racks]);
  const nodeByName = useMemo(() => new Map(topo.nodes.map((node) => [node.name, node])), [topo]);
  const linkIndex = useMemo(
    () => buildLinkIndex(topo, (node) => slottedOf(stencilFor(node.platform, componentsOf(node.raw)))),
    [topo],
  );
  const placements = useMemo(() => {
    const byName = new Map<string, DevicePlacement>();
    for (const rack of racks) {
      for (const device of rack.devices) {
        byName.set(device.node.name, { rack: rack.label, uStart: device.uStart, uEnd: device.uEnd });
      }
    }
    return byName;
  }, [racks]);
  // the pointer handlers live in the mount effect; they read the current index through this ref
  const linkIndexRef = useRef(linkIndex);
  useEffect(() => { linkIndexRef.current = linkIndex; }, [linkIndex]);
  const labelsVisibleRef = useRef(labelsVisible);
  labelsVisibleRef.current = labelsVisible;
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
    // trace ids come from the 2D graph (isl|…, isllag|…, stub|…); expand them into the
    // backend link ids the rack routes are keyed by
    const ids = new Set(selectedCableIds);
    for (const traceId of tracedEdges) {
      ids.add(traceId);
      for (const linkId of linkIndex.linkIdsByTraceId.get(traceId) ?? []) ids.add(linkId);
    }
    return ids;
  }, [selectedCableIds, tracedEdges, linkIndex]);
  const cableHighlightAny = traceAny || selectedCableIds.size > 0;
  const pinnedCable = useMemo(() => {
    if (!pinnedTraceKey?.startsWith('cable:')) return null;
    const traceId = pinnedTraceKey.slice(6);
    const linkIds = linkIndex.linkIdsByTraceId.get(traceId);
    const link = linkIndex.linkById.get(linkIds?.[0] ?? traceId);
    if (!link) return null;
    const row = linkIndex.rowByEnd.get(endKey(link.source, link.sourcePort))
      ?? linkIndex.rowByEnd.get(endKey(link.target, link.targetPort));
    const kind = (row && rowOccupancyKind(row, topo.lags)) || 'isl';
    return { link, kind, bundleSize: linkIds?.length ?? 1 };
  }, [pinnedTraceKey, linkIndex, topo.lags]);
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
    controls.zoomToCursor = true; // wheel dives toward the port under the pointer
    controls.minDistance = 0.55;
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
    // demand rendering: the rAF loop stays alive but only draws while an interaction,
    // damping tail, async texture load or style change keeps the window open
    let renderUntil = performance.now() + 2000;
    const state: RackSceneState = {
      renderer,
      scene,
      camera,
      controls,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      root,
      devices: [],
      deviceCenters: new Float32Array(0),
      anchors: new Map(),
      rackHitboxes: [],
      labels: [],
      cableLayer: null,
      cableHighlightLayer: null,
      cableEndpointLayer: null,
      cableRoutes: [],
      cameraTween: null,
      requestRender: (ms = RENDER_ACTIVE_MS) => {
        renderUntil = Math.max(renderUntil, performance.now() + ms);
      },
    };
    sceneRef.current = state;
    controls.addEventListener('change', () => state.requestRender());

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      setCableLayerResolutions(state);
      state.requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const pressedKeys = new Set<NavDirection>();
    let keyboardFast = false;
    // walk (FPS) mode: pointer lock aims the camera directly; the crosshair at the canvas
    // center takes over hover picking. Assigned below once the hover helpers exist.
    const fps = { active: false, lastPickTime: 0 };
    let updateCenterHover = () => {};
    let frame = 0;
    let lastFrameTime = performance.now();
    const render = (time = performance.now()) => {
      frame = window.requestAnimationFrame(render);
      const deltaSeconds = Math.min(0.06, Math.max(0, (time - lastFrameTime) / 1000));
      lastFrameTime = time;
      if (pressedKeys.size > 0) state.requestRender();
      if (time > renderUntil) return;
      stepCameraTween(state, time);
      applyKeyboardNavigation(state, pressedKeys, deltaSeconds, keyboardFast);
      if (fps.active && time - fps.lastPickTime > 120) {
        fps.lastPickTime = time;
        updateCenterHover();
      }
      updateCableScaleForDistance(state);
      controls.update();
      renderer.render(scene, camera);
    };
    render();

    let lastHover: string | null = null;
    let lastPick: HoverPick | null = null;
    let glowingRack: RackHitbox | null = null;
    const setRackGlow = (label: string | null) => {
      const mesh = label
        ? state.rackHitboxes.find((hitbox) => hitbox.userData.rackLabel === label) ?? null
        : null;
      if (glowingRack === mesh) return;
      if (glowingRack) glowingRack.material.opacity = 0;
      glowingRack = mesh;
      if (glowingRack) glowingRack.material.opacity = 0.14;
      state.requestRender();
    };
    const clearHover = () => {
      lastHover = null;
      lastPick = null;
      setRackGlow(null);
      trace.hover(null);
      setHover(null);
    };
    const pointerDown = { x: 0, y: 0 };
    const mouseLook = { down: false, active: false, lastX: 0, lastY: 0, pointerId: -1 };
    const panDrag = { active: false, lastX: 0, lastY: 0, pointerId: -1 };
    const onPointerDown = (event: PointerEvent) => {
      renderer.domElement.focus({ preventScroll: true });
      state.cameraTween = null;
      state.requestRender();
      pointerDown.x = event.clientX;
      pointerDown.y = event.clientY;
      if (fps.active) return; // no drag gestures while walking; clicks land via onClick
      if (event.button === 0) {
        mouseLook.down = true;
        mouseLook.active = false;
        mouseLook.lastX = event.clientX;
        mouseLook.lastY = event.clientY;
        mouseLook.pointerId = event.pointerId;
        renderer.domElement.setPointerCapture(event.pointerId);
      } else if (event.button === 2) {
        panDrag.active = true;
        panDrag.lastX = event.clientX;
        panDrag.lastY = event.clientY;
        panDrag.pointerId = event.pointerId;
        renderer.domElement.setPointerCapture(event.pointerId);
        renderer.domElement.style.cursor = 'grabbing';
        clearHover();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isKeyboardInputTarget(event.target)) return;
      if (event.key === 'Escape') {
        // first Esc leaves walk mode (the browser usually consumes it, but not always);
        // Esc outside walk mode clears the selection
        if (fps.active) {
          document.exitPointerLock();
          return;
        }
        trace.clear();
        callbacksRef.current.onClearSelection();
        callbacksRef.current.onOpenNode(null);
        return;
      }
      if (event.code === 'KeyV') {
        event.preventDefault();
        if (fps.active) document.exitPointerLock();
        else renderer.domElement.requestPointerLock();
        return;
      }
      if (event.code === 'KeyF') {
        // fly to whatever is hovered: a device's front panel or a whole rack
        const pick = lastPick;
        const pose = pick?.target.type === 'device'
          ? deviceFocusPose(state, pick.target.nodeName)
          : pick?.target.type === 'rack'
            ? rackFocusPose(state, pick.target.rack)
            : null;
        if (pose) {
          event.preventDefault();
          flyTo(state, pose);
        }
        return;
      }
      const key = navigationKey(event);
      if (!key) return;
      event.preventDefault();
      state.cameraTween = null;
      pressedKeys.add(key);
      keyboardFast = event.shiftKey;
      state.requestRender();
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
    // What's under the cursor, most specific first: a cable in front of everything, then a
    // front-panel port, then the device. Every pick carries its trace key so hover and click
    // light the same thing in both the rack and topology views.
    const resolveHoverAt = (clientX: number, clientY: number): HoverPick | null => {
      if (!updatePointerRay(state, clientX, clientY)) return null;
      const deviceHit = pickDevice(state);
      const cable = pickCable(state, deviceHit ? deviceHit.distance + 0.02 : Number.POSITIVE_INFINITY);
      // a cable wins over a device only when clearly in front of it, so the short stub
      // leaving a port never steals hover from the port itself
      if (cable && (!deviceHit || cable.rayDistance < deviceHit.distance - 0.06)) {
        const traceId = linkIndexRef.current.traceIdByLinkId.get(cable.linkId) ?? cable.linkId;
        return {
          key: `cable:${cable.linkId}`,
          traceKey: `cable:${traceId}`,
          target: { type: 'cable', linkId: cable.linkId },
        };
      }
      if (deviceHit) {
        const mesh = deviceHit.object as DeviceMesh;
        const nodeName = mesh.userData.nodeName;
        const anchor = state.anchors.get(nodeName);
        const port = anchor ? pickDevicePort(anchor, deviceHit.point) : null;
        if (port) {
          return {
            key: `port:${nodeName}:${port.cage}:${port.channel ?? ''}`,
            traceKey: portTraceKey(linkIndexRef.current, nodeName, port) ?? `node:${nodeName}`,
            target: { type: 'device', nodeName, port },
          };
        }
        return { key: `node:${nodeName}`, traceKey: `node:${nodeName}`, target: { type: 'device', nodeName } };
      }
      const rackHit = state.raycaster.intersectObjects(state.rackHitboxes, false)[0];
      if (rackHit) {
        const rackLabel = (rackHit.object as RackHitbox).userData.rackLabel;
        return { key: `rack:${rackLabel}`, traceKey: null, target: { type: 'rack', rack: rackLabel } };
      }
      return null;
    };
    // shared by pointer hover and the walk-mode crosshair: light the pick and place the card
    const applyHover = (pick: HoverPick | null, x: number, y: number) => {
      setRackGlow(pick?.target.type === 'rack' ? pick.target.rack : null);
      if ((pick?.key ?? null) === lastHover) {
        if (pick) setHover({ target: pick.target, x, y });
        return;
      }
      lastHover = pick?.key ?? null;
      lastPick = pick;
      if (pick) {
        trace.hover(pick.traceKey);
        setHover({ target: pick.target, x, y });
      } else {
        trace.hover(null);
        setHover(null);
      }
    };
    const canvasCenter = (): { x: number; y: number } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    updateCenterHover = () => {
      const center = canvasCenter();
      if (!center) return;
      applyHover(resolveHoverAt(center.x, center.y), center.x, center.y);
    };
    // click position is frozen while pointer-locked, so walk mode picks at the crosshair
    const resolveClickPick = (event: MouseEvent): HoverPick | null => {
      if (!fps.active) return resolveHoverAt(event.clientX, event.clientY);
      const center = canvasCenter();
      return center ? resolveHoverAt(center.x, center.y) : null;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (fps.active) {
        // pointer lock: raw mouse deltas aim the camera, the crosshair does the picking
        applyMouseLook(state, event.movementX, event.movementY);
        state.requestRender();
        updateCenterHover();
        return;
      }
      if (panDrag.active && event.pointerId === panDrag.pointerId && (event.buttons & 2) === 2) {
        const deltaX = event.clientX - panDrag.lastX;
        const deltaY = event.clientY - panDrag.lastY;
        panDrag.lastX = event.clientX;
        panDrag.lastY = event.clientY;
        event.preventDefault();
        // grab metaphor: the scene follows the pointer
        panView(state, -deltaX, deltaY);
        state.requestRender();
        return;
      }
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
          clearHover();
          applyMouseLook(state, deltaX, deltaY);
          state.requestRender();
          return;
        }
      }
      const pick = resolveHoverAt(event.clientX, event.clientY);
      renderer.domElement.style.cursor = pick ? 'pointer' : 'grab';
      applyHover(pick, event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === panDrag.pointerId) {
        panDrag.active = false;
        panDrag.pointerId = -1;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
        renderer.domElement.style.cursor = 'grab';
      }
      if (event.pointerId !== mouseLook.pointerId) return;
      mouseLook.down = false;
      mouseLook.active = false;
      mouseLook.pointerId = -1;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      renderer.domElement.style.cursor = 'grab';
    };
    const onPointerLeave = () => {
      if (mouseLook.active || panDrag.active) return;
      renderer.domElement.style.cursor = 'grab';
      clearHover();
    };
    const onClick = (event: MouseEvent) => {
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
      if (moved > POINTER_CLICK_TOLERANCE) return;
      const pick = resolveClickPick(event);
      if (pick?.target.type === 'cable') {
        trace.pin(pick.traceKey ?? `cable:${pick.target.linkId}`);
        return;
      }
      if (pick?.target.type === 'rack') {
        const pose = rackFocusPose(state, pick.target.rack);
        if (pose) flyTo(state, pose);
        return;
      }
      if (pick?.target.type === 'device') {
        // a port click pins just that cable; a chassis click pins the whole node's cables
        // and flies to a straight-on view of the front panel
        trace.pin(pick.traceKey ?? `node:${pick.target.nodeName}`);
        callbacksRef.current.onOpenNode(pick.target.nodeName, { select: true });
        if (!pick.target.port) {
          const pose = deviceFocusPose(state, pick.target.nodeName);
          if (pose) flyTo(state, pose);
        }
        return;
      }
      trace.clear();
      callbacksRef.current.onClearSelection();
      callbacksRef.current.onOpenNode(null);
    };
    const onDoubleClick = (event: MouseEvent) => {
      const pick = resolveClickPick(event);
      if (pick?.target.type !== 'device') return;
      trace.pin(`node:${pick.target.nodeName}`, true);
      callbacksRef.current.onOpenNode(pick.target.nodeName, { expand: true, select: true });
    };

    const onWheel = (event: WheelEvent) => {
      state.cameraTween = null;
      if (fps.active) {
        // scroll walks forward/back along the view direction, speed scaled like WASD
        const notches = event.deltaMode === 1 ? event.deltaY / 3 : event.deltaY / 100;
        const distance = state.camera.position.distanceTo(state.controls.target);
        const speed = Math.max(KEYBOARD_MOVE_SPEED_MIN, Math.min(KEYBOARD_MOVE_SPEED_MAX, distance * 0.45));
        const move = state.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(-notches * speed * 0.22);
        state.camera.position.add(move);
        state.controls.target.add(move);
      }
      state.requestRender();
    };
    const onPointerLockChange = () => {
      fps.active = document.pointerLockElement === renderer.domElement;
      setFpsMode(fps.active);
      controls.enableZoom = !fps.active; // walk mode owns the wheel
      state.cameraTween = null;
      clearHover();
      renderer.domElement.style.cursor = fps.active ? 'none' : 'grab';
      state.requestRender();
      if (fps.active) {
        // the toggle button may still hold focus; keyboard nav needs the canvas
        renderer.domElement.focus({ preventScroll: true });
        updateCenterHover();
      }
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('dblclick', onDoubleClick);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearPressedKeys);

    return () => {
      if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      renderer.domElement.removeEventListener('wheel', onWheel);
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

  // Selection/trace styling is kept in a ref so a finished (async) scene build can re-apply
  // the current highlight state to the freshly created meshes.
  const applyStylesRef = useRef<() => void>(() => {});
  useEffect(() => {
    applyStylesRef.current = () => {
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
      state.requestRender();
    };
    applyStylesRef.current();
  }, [selectedSet, traceAny, tracedNodes, highlightedCableIds, cableHighlightAny, mode]);

  const framedRacksRef = useRef<RackGroup[] | null>(null);
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    let cancelled = false;
    // reframe the camera only when the rack layout itself changed; a theme flip keeps the view
    const frame = framedRacksRef.current !== racks;
    void buildScene(state, topo, racks, shown, mode, labelsVisibleRef.current, frame, () => cancelled).then(() => {
      if (cancelled) return;
      framedRacksRef.current = racks;
      applyStylesRef.current();
    });
    return () => { cancelled = true; };
  }, [topo, racks, shown, mode]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    for (const label of state.labels) label.visible = labelsVisible;
    state.requestRender();
  }, [labelsVisible]);

  const nudgeLook = useCallback((deltaX: number, deltaY: number) => {
    const state = sceneRef.current;
    if (!state) return;
    state.cameraTween = null;
    applyMouseLook(state, deltaX, deltaY);
    state.controls.update();
    state.requestRender();
  }, []);

  const nudgePan = useCallback((rightPx: number, upPx: number) => {
    const state = sceneRef.current;
    if (!state) return;
    state.cameraTween = null;
    panView(state, rightPx, upPx);
    state.controls.update();
    state.requestRender();
  }, []);

  const nudgeZoom = useCallback((factor: number) => {
    const state = sceneRef.current;
    if (!state) return;
    state.cameraTween = null;
    zoomView(state, factor);
    state.controls.update();
    state.requestRender();
  }, []);

  const toggleFps = useCallback(() => {
    const state = sceneRef.current;
    if (!state) return;
    if (document.pointerLockElement === state.renderer.domElement) document.exitPointerLock();
    else state.renderer.domElement.requestPointerLock();
  }, []);

  const focusNode = useCallback((nodeName: string) => {
    const state = sceneRef.current;
    if (!state) return;
    const pose = deviceFocusPose(state, nodeName);
    if (pose) flyTo(state, pose);
  }, []);

  const viewFrontElevation = useCallback(() => {
    const state = sceneRef.current;
    if (!state) return;
    const pose = hallFrontPose(state);
    if (pose) flyTo(state, pose);
  }, []);

  const resetCamera = useCallback(() => {
    const state = sceneRef.current;
    if (!state) return;
    const overview = frameOverview(state);
    if (overview) flyTo(state, overview.pose);
  }, []);

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
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          {totalRackLabels > 0 ? `${totalRackLabels} rack labels in namespace` : 'No rack labels in namespace'}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
          Drag to look · right-drag to pan · wheel zooms to cursor
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
          Click a rack or device to face it · F on hover · V walk mode
        </Typography>
      </Box>

      <Box sx={{ position: 'absolute', top: 12, right: 12, zIndex: 1, display: 'flex', gap: 0.5,
        bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2, p: 0.5 }}>
        <Tooltip title={fpsMode ? 'Exit walk mode (V or Esc)' : 'Walk mode — free mouse look (V)'}>
          <IconButton size="small" onClick={toggleFps}
            sx={{ color: fpsMode ? 'primary.main' : 'text.primary' }}>
            <DirectionsWalkIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Front elevation — face the rack rows">
          <IconButton size="small" onClick={viewFrontElevation} sx={{ color: 'text.primary' }}>
            <ViewColumnIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Frame all racks">
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
        <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.disabled', fontSize: 10, lineHeight: 1.6 }}>
          Look · zoom
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: '30px 30px 30px 30px', gridTemplateRows: '30px 30px',
          gap: 0.5, alignItems: 'center', justifyContent: 'center' }}>
          <GizmoButton title="Tilt up" ariaLabel="Tilt rack view up"
            onNudge={() => nudgeLook(0, -GIZMO_TILT_STEP)}
            onHold={(dt) => nudgeLook(0, -GIZMO_TILT_HOLD_SPEED * dt)}
            sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 1 }}>
            <KeyboardArrowUpIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Zoom in" ariaLabel="Zoom rack view in"
            onNudge={() => nudgeZoom(GIZMO_ZOOM_STEP)}
            onHold={(dt) => nudgeZoom(Math.pow(GIZMO_ZOOM_HOLD_RATE, dt))}
            sx={{ ...gizmoButtonSx, gridColumn: 4, gridRow: 1 }}>
            <AddIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Rotate left" ariaLabel="Rotate rack view left"
            onNudge={() => nudgeLook(-GIZMO_ROTATE_STEP, 0)}
            onHold={(dt) => nudgeLook(-GIZMO_ROTATE_HOLD_SPEED * dt, 0)}
            sx={{ ...gizmoButtonSx, gridColumn: 1, gridRow: 2 }}>
            <RotateLeftIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Tilt down" ariaLabel="Tilt rack view down"
            onNudge={() => nudgeLook(0, GIZMO_TILT_STEP)}
            onHold={(dt) => nudgeLook(0, GIZMO_TILT_HOLD_SPEED * dt)}
            sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 2 }}>
            <KeyboardArrowDownIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Rotate right" ariaLabel="Rotate rack view right"
            onNudge={() => nudgeLook(GIZMO_ROTATE_STEP, 0)}
            onHold={(dt) => nudgeLook(GIZMO_ROTATE_HOLD_SPEED * dt, 0)}
            sx={{ ...gizmoButtonSx, gridColumn: 3, gridRow: 2 }}>
            <RotateRightIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Zoom out" ariaLabel="Zoom rack view out"
            onNudge={() => nudgeZoom(1 / GIZMO_ZOOM_STEP)}
            onHold={(dt) => nudgeZoom(Math.pow(1 / GIZMO_ZOOM_HOLD_RATE, dt))}
            sx={{ ...gizmoButtonSx, gridColumn: 4, gridRow: 2 }}>
            <RemoveIcon fontSize="small" />
          </GizmoButton>
        </Box>
        <Box sx={{ height: 1, bgcolor: 'divider', opacity: 0.72, my: 0.75 }} />
        <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.disabled', fontSize: 10, lineHeight: 1.6 }}>
          Move
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: '30px 30px 30px', gridTemplateRows: '30px 30px',
          gap: 0.5, justifyContent: 'center' }}>
          <GizmoButton title="Pan up" ariaLabel="Pan rack view up"
            onNudge={() => nudgePan(0, GIZMO_PAN_STEP)}
            onHold={(dt) => nudgePan(0, GIZMO_PAN_HOLD_SPEED * dt)}
            sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 1 }}>
            <KeyboardArrowUpIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Pan left" ariaLabel="Pan rack view left"
            onNudge={() => nudgePan(-GIZMO_PAN_STEP, 0)}
            onHold={(dt) => nudgePan(-GIZMO_PAN_HOLD_SPEED * dt, 0)}
            sx={{ ...gizmoButtonSx, gridColumn: 1, gridRow: 2 }}>
            <KeyboardArrowLeftIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Pan down" ariaLabel="Pan rack view down"
            onNudge={() => nudgePan(0, -GIZMO_PAN_STEP)}
            onHold={(dt) => nudgePan(0, -GIZMO_PAN_HOLD_SPEED * dt)}
            sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 2 }}>
            <KeyboardArrowDownIcon fontSize="small" />
          </GizmoButton>
          <GizmoButton title="Pan right" ariaLabel="Pan rack view right"
            onNudge={() => nudgePan(GIZMO_PAN_STEP, 0)}
            onHold={(dt) => nudgePan(GIZMO_PAN_HOLD_SPEED * dt, 0)}
            sx={{ ...gizmoButtonSx, gridColumn: 3, gridRow: 2 }}>
            <KeyboardArrowRightIcon fontSize="small" />
          </GizmoButton>
        </Box>
        <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.disabled', fontSize: 9, mt: 0.5 }}>
          Hold a button to glide
        </Typography>
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

      {fpsMode && (
        <>
          <Box aria-hidden sx={{ position: 'absolute', left: '50%', top: '50%',
            transform: 'translate(-50%, -50%)', zIndex: 1, pointerEvents: 'none',
            width: 18, height: 18, filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.55))',
            '&::before': { content: '""', position: 'absolute', left: '50%', top: 0, bottom: 0,
              width: '2px', ml: '-1px', bgcolor: 'common.white', opacity: 0.85 },
            '&::after': { content: '""', position: 'absolute', top: '50%', left: 0, right: 0,
              height: '2px', mt: '-1px', bgcolor: 'common.white', opacity: 0.85 },
          }} />
          <Box sx={{ position: 'absolute', bottom: { xs: 68, sm: 12 }, left: '50%', zIndex: 1,
            transform: 'translateX(-50%)', px: 1.25, py: 0.5,
            bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Walk mode · aim to inspect · click to pin · scroll walks · WASD/QE move · Esc exits
            </Typography>
          </Box>
        </>
      )}

      {racks.length === 0 && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Box sx={{ px: 2, py: 1.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>No devices match the current rack filter.</Typography>
          </Box>
        </Box>
      )}

      {pinnedCable && (
        <Box sx={{ position: 'absolute', bottom: { xs: 68, sm: 48 }, left: '50%', zIndex: 1,
          transform: 'translateX(-50%)', px: 1.5, py: 0.75, maxWidth: '72%',
          bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 3,
          display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ width: 8, height: 8, flex: 'none', bgcolor: OCCUPANCY_KIND_COLORS[pinnedCable.kind] }} />
          <Tooltip title={`Fly to ${pinnedCable.link.source}`} disableInteractive>
            <Link component="button" type="button" variant="caption" underline="hover" noWrap
              onClick={() => focusNode(pinnedCable.link.source)}
              sx={{ fontWeight: 600, color: 'text.primary', minWidth: 0 }}>
              {pinnedCable.link.source} {shortPortLabel(pinnedCable.link.sourcePort)}
              {placementSuffix(placements.get(pinnedCable.link.source))}
            </Link>
          </Tooltip>
          <Typography variant="caption" sx={{ flex: 'none', color: 'text.secondary' }}>⟷</Typography>
          <Tooltip title={`Fly to ${pinnedCable.link.target}`} disableInteractive>
            <Link component="button" type="button" variant="caption" underline="hover" noWrap
              onClick={() => focusNode(pinnedCable.link.target)}
              sx={{ fontWeight: 600, color: 'text.primary', minWidth: 0 }}>
              {pinnedCable.link.target} {shortPortLabel(pinnedCable.link.targetPort)}
              {placementSuffix(placements.get(pinnedCable.link.target))}
            </Link>
          </Tooltip>
          {pinnedCable.bundleSize > 1 && (
            <Typography variant="caption" sx={{ flex: 'none', color: 'text.secondary' }}>×{pinnedCable.bundleSize} bundle</Typography>
          )}
          <Typography variant="caption" sx={{ color: 'text.disabled', flex: 'none' }}>Esc to clear</Typography>
        </Box>
      )}

      {hover && (
        <HoverCard hover={hover} nodeByName={nodeByName} placements={placements} rackByLabel={rackByLabel} linkIndex={linkIndex} lags={topo.lags} />
      )}
    </Box>
  );
}

export default memo(RackView);
