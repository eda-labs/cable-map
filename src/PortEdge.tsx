import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import { getFloatingEdgeParams } from './edgeUtils';

// Floating edge (topo-builder style): attaches to the border of each node's facing
// side. Shows the LOCAL port label near each node end (e.g. "1-1, 1-2").
type Data = { sourcePorts: string; targetPorts: string };
type PortEdgeType = Edge<Data, 'portEdge'>;

function labelStyle(x: number, y: number): React.CSSProperties {
  return {
    position: 'absolute',
    transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
    fontSize: 10, lineHeight: 1.3, background: '#101824', color: '#C9CED6',
    padding: '0 4px', borderRadius: 3, pointerEvents: 'none', whiteSpace: 'nowrap',
  };
}

export default function PortEdge({ source, target, data }: EdgeProps<PortEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty, sourcePos, targetPos } = getFloatingEdgeParams(sourceNode, targetNode);
  const [path] = getBezierPath({
    sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourcePosition: sourcePos, targetPosition: targetPos,
  });
  const lerp = (t: number) => ({ x: sx + (tx - sx) * t, y: sy + (ty - sy) * t });
  const s = lerp(0.16), tp = lerp(0.84);

  return (
    <>
      <BaseEdge path={path} interactionWidth={10} style={{ stroke: 'var(--color-link-stroke)', strokeWidth: 1 }} />
      <EdgeLabelRenderer>
        <div style={labelStyle(s.x, s.y)}>{data?.sourcePorts}</div>
        <div style={labelStyle(tp.x, tp.y)}>{data?.targetPorts}</div>
      </EdgeLabelRenderer>
    </>
  );
}
