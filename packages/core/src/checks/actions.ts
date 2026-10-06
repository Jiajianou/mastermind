import { defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { taskRefInputSchema } from "../contracts/index.js";
import type { CheckPipeline } from "./pipeline.js";

export function rerunChecksAction(pipeline: Pick<CheckPipeline, "rerun">) {
  return defineAction({
    name: "rerunChecks",
    description:
      "Run a task's checks again: build, acceptance, rebase onto main, the full suite and the reviewer. Allowed for a task in review (it returns to checking) or one whose checks are waiting. Returns the task.",
    input: taskRefInputSchema,
    emits: [],
    handler: ({ taskId }) => pipeline.rerun(taskId),
  }) satisfies ContractedActions<"rerunChecks">["rerunChecks"];
}
