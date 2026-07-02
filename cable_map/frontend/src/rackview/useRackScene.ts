import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LinkIndex } from '../domain/topology/linkIndex';
import { trace } from '../trace';
import { type OpenNodeHandler } from '../components/NodeActionsContext';
import {
  FPS_PITCH_MAX, FPS_PITCH_MIN, KEYBOARD_MOVE_SPEED_MAX, KEYBOARD_MOVE_SPEED_MIN,
  POINTER_CLICK_TOLERANCE, RENDER_ACTIVE_MS,
} from './constants';
import {
  applyKeyboardNavigation, applyMouseLook, deviceFocusPose, flyTo, panView, rackFocusPose, stepCameraTween,
} from './camera';
import { setCableLayerResolutions, updateCableScaleForDistance } from './cables';
import { pickCable, pickDevice, pickDevicePort, portTraceKey, updatePointerRay } from './picking';
import { disposeObject } from './sceneObjects';
import type { DeviceMesh, HoverPick, HoverState, NavDirection, RackHitbox, RackSceneState } from './types';

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

type RackSceneOptions = {
  hostRef: RefObject<HTMLDivElement | null>;
  callbacksRef: RefObject<{ onOpenNode: OpenNodeHandler; onClearSelection: () => void }>;
  // the pointer handlers live in the mount effect; they read the current index through this ref
  linkIndexRef: RefObject<LinkIndex>;
  onHover: (hover: HoverState | null) => void;
  onFpsModeChange: (active: boolean) => void;
};

// Owns the whole three.js session for the rack view: renderer/camera/controls setup, the
// demand-rendered rAF loop, and every pointer/keyboard/pointer-lock interaction. Mounts once;
// scene content is (re)built into the returned state by buildScene.
export function useRackScene({ hostRef, callbacksRef, linkIndexRef, onHover, onFpsModeChange }: RackSceneOptions): RefObject<RackSceneState | null> {
  const sceneRef = useRef<RackSceneState | null>(null);

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
      onHover(null);
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
        if (pick) onHover({ target: pick.target, x, y });
        return;
      }
      lastHover = pick?.key ?? null;
      lastPick = pick;
      if (pick) {
        trace.hover(pick.traceKey);
        onHover({ target: pick.target, x, y });
      } else {
        trace.hover(null);
        onHover(null);
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
      onFpsModeChange(fps.active);
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
    // mount-once three.js session; refs are stable and onHover/onFpsModeChange are setState setters
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return sceneRef;
}
