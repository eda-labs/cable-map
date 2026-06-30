// Tiny external store for the LLDP overlay toggle. When on, edges and ports recolour by
// their LLDP status (green = neighbour confirms the cabling, red = mismatch, grey = no
// neighbour seen) instead of by cable kind.
import { createExternalStore } from './createExternalStore';

const store = createExternalStore(false);

export const lldp = {
  toggle() { store.setSnapshot(!store.getSnapshot()); },
  get: store.getSnapshot,
};

export function useLldp(): boolean {
  return store.useStoreSnapshot(false);
}
