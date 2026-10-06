import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { makeTempDir, writeFiles } from "../testing/temp-dir.js";
import { ConfigError } from "./errors.js";
import { loadConfig, setConfig } from "./layers.js";

async function makeProject(files: Record<string, string> = {}) {
  const repoRoot = await makeTempDir();
  await writeFiles(repoRoot, files);
  return { repoRoot, homeDir: join(repoRoot, "home") };
}

const localConfigPath = (repoRoot: string) => join(repoRoot, ".mastermind", "config.yaml");

describe("loadConfig", () => {
  it("layers .mastermind/config.yaml over mastermind.yaml over the built-in defaults", async () => {
    const context = await makeProject({
      "mastermind.yaml":
        "maxAttempts: 5\nport: 4800\nmodels: { worker: sonnet }\nsandbox: { allowedDomains: [a.dev] }\n",
      ".mastermind/config.yaml":
        "maxAttempts: 7\nmodels:\n  judge: sonnet\nsandbox:\n  allowedDomains: [b.dev]\n",
    });

    const config = await loadConfig(context);

    expect(config).toMatchObject({
      mainBranch: "main",
      maxAttempts: 7,
      port: 4800,
      models: {
        worker: "sonnet",
        fixer: "opus",
        reviewer: "sonnet",
        judge: "sonnet",
        conductor: "opus",
      },
      sandbox: { enabled: true, allowedDomains: ["b.dev"], allowWrite: [] },
      stuckCheck: { after: "60m", every: "20m" },
    });
  });

  it.each([
    {
      file: ".mastermind/config.yaml",
      yaml: "stuckCheck:\n  after: soon\n",
      key: "stuckCheck.after",
    },
    { file: ".mastermind/config.yaml", yaml: "maxWorkers: 0\n", key: "maxWorkers" },
    { file: ".mastermind/config.yaml", yaml: "models: { wroker: opus }\n", key: "models.wroker" },
    { file: "mastermind.yaml", yaml: "workerPermissions: yolo\n", key: "workerPermissions" },
    {
      file: "mastermind.yaml",
      yaml: "sandbox: { allowedDomains: [github.com, 42] }\n",
      key: "sandbox.allowedDomains[1]",
    },
  ])(
    "rejects an invalid $key in $file with an error naming the key",
    async ({ file, yaml, key }) => {
      const context = await makeProject({ [file]: yaml });

      const error: unknown = await loadConfig(context).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toMatchObject({ file, issues: [{ key }] });
      expect(String(error)).toContain(`${file}: ${key}: `);
    },
  );

  it("rejects a file that is not valid YAML, naming the file", async () => {
    const context = await makeProject({ "mastermind.yaml": "models: [opus\n" });

    await expect(loadConfig(context)).rejects.toThrow(/^mastermind\.yaml: /);
  });
});

describe("setConfig", () => {
  it("writes only the overrides and keeps the rest of the local file intact", async () => {
    const original = [
      "# chosen by the owner",
      "port: 4800",
      "models: { judge: sonnet }",
      "requireReviewFor: [kernel/vfs/]",
      "",
    ].join("\n");
    const context = await makeProject({
      "mastermind.yaml": "maxAttempts: 5\n",
      ".mastermind/config.yaml": original,
    });

    const config = await setConfig(context, {
      models: { worker: "haiku" },
      commands: { test: "make check" },
      sandbox: { allowedDomains: ["github.com"] },
    });

    const written = await readFile(localConfigPath(context.repoRoot), "utf8");
    expect(written).toContain("# chosen by the owner");
    expect(parse(written)).toEqual({
      port: 4800,
      models: { judge: "sonnet", worker: "haiku" },
      requireReviewFor: ["kernel/vfs/"],
      commands: { test: "make check" },
      sandbox: { allowedDomains: ["github.com"] },
    });
    expect(config).toMatchObject({
      maxAttempts: 5,
      port: 4800,
      models: { judge: "sonnet", worker: "haiku" },
      commands: { setup: "", build: "", test: "make check" },
      sandbox: { enabled: true, allowedDomains: ["github.com"] },
    });
    expect(await loadConfig(context)).toEqual(config);
  });

  it("creates the local file and keeps every one of several concurrent changes", async () => {
    const context = await makeProject();

    await Promise.all([
      setConfig(context, { maxWorkers: 3 }),
      setConfig(context, { port: 4801 }),
      setConfig(context, { models: { judge: "sonnet" } }),
    ]);

    expect(parse(await readFile(localConfigPath(context.repoRoot), "utf8"))).toEqual({
      maxWorkers: 3,
      port: 4801,
      models: { judge: "sonnet" },
    });
  });

  it("refuses an invalid change, naming the key, and leaves the file untouched", async () => {
    const context = await makeProject({ ".mastermind/config.yaml": "port: 4800\n" });

    await expect(setConfig(context, { port: 70_000, autoRebase: true })).rejects.toThrow(
      /^config change: port: /,
    );
    expect(await readFile(localConfigPath(context.repoRoot), "utf8")).toBe("port: 4800\n");
  });
});
