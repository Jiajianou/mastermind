import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { makeTempDir, writeFiles } from "../testing/temp-dir.js";
import { loadConfig, setConfig } from "./layers.js";
import { prepareProject } from "./setup.js";

async function makeRepo(files: Record<string, string> = {}) {
  const repoRoot = await makeTempDir();
  await mkdir(join(repoRoot, ".git"));
  await writeFiles(repoRoot, files);
  return { repoRoot, homeDir: join(repoRoot, "home"), platform: "linux" } as const;
}

describe("prepareProject", () => {
  it("adds the mastermind paths to .git/info/exclude once, however often it runs", async () => {
    const context = await makeRepo({
      ".git/info/exclude": "# git ls-files --others --exclude-from=.git/info/exclude\n*.log",
    });

    await prepareProject(context);
    await prepareProject(context);

    expect(await readFile(join(context.repoRoot, ".git/info/exclude"), "utf8")).toBe(
      "# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n/.mastermind/\n/.mastermind-result.md\n",
    );
    expect((await stat(join(context.repoRoot, ".mastermind"))).isDirectory()).toBe(true);
  });

  it("uses the common git dir's exclude file in a linked worktree", async () => {
    const main = await makeRepo();
    const linked = await makeTempDir();
    const worktreeGitDir = join(main.repoRoot, ".git/worktrees/linked");
    await writeFiles(worktreeGitDir, { commondir: "../..\n" });
    await writeFiles(linked, { ".git": `gitdir: ${worktreeGitDir}\n` });

    await prepareProject({ ...main, repoRoot: linked });

    expect(await readFile(join(main.repoRoot, ".git/info/exclude"), "utf8")).toBe(
      "/.mastermind/\n/.mastermind-result.md\n",
    );
  });

  it("writes detected commands and toolchain sandbox presets on the first run only", async () => {
    const context = await makeRepo({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
      "pnpm-lock.yaml": "",
    });

    const first = await prepareProject(context);
    await setConfig(context, { commands: { test: "pnpm test:unit" } });
    const second = await prepareProject(context);

    expect(first).toMatchObject({
      firstRun: true,
      detection: { commands: { test: { command: "pnpm test" } }, toolchains: ["pnpm"] },
    });
    expect(second).toEqual({ firstRun: false });
    expect(await loadConfig(context)).toMatchObject({
      commands: { setup: "pnpm install", build: "pnpm run build", test: "pnpm test:unit" },
      sandbox: {
        enabled: true,
        allowedDomains: ["registry.npmjs.org"],
        allowWrite: ["~/.local/share/pnpm", "~/.cache/pnpm"],
      },
    });
  });

  it("leaves keys that the committed mastermind.yaml sets to it", async () => {
    const context = await makeRepo({
      "mastermind.yaml": "commands: { test: make ci }\nsandbox: { allowedDomains: [crates.io] }\n",
      "Cargo.toml": "[package]\n",
    });

    await prepareProject(context);

    expect(
      parse(await readFile(join(context.repoRoot, ".mastermind/config.yaml"), "utf8")),
    ).toEqual({
      commands: { setup: "cargo fetch", build: "cargo build" },
      sandbox: { allowWrite: ["~/.cargo/registry", "~/.cargo/git"] },
    });
  });
});
