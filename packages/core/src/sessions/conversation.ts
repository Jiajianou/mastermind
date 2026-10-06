import type { Db } from "../db/index.js";
import { createStreamParser } from "./parser.js";

function conversationStarted(db: Pick<Db, "events">, sessionId: number): boolean {
  const parser = createStreamParser();
  return db.events.listForSession(sessionId).some(({ payload }) => {
    const { line } = parser.parseLine(payload).details;
    return line === "assistant" || line === "tool_use";
  });
}

// `--resume` is only offered once the conversation got going: a run that ended before its first assistant line may
// have no stored conversation, and resuming it would fail with "No conversation found".
export function canResumeConversation(
  db: Pick<Db, "events" | "sessions">,
  taskId: string,
  claudeSessionId: string,
): boolean {
  return db.sessions
    .listForTask(taskId)
    .some((run) => run.claudeSessionId === claudeSessionId && conversationStarted(db, run.id));
}
