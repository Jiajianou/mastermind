import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { PrintOptions } from "../claude.js";
import type { Session, SessionRole, SessionStatus } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import { applySettlementEffect } from "./effects.js";
import type { UsageBackoff } from "./effects.js";
import { outcomeEffect } from "./settlement.js";
import type { SettlementEffect } from "./settlement.js";
import type { SessionEnd, SessionReport, SessionSpawner } from "./spawner.js";
import { jsonSchemaFor, readStructuredOutput, StructuredOutputError } from "./structured-output.js";

export type OneShotRole = Extract<SessionRole, "reviewer" | "judge">;

export interface OneShotRequest<Schema extends z.ZodType> {
  role: OneShotRole;
  taskId: string;
  round: number;
  cwd: string;
  prompt: string;
  schema: Schema;
  print: Omit<PrintOptions, "inputFormat" | "sessionId" | "resume" | "jsonSchema">;
}

export type OneShotResult<Value> =
  | { kind: "answered"; value: Value; session: Session }
  | { kind: "failed"; reason: string; session: Session };

export interface OneShotRunner {
  run<Schema extends z.ZodType>(
    request: OneShotRequest<Schema>,
  ): Promise<OneShotResult<z.output<Schema>>>;
}

export interface OneShotOptions {
  db: Db;
  bus: EventBus;
  spawner: SessionSpawner;
  backoff: UsageBackoff;
}

interface Verdict<Value> {
  status: Exclude<SessionStatus, "running">;
  effect: SettlementEffect;
  answer: { kind: "answered"; value: Value } | { kind: "failed"; reason: string };
}

function endReason(end: SessionEnd): string {
  switch (end.kind) {
    case "stopped":
      return "it was stopped";
    case "aborted":
      return end.reason;
    case "exited":
      switch (end.outcome.status) {
        case "succeeded":
          return "it finished";
        case "rate_limited":
          return "it hit the usage limit";
        case "auth_failed":
        case "failed":
          return end.outcome.reason;
      }
  }
}

function judgeReport<Schema extends z.ZodType>(
  report: SessionReport,
  schema: Schema,
): Verdict<z.output<Schema>> {
  const { end } = report;
  if (end.kind !== "exited") {
    const status = end.kind === "stopped" ? "stopped" : "failed";
    return { status, effect: { kind: "none" }, answer: { kind: "failed", reason: endReason(end) } };
  }
  const effect = outcomeEffect(end.outcome);
  if (end.outcome.status !== "succeeded")
    return {
      status: end.outcome.status,
      effect,
      answer: { kind: "failed", reason: endReason(end) },
    };
  try {
    const value = readStructuredOutput(report.result, schema);
    return { status: "succeeded", effect, answer: { kind: "answered", value } };
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error;
    return { status: "failed", effect, answer: { kind: "failed", reason: error.message } };
  }
}

export function createOneShotRunner({ db, bus, spawner, backoff }: OneShotOptions): OneShotRunner {
  function end(session: Session, status: Exclude<SessionStatus, "running">): Session {
    const ended = db.sessions.end(session.id, { status });
    bus.emit({ type: "session.ended", sessionId: ended.id, taskId: ended.taskId, session: ended });
    return ended;
  }

  function recordFailure(session: Session, reason: string): void {
    const event = db.events.append({
      sessionId: session.id,
      type: "error",
      summary: `No answer: ${reason}`,
      payload: JSON.stringify({ type: "one_shot", reason }),
    });
    bus.emit({ type: "session.event", sessionId: session.id, taskId: session.taskId, event });
  }

  return {
    async run(request) {
      const sessionId = randomUUID();
      const session = db.sessions.create({
        role: request.role,
        taskId: request.taskId,
        round: request.round,
        claudeSessionId: sessionId,
        model: request.print.model,
      });
      const print: PrintOptions = {
        ...request.print,
        inputFormat: "text",
        sessionId,
        jsonSchema: jsonSchemaFor(request.schema),
        noSessionPersistence: true,
      };
      let report: SessionReport;
      try {
        const live = await spawner.launch({
          session,
          cwd: request.cwd,
          prompt: request.prompt,
          print,
        });
        report = await live.finished;
      } catch (error) {
        end(session, "failed");
        throw error;
      }
      const verdict = judgeReport(report, request.schema);
      if (verdict.answer.kind === "failed" && verdict.status === "failed")
        recordFailure(session, verdict.answer.reason);
      const ended = end(session, verdict.status);
      applySettlementEffect(verdict.effect, { db, bus, backoff });
      return { ...verdict.answer, session: ended };
    },
  };
}
