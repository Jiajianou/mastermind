import type { Config, Task } from "../contracts/index.js";
import { touchesOverlap } from "../contracts/index.js";

export type FailureDecision =
  { kind: "fix"; attempts: number } | { kind: "block"; attempts: number };

export interface FailureState {
  attempts: number;
  maxAttempts: number;
  countsAttempt: boolean;
}

export function decideAfterFailure({
  attempts,
  maxAttempts,
  countsAttempt,
}: FailureState): FailureDecision {
  if (!countsAttempt) return { kind: "fix", attempts };
  const counted = attempts + 1;
  return counted >= maxAttempts
    ? { kind: "block", attempts: counted }
    : { kind: "fix", attempts: counted };
}

export function statusAfterPassing(
  task: Pick<Task, "touches">,
  changedFiles: readonly string[],
  config: Pick<Config, "autoRebase" | "requireReviewFor">,
): "review" | "rebasing" {
  if (!config.autoRebase) return "review";
  const { requireReviewFor } = config;
  const protectedChange =
    touchesOverlap(task.touches, requireReviewFor) ||
    changedFiles.some((file) => touchesOverlap([file], requireReviewFor));
  return protectedChange ? "review" : "rebasing";
}
