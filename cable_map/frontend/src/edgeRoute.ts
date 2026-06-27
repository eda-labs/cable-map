// Tiny external store for the cable-routing toggle. When on, cables route through a shared horizontal
// "bus" at the vertical midpoint between the two node rows — each cable stems vertically out of its
// port and runs along midY — instead of a direct point-to-point bezier. This declutters dense fabrics
// (hundreds of crossing diagonals collapse into a tidy corridor). Standalone store like trace/lldp so
// every edge reads it via useSyncExternalStore without prop-drilling or rebuilding the edge list.
import { useSyncExternalStore } from 'react';

let on = true;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export const edgeRoute = {
  toggle() { on = !on; emit(); },
  get: () => on,
};

export function useGroupedEdges(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => on,
    () => true,
  );
}
