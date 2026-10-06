import {
  planMetaSchema,
  planStartedMetaSchema,
  plural,
  startPlanInputSchema,
} from "../contracts/index.js";
import type { ChatMessage, PlanMeta, PlanStartedMeta, Task } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import { ActionError } from "./errors.js";
import { defineAction } from "./registry.js";
import { createTaskRows } from "./tasks.js";

interface Plan {
  id: number;
  tasks: PlanMeta["tasks"];
}

const asPlan = (message: ChatMessage): Plan | null => {
  if (message.kind !== "plan") return null;
  const meta = planMetaSchema.safeParse(message.meta);
  return meta.success ? { id: message.id, tasks: meta.data.tasks } : null;
};

function latestPlan(db: Db): Plan | null {
  return db.chat.list().reduce<Plan | null>((latest, message) => asPlan(message) ?? latest, null);
}

function requirePlan(db: Db, planId: number | undefined): Plan {
  if (planId === undefined) {
    const latest = latestPlan(db);
    if (latest === null) throw ActionError.fromMessage("not_found", "no plan has been proposed");
    return latest;
  }
  const message = db.chat.get(planId);
  const plan = message === null ? null : asPlan(message);
  if (plan === null) throw ActionError.fromMessage("not_found", `no plan ${String(planId)}`);
  return plan;
}

function assertStartable(db: Db, plan: Plan): void {
  for (const later of db.chat.list(plan.id)) {
    if (asPlan(later) !== null)
      throw ActionError.fromMessage(
        "conflict",
        `plan ${String(plan.id)} was replaced by a newer plan (${String(later.id)})`,
      );
    const started = planStartedMetaSchema.safeParse(later.meta);
    if (later.kind === "system" && started.success && started.data.planId === plan.id)
      throw ActionError.fromMessage("conflict", `plan ${String(plan.id)} was already started`);
  }
}

export const startPlan = defineAction({
  name: "startPlan",
  description:
    "Create every task of a proposed plan in one batch, exactly as it was shown. planId is the plan's chat message id and defaults to the latest plan. Only the latest plan can be started, and only once; the batch is checked against the current tasks and rejected as a whole on an id that now exists, an unknown dependency or a cycle.",
  input: startPlanInputSchema,
  emits: ["task.updated", "chat.message"],
  handler: ({ planId }, { db, emit }): Task[] => {
    const { created, message } = db.transaction(() => {
      const plan = requirePlan(db, planId);
      assertStartable(db, plan);
      const tasks = createTaskRows(db, plan.tasks);
      const ids = tasks.map((task) => task.id).join(", ");
      const posted = db.chat.append({
        kind: "system",
        content: `Plan started: added ${plural(tasks.length, "task")} (${ids}).`,
        meta: { plan: "started", planId: plan.id } satisfies PlanStartedMeta,
      });
      return { created: tasks, message: posted };
    });
    for (const task of created) emit({ type: "task.updated", taskId: task.id, task });
    emit({ type: "chat.message", message });
    return created;
  },
});
