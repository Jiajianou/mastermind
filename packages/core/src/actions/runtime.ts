import { configLayerSchema } from "../contracts/index.js";
import type { RuntimeFlags } from "../contracts/index.js";
import { defineAction, noInputSchema } from "./registry.js";
import type { ActionScope } from "./registry.js";

export type SchedulerScope = Pick<ActionScope<"scheduler.updated">, "db" | "emit">;

function setSchedulerFlags(scope: SchedulerScope, change: Partial<RuntimeFlags>): RuntimeFlags {
  const flags = scope.db.flags.set(change);
  scope.emit({ type: "scheduler.updated", paused: flags.paused, resumeAt: flags.backoffResumeAt });
  return flags;
}

export function setBackoff(scope: SchedulerScope, resumeAt: Date | null): RuntimeFlags {
  return setSchedulerFlags(scope, { backoffResumeAt: resumeAt?.toISOString() ?? null });
}

export const pause = defineAction({
  name: "pause",
  description: "Pause the scheduler: no new sessions start. Running sessions continue.",
  input: noInputSchema,
  emits: ["scheduler.updated"],
  handler: (_input, scope) => setSchedulerFlags(scope, { paused: true }),
});

export const resume = defineAction({
  name: "resume",
  description: "Resume the scheduler after a pause.",
  input: noInputSchema,
  emits: ["scheduler.updated"],
  handler: (_input, scope) => setSchedulerFlags(scope, { paused: false }),
});

export const setConfig = defineAction({
  name: "setConfig",
  description:
    "Change project settings in .mastermind/config.yaml. Only the keys given change; nested objects such as models merge key by key.",
  input: configLayerSchema,
  emits: ["config.updated"],
  handler: async (change, scope) => {
    const config = await scope.config.set(change);
    scope.emit({ type: "config.updated", config });
    return config;
  },
});
