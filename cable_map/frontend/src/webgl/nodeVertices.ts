import type { Node as RFNode } from '@xyflow/react';
import {
  switchPortCenter,
  type CableKind, type EndpointData, type PortInfo, type SwitchData,
} from '../graph';
import type { NodePalette, RgbaColor } from './color';

export const NODE_VERTEX_STRIDE = 6;

const ENDPOINT_W = 112;
const ENDPOINT_H = 22;

function pushVertex(vertices: number[], x: number, y: number, color: RgbaColor, alpha = 1) {
  vertices.push(x, y, color[0], color[1], color[2], color[3] * alpha);
}

function pushRect(vertices: number[], x: number, y: number, width: number, height: number, color: RgbaColor, alpha = 1) {
  if (width <= 0 || height <= 0) return;
  pushVertex(vertices, x, y, color, alpha);
  pushVertex(vertices, x, y + height, color, alpha);
  pushVertex(vertices, x + width, y, color, alpha);
  pushVertex(vertices, x, y + height, color, alpha);
  pushVertex(vertices, x + width, y + height, color, alpha);
  pushVertex(vertices, x + width, y, color, alpha);
}

function pushBorder(vertices: number[], x: number, y: number, width: number, height: number, color: RgbaColor) {
  const s = 1.5;
  pushRect(vertices, x, y, width, s, color, 0.8);
  pushRect(vertices, x, y + height - s, width, s, color, 0.8);
  pushRect(vertices, x, y, s, height, color, 0.8);
  pushRect(vertices, x + width - s, y, s, height, color, 0.8);
}

function colorForPort(info: PortInfo, palette: NodePalette, lldp: boolean): RgbaColor {
  if (lldp && (info.lldp === 'ok' || info.lldp === 'mismatch' || info.lldp === 'none')) return palette[info.lldp];
  if (info.kind !== 'free') return palette[info.kind as CableKind];
  return palette.free;
}

function colorForEndpoint(data: EndpointData, palette: NodePalette, lldp: boolean): RgbaColor {
  if (lldp && (data.lldp === 'ok' || data.lldp === 'mismatch' || data.lldp === 'none')) return palette[data.lldp];
  return palette[data.kind];
}

export function buildNodeVertices(nodes: RFNode[], palette: NodePalette, lldp: boolean): Float32Array {
  const vertices: number[] = [];

  for (const node of nodes) {
    const width = node.width ?? node.measured?.width ?? (node.type === 'endpoint' ? ENDPOINT_W : 180);
    const height = node.height ?? node.measured?.height ?? (node.type === 'endpoint' ? ENDPOINT_H : 80);
    const x = node.position.x;
    const y = node.position.y;

    if (node.type === 'endpoint') {
      const data = node.data as EndpointData;
      const color = colorForEndpoint(data, palette, lldp);
      pushRect(vertices, x, y, width, height, palette.line, 0.22);
      pushRect(vertices, x, y, width, 4, color, 1);
      pushBorder(vertices, x, y, width, height, color);
      continue;
    }

    const data = node.data as SwitchData;
    pushRect(vertices, x, y, width, height, palette.line, 0.2);
    pushRect(vertices, x + 1, y + 1, width - 2, Math.min(18, height * 0.28), palette.free, 0.65);
    pushBorder(vertices, x, y, width, height, palette.line);

    for (const port of data.ports) {
      const center = switchPortCenter(data, port.port, port.channel);
      if (!center) continue;
      const color = colorForPort(port, palette, lldp);
      const portW = port.channel ? 3.5 : 5.5;
      const portH = 4.5;
      pushRect(vertices, x + center.x - portW / 2, y + center.y - portH / 2, portW, portH, color, 1);
    }
  }

  return new Float32Array(vertices);
}
