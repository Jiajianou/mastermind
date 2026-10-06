import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../contracts/index.js";
import type { Clock } from "../clock.js";
import type { Check, CheckKind } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import { cleanEnv } from "../env.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import { describeExit, exitedCleanly } from "../procs.js";
import type { ExitResult, ProcessRegistry } from "../procs.js";

export interface CheckContext {
  db: Db;
  bus: EventBus;
  registry: ProcessRegistry;
  env: Environment;
  clock: Clock;
  logsDir: string;
  onError: (error: unknown) => void;
}

export interface CheckTarget {
  taskId: string;
  round: number;
  kind: CheckKind;
  cwd: string;
}

export interface CheckRun {
  check: Check;
  note(text: string): void;
  exec(command: string, args: readonly string[]): Promise<ExitResult>;
  finish(passed: boolean, summary: string): Promise<Check>;
}

export interface ShellCheck extends CheckTarget {
  command: string;
  notes?: readonly string[];
}

export const fileStamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

export async function startCheck(context: CheckContext, target: CheckTarget): Promise<CheckRun> {
  const { db, bus, clock } = context;
  const { taskId, kind } = target;
  const startedAt = clock.now();
  const logDir = join(context.logsDir, "checks");
  const logPath = join(logDir, `${taskId}-${kind}-${fileStamp(startedAt)}.log`);
  await mkdir(logDir, { recursive: true });
  const log = createWriteStream(logPath);
  log.on("error", context.onError);
  const write = (line: string) => log.write(`${line}\n`);
  const childEnv = cleanEnv(context.env);
  const check = db.checks.create({ taskId, round: target.round, kind, logPath });
  bus.emit({ type: "check.updated", taskId, check });

  return {
    check,

    note: write,

    async exec(command, args) {
      const child = await context.registry.spawn({
        kind: "check",
        command,
        args,
        env: childEnv,
        cwd: target.cwd,
        io: { stdin: "ignore", onStdoutLine: write, onStderrLine: write },
      });
      return child.exited;
    },

    async finish(passed, summary) {
      await new Promise((resolve) => log.end(resolve));
      const durationMs = Math.max(clock.now().getTime() - startedAt.getTime(), 0);
      const status = passed ? "passed" : "failed";
      const finished = db.checks.finish(check.id, { status, summary, durationMs });
      bus.emit({ type: "check.updated", taskId, check: finished });
      return finished;
    },
  };
}

export async function runShellCheck(context: CheckContext, request: ShellCheck): Promise<Check> {
  const run = await startCheck(context, request);
  try {
    for (const note of request.notes ?? []) run.note(note);
    run.note(`$ ${request.command}`);
    const exit = await run.exec("/bin/sh", ["-c", request.command]);
    return await run.finish(exitedCleanly(exit), `${request.command} ${describeExit(exit)}`);
  } catch (error) {
    await run.finish(false, errorMessage(error));
    throw error;
  }
}
