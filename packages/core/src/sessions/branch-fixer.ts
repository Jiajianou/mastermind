import type { ResolvedConfig } from "../config/index.js";
import type { Session, SessionStatus } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import { editingPrintOptions } from "./editing-print.js";
import type { EditingPrintContext } from "./editing-print.js";
import { applySettlementEffect } from "./effects.js";
import type { UsageBackoff } from "./effects.js";
import { outcomeEffect } from "./settlement.js";
import type { SettlementEffect } from "./settlement.js";
import type { SessionEnd, SessionSpawner } from "./spawner.js";

export interface BranchFixerOptions extends EditingPrintContext {
  db: Db;
  bus: EventBus;
  spawner: SessionSpawner;
  backoff: UsageBackoff;
  config: () => ResolvedConfig;
}

export interface BranchFixRequest {
  worktree: string;
  prompt: string;
}

export type BranchFixOutcome =
  { kind: "finished"; session: Session } | { kind: "failed"; reason: string; session: Session };

export interface BranchFixer {
  resolve(request: BranchFixRequest): Promise<BranchFixOutcome>;
}

interface Settled {
  status: Exclude<SessionStatus, "running">;
  effect: SettlementEffect;
  failure: string | null;
}

function settle(end: SessionEnd): Settled {
  const none: SettlementEffect = { kind: "none" };
  switch (end.kind) {
    case "stopped":
      return { status: "stopped", effect: none, failure: "it was stopped" };
    case "aborted":
      return { status: "failed", effect: none, failure: end.reason };
    case "stuck":
      return { status: "failed", effect: none, failure: `it was stuck: ${end.reason}` };
    case "exited": {
      const { outcome } = end;
      const effect = outcomeEffect(outcome);
      switch (outcome.status) {
        case "succeeded":
          return { status: "succeeded", effect, failure: null };
        case "rate_limited":
          return { status: "rate_limited", effect, failure: "it hit the usage limit" };
        case "auth_failed":
        case "failed":
          return { status: outcome.status, effect, failure: outcome.reason };
      }
    }
  }
}

// A fixer for the owner's own branch belongs to no task, so it is settled here rather than by the task settlement.
export function createBranchFixer(options: BranchFixerOptions): BranchFixer {
  const { db, bus, spawner } = options;

  function end(session: Session, settled: Settled): Session {
    if (settled.failure !== null) {
      const event = db.events.append({
        sessionId: session.id,
        type: "error",
        summary: `Session failed: ${settled.failure}`,
        payload: JSON.stringify({ type: "branch_fixer", reason: settled.failure }),
      });
      bus.emit({ type: "session.event", sessionId: session.id, taskId: null, event });
    }
    const ended = db.sessions.end(session.id, { status: settled.status });
    bus.emit({ type: "session.ended", sessionId: ended.id, taskId: null, session: ended });
    return ended;
  }

  return {
    async resolve({ worktree, prompt }) {
      const print = editingPrintOptions(options, {
        role: "fixer",
        config: options.config(),
        worktree,
        resume: null,
        systemPrompt: "branch-fixer",
      });
      const session = db.sessions.create({
        role: "fixer",
        taskId: null,
        attempt: 1,
        claudeSessionId: print.sessionId ?? null,
        model: print.model,
      });
      let settled: Settled;
      try {
        const live = await spawner.launch({ session, cwd: worktree, prompt, print });
        settled = settle((await live.finished).end);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        end(session, { status: "failed", effect: { kind: "none" }, failure });
        throw error;
      }
      const ended = end(session, settled);
      applySettlementEffect(settled.effect, { db, bus, backoff: options.backoff });
      return settled.failure === null
        ? { kind: "finished", session: ended }
        : { kind: "failed", reason: settled.failure, session: ended };
    },
  };
}
