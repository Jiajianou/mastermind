import { execFileSync, spawn } from "node:child_process";
import { Interrupted } from "./interrupt.js";
import type { InvocationLog } from "./log.js";

export function processGroupOf(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ChildProcesses {
  runCommand(command: string, cwd: string, signal: AbortSignal): Promise<CommandOutput>;
  spawnGrandchild(marker: string, ownGroup: boolean): void;
  killAll(): void;
}

export function createChildProcesses(log: InvocationLog): ChildProcesses {
  const groups = new Set<number>();

  const killGroup = (pgid: number): void => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };

  return {
    runCommand(command, cwd, signal) {
      if (signal.aborted) return Promise.reject(new Interrupted());
      return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const pid = child.pid;
        if (pid !== undefined) {
          groups.add(pid);
          log.append({ kind: "spawn", childPid: pid, childPgid: pid, command });
        }
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
        child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
        const onAbort = (): void => {
          if (pid !== undefined) killGroup(pid);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", reject);
        child.on("close", (code) => {
          signal.removeEventListener("abort", onAbort);
          if (pid !== undefined) groups.delete(pid);
          if (signal.aborted) reject(new Interrupted());
          else resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: code ?? 1 });
        });
      });
    },

    spawnGrandchild(marker, ownGroup) {
      const keepAlive = "setInterval(() => {}, 1 << 30)";
      const args = ["-e", keepAlive, "fake-claude-grandchild", marker, process.argv[1] ?? ""];
      const child = spawn(process.execPath, args, { detached: ownGroup, stdio: "ignore" });
      child.unref();
      const childPid = child.pid;
      if (childPid === undefined) throw new Error("could not spawn the grandchild process");
      const childPgid = ownGroup ? childPid : processGroupOf(process.pid);
      if (ownGroup) groups.add(childPid);
      log.append({
        kind: "spawn",
        childPid,
        childPgid,
        command: [process.execPath, ...args].join(" "),
      });
    },

    killAll() {
      for (const pgid of groups) killGroup(pgid);
      groups.clear();
    },
  };
}
