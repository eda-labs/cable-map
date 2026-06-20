// Floating-edge geometry, ported from eda-labs/topo-builder (src/lib/edgeUtils.ts).
// Edges attach to the border of the side each node faces, computed from node
// centers — no fixed handles.
import { Position, type InternalNode } from '@xyflow/react';

const W = 80, H = 80;   // DEFAULT_NODE_WIDTH/HEIGHT

function dims(node: InternalNode) {
  return { w: node.measured?.width ?? W, h: node.measured?.height ?? H };
}
function center(node: InternalNode) {
  const { w, h } = dims(node);
  const p = node.internals.positionAbsolute;
  return { x: p.x + w / 2, y: p.y + h / 2 };
}

// which side of `node` faces `other`
export function facingSide(node: InternalNode, other: InternalNode): Position {
  const a = center(node), b = center(other);
  if (Math.abs(a.x - b.x) > Math.abs(a.y - b.y)) {
    return a.x > b.x ? Position.Left : Position.Right;
  }
  return a.y > b.y ? Position.Top : Position.Bottom;
}

function borderPoint(node: InternalNode, pos: Position) {
  const { w, h } = dims(node);
  const p = node.internals.positionAbsolute;
  switch (pos) {
    case Position.Left: return { x: p.x, y: p.y + h / 2 };
    case Position.Right: return { x: p.x + w, y: p.y + h / 2 };
    case Position.Top: return { x: p.x + w / 2, y: p.y };
    default: return { x: p.x + w / 2, y: p.y + h };
  }
}

export function getFloatingEdgeParams(source: InternalNode, target: InternalNode) {
  const sourcePos = facingSide(source, target);
  const targetPos = facingSide(target, source);
  const s = borderPoint(source, sourcePos);
  const t = borderPoint(target, targetPos);
  return { sx: s.x, sy: s.y, tx: t.x, ty: t.y, sourcePos, targetPos };
}
