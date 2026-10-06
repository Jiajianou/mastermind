import { existsSync } from "node:fs";
import { assertTransition } from "../actions/index.js";
import type { Clock } from "../clock.js";
import { isEditingRole } from "../contracts/index.js";
import type { Check, Task } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import { claudeCallsAllowed } from "../sessions/effects.js";
import type { SessionManager } from "../sessions/manager.js";
import { readLogTail } from "./log.js";
import { decideAfterFailure } from "./outcome.js";
import { checkFailurePrompt, checkName, conflictPrompt } from "./prompts.js";
import type { FailedCheck } from "./prompts.js";

export type FixableStatus = "checking" | "rebasing";

export interface FixRequest {
  prompt: string;
  reason: string;
  countsAttempt: boolean;
  conflict: boolean;
}

export type FixResult = "started" | "blocked" | "waiting" | "gone";

export interface FixerLauncherOptions {
  db: Db;
  bus: EventBus;
  clock: Clock;
  maxAttempts: () => number;
  fixers: Pick<SessionManager, "startFixer">;
  onError: (error: unknown) => void;
}

export interface FixerLauncher {
  claudeAllowed(): boolean;
  followsConflictFixer(taskId: string): boolean;
  fix(taskId: string, from: FixableStatus, request: FixRequest): Promise<FixResult>;
  block(taskId: string, from: FixableStatus, attempts: number, reason: string): void;
}

const tailLimits = { maxBytes: 64 * 1024, maxLines: 80 };

export async function readFailedCheck(check: Check): Promise<FailedCheck> {
  if (check.logPath === null || !existsSync(check.logPath)) return { check, logTail: "" };
  return { check, logTail: (await readLogTail(check.logPath, tailLimits)).text };
}

export function checkFailureRequest(task: Task, failed: FailedCheck): FixRequest {
  const { check } = failed;
  return {
    prompt: checkFailurePrompt(task, failed),
    reason: `the ${checkName(check)} check failed: ${check.summary ?? "no details"}`,
    countsAttempt: true,
    conflict: false,
  };
}

export interface ConflictDetails {
  check: Check;
  upstream: string;
  mainBranch: string;
  fixerGaveUp: boolean;
}

export async function conflictRequest(task: Task, conflict: ConflictDetails): Promise<FixRequest> {
  const { check, upstream, mainBranch, fixerGaveUp } = conflict;
  const { logTail } = await readFailedCheck(check);
  return {
    prompt: conflictPrompt(task, { upstream, mainBranch, logTail }),
    reason: fixerGaveUp
      ? `the fixer could not resolve the rebase conflict: ${check.summary ?? ""}`
      : (check.summary ?? "rebase conflict"),
    countsAttempt: fixerGaveUp,
    conflict: true,
  };
}

export function createFixerLauncher(options: FixerLauncherOptions): FixerLauncher {
  const { db, bus, onError } = options;
  const conflictFixers = new Map<string, number>();

  const claudeAllowed = (): boolean => claudeCallsAllowed(db, options.clock.now());

  function inStatus(taskId: string, status: FixableStatus): Task | null {
    const task = db.tasks.get(taskId);
    return task?.status === status ? task : null;
  }

  function block(taskId: string, from: FixableStatus, attempts: number, reason: string): void {
    const blocked = db.transaction(() => {
      const task = inStatus(taskId, from);
      if (task === null) return null;
      assertTransition(taskId, task.status, "blocked");
      const session = db.sessions.listForTask(taskId).findLast(isEditingRole);
      const tries = `${String(attempts)} attempt${attempts === 1 ? "" : "s"}`;
      const event =
        session === undefined
          ? null
          : db.events.append({
              sessionId: session.id,
              type: "error",
              summary: `Blocked after ${tries}: ${reason}`,
              payload: JSON.stringify({ type: "blocked", attempts, reason }),
            });
      return { event, task: db.tasks.update(taskId, { status: "blocked", attempts }) };
    });
    if (blocked === null) return;
    if (blocked.event !== null)
      bus.emit({
        type: "session.event",
        sessionId: blocked.event.sessionId,
        taskId,
        event: blocked.event,
      });
    bus.emit({ type: "task.updated", taskId, task: blocked.task });
  }

  return {
    claudeAllowed,

    // A conflict right after a conflict fixer means that fixer gave up, which counts an attempt.
    followsConflictFixer(taskId) {
      const fixerId = conflictFixers.get(taskId);
      conflictFixers.delete(taskId);
      return (
        fixerId !== undefined &&
        db.sessions.listForTask(taskId).findLast(isEditingRole)?.id === fixerId
      );
    },

    async fix(taskId, from, request) {
      const task = inStatus(taskId, from);
      if (task === null) return "gone";
      const decision = decideAfterFailure({
        attempts: task.attempts,
        maxAttempts: options.maxAttempts(),
        countsAttempt: request.countsAttempt,
      });
      if (decision.kind === "block") {
        block(taskId, from, decision.attempts, request.reason);
        return "blocked";
      }
      if (!claudeAllowed()) return "waiting";
      try {
        const fixer = await options.fixers.startFixer({
          taskId,
          prompt: request.prompt,
          attempts: decision.attempts,
        });
        if (request.conflict) conflictFixers.set(taskId, fixer.id);
        return "started";
      } catch (error) {
        onError(error);
        return "waiting";
      }
    },

    block,
  };
}
