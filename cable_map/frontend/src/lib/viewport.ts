import { type Node as RFNode, type Viewport } from '@xyflow/react';

export const LARGE_DEFAULT_VIEWPORT: Viewport = { x: 24, y: 24, zoom: 0.35 };
export const LARGE_MIN_ZOOM = 0.02;
export const LARGE_MAX_ZOOM = 2;
export const LARGE_VIEWPORT_PAD = 900;
export const LARGE_WEBGL_NODE_ZOOM = 0.2;

export type FlowBounds = { x: number; y: number; width: number; height: number };
export type FitNodesOptions = { padding: number; duration: number; maxZoom?: number };

export function nodeIntersectsViewport(node: RFNode, viewport: Viewport, width: number, height: number): boolean {
  const nodeWidth = node.width ?? node.measured?.width ?? 160;
  const nodeHeight = node.height ?? node.measured?.height ?? 80;
  const left = node.position.x * viewport.zoom + viewport.x;
  const top = node.position.y * viewport.zoom + viewport.y;
  const right = (node.position.x + nodeWidth) * viewport.zoom + viewport.x;
  const bottom = (node.position.y + nodeHeight) * viewport.zoom + viewport.y;
  return right >= -LARGE_VIEWPORT_PAD &&
    left <= width + LARGE_VIEWPORT_PAD &&
    bottom >= -LARGE_VIEWPORT_PAD &&
    top <= height + LARGE_VIEWPORT_PAD;
}

function nodeBounds(node: RFNode): FlowBounds {
  const width = node.measured?.width ?? node.width ?? node.initialWidth ?? 160;
  const height = node.measured?.height ?? node.height ?? node.initialHeight ?? 80;
  return { x: node.position.x, y: node.position.y, width, height };
}

export function nodesBounds(nodes: RFNode[]): FlowBounds | null {
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const bounds = nodeBounds(node);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}
