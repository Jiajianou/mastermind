import type { Session } from "@mastermind/core/contracts";
import { useMemo } from "react";
import { sessionTranscript, workingSince } from "./transcript.js";
import type { TranscriptEntry } from "./transcript.js";
import { useSessionEvents } from "./use-session-events.js";
import { useLive } from "../store/hooks.js";
import type { LiveActivity } from "../store/state.js";

export interface SessionTranscriptView {
  entries: TranscriptEntry[];
  workingSince: string | null;
  live: LiveActivity | null;
  failure: string | null;
}

export function useSessionTranscript(
  session: Pick<Session, "id" | "status" | "startedAt">,
): SessionTranscriptView {
  const { events, failure } = useSessionEvents(session.id);
  const running = session.status === "running";
  const entries = useMemo(() => sessionTranscript(events, running), [events, running]);
  const live = useLive((state) => state.sessionLive[session.id]) ?? null;
  return {
    entries,
    workingSince: workingSince(events, running, session.startedAt),
    live: running ? live : null,
    failure,
  };
}
