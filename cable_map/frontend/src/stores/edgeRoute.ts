// Tiny external store for the cable-routing toggle. When on, cables route through a shared horizontal
// bus at the vertical midpoint between the two node rows.
import { createExternalStore } from './createExternalStore';

const store = createExternalStore(true);

export const edgeRoute = {
  toggle() { store.setSnapshot(!store.getSnapshot()); },
  get: store.getSnapshot,
};

export function useGroupedEdges(): boolean {
  return store.useStoreSnapshot(true);
}
