import { z } from "zod";
import { defineAction } from "../actions/index.js";
import type { SessionManager } from "./manager.js";

export function stopSessionAction(manager: Pick<SessionManager, "stopSession">) {
  return defineAction({
    name: "stopSession",
    description:
      "Stop a running session: SIGTERM, then SIGKILL after 10 seconds. Its task is held with the session kept for resuming; release the task to continue.",
    input: z.strictObject({ sessionId: z.int().min(1) }),
    emits: [],
    handler: ({ sessionId }) => manager.stopSession(sessionId),
  });
}
