import type { Breakout } from '../domain/topology/contract';
import { breakoutChannel, cageKey, portIdx } from '../domain/ports/interfaceNames';
import { DEVICE_WIDTH } from './constants';
import type { DeviceAnchor } from './types';

export function stringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function portOrdinal(port: string): number {
  const index = portIdx(port);
  if (index != null) return index;
  const numbers = port.match(/\d+/g);
  if (!numbers?.length) return (stringHash(port) % 64) + 1;
  const last = Number(numbers[numbers.length - 1]);
  if (!Number.isFinite(last) || last <= 0) return (stringHash(port) % 64) + 1;
  return last;
}

export function fallbackPortOffset(port: string): { x: number; y: number } {
  const ordinal = portOrdinal(port);
  const columns = 32;
  const column = (ordinal - 1) % columns;
  const row = Math.floor((ordinal - 1) / columns) % 2;
  const ratio = columns > 1 ? column / (columns - 1) : 0.5;
  return {
    x: (ratio - 0.5) * DEVICE_WIDTH * 0.82,
    y: row === 0 ? 0.024 : -0.024,
  };
}

function breakoutOffset(breakout: Breakout | undefined, channel: number | null, width: number, height: number): { x: number; y: number } {
  if (!breakout || !channel) return { x: 0, y: 0 };
  const channels = Math.max(1, breakout.channels);
  const safeChannel = Math.max(1, Math.min(channels, channel));
  const rows = channels > 4 ? 2 : 1;
  const columns = Math.ceil(channels / rows);
  const column = (safeChannel - 1) % columns;
  const row = Math.floor((safeChannel - 1) / columns);
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  return {
    x: -width / 2 + column * cellWidth + cellWidth / 2,
    y: -height / 2 + row * cellHeight + cellHeight / 2,
  };
}

export function panelLocalOffset(normalizedX: number, normalizedY: number, panelHeight: number): { x: number; y: number } {
  return {
    x: (0.5 - normalizedX) * DEVICE_WIDTH,
    y: (0.5 - normalizedY) * panelHeight,
  };
}

export function portOffset(anchor: DeviceAnchor, port: string): { x: number; y: number } {
  const cage = cageKey(port, anchor.slotted);
  const panelPort = cage ? anchor.layout?.get(cage) : undefined;
  if (!panelPort) return fallbackPortOffset(port);

  const channel = breakoutChannel(port);
  const offset = breakoutOffset(cage ? anchor.breakouts?.[cage] : undefined, channel, panelPort.w, panelPort.h);
  const normalizedX = panelPort.x + offset.x;
  const normalizedY = panelPort.y + offset.y;
  return panelLocalOffset(normalizedX, normalizedY, anchor.panelHeight);
}
