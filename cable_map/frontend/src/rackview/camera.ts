import * as THREE from 'three';
import {
  DEVICE_DEPTH, DEVICE_WIDTH, FLY_DURATION_MS, FPS_MOUSE_SENSITIVITY, FPS_PITCH_MAX, FPS_PITCH_MIN,
  KEYBOARD_FAST_MULTIPLIER, KEYBOARD_MOVE_SPEED_MAX, KEYBOARD_MOVE_SPEED_MIN,
  RACK_DEPTH, RACK_HEIGHT, RACK_SPACING, RACK_WIDTH,
} from './constants';
import type { CameraPose, NavDirection, RackSceneState } from './types';

export function frameOverview(state: RackSceneState): { pose: CameraPose; maxDim: number } | null {
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

export function frameCamera(state: RackSceneState) {
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
export function flyTo(state: RackSceneState, pose: CameraPose, duration = FLY_DURATION_MS) {
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

export function stepCameraTween(state: RackSceneState, time: number) {
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
export function deviceFocusPose(state: RackSceneState, nodeName: string): CameraPose | null {
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

export function rackFocusPose(state: RackSceneState, rackLabel: string): CameraPose | null {
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
export function hallFrontPose(state: RackSceneState): CameraPose | null {
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

export function applyMouseLook(state: RackSceneState, deltaX: number, deltaY: number) {
  const offset = state.controls.target.clone().sub(state.camera.position);
  const distance = Math.max(1, offset.length());
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= deltaX * FPS_MOUSE_SENSITIVITY;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi + deltaY * FPS_MOUSE_SENSITIVITY, FPS_PITCH_MIN, FPS_PITCH_MAX);
  offset.setFromSpherical(spherical).setLength(distance);
  state.controls.target.copy(state.camera.position).add(offset);
}

export function applyKeyboardNavigation(state: RackSceneState, pressedKeys: Set<NavDirection>, deltaSeconds: number, fast: boolean) {
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
export function panView(state: RackSceneState, rightPx: number, upPx: number) {
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

export function zoomView(state: RackSceneState, factor: number) {
  const offset = state.camera.position.clone().sub(state.controls.target);
  const distance = offset.length();
  if (distance < 0.001) return;
  const nextDistance = THREE.MathUtils.clamp(distance * factor, state.controls.minDistance, state.controls.maxDistance);
  state.camera.position.copy(state.controls.target).addScaledVector(offset.normalize(), nextDistance);
}
