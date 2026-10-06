import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProcessRegistry } from "@mastermind/core/procs";
import {
  doctorCheckNames,
  doctorPassed,
  formatDoctorReport,
  runDoctor,
} from "@mastermind/core/startup";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnv, IsolatedEnvOptions } from "../support/isolated-env.js";
import { createTempRepo } from "../support/temp-repo.js";

function reportLines(report: string): Record<string, string> {
  return Object.fromEntries(
    report.split("\n").flatMap((line) => {
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

async function doctor(
  path: string,
  env: IsolatedEnv,
): Promise<{ report: string; passed: boolean }> {
  const checks = await runDoctor({
    path,
    env: env.env,
    homeDir: env.home,
    platform: process.platform,
    registry: createProcessRegistry(),
  });
  return { report: formatDoctorReport(checks), passed: doctorPassed(checks) };
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
    await mkdir(join(repo.path, ".mastermind", "logs", "checks"), { recursive: true });
    await writeFile(
      join(repo.path, ".mastermind", "logs", "checks", "ext2-driver-test.log"),
      Buffer.alloc(3 * 1024),
    );

    const run = await doctor(repo.path, env);

    const lines = reportLines(run.report);
    expect(Object.keys(lines)).toEqual(doctorCheckNames);
    for (const name of doctorCheckNames) expect(lines[name]).toMatch(new RegExp(`^✓ ${name} `));
    expect(lines.git).toContain(`${repo.path} on branch dev`);
    expect(lines.claude).toContain("Claude Code 2.1.283");
    expect(lines["sign-in"]).toContain("owner@example.com (Max)");
    expect(lines.worktrees).toMatch(/\d+ KB in 1 task clone in /);
    expect(lines.logs).toMatch(/3 KB in 1 file in .*, kept for 30d$/);
    expect(run.report).toContain("All checks passed.");
    expect(run.passed).toBe(true);
  });

  it("flags each problem it finds and exits non-zero", async () => {
    const repo = await createTempRepo();
    const env = await doctorEnv({ account: "signed-out", version: "2.1.300" });
    await mkdir(join(repo.path, ".mastermind"));
    await writeFile(join(repo.path, ".mastermind", "config.yaml"), "models:\n  wroker: opus\n");

    const run = await doctor(repo.path, env);

    const lines = reportLines(run.report);
    expect(Object.keys(lines)).toEqual(doctorCheckNames);
    expect(lines.git).toMatch(/^✓ git /);
    expect(lines.claude).toMatch(/^! claude .*Claude Code 2\.1\.300 has not been tested/);
    expect(lines["sign-in"]).toMatch(/^✗ sign-in .*Not signed in/);
    expect(lines.attribution).toMatch(/^! attribution .*Claude attribution is not fully off/);
    expect(lines.config).toMatch(/^✗ config .*models\.wroker: unknown key/);
    expect(lines.worktrees).toMatch(/^- worktrees .*needs a valid config/);
    expect(lines.logs).toMatch(/^- logs .*needs a valid config/);
    expect(run.report).toContain("2 checks failed.");
    expect(run.passed).toBe(false);
  });

  it("fails the git check outside a repository", async () => {
    const env = await doctorEnv({});

    const run = await doctor(env.root, env);

    const lines = reportLines(run.report);
    expect(lines.git).toMatch(/^✗ git .*is not inside a git repository/);
    expect(lines.config).toMatch(/^- config /);
    expect(run.passed).toBe(false);
  });
});
