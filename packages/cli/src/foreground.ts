import { writeSync } from "node:fs";
import type { Environment } from "@mastermind/core/env";
import type { ProcessRegistry } from "@mastermind/core/procs";
import { createNativeNotifier } from "@mastermind/core/notify";
import { createRuntime } from "@mastermind/core/runtime";
import type { Startup } from "@mastermind/core/startup";
import { promptsDir, webRoot } from "./assets.js";
import { createCtrlCGuard } from "./ctrl-c.js";
import { exitCodes, runKillPath } from "./kill-path.js";
import type { KillPathSteps } from "./kill-path.js";
import { startPlainLog } from "./plain-log.js";
import { createTerminalCommands } from "./terminal-commands.js";
import { renderStatusApp } from "./tui/app.js";
import type { TerminalView } from "./tui/app.js";

export interface ForegroundRun {
  startup: Startup;
  registry: ProcessRegistry;
  env: Environment;
  homeDir: string;
  open: boolean;
}

function pathGuardCommand(): string[] {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("cannot tell which script is running mastermind");
  return [process.execPath, ...process.execArgv, entry, "path-guard"];
}

// Synchronous writes, because stdout is asynchronous for pipes on macOS and process.exit would cut it off.
const syncOutput: Pick<KillPathSteps, "write" | "writeError" | "exit"> = {
  write: (text) => {
    writeSync(1, text);
  },
  writeError: (text) => {
    writeSync(2, text);
  },
  exit: (code) => process.exit(code),
};

const startupSignals = {
  SIGINT: exitCodes.interrupt,
  SIGHUP: exitCodes.hangup,
  SIGTERM: exitCodes.terminate,
} as const;

// Before the runtime traps signals, Node's default handlers would exit and orphan detached children such as the
// login hand-off. Nothing is running yet, so one signal is enough.
export function exitOnSignalsDuringStartup(
  registry: ProcessRegistry,
  release: () => void,
): () => void {
  const handlers = Object.entries(startupSignals).map(([signal, exitCode]) => {
    const handler = (): void => {
      runKillPath(
        {
          killProcesses: () => registry.killAllSync(),
          markKilled: () => ({ sessions: 0, checks: 0, rebases: 0 }),
          restoreTerminal: () => undefined,
          release,
          ...syncOutput,
        },
        { exitCode },
      );
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
}

const describe = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

export async function runInForeground(run: ForegroundRun): Promise<void> {
  const { startup, registry, env } = run;
  let view: TerminalView | null = null;
  let killing = false;

  const killNow = (exitCode: number, reason?: string): never => {
    if (killing) process.exit(exitCode);
    killing = true;
    return runKillPath(
      {
        killProcesses: () => runtime.killProcessesSync(),
        markKilled: () => runtime.markKilledSync(),
        restoreTerminal: () => view?.restore(),
        release: () => {
          runtime.closeSync();
        },
        ...syncOutput,
      },
      { exitCode, reason },
    );
  };

  const reportError = (error: unknown): void => {
    runtime.store.notice(`Error: ${error instanceof Error ? error.message : String(error)}`);
  };

  const runtime = await createRuntime({
    startup,
    registry,
    env,
    homeDir: run.homeDir,
    promptsDir,
    webRoot,
    pathGuardCommand: pathGuardCommand(),
    nativeNotifier: createNativeNotifier({ registry, env, platform: process.platform }),
    onError: (error) => {
      reportError(error);
    },
  });
  const guard = createCtrlCGuard({ onFire: () => killNow(exitCodes.interrupt) });

  process.on("SIGINT", () => {
    guard.press();
  });
  process.on("SIGHUP", () => killNow(exitCodes.hangup));
  process.on("SIGTERM", () => killNow(exitCodes.terminate));
  process.on("uncaughtException", (error) =>
    killNow(exitCodes.crash, `crashed: ${describe(error)}`),
  );

  const onCommand = createTerminalCommands({
    runtime,
    registry,
    env,
    platform: process.platform,
    handOffTerminal: (work) => (view === null ? work() : view.handOff(work)),
    onError: reportError,
  });
  const { stdin, stdout } = process;
  view =
    stdin.isTTY && stdout.isTTY
      ? renderStatusApp({ store: runtime.store, guard, onCommand }, stdin, stdout)
      : startPlainLog(runtime.store, guard, (line) => {
          stdout.write(`${line}\n`);
        });

  runtime.start();
  if (run.open) onCommand("open");
}
