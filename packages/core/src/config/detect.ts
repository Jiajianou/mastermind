import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commandKindSchema } from "../contracts/config.js";
import type {
  CommandKind,
  DetectedCommand,
  ProjectDetection,
  Toolchain,
} from "../contracts/config.js";

interface SourceDetection {
  commands: Partial<Record<CommandKind, DetectedCommand>>;
  toolchains: Toolchain[];
  warnings: string[];
}

interface RepoListing {
  files: ReadonlySet<string>;
  read(name: string): Promise<string>;
}

type Detector = (repo: RepoListing) => Promise<SourceDetection | null>;

const makefileNames = ["GNUmakefile", "makefile", "Makefile"];
const makeTargetLine = /^([^\s#=:%.$][^#=:%$]*?)\s*(?::(?![:=])|::(?!=))/;
const makeTargetChoices: Record<CommandKind, readonly string[]> = {
  setup: ["setup", "deps", "bootstrap"],
  build: ["build", "all"],
  test: ["test", "check"],
};

function makeTargets(makefile: string): Set<string> {
  const targets = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    const names = makeTargetLine.exec(line)?.[1];
    for (const name of names?.split(/\s+/) ?? []) targets.add(name);
  }
  return targets;
}

const detectMakefile: Detector = async (repo) => {
  const name = makefileNames.find((candidate) => repo.files.has(candidate));
  if (name === undefined) return null;
  const targets = makeTargets(await repo.read(name));
  const commands: SourceDetection["commands"] = {};
  for (const kind of commandKindSchema.options) {
    const target = makeTargetChoices[kind].find((choice) => targets.has(choice));
    if (target !== undefined)
      commands[kind] = { command: `make ${target}`, source: `${name} target "${target}"` };
  }
  return { commands, toolchains: [], warnings: [] };
};

const packageJsonSchema = z.looseObject({
  scripts: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
});

type NodePackageManager = "npm" | "pnpm" | "yarn";

const nodeLockfiles: readonly [string, NodePackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

interface NodePackageManagerChoice {
  manager: NodePackageManager;
  reason: string;
  locked: boolean;
}

function nodePackageManager(
  repo: RepoListing,
  declared: string | undefined,
): NodePackageManagerChoice {
  const lockfile = nodeLockfiles.find(([file]) => repo.files.has(file));
  if (lockfile !== undefined) return { manager: lockfile[1], reason: lockfile[0], locked: true };
  const declaredManager = (["pnpm", "yarn", "npm"] as const).find((manager) =>
    declared?.startsWith(`${manager}@`),
  );
  if (declaredManager !== undefined)
    return { manager: declaredManager, reason: "packageManager field", locked: false };
  return { manager: "npm", reason: "no lockfile", locked: false };
}

function nodeInstallCommand({ manager, locked }: NodePackageManagerChoice): string {
  if (manager !== "npm") return `${manager} install`;
  return locked ? "npm ci" : "npm install";
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function skipped(warning: string): SourceDetection {
  return { commands: {}, toolchains: [], warnings: [warning] };
}

const detectPackageJson: Detector = async (repo) => {
  if (!repo.files.has("package.json")) return null;
  const json = parseJson(await repo.read("package.json"));
  if (!json.ok)
    return skipped(`package.json was skipped because it is not valid JSON: ${json.message}`);
  const packageJson = packageJsonSchema.safeParse(json.value);
  if (!packageJson.success)
    return skipped("package.json was skipped because it is not an object with string scripts");
  const { scripts = {}, packageManager } = packageJson.data;
  const choice = nodePackageManager(repo, packageManager);
  const { manager } = choice;
  const via = `via ${manager} (${choice.reason})`;
  const commands: SourceDetection["commands"] = {
    setup: { command: nodeInstallCommand(choice), source: `package.json dependencies ${via}` },
  };
  if (scripts.build !== undefined) {
    commands.build = {
      command: `${manager} run build`,
      source: `package.json script "build" ${via}`,
    };
  }
  if (scripts.test !== undefined && !scripts.test.includes("no test specified")) {
    commands.test = { command: `${manager} test`, source: `package.json script "test" ${via}` };
  }
  return { commands, toolchains: [manager], warnings: [] };
};

const detectCargo: Detector = (repo) =>
  Promise.resolve(
    repo.files.has("Cargo.toml")
      ? {
          commands: {
            setup: { command: "cargo fetch", source: "Cargo.toml" },
            build: { command: "cargo build", source: "Cargo.toml" },
            test: { command: "cargo test", source: "Cargo.toml" },
          },
          toolchains: ["cargo"],
          warnings: [],
        }
      : null,
  );

const detectGo: Detector = (repo) =>
  Promise.resolve(
    repo.files.has("go.mod")
      ? {
          commands: {
            setup: { command: "go mod download", source: "go.mod" },
            build: { command: "go build ./...", source: "go.mod" },
            test: { command: "go test ./...", source: "go.mod" },
          },
          toolchains: ["go"],
          warnings: [],
        }
      : null,
  );

const pythonCommands: Record<"uv" | "poetry" | "pip", { setup: string; test: string }> = {
  uv: { setup: "uv sync", test: "uv run pytest" },
  poetry: { setup: "poetry install", test: "poetry run pytest" },
  pip: { setup: "python -m pip install -e .", test: "python -m pytest" },
};

function pythonManager(
  repo: RepoListing,
  pyproject: string,
): { manager: "uv" | "poetry" | "pip"; reason: string } {
  if (repo.files.has("uv.lock")) return { manager: "uv", reason: "uv.lock" };
  if (repo.files.has("poetry.lock")) return { manager: "poetry", reason: "poetry.lock" };
  if (/^\[tool\.uv\b/m.test(pyproject)) return { manager: "uv", reason: "[tool.uv]" };
  if (/^\[tool\.poetry\b/m.test(pyproject)) return { manager: "poetry", reason: "[tool.poetry]" };
  return { manager: "pip", reason: "no lockfile" };
}

const detectPyproject: Detector = async (repo) => {
  if (!repo.files.has("pyproject.toml")) return null;
  const { manager, reason } = pythonManager(repo, await repo.read("pyproject.toml"));
  const source = `pyproject.toml via ${manager} (${reason})`;
  return {
    commands: {
      setup: { command: pythonCommands[manager].setup, source },
      test: { command: pythonCommands[manager].test, source },
    },
    toolchains: [manager],
    warnings: [],
  };
};

const detectors: readonly Detector[] = [
  detectMakefile,
  detectPackageJson,
  detectCargo,
  detectGo,
  detectPyproject,
];

export async function detectProject(repoRoot: string): Promise<ProjectDetection> {
  const repo: RepoListing = {
    files: new Set(await readdir(repoRoot)),
    read: (name) => readFile(join(repoRoot, name), "utf8"),
  };
  const detection: ProjectDetection = {
    commands: { setup: null, build: null, test: null },
    toolchains: [],
    warnings: [],
  };
  for (const detector of detectors) {
    const found = await detector(repo);
    if (found === null) continue;
    for (const kind of commandKindSchema.options) {
      detection.commands[kind] ??= found.commands[kind] ?? null;
    }
    detection.toolchains.push(
      ...found.toolchains.filter((toolchain) => !detection.toolchains.includes(toolchain)),
    );
    detection.warnings.push(...found.warnings);
  }
  return detection;
}

export function detectedCommandsConfig({
  commands,
}: ProjectDetection): Partial<Record<CommandKind, string>> {
  const config: Partial<Record<CommandKind, string>> = {};
  for (const kind of commandKindSchema.options) {
    const detected = commands[kind];
    if (detected !== null) config[kind] = detected.command;
  }
  return config;
}
