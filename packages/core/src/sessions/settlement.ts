import type { ExitOutcome, SessionStatus, Task, TaskStatus } from "../contracts/index.js";
import type { SessionReport } from "./spawner.js";

export type SettlementEffect =
  | { kind: "none" }
  | { kind: "succeeded" }
  | { kind: "usage-limit"; resetAt: Date | null }
  | { kind: "auth-required" }
  | { kind: "backoff" };

export interface WorkerSettlement {
  sessionStatus: Exclude<SessionStatus, "running">;
  task: Pick<Task, "attempts" | "resumeSession" | "held"> & { status: TaskStatus };
  failure: string | null;
  effect: SettlementEffect;
}

export interface SettlementInput {
  report: Pick<SessionReport, "end" | "conversationStarted">;
  task: Pick<Task, "attempts" | "held">;
  claudeSessionId: string | null;
  maxAttempts: number;
}

export function outcomeEffect(outcome: ExitOutcome): SettlementEffect {
  switch (outcome.status) {
    case "succeeded":
      return { kind: "succeeded" };
    case "rate_limited":
      return {
        kind: "usage-limit",
        resetAt: outcome.resetAt === undefined ? null : new Date(outcome.resetAt),
      };
    case "auth_failed":
      return { kind: "auth-required" };
    case "failed":
      return { kind: "backoff" };
  }
}

export function settleWorkerRun({
  report,
  task,
  claudeSessionId,
  maxAttempts,
}: SettlementInput): WorkerSettlement {
  const { attempts, held } = task;
  const resumable = report.conversationStarted ? claudeSessionId : null;
  const requeue = (resumeSession: string | null) => ({
    status: "pending" as const,
    attempts,
    resumeSession,
    held,
  });
  const countAttempt = () => ({
    status: attempts + 1 >= maxAttempts ? ("blocked" as const) : ("pending" as const),
    attempts: attempts + 1,
    resumeSession: null,
    held,
  });

  const { end } = report;
  if (end.kind === "stopped") {
    return {
      sessionStatus: "stopped",
      task: { ...requeue(resumable), held: true },
      failure: null,
      effect: { kind: "none" },
    };
  }
  if (end.kind === "aborted" || end.kind === "stuck") {
    return {
      sessionStatus: "failed",
      task: countAttempt(),
      failure: end.kind === "stuck" ? `stuck: ${end.reason}` : end.reason,
      effect: { kind: "none" },
    };
  }
  const { outcome } = end;
  const effect = outcomeEffect(outcome);
  switch (outcome.status) {
    case "succeeded":
      return {
        sessionStatus: "succeeded",
        task: { status: "checking", attempts, resumeSession: null, held },
        failure: null,
        effect,
      };
    case "rate_limited":
      return {
        sessionStatus: "rate_limited",
        task: requeue(resumable),
        failure: null,
        effect,
      };
    case "auth_failed":
      return {
        sessionStatus: "auth_failed",
        task: requeue(resumable),
        failure: null,
        effect,
      };
    case "failed":
      return {
        sessionStatus: "failed",
        task: countAttempt(),
        failure: outcome.reason,
        effect,
      };
  }
}
