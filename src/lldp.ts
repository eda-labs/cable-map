// Tiny external store for the LLDP overlay toggle. When on, edges and ports recolour by
// their LLDP status (green = neighbour confirms the cabling, red = mismatch, grey = no
// neighbour seen) instead of by cable kind. Kept as a standalone store — like trace.ts — so
// every edge/port can read it via useSyncExternalStore without prop-drilling or re-renders.
import { useSyncExternalStore } from 'react';

let on = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export const lldp = {
  toggle() { on = !on; emit(); },
  get: () => on,
};

export function useLldp(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => on,
    () => false,
  );
}
