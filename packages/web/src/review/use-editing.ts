import type { SessionEvent } from "@mastermind/core/contracts";
import { useMemo } from "react";
import { lastEditedPath } from "../sessions/activity.js";
import { useLive } from "../store/hooks.js";

// The stream names the edited file exactly; after a reload only the stored events are left to read it from.
export function useLatestEdit(sessionId: number, events: readonly SessionEvent[]): string | null {
  const streamed = useLive((state) => state.editing[sessionId]);
  const stored = useMemo(() => lastEditedPath(events), [events]);
  return streamed ?? stored;
}
