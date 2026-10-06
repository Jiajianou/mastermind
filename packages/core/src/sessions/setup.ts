import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../clock.js";
import type { Check } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import { cleanEnv } from "../env.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import type { ExitResult, ProcessRegistry } from "../procs.js";

export interface SetupCheckRequest {
  db: Db;
  bus: EventBus;
  registry: ProcessRegistry;
  env: Environment;
  clock: Clock;
  logsDir: string;
  taskId: string;
  round: number;
  command: string;
  cwd: string;
  onError: (error: unknown) => void;
}

function describeExit(exit: ExitResult): string {
  return exit.kind === "exited"
    ? `exited with code ${String(exit.code)}`
    : `was killed by ${exit.signal}`;
}

const fileStamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

export async function runSetupCheck(request: SetupCheckRequest): Promise<Check> {
  const { db, bus, clock, taskId } = request;
  const startedAt = clock.now();
  const logDir = join(request.logsDir, "checks");
  const logPath = join(logDir, `${taskId}-setup-${fileStamp(startedAt)}.log`);
  await mkdir(logDir, { recursive: true });
  const log = createWriteStream(logPath);
  log.on("error", request.onError);
  const check = db.checks.create({ taskId, round: request.round, kind: "setup", logPath });
  bus.emit({ type: "check.updated", taskId, check });

  const finish = (passed: boolean, summary: string): Check => {
    const durationMs = Math.max(clock.now().getTime() - startedAt.getTime(), 0);
    const status = passed ? "passed" : "failed";
    const finished = db.checks.finish(check.id, { status, summary, durationMs });
    bus.emit({ type: "check.updated", taskId, check: finished });
    return finished;
  };

  try {
    log.write(`$ ${request.command}\n`);
    const child = await request.registry.spawn({
      kind: "check",
      command: "/bin/sh",
      args: ["-c", request.command],
      env: cleanEnv(request.env),
      cwd: request.cwd,
      io: {
        stdin: "ignore",
        onStdoutLine: (line) => log.write(`${line}\n`),
        onStderrLine: (line) => log.write(`${line}\n`),
      },
    });
    const exit = await child.exited;
    const passed = exit.kind === "exited" && exit.code === 0;
    return finish(passed, `${request.command} ${describeExit(exit)}`);
  } catch (error) {
    finish(false, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await new Promise((resolve) => log.end(resolve));
  }
}
