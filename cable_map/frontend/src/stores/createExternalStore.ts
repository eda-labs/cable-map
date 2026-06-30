import { useSyncExternalStore } from 'react';

export function createExternalStore<T>(initial: T) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const emit = () => { for (const listener of listeners) listener(); };
  const getSnapshot = () => snapshot;
  const setSnapshot = (next: T) => {
    snapshot = next;
    emit();
  };

  return {
    getSnapshot,
    setSnapshot,
    emit,
    subscribe,
    useStoreSnapshot(serverSnapshot = initial): T {
      return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
    },
    useStoreSelector<S>(selector: (value: T) => S, serverSnapshot: S): S {
      return useSyncExternalStore(subscribe, () => selector(snapshot), () => serverSnapshot);
    },
  };
}
