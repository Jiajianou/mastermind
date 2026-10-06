import type { KilledCounts } from "@mastermind/core/db";
import type { KillReport } from "@mastermind/core/procs";
import { killSummary } from "./messages.js";
import type { LiveCounts } from "./messages.js";

export interface KillPathSteps {
  killProcesses(): KillReport;
  markKilled(): KilledCounts;
  restoreTerminal(): void;
  release(): void;
  write(text: string): void;
  writeError(text: string): void;
  exit(code: number): never;
}

export const exitCodes = { interrupt: 130, hangup: 129, terminate: 143, crash: 1 } as const;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function countsFromProcesses({ counts }: KillReport): LiveCounts {
  return { sessions: counts.session + counts.conductor, checks: counts.check };
}

export interface KillRequest {
  exitCode: number;
  reason?: string;
}

export function runKillPath(steps: KillPathSteps, { exitCode, reason }: KillRequest): never {
  const failures: string[] = reason === undefined ? [] : [reason];
  function attempt<T>(step: string, work: () => T): T | null {
    try {
      return work();
    } catch (error) {
      failures.push(`${step}: ${describe(error)}`);
      return null;
    }
  }

  const processes = attempt("killing processes", () => steps.killProcesses());
  for (const { target, error } of processes?.failures ?? [])
    failures.push(`killing ${String(target)}: ${describe(error)}`);
  const killed = attempt("marking sessions killed", () => steps.markKilled());
  attempt("restoring the terminal", () => {
    steps.restoreTerminal();
  });
  attempt("releasing the lock", () => {
    steps.release();
  });

  const counts =
    killed ?? (processes === null ? { sessions: 0, checks: 0 } : countsFromProcesses(processes));
  attempt("printing the summary", () => {
    steps.write(`${killSummary(counts)}\n`);
  });
  if (failures.length > 0) {
    try {
      steps.writeError(failures.map((failure) => `mastermind: ${failure}\n`).join(""));
    } catch {
      // The terminal is gone (SIGHUP), so there is nowhere left to report to.
    }
  }
  return steps.exit(exitCode);
}
