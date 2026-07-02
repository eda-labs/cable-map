import * as THREE from 'three';
import { type Mode } from '../theme';
import { scenePalette } from './constants';

function disposeMaterial(material: THREE.Material) {
  const mapped = material as THREE.Material & { map?: THREE.Texture | null };
  if (!mapped.map?.userData.sharedFrontPanel) mapped.map?.dispose();
  material.dispose();
}

export function disposeObject(object: THREE.Object3D) {
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

export function makeLabelSprite(text: string, mode: Mode): THREE.Sprite {
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
