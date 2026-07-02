import type { CableKind } from '../graph';
import { type Mode } from '../theme';

export const RACK_WIDTH = 1.45;
export const RACK_HEIGHT = 6;
export const RACK_DEPTH = 1.05;
export const UNIT_HEIGHT = RACK_HEIGHT / 42;
export const DEVICE_DEPTH = RACK_DEPTH * 0.5;
export const DEVICE_WIDTH = RACK_WIDTH - 0.18;
export const POINTER_CLICK_TOLERANCE = 5;
export const RACK_SPACING = 2.05;
export const ROW_SPACING = 2.75;
export const ROW_SIDE_OFFSET = 0.82;
export const CABLE_FRONT_CLEARANCE = 0.34;
export const CABLE_TRAY_HEIGHT = RACK_HEIGHT + 0.34;
export const KEYBOARD_MOVE_SPEED_MIN = 2.4;
export const KEYBOARD_MOVE_SPEED_MAX = 48;
export const KEYBOARD_FAST_MULTIPLIER = 2.4;
export const FPS_MOUSE_SENSITIVITY = 0.0023;
export const FPS_PITCH_MIN = 0.12;
export const FPS_PITCH_MAX = Math.PI - 0.14;
// gizmo buttons: a tap applies one step, holding glides continuously at the hold speed
export const GIZMO_ROTATE_STEP = 72;
export const GIZMO_TILT_STEP = 48;
export const GIZMO_ROTATE_HOLD_SPEED = 620;
export const GIZMO_TILT_HOLD_SPEED = 400;
export const GIZMO_PAN_STEP = 120;
export const GIZMO_PAN_HOLD_SPEED = 660;
export const GIZMO_ZOOM_STEP = 0.82;
export const GIZMO_ZOOM_HOLD_RATE = 0.4; // distance factor per second while held
export const GIZMO_HOLD_DELAY_MS = 240;
export const FLY_DURATION_MS = 750;
export const CABLE_LINEWIDTH_IDLE = 1.2;
export const CABLE_LINEWIDTH_CLOSE = 3.25;
export const CABLE_LINEWIDTH_TRACE = 2.8;
export const CABLE_LINEWIDTH_TRACE_CLOSE = 5.5;
// hover hit-testing: pick radius grows with camera distance; above the route limit the
// per-segment sweep is skipped entirely (matches the 2D canvas's large-topology cutoff)
export const CABLE_PICK_ROUTE_LIMIT = 5000;
export const CABLE_PICK_MIN_THRESHOLD = 0.035;
export const CABLE_PICK_MAX_THRESHOLD = 0.17;
// demand rendering: how long one interaction keeps frames flowing before the loop idles
export const RENDER_ACTIVE_MS = 400;
export const OCCUPIED_PORT_COLOR = '#37CC73';
export const OCCUPIED_PORT_OPACITY = 0.44;
export const OCCUPIED_PORT_Z = -DEVICE_DEPTH / 2 - 0.014;
export const CABLE_ENTRY_Z = OCCUPIED_PORT_Z - 0.006;
export const OCCUPANCY_KIND_ORDER = ['isl', 'edge', 'lag', 'mlag'] as const satisfies readonly CableKind[];
export const OCCUPANCY_KIND_COLORS: Record<CableKind, string> = {
  isl: OCCUPIED_PORT_COLOR,
  edge: '#23ABB6',
  lag: '#F7B737',
  mlag: '#9765FE',
};
export const OCCUPANCY_KIND_LABELS: Record<CableKind, string> = {
  isl: 'Fabric',
  edge: 'Edge',
  lag: 'Local LAG',
  mlag: 'Multihome LAG',
};

export function scenePalette(mode: Mode) {
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

export function roleColor(role: string, mode: Mode): string {
  const value = role.toLowerCase();
  const dark = mode === 'dark';
  if (value.includes('super')) return dark ? '#E03DCD' : '#A50885';
  if (value.includes('spine')) return dark ? '#9765FE' : '#5A0DD5';
  if (value.includes('border')) return dark ? '#FFA663' : '#AF3903';
  if (value.includes('leaf')) return dark ? '#37CC73' : '#00822B';
  if (value.includes('access')) return dark ? '#50C4D0' : '#027490';
  return dark ? '#8EC2FF' : '#005AFF';
}

export function chassisColor(mode: Mode): string {
  return mode === 'dark' ? '#202B38' : '#CED7E1';
}
