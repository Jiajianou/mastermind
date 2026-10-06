import { homedir } from "node:os";
import { createProcessRegistry } from "@mastermind/core/procs";
import {
  doctorPassed,
  formatDoctorReport,
  runDoctor,
  startMastermind,
  StartupError,
} from "@mastermind/core/startup";
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

export async function runForeground(path: string, options: ForegroundOptions): Promise<number> {
  try {
    const startup = await startMastermind({
      path,
      port: options.port,
      env: process.env,
      homeDir: homedir(),
      platform: process.platform,
      registry: createProcessRegistry(),
      prompts: createTerminalPrompts(process.stdin, process.stdout),
    });
    startup.close();
    return 0;
  } catch (error) {
    return reportFailure(error);
  }
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
