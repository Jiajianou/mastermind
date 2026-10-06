import { describe, expect, it } from "vitest";
import type { CommandKind, Toolchain } from "../contracts/config.js";
import { makeTempDir, writeFiles } from "../testing/temp-dir.js";
import { detectedCommandsConfig, detectProject } from "./detect.js";

const scripts = (entries: Record<string, string>) =>
  JSON.stringify({ name: "app", scripts: entries });

const makefile = [
  "CC := gcc",
  "VERSION ::= 1.0",
  ".PHONY: build test",
  "build: src/main.c",
  "\t$(CC) -o app src/main.c",
  "test lint: build",
  "\t./run-tests",
  "%.o: %.c",
].join("\n");

interface DetectionCase {
  name: string;
  files: Record<string, string>;
  commands: Partial<Record<CommandKind, string>>;
  toolchains: Toolchain[];
}

const cases: DetectionCase[] = [
  {
    name: "pnpm scripts, chosen by pnpm-lock.yaml",
    files: { "package.json": scripts({ build: "tsc", test: "vitest" }), "pnpm-lock.yaml": "" },
    commands: { setup: "pnpm install", build: "pnpm run build", test: "pnpm test" },
    toolchains: ["pnpm"],
  },
  {
    name: "yarn scripts, chosen by yarn.lock",
    files: { "package.json": scripts({ test: "jest" }), "yarn.lock": "" },
    commands: { setup: "yarn install", test: "yarn test" },
    toolchains: ["yarn"],
  },
  {
    name: "npm with a lockfile and npm's placeholder test script",
    files: {
      "package.json": scripts({
        build: "webpack",
        test: 'echo "Error: no test specified" && exit 1',
      }),
      "package-lock.json": "{}",
    },
    commands: { setup: "npm ci", build: "npm run build" },
    toolchains: ["npm"],
  },
  {
    name: "the packageManager field when there is no lockfile",
    files: {
      "package.json": JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { test: "vitest" },
      }),
    },
    commands: { setup: "pnpm install", test: "pnpm test" },
    toolchains: ["pnpm"],
  },
  {
    name: "Makefile targets ahead of package.json scripts",
    files: { Makefile: makefile, "package.json": scripts({ build: "tsc", test: "vitest" }) },
    commands: { setup: "npm install", build: "make build", test: "make test" },
    toolchains: ["npm"],
  },
  {
    name: "Makefile fallback targets all, check and deps",
    files: { Makefile: "all:\n\tcc main.c\ncheck: all\n\t./check\ndeps:\n\t./fetch\n" },
    commands: { setup: "make deps", build: "make all", test: "make check" },
    toolchains: [],
  },
  {
    name: "Cargo.toml",
    files: { "Cargo.toml": '[package]\nname = "kernel"\n' },
    commands: { setup: "cargo fetch", build: "cargo build", test: "cargo test" },
    toolchains: ["cargo"],
  },
  {
    name: "go.mod",
    files: { "go.mod": "module example.com/app\n" },
    commands: { setup: "go mod download", build: "go build ./...", test: "go test ./..." },
    toolchains: ["go"],
  },
  {
    name: "pyproject.toml with uv.lock",
    files: { "pyproject.toml": '[project]\nname = "app"\n', "uv.lock": "" },
    commands: { setup: "uv sync", test: "uv run pytest" },
    toolchains: ["uv"],
  },
  {
    name: "pyproject.toml with a [tool.poetry] table",
    files: { "pyproject.toml": '[tool.poetry]\nname = "app"\n' },
    commands: { setup: "poetry install", test: "poetry run pytest" },
    toolchains: ["poetry"],
  },
  {
    name: "plain pyproject.toml with pip",
    files: { "pyproject.toml": '[project]\nname = "app"\n' },
    commands: { setup: "python -m pip install -e .", test: "python -m pytest" },
    toolchains: ["pip"],
  },
  {
    name: "several ecosystems, the first source winning each command",
    files: {
      "go.mod": "module app\n",
      "pyproject.toml": "[tool.uv]\n",
      "yarn.lock": "",
      "package.json": "{}",
    },
    commands: { setup: "yarn install", build: "go build ./...", test: "go test ./..." },
    toolchains: ["yarn", "go", "uv"],
  },
  {
    name: "nothing recognisable",
    files: { "README.md": "# app\n" },
    commands: {},
    toolchains: [],
  },
];

describe("detectProject", () => {
  it.each(cases)("detects $name", async ({ files, commands, toolchains }) => {
    const repo = await makeTempDir();
    await writeFiles(repo, files);

    const detection = await detectProject(repo);

    expect(detectedCommandsConfig(detection)).toEqual(commands);
    expect(detection.toolchains).toEqual(toolchains);
    expect(detection.warnings).toEqual([]);
  });

  it("names the file each command came from, for the owner to confirm", async () => {
    const repo = await makeTempDir();
    await writeFiles(repo, {
      "package.json": scripts({ test: "vitest" }),
      "pnpm-lock.yaml": "",
      Makefile: makefile,
    });

    const { commands } = await detectProject(repo);

    expect(commands).toEqual({
      setup: {
        command: "pnpm install",
        source: "package.json dependencies via pnpm (pnpm-lock.yaml)",
      },
      build: { command: "make build", source: 'Makefile target "build"' },
      test: { command: "make test", source: 'Makefile target "test"' },
    });
  });

  it("skips a broken package.json with a warning and still detects other sources", async () => {
    const repo = await makeTempDir();
    await writeFiles(repo, { "package.json": "{ not json", "go.mod": "module app\n" });

    const detection = await detectProject(repo);

    expect(detectedCommandsConfig(detection)).toEqual({
      setup: "go mod download",
      build: "go build ./...",
      test: "go test ./...",
    });
    expect(detection.warnings).toEqual([expect.stringContaining("package.json was skipped")]);
  });
});
