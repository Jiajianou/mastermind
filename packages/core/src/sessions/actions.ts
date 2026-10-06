import { ActionError, defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { sessionRefInputSchema } from "../contracts/index.js";
import type { SessionManager } from "./manager.js";

export function stopSessionAction(manager: Pick<SessionManager, "stopSession">) {
  return defineAction({
    name: "stopSession",
    description:
      "Stop a running session: SIGTERM, then SIGKILL after 10 seconds. Its task is held with the session kept for resuming; release the task to continue. Returns the stopped session.",
    input: sessionRefInputSchema,
    emits: [],
    handler: async ({ sessionId }, { db }) => {
      await manager.stopSession(sessionId);
      const session = db.sessions.get(sessionId);
      if (session === null)
        throw ActionError.fromMessage("not_found", `no session ${String(sessionId)}`);
      return session;
    },
  }) satisfies ContractedActions<"stopSession">["stopSession"];
}
