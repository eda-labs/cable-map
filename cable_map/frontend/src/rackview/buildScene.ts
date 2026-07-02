import * as THREE from 'three';
import type { Topology } from '../domain/topology/contract';
import { layoutOf, slottedOf } from '../domain/ports/frontPanelMeta';
import type { RackGroup } from '../domain/topology/racks';
import { componentsOf, stencilFor } from '../stencil';
import { type Mode } from '../theme';
import { RACK_DEPTH, RACK_HEIGHT, RACK_WIDTH, scenePalette } from './constants';
import { addCableLayer } from './cables';
import { frameCamera } from './camera';
import { addDevice } from './devices';
import { loadFrontPanelMeasuredLayouts, panelHeightForStencil } from './frontPanel';
import { addRackFurniture, collectRackFrame, createFurnitureCollector } from './furniture';
import { layoutRackRows } from './layout';
import { disposeObject, makeLabelSprite } from './sceneObjects';
import type { RackHitbox, RackSceneState } from './types';

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

export async function buildScene(
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
