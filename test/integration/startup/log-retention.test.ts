import { existsSync } from "node:fs";
import { chmod, mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectPaths } from "@mastermind/core/config";
import { createProcessRegistry } from "@mastermind/core/procs";
import { startMastermind } from "@mastermind/core/startup";
import { describe, expect, it } from "vitest";
import { onCleanup } from "../../support/cleanup.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import { createTempRepo } from "../../support/temp-repo.js";
import { scriptedPrompts } from "./scripted-prompts.js";

const now = new Date("2031-03-01T12:00:00Z");
const daysAgo = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

const logAges: Record<string, number> = {
  "sessions/12.jsonl": 45,
  "checks/ext2-driver-test-20310129.log": 31,
  "rebases/vfs-cache-20310219.log": 10,
  "branches/dev-20310228.log": 1,
};
const logNames = Object.keys(logAges);

async function projectWithLogs(config: string): Promise<{ path: string; logs: string }> {
  const repo = await createTempRepo();
  await repo.git("switch", "--quiet", "--create", "dev");
  const { logs, localConfig } = projectPaths(repo.path);
  await mkdir(dirname(localConfig), { recursive: true });
  await writeFile(localConfig, config);
  for (const [name, age] of Object.entries(logAges)) {
    const path = join(logs, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "output\n");
    await utimes(path, daysAgo(age), daysAgo(age));
  }
  return { path: repo.path, logs };
}

async function start(path: string): Promise<string[]> {
  const env = await isolatedEnv({ account: "max" });
  const registry = createProcessRegistry();
  onCleanup(() => {
    registry.killAllSync();
  });
  const { prompts, transcript } = scriptedPrompts([]);
  const startup = await startMastermind({
    path,
    env: env.env,
    homeDir: env.home,
    platform: process.platform,
    registry,
    prompts,
    clock: { now: () => now },
  });
  startup.close();
  return transcript;
}

const remainingLogs = (logs: string): string[] =>
  logNames.filter((name) => existsSync(join(logs, name)));

describe("log retention", () => {
  it.each([
    {
      config: "",
      retention: "30d",
      removed: ["sessions/12.jsonl", "checks/ext2-driver-test-20310129.log"],
    },
    {
      config: "logRetention: 7d\n",
      retention: "7d",
      removed: [
        "sessions/12.jsonl",
        "checks/ext2-driver-test-20310129.log",
        "rebases/vfs-cache-20310219.log",
      ],
    },
  ])(
    "prunes logs older than $retention at startup and keeps the rest",
    async ({ config, retention, removed }) => {
      const project = await projectWithLogs(config);

      const transcript = await start(project.path);

      expect(remainingLogs(project.logs)).toEqual(
        logNames.filter((name) => !removed.includes(name)),
      );
      expect(transcript).toContain(
        `Removed ${String(removed.length)} log files older than ${retention}.`,
      );
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "starts anyway and says which old log it could not remove",
    async () => {
      const project = await projectWithLogs("");
      const lockedDir = join(project.logs, "sessions");
      await chmod(lockedDir, 0o555);
      onCleanup(() => chmod(lockedDir, 0o755));

      const transcript = await start(project.path);

      expect(remainingLogs(project.logs)).toEqual([
        "sessions/12.jsonl",
        "rebases/vfs-cache-20310219.log",
        "branches/dev-20310228.log",
      ]);
      expect(transcript).toContain("Removed 1 log file older than 30d.");
      expect(transcript).toContainEqual(
        expect.stringMatching(
          /^Could not remove 1 log file older than 30d, such as .*sessions\/12\.jsonl: .*EACCES/,
        ),
      );
    },
  );
});
