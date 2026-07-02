import * as THREE from 'three';
import { appPath } from '../api/base';
import type { FrontPanelPortPos } from '../domain/ports/frontPanelMeta';
import { frontPanelMetaOf } from '../domain/ports/frontPanelMeta';
import type { RackGroup } from '../domain/topology/racks';
import { componentsOf, stencilFor } from '../stencil';
import { DEVICE_WIDTH } from './constants';

export type FrontPanelTexture = {
  texture: THREE.Texture;
  aspect: number;
};

type FrontPanelTextureEntry =
  | { state: 'pending'; promise: Promise<FrontPanelTexture | null> }
  | { state: 'ready'; panel: FrontPanelTexture }
  | { state: 'missing' };

export type FrontPanelMeasuredLayout = {
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

export function panelHeightForStencil(stencil: string, fallbackHeight: number, measured?: FrontPanelMeasuredLayout | null): number {
  if (measured?.aspect) return Math.max(0.06, DEVICE_WIDTH / measured.aspect);
  const meta = frontPanelMetaOf(stencil);
  return meta ? Math.max(0.06, DEVICE_WIDTH / meta.aspect) : fallbackHeight;
}

function frontPanelUrl(stencil: string): string {
  return appPath(`frontpanel/${encodeURIComponent(stencil)}.svg`);
}

function textureAspect(texture: THREE.Texture): number {
  const image = texture.image as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number } | undefined;
  const width = image?.naturalWidth || image?.width || 0;
  const height = image?.naturalHeight || image?.height || 0;
  return width > 0 && height > 0 ? width / height : 0;
}

export function loadFrontPanelTexture(stencil: string): Promise<FrontPanelTexture | null> {
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

export async function loadFrontPanelMeasuredLayouts(racks: RackGroup[]): Promise<Map<string, FrontPanelMeasuredLayout | null>> {
  const stencils = new Set<string>();
  for (const rack of racks) {
    for (const device of rack.devices) {
      stencils.add(stencilFor(device.node.platform, componentsOf(device.node.raw)));
    }
  }
  const entries = await Promise.all([...stencils].map(async (stencil) => [stencil, await loadFrontPanelMeasuredLayout(stencil)] as const));
  return new Map(entries);
}

export function frontPanelGeometry(width: number, height: number): THREE.BufferGeometry {
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
