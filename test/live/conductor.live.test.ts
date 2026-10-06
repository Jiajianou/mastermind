import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { locateOnPath } from "@mastermind/core/executables";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../support/cleanup.js";
import { spawnCli } from "../support/cli.js";
import { fakeClaudePath } from "../support/fake-claude.js";
import type { Scenario } from "../support/fake-claude.js";
import { installFakeNotifier } from "../support/fake-notifier.js";
import { conductorToolCalls, openProjectDb, startMastermind } from "../support/mastermind.js";
import type { RunningMastermind } from "../support/mastermind.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";

const readTools = new Set([
  "Read",
  "Grep",
  "Glob",
  ...[
    "get_summary",
    "list_tasks",
    "get_task",
    "list_sessions",
    "get_session_events",
    "get_changes",
    "get_check_log",
  ].map((tool) => `mcp__mastermind__${tool}`),
]);

const workerScenario: Scenario = {
  turns: [{ steps: [{ kind: "text", text: "Creating hello.txt" }, { kind: "hang" }] }],
};

function realClaude(): string {
  const found = locateOnPath("claude", process.env.PATH ?? "");
  if (found === null) throw new Error("the live tests need the real `claude` on PATH");
  return found;
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

// Only the Conductor, the sign-in check and the version check reach the real CLI; every worker is fake-claude.
async function writeDispatchingClaude(binDir: string): Promise<void> {
  const real = shellQuote(realClaude());
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    `  auth|--version) exec ${real} "$@" ;;`,
    "esac",
    'for arg in "$@"; do',
    '  case "$arg" in',
    `    */conductor.md) exec ${real} "$@" ;;`,
    "  esac",
    "done",
    `exec ${shellQuote(fakeClaudePath)} "$@"`,
    "",
  ].join("\n");
  const path = join(binDir, "claude");
  await mkdir(binDir);
  await writeFile(path, script);
  await chmod(path, 0o755);
}

async function liveEnv(root: string): Promise<Record<string, string>> {
  const binDir = join(root, "bin");
  await writeDispatchingClaude(binDir);
  await installFakeNotifier(binDir);
  const scenarioPath = join(root, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(workerScenario));
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(FAKE_CLAUDE_|GIT_)/.test(entry[0]),
  );
  return {
    ...Object.fromEntries(inherited),
    PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
    FAKE_CLAUDE_STATE: join(root, "fake-claude-state"),
    FAKE_CLAUDE_LOG: join(root, "fake-claude.log"),
    FAKE_CLAUDE_SCENARIO: scenarioPath,
  };
}

async function chat(running: RunningMastermind, text: string): Promise<void> {
  const reply = running.spawn(["chat", text]);
  const code = await reply.closed;
  expect(code, `chat failed:\n${reply.output.stdout}${reply.output.stderr}`).toBe(0);
}

describe("the real Conductor drives fake workers", () => {
  it("adds a task through create_tasks, then answers a status question with read tools only", async () => {
    const root = await makeTempDir("live");
    const repo = await createTempRepo({
      files: {
        "README.md": "# Greeter\n\nA tiny project that will greet people.\n",
        "mastermind.yaml": `worktreeDir: ${join(root, "worktrees")}\nmaxWorkers: 1\n`,
      },
    });
    await repo.git("switch", "--quiet", "--create", "dev");
    const running = await startMastermind(repo, await liveEnv(root), {
      launch: spawnCli,
      startupMs: 60_000,
    });
    const db = openProjectDb(repo);

    await chat(running, "add a task to create hello.txt");
    const addCalls = conductorToolCalls(db);
    expect(addCalls).toContain("mcp__mastermind__create_tasks");
    const [task] = db.tasks.list();
    if (task === undefined) throw new Error("create_tasks left no task");

    await waitFor(
      () =>
        db.sessions
          .listForTask(task.id)
          .some((session) => session.role === "worker" && session.status === "running"),
      30_000,
    );

    await chat(running, "what's running?");
    const statusCalls = conductorToolCalls(db).slice(addCalls.length);
    expect(statusCalls.filter((tool) => !readTools.has(tool))).toEqual([]);
  });
});
