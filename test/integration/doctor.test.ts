import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../support/cli.js";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnv, IsolatedEnvOptions } from "../support/isolated-env.js";
import { createTempRepo } from "../support/temp-repo.js";

const checkNames = ["git", "claude", "sign-in", "attribution", "config", "worktrees", "sandbox"];

function reportLines(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout.split("\n").flatMap((line) => {
      const name = /^[✓!✗-] (\S+)/.exec(line)?.[1];
      return name === undefined ? [] : [[name, line]];
    }),
  );
}

// On Linux the sandbox needs bubblewrap and socat; stubs keep the check independent of the CI machine.
async function stubLinuxSandboxTools(env: IsolatedEnv): Promise<void> {
  for (const tool of ["bwrap", "socat"]) {
    const path = join(env.binDir, tool);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
}

async function doctorEnv(options: IsolatedEnvOptions): Promise<IsolatedEnv> {
  const env = await isolatedEnv(options);
  await stubLinuxSandboxTools(env);
  return env;
}

describe("mastermind doctor", () => {
  it("reports every check and exits 0 when the machine is ready", async () => {
    const repo = await createTempRepo();
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await doctorEnv({ account: "max" });
    await mkdir(join(env.home, ".claude"), { recursive: true });
    await writeFile(
      join(env.home, ".claude", "settings.json"),
      JSON.stringify({ attribution: { commit: "", pr: "", sessionUrl: false } }),
    );
    await mkdir(join(repo.path, ".mastermind"));
    await writeFile(
      join(repo.path, ".mastermind", "config.yaml"),
      `worktreeDir: ${env.worktreeRoot}\n`,
    );
    await mkdir(join(env.worktreeRoot, "ext2-driver"));
    await writeFile(join(env.worktreeRoot, "ext2-driver", "data.bin"), Buffer.alloc(64 * 1024));

    const run = await runCli(["doctor", repo.path], { env: env.env });

    const lines = reportLines(run.stdout);
    expect(Object.keys(lines)).toEqual(checkNames);
    for (const name of checkNames) expect(lines[name]).toMatch(new RegExp(`^✓ ${name} `));
    expect(lines.git).toContain(`${repo.path} on branch dev`);
    expect(lines.claude).toContain("Claude Code 2.1.283");
    expect(lines["sign-in"]).toContain("owner@example.com (Max)");
    expect(lines.worktrees).toMatch(/\d+ KB in 1 task clone in /);
    expect(run.stdout).toContain("All checks passed.");
    expect(run.code).toBe(0);
  });

  it("flags each problem it finds and exits non-zero", async () => {
    const repo = await createTempRepo();
    const env = await doctorEnv({ account: "signed-out", version: "2.1.300" });
    await mkdir(join(repo.path, ".mastermind"));
    await writeFile(join(repo.path, ".mastermind", "config.yaml"), "models:\n  wroker: opus\n");

    const run = await runCli(["doctor", repo.path], { env: env.env });

    const lines = reportLines(run.stdout);
    expect(Object.keys(lines)).toEqual(checkNames);
    expect(lines.git).toMatch(/^✓ git /);
    expect(lines.claude).toMatch(/^! claude .*Claude Code 2\.1\.300 has not been tested/);
    expect(lines["sign-in"]).toMatch(/^✗ sign-in .*Not signed in/);
    expect(lines.attribution).toMatch(/^! attribution .*Claude attribution is not fully off/);
    expect(lines.config).toMatch(/^✗ config .*models\.wroker: unknown key/);
    expect(lines.worktrees).toMatch(/^- worktrees .*needs a valid config/);
    expect(run.stdout).toContain("2 checks failed.");
    expect(run.code).toBe(1);
  });

  it("fails the git check outside a repository", async () => {
    const env = await doctorEnv({});

    const run = await runCli(["doctor", env.root], { env: env.env });

    const lines = reportLines(run.stdout);
    expect(lines.git).toMatch(/^✗ git .*is not inside a git repository/);
    expect(lines.config).toMatch(/^- config /);
    expect(run.code).toBe(1);
  });
});
