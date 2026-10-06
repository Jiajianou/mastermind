import { z } from "zod";
import type { ResolvedConfig } from "../config/index.js";
import type { Task } from "../contracts/index.js";
import type { OneShotRunner } from "../sessions/one-shot.js";
import { attributionOff } from "../sessions/settings.js";
import { flakyJudgePrompt } from "./prompts.js";
import type { FailedCheck } from "./prompts.js";

export const flakyVerdictSchema = z.strictObject({ flaky: z.boolean(), reason: z.string() });
export type FlakyVerdict = z.infer<typeof flakyVerdictSchema>;

export interface FlakyJudge {
  judge(task: Task, cwd: string, failed: FailedCheck): Promise<FlakyVerdict | null>;
}

export function createFlakyJudge(options: {
  oneShot: OneShotRunner;
  config: () => ResolvedConfig;
}): FlakyJudge {
  return {
    async judge(task, cwd, failed) {
      const result = await options.oneShot.run({
        role: "judge",
        taskId: task.id,
        round: task.round,
        cwd,
        prompt: flakyJudgePrompt(task, failed),
        schema: flakyVerdictSchema,
        print: {
          model: options.config().models.judge,
          maxTurns: 1,
          tools: [],
          settings: { attribution: attributionOff },
        },
      });
      return result.kind === "answered" ? result.value : null;
    },
  };
}
