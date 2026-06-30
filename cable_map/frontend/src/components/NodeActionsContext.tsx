import { createContext, useContext } from 'react';

export type OpenNodeOptions = {
  expand?: boolean;
  pan?: boolean;
  pin?: boolean;
  select?: boolean;
};

export type OpenNodeHandler = (id: string | null, options?: OpenNodeOptions) => void;

const noopOpenNode: OpenNodeHandler = () => {};

const NodeActionsContext = createContext<OpenNodeHandler>(noopOpenNode);

export const NodeActionsProvider = NodeActionsContext.Provider;

export function useOpenNode(): OpenNodeHandler {
  return useContext(NodeActionsContext);
}
