import { homedir } from "node:os";
import { text } from "node:stream/consumers";
import { createProcessRegistry } from "@mastermind/core/procs";
import { pathGuardResponse } from "@mastermind/core/sessions";
import {
  doctorPassed,
  formatDoctorReport,
  runDoctor,
  startMastermind,
  StartupError,
} from "@mastermind/core/startup";
import type { Startup } from "@mastermind/core/startup";
import { runInForeground } from "./foreground.js";
import { createTerminalPrompts } from "./terminal-prompts.js";

export interface ForegroundOptions {
  port?: number | undefined;
  open: boolean;
}

function reportFailure(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(error instanceof StartupError ? `${message}\n` : `mastermind: ${message}\n`);
  return 1;
}

const runsUntilKilled = new Promise<never>(() => undefined);

export async function runForeground(path: string, options: ForegroundOptions): Promise<number> {
  const registry = createProcessRegistry();
  const homeDir = homedir();
  let startup: Startup;
  try {
    startup = await startMastermind({
      path,
      port: options.port,
      env: process.env,
      homeDir,
      platform: process.platform,
      registry,
      prompts: createTerminalPrompts(process.stdin, process.stdout),
    });
  } catch (error) {
    return reportFailure(error);
  }
  try {
    await runInForeground({
      startup,
      registry,
      env: process.env,
      homeDir,
      open: options.open,
    });
  } catch (error) {
    registry.killAllSync();
    startup.close();
    return reportFailure(error);
  }
  return runsUntilKilled;
}

export async function runPathGuard(worktree: string): Promise<number> {
  process.stdout.write(pathGuardResponse(await text(process.stdin), worktree));
  return 0;
}

export async function runDoctorCommand(path: string): Promise<number> {
  try {
    const checks = await runDoctor({
      path,
      env: process.env,
      homeDir: homedir(),
      platform: process.platform,
      registry: createProcessRegistry(),
    });
    process.stdout.write(formatDoctorReport(checks));
    return doctorPassed(checks) ? 0 : 1;
  } catch (error) {
    return reportFailure(error);
  }
}
