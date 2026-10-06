import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, alreadyRunningMessage, lockPath, readLock } from "@mastermind/core/lock";
import type { InstanceLock, LockAttempt } from "@mastermind/core/lock";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../support/cleanup.js";
import { exitedPid, startUnrelatedProcess } from "../support/processes.js";

function acquired(attempt: LockAttempt): InstanceLock {
  if (attempt.kind !== "acquired") throw new Error(`lock is held by pid ${String(attempt.pid)}`);
  return attempt.lock;
}

const tempStateDir = async (): Promise<string> => join(await makeTempDir("lock"), ".mastermind");

describe("single-instance lock", () => {
  it.each([
    {
      stale: "whose pid is dead",
      leave: async (stateDir: string) => {
        const crashed = acquired(acquireLock(stateDir, { pid: await exitedPid() }));
        crashed.setPort(4700);
        return crashed;
      },
    },
    {
      stale: "that was left half-written",
      leave: async (stateDir: string) => {
        await mkdir(stateDir, { recursive: true });
        await writeFile(lockPath(stateDir), '{"pid": 41');
        return null;
      },
    },
  ])("takes over a lock $stale, and the old holder cannot release it", async ({ leave }) => {
    const stateDir = await tempStateDir();
    const previous = await leave(stateDir);

    const current = acquired(acquireLock(stateDir));
    current.setPort(4701);
    previous?.releaseSync();

    expect(readLock(stateDir)).toEqual({ pid: process.pid, port: 4701 });
    current.releaseSync();
    expect(existsSync(lockPath(stateDir))).toBe(false);
  });

  it.each([
    {
      holder: "a serving instance",
      port: 4702,
      expected: (pid: number) =>
        `mastermind is already running for this repo (pid ${String(pid)}) → http://127.0.0.1:4702/#t=8f3c2a91`,
    },
    {
      holder: "an instance still starting",
      port: null,
      expected: (pid: number) =>
        `mastermind is already running for this repo (pid ${String(pid)}), still starting`,
    },
  ])("refuses a live lock held by $holder and reports it", async ({ port, expected }) => {
    const stateDir = await tempStateDir();
    const pid = await startUnrelatedProcess();
    const holder = acquired(acquireLock(stateDir, { pid }));
    if (port !== null) holder.setPort(port);
    await writeFile(join(stateDir, "token"), "8f3c2a91\n", { mode: 0o600 });

    const attempt = acquireLock(stateDir);

    if (attempt.kind !== "held") throw new Error("a live lock was taken over");
    expect(attempt.pid).toBe(pid);
    expect(alreadyRunningMessage(attempt)).toBe(expected(pid));
    expect(readLock(stateDir)).toEqual({ pid, port });
  });
});
