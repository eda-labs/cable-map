import * as THREE from 'three';
import type { Topology } from '../domain/topology/contract';
import type { RackGroup } from '../domain/topology/racks';
import { componentsOf, stencilFor } from '../stencil';
import { type Mode } from '../theme';
import {
  DEVICE_DEPTH, DEVICE_WIDTH, RACK_DEPTH, UNIT_HEIGHT, chassisColor, roleColor,
} from './constants';
import {
  frontPanelGeometry, loadFrontPanelTexture, panelHeightForStencil, type FrontPanelMeasuredLayout,
} from './frontPanel';
import { addOccupancyOverlay } from './occupancy';
import type { DeviceMesh } from './types';

export function addDevice(
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

export function setDeviceOpacity(mesh: DeviceMesh, opacity: number) {
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
