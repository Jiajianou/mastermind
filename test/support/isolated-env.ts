import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { logRecordSchema } from "../fixtures/fake-claude/src/log.js";
import type { InvocationRecord, FakeClaudeLogRecord } from "../fixtures/fake-claude/src/log.js";
import { scenarioSchema } from "../fixtures/fake-claude/src/scenario.js";
import type { AccountKind } from "../fixtures/fake-claude/src/config.js";
import type { Scenario } from "../fixtures/fake-claude/src/scenario.js";
import { makeTempDir, onCleanup } from "./cleanup.js";
import { fakeClaudeBinDir } from "./fake-claude.js";
import { findPids, killLiveGroups, killMarkedProcesses } from "./processes.js";
import { owner } from "./temp-repo.js";

export interface IsolatedEnvOptions {
  account?: AccountKind;
  version?: string;
  env?: Record<string, string>;
}

export interface IsolatedEnv {
  root: string;
  home: string;
  worktreeRoot: string;
  binDir: string;
  env: Record<string, string>;
  writeScenario(scenario: Scenario): Promise<void>;
  readLog(): Promise<FakeClaudeLogRecord[]>;
  invocations(): Promise<InvocationRecord[]>;
  livePids(): number[];
}

const outerSessionVariable = /^(ANTHROPIC_|CLAUDE|FAKE_CLAUDE_|GIT_|AI_AGENT$)/;

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !outerSessionVariable.test(entry[0]),
    ),
  );
}

const gitConfig = `[user]
\tname = ${owner.name}
\temail = ${owner.email}
[init]
\tdefaultBranch = main
[commit]
\tgpgsign = false
`;

export async function isolatedEnv(options: IsolatedEnvOptions = {}): Promise<IsolatedEnv> {
  const root = await makeTempDir("env");
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const worktreeRoot = join(home, ".mastermind", "worktrees");
  const scenarioPath = join(root, "scenario.json");
  const logPath = join(root, "fake-claude.log");
  await mkdir(worktreeRoot, { recursive: true });
  await mkdir(binDir);
  await symlink(join(fakeClaudeBinDir, "claude"), join(binDir, "claude"));
  await symlink(join(fakeClaudeBinDir, "run.js"), join(binDir, "run.js"));
  await writeFile(join(home, ".gitconfig"), gitConfig);

  const env: Record<string, string> = {
    ...inheritedEnv(),
    HOME: home,
    // The owner's shell would read the owner's rc files (or, for zsh, prompt to create them in the empty HOME).
    SHELL: "/bin/sh",
    PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    FAKE_CLAUDE_STATE: join(root, "fake-claude-state"),
    FAKE_CLAUDE_LOG: logPath,
    FAKE_CLAUDE_SCENARIO: scenarioPath,
    ...(options.account === undefined ? {} : { FAKE_CLAUDE_ACCOUNT: options.account }),
    ...(options.version === undefined ? {} : { FAKE_CLAUDE_VERSION: options.version }),
    ...options.env,
  };

  const readLog = async (): Promise<FakeClaudeLogRecord[]> => {
    if (!existsSync(logPath)) return [];
    const lines = (await readFile(logPath, "utf8")).split("\n").filter((line) => line !== "");
    return lines.map((line) => logRecordSchema.parse(JSON.parse(line)));
  };

  onCleanup(async () => {
    killMarkedProcesses(binDir);
    const spawned = (await readLog()).flatMap((record) =>
      record.kind === "spawn" ? [{ pid: record.childPid, pgid: record.childPgid }] : [],
    );
    killLiveGroups(spawned);
  });

  return {
    root,
    home,
    worktreeRoot,
    binDir,
    env,
    async writeScenario(scenario) {
      await writeFile(scenarioPath, JSON.stringify(scenarioSchema.parse(scenario)));
    },
    readLog,
    async invocations() {
      return (await readLog()).filter((record) => record.kind === "invocation");
    },
    livePids: () => findPids(binDir),
  };
}
