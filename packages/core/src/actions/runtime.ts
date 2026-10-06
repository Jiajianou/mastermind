import { configLayerSchema, confirmSetupInputSchema, noInputSchema } from "../contracts/index.js";
import type { RuntimeFlags, SetupMeta } from "../contracts/index.js";
import { defineAction } from "./registry.js";
import type { ActionScope } from "./registry.js";

export type SchedulerScope = Pick<ActionScope<"scheduler.updated">, "db" | "emit">;

function emitScheduler(scope: SchedulerScope, flags: RuntimeFlags): RuntimeFlags {
  scope.emit({ type: "scheduler.updated", paused: flags.paused, resumeAt: flags.backoffResumeAt });
  return flags;
}

const setSchedulerFlags = (scope: SchedulerScope, change: Partial<RuntimeFlags>): RuntimeFlags =>
  emitScheduler(scope, scope.db.flags.set(change));

export function setBackoff(scope: SchedulerScope, resumeAt: Date | null): RuntimeFlags {
  return setSchedulerFlags(scope, { backoffResumeAt: resumeAt?.toISOString() ?? null });
}

export type SignInScope = Pick<ActionScope<"scheduler.updated" | "auth.updated">, "db" | "emit">;

// An expired sign-in pauses work, and a good check resumes it (PLAN 4.3).
export function setSignInRequired(scope: SignInScope, required: boolean): RuntimeFlags {
  const flags = scope.db.flags.set({ authRequired: required, paused: required });
  scope.emit({ type: "auth.updated", authRequired: flags.authRequired });
  return emitScheduler(scope, flags);
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

const commandText = (command: string): string => (command === "" ? "none" : command);

export const confirmSetup = defineAction({
  name: "confirmSetup",
  description:
    "Confirm the project's build and test commands on first run. They are saved to .mastermind/config.yaml and the confirmation is posted to the chat.",
  input: confirmSetupInputSchema,
  emits: ["config.updated", "chat.message"],
  handler: async ({ build, test }, scope) => {
    const config = await scope.config.set({ commands: { build, test } });
    scope.emit({ type: "config.updated", config });
    const message = scope.db.chat.append({
      kind: "system",
      content: `Build and test commands confirmed: build ${commandText(build)}, test ${commandText(test)}`,
      meta: { setup: "confirmed" } satisfies SetupMeta,
    });
    scope.emit({ type: "chat.message", message });
    return config;
  },
});
