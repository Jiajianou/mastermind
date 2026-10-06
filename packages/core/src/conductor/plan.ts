import type { z } from "zod";
import { assertValidBatch } from "../actions/index.js";
import { postChatMessage } from "../chat.js";
import type { ChatSink } from "../chat.js";
import type { ChatMessage, PlanMeta, proposePlanInputSchema } from "../contracts/index.js";

export type PlanInput = z.output<typeof proposePlanInputSchema>;

export function proposePlan(sink: ChatSink, { tasks }: PlanInput): ChatMessage {
  const planned = tasks.map(({ id, title, goal, acceptance, touches, deps, priority }) => ({
    id,
    title,
    goal,
    acceptance,
    touches,
    deps,
    priority,
  }));
  assertValidBatch(sink.db, planned);
  const lines = tasks.map(
    ({ id, title, note }, index) => `${String(index + 1)}. ${id}: ${note ?? title}`,
  );
  const meta: PlanMeta = { tasks: planned };
  return postChatMessage(sink, { kind: "plan", content: lines.join("\n"), meta });
}
