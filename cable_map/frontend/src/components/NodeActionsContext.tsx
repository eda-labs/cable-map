import { createContext, useContext } from 'react';

export type OpenNodeHandler = (id: string | null, expand?: boolean) => void;

const noopOpenNode: OpenNodeHandler = () => {};

const NodeActionsContext = createContext<OpenNodeHandler>(noopOpenNode);

export const NodeActionsProvider = NodeActionsContext.Provider;

export function useOpenNode(): OpenNodeHandler {
  return useContext(NodeActionsContext);
}
