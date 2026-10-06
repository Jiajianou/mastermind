import { ActionError, defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { messageSessionInputSchema, sessionRefInputSchema } from "../contracts/index.js";
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

export function messageSessionAction(manager: Pick<SessionManager, "messageSession">) {
  return defineAction({
    name: "messageSession",
    description:
      "Send a message to a worker or fixer session. A live session takes it in at its next tool call; a session that has ended is resumed in the same workspace with the message, as a new session that counts no attempt. Returns how it was delivered and the session that received it.",
    input: messageSessionInputSchema,
    emits: [],
    handler: ({ sessionId, text }) => manager.messageSession(sessionId, text),
  }) satisfies ContractedActions<"messageSession">["messageSession"];
}
