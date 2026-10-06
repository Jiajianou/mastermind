import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signInPrompt, switchAccountWarning } from "@mastermind/core/auth";
import { projectPaths } from "@mastermind/core/config";
import { readLock } from "@mastermind/core/lock";
import { createProcessRegistry } from "@mastermind/core/procs";
import { startMastermind, startupBanner } from "@mastermind/core/startup";
import type { Startup, StartupPrompts } from "@mastermind/core/startup";
import { describe, expect, it } from "vitest";
import { runCli } from "../../support/cli.js";
import { makeTempDir, onCleanup } from "../../support/cleanup.js";
import type { AccountKind } from "../../support/fake-claude.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { IsolatedEnv } from "../../support/isolated-env.js";
import { createTempRepo } from "../../support/temp-repo.js";
import type { TempRepo } from "../../support/temp-repo.js";
import { scriptedPrompts } from "./scripted-prompts.js";
import type { Answer } from "./scripted-prompts.js";

async function startFor(
  repoPath: string,
  env: IsolatedEnv,
  prompts: StartupPrompts,
): Promise<Startup> {
  const registry = createProcessRegistry();
  onCleanup(() => {
    registry.killAllSync();
  });
  const startup = await startMastermind({
    path: repoPath,
    env: env.env,
    homeDir: env.home,
    platform: process.platform,
    registry,
    prompts,
  });
  onCleanup(() => {
    startup.close();
  });
  return startup;
}

async function repoOnBranch(branch: string): Promise<TempRepo> {
  const repo = await createTempRepo();
  await repo.git("switch", "--quiet", "--create", branch);
  return repo;
}

async function signInCommands(env: IsolatedEnv): Promise<string[]> {
  return (await env.invocations())
    .map(({ argv }) => argv.join(" "))
    .filter((command) => command.startsWith("auth login") || command.startsWith("auth logout"));
}

const signedIn = "✓ Signed in as owner@example.com (Max)";

describe("startup sequence", () => {
  it("offers sign-in when signed out, and continues startup after a successful login", async () => {
    const repo = await repoOnBranch("dev");
    const env = await isolatedEnv({
      account: "signed-out",
      env: { FAKE_CLAUDE_LOGIN_ACCOUNT: "max" },
    });
    const { prompts, transcript } = scriptedPrompts([{ kind: "enter" }]);

    const startup = await startFor(repo.path, env, prompts);

    expect(transcript).toEqual([
      signInPrompt,
      signedIn,
      "First run: wrote .mastermind/config.yaml.",
      "No setup, build or test commands were detected; the chat will ask for them.",
      startupBanner,
    ]);
    expect(startup.auth).toEqual({ kind: "accepted", email: "owner@example.com", plan: "max" });
    expect(await signInCommands(env)).toEqual(["auth login --claudeai"]);
    const { stateDir, localConfig } = projectPaths(repo.path);
    expect(readLock(stateDir)).toEqual({ pid: process.pid, port: null });
    expect(existsSync(localConfig)).toBe(true);
    expect(await readFile(join(repo.path, ".git", "info", "exclude"), "utf8")).toContain(
      "/.mastermind/",
    );
    expect(await repo.git("status", "--porcelain")).toBe("");

    startup.close();
    expect(readLock(stateDir)).toBeNull();
  });

  it("gives up after 3 failed sign-ins and releases the lock", async () => {
    const repo = await repoOnBranch("dev");
    const env = await isolatedEnv({ account: "signed-out", env: { FAKE_CLAUDE_LOGIN_FAIL: "1" } });
    const { prompts, transcript } = scriptedPrompts([
      { kind: "enter" },
      { kind: "enter" },
      { kind: "enter" },
    ]);

    await expect(startFor(repo.path, env, prompts)).rejects.toMatchObject({
      failure: "sign-in-failed",
    });

    expect(transcript.filter((line) => line === signInPrompt)).toHaveLength(3);
    expect(await signInCommands(env)).toEqual(Array(3).fill("auth login --claudeai"));
    expect(readLock(projectPaths(repo.path).stateDir)).toBeNull();
  });

  it.each<{ account: AccountKind }>([{ account: "api-key" }, { account: "console" }])(
    "refuses a $account account with the 4.2 text and a non-zero exit",
    async ({ account }) => {
      const repo = await repoOnBranch("dev");
      const env = await isolatedEnv({ account });

      const run = await runCli([repo.path], { env: env.env });

      expect(run.code).toBe(1);
      expect(run.stdout).toContain(
        "This account uses API billing. Mastermind supports Claude Pro and Max subscriptions only.",
      );
      expect(run.stdout).toContain(switchAccountWarning);
      expect(run.stderr).toBe("Quit: this account can't run mastermind.\n");
      expect(await signInCommands(env)).toEqual([]);
      expect(readLock(projectPaths(repo.path).stateDir)).toBeNull();
      expect(await repo.git("status", "--porcelain")).toBe("");
    },
  );

  it("signs out and in again when the owner switches away from a refused account", async () => {
    const repo = await repoOnBranch("dev");
    const env = await isolatedEnv({
      account: "console",
      env: { FAKE_CLAUDE_LOGIN_ACCOUNT: "max" },
    });
    const { prompts, transcript } = scriptedPrompts([{ kind: "choose", value: "switch" }]);

    const startup = await startFor(repo.path, env, prompts);

    expect(transcript.slice(0, 3)).toEqual([
      "This account uses API billing. Mastermind supports Claude Pro and Max subscriptions only.",
      switchAccountWarning,
      "Sign in with a different account?",
    ]);
    expect(transcript).toContain(signedIn);
    expect(await signInCommands(env)).toEqual(["auth logout", "auth login --claudeai"]);
    expect(startup.auth.plan).toBe("max");
  });

  it.each<{ name: string; answers: Answer[]; branch: string }>([
    { name: "a new dev branch", answers: [{ kind: "choose", value: "new" }], branch: "dev" },
    {
      name: "an existing branch",
      answers: [
        { kind: "choose", value: "existing" },
        { kind: "choose", value: "feature" },
      ],
      branch: "feature",
    },
  ])("on main, switching to $name keeps uncommitted changes", async ({ answers, branch }) => {
    const repo = await createTempRepo({
      files: { "README.md": "# Temp repo\n", "notes.md": "draft\n" },
      branches: { feature: { "feature.md": "feature work\n" } },
    });
    const mainCommit = await repo.git("rev-parse", "main");
    await writeFile(join(repo.path, "README.md"), "# Temp repo\n\nUncommitted edit.\n");
    await writeFile(join(repo.path, "scratch.txt"), "untracked\n");
    const statusBefore = await repo.git("status", "--porcelain");
    const env = await isolatedEnv();
    const { prompts, transcript } = scriptedPrompts(answers);

    const startup = await startFor(repo.path, env, prompts);

    expect(transcript).toContain(
      "You're on main. Mastermind rebases finished work onto main, so please work on another branch.",
    );
    expect(startup.branch).toBe(branch);
    expect(await repo.git("branch", "--show-current")).toBe(branch);
    expect(await repo.git("status", "--porcelain")).toBe(statusBefore);
    expect(await readFile(join(repo.path, "README.md"), "utf8")).toContain("Uncommitted edit.");
    expect(await repo.git("rev-parse", "main")).toBe(mainCommit);
  });

  it("fails outside a git repository without creating anything there", async () => {
    const dir = await makeTempDir("not-a-repo");
    const env = await isolatedEnv();

    const run = await runCli([dir], { env: env.env });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${dir} is not inside a git repository.`);
    expect(existsSync(join(dir, ".mastermind"))).toBe(false);
  });
});
