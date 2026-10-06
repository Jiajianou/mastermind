import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { onCleanup } from "./cleanup.js";

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export function processTable(): ProcessRow[] {
  const output = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    const [, pid, ppid, pgid, command] = match;
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), command: command ?? "" }];
  });
}

export function findPids(marker: string): number[] {
  return processTable()
    .filter((row) => row.pid !== process.pid && row.command.includes(marker))
    .filter((row) => !row.command.startsWith("ps "))
    .map((row) => row.pid);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

function sendKill(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function descendantsOf(roots: readonly number[], table: readonly ProcessRow[]): ProcessRow[] {
  const found = new Map<number, ProcessRow>();
  const queue = [...roots];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const row of table) {
      if ((row.pid === pid || row.ppid === pid) && !found.has(row.pid)) {
        found.set(row.pid, row);
        queue.push(row.pid);
      }
    }
  }
  return [...found.values()];
}

export function killProcessTree(roots: readonly number[]): void {
  const table = processTable();
  const ownGroup = table.find((row) => row.pid === process.pid)?.pgid;
  for (const row of descendantsOf(roots, table)) {
    if (row.pid === process.pid) continue;
    sendKill(row.pgid === ownGroup ? row.pid : -row.pgid);
  }
}

export function killLiveGroups(groups: readonly { pid: number; pgid: number }[]): void {
  const table = processTable();
  const live = groups.filter(({ pid, pgid }) =>
    table.some((row) => row.pid === pid && row.pgid === pgid),
  );
  killProcessTree(live.map(({ pid }) => pid));
}

export function killMarkedProcesses(marker: string): void {
  for (let pass = 0; pass < 2; pass += 1) killProcessTree(findPids(marker));
}

export function trackChild(child: ChildProcess): void {
  onCleanup(() => {
    if (child.pid !== undefined) killProcessTree([child.pid]);
  });
}

export async function startUnrelatedProcess(): Promise<number> {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  trackChild(child);
  await once(child, "spawn");
  if (child.pid === undefined) throw new Error("sleep started without a pid");
  return child.pid;
}

export async function exitedPid(): Promise<number> {
  const child = spawn("true", { stdio: "ignore" });
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("true ran without a pid");
  return child.pid;
}

type Pending = false | null | undefined;

export async function waitFor<T>(
  condition: () => T | Pending | Promise<T | Pending>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await condition();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)} ms`, { cause: lastError });
    }
    await delay(25);
  }
}
