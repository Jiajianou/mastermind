import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Session, Task } from "@mastermind/core/contracts";
import type { ApiClient } from "../api/client.js";
import type { LiveState } from "./state.js";
import type { Store } from "./store.js";

interface Live {
  store: Store;
  api: ApiClient;
}

const LiveContext = createContext<Live | null>(null);

export function LiveProvider({ store, api, children }: Live & { children: ReactNode }) {
  const live = useMemo(() => ({ store, api }), [store, api]);
  return <LiveContext value={live}>{children}</LiveContext>;
}

function useLiveContext(): Live {
  const live = useContext(LiveContext);
  if (live === null) throw new Error("useLive needs a LiveProvider");
  return live;
}

// The reducers keep every untouched entity's reference, so a selector that returns stored values re-renders its
// component only when that value changes. Selectors must not build new objects.
export function useLive<Selected>(select: (state: LiveState) => Selected): Selected {
  const { store } = useLiveContext();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}

export function useTask(taskId: string): Task | undefined {
  return useLive((state) => state.tasks[taskId]);
}

export function useSession(sessionId: number): Session | undefined {
  return useLive((state) => state.sessions[sessionId]);
}

export function useApi(): ApiClient {
  return useLiveContext().api;
}

export function useDispatch(): Store["dispatch"] {
  return useLiveContext().store.dispatch;
}
