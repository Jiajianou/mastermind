import { reduce } from "./reducer.js";
import { initialState } from "./state.js";
import type { LiveState, StoreAction } from "./state.js";

export interface Store {
  getState: () => LiveState;
  dispatch: (action: StoreAction) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore(state: LiveState = initialState): Store {
  let current = state;
  const listeners = new Set<() => void>();
  return {
    getState: () => current,
    dispatch(action) {
      const next = reduce(current, action);
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
