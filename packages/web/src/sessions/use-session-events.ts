import type { SessionEvent } from "@mastermind/core/contracts";
import { useEffect, useState } from "react";
import { useApi, useDispatch, useLive } from "../store/hooks.js";

const noEvents: readonly SessionEvent[] = [];

export interface SessionTimeline {
  events: readonly SessionEvent[];
  failure: string | null;
}

// Live events reach the store from the stream; the history before this page connected is read once per session
// and again after a reconnect, which resets the store's record of loaded histories. A read that began before a
// disconnect is dropped, since it may miss events from the gap.
export function useSessionEvents(sessionId: number): SessionTimeline {
  const api = useApi();
  const dispatch = useDispatch();
  const events = useLive((state) => state.sessionEvents[sessionId]) ?? noEvents;
  const loaded = useLive((state) => state.historyLoaded[sessionId] === true);
  const live = useLive((state) => state.connection === "live");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!live || loaded) return;
    let current = true;
    api.sessionEvents(sessionId).then(
      (history) => {
        if (current) dispatch({ type: "session.history.loaded", sessionId, events: history });
      },
      (error: unknown) => {
        if (current) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [api, dispatch, sessionId, live, loaded]);

  return { events, failure: loaded ? null : failure };
}
