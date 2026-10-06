import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AuthStatusError, checkAuth, describeAuth } from "../auth.js";
import { checkClaude, createClaudeCli, describeClaudeCheck } from "../claude.js";
import type { ClaudeCli } from "../claude.js";
import {
  ConfigError,
  hostPlatform,
  loadConfig,
  projectPaths,
  readOptionalFile,
  resolveConfigPath,
} from "../config/index.js";
import type { ConfigContext } from "../config/index.js";
import { isMissingFileError } from "../errno.js";
import { errorMessage, planLabel, plural } from "../contracts/index.js";
import type { Config } from "../contracts/index.js";
import { cleanEnv } from "../env.js";
import type { Environment } from "../env.js";
import { isExecutableFile, locateOnPath } from "../executables.js";
import { createGit } from "../git/index.js";
import { listLogFiles } from "../logs.js";
import { collectOutput, exitedCleanly, SpawnError } from "../procs.js";
import type { ProcessRegistry } from "../procs.js";
import { StartupError } from "./errors.js";
import { currentBranch, findRepo } from "./repo.js";

export const doctorCheckNames = [
  "git",
  "claude",
  "sign-in",
  "attribution",
  "config",
  "worktrees",
  "logs",
  "sandbox",
] as const;
export type DoctorCheckName = (typeof doctorCheckNames)[number];

export type DoctorLevel = "ok" | "warning" | "error" | "skipped";

export interface DoctorCheck {
  name: DoctorCheckName;
  level: DoctorLevel;
  message: string;
}

export interface DoctorOptions {
  path: string;
  env: Environment;
  homeDir: string;
  platform: NodeJS.Platform;
  registry: ProcessRegistry;
}

type Outcome = Omit<DoctorCheck, "name">;

const ok = (message: string): Outcome => ({ level: "ok", message });
const warning = (message: string): Outcome => ({ level: "warning", message });
const failure = (message: string): Outcome => ({ level: "error", message });
const skipped = (message: string): Outcome => ({ level: "skipped", message });

interface RepoState {
  outcome: Outcome;
  repoRoot: string | null;
}

async function checkGit({ path, env, registry }: DoctorOptions): Promise<RepoState> {
  const git = createGit({ registry, env });
  let version: string;
  try {
    version = (await git.run(".", ["--version"])).trim();
  } catch (error) {
    if (!(error instanceof SpawnError)) throw error;
    return { outcome: failure("git is not installed or not on your PATH."), repoRoot: null };
  }
  try {
    const repoRoot = await findRepo(git, path);
    const branch = await currentBranch(git, repoRoot);
    const where = branch === null ? "a detached HEAD" : `branch ${branch}`;
    return { outcome: ok(`${version} · ${repoRoot} on ${where}`), repoRoot };
  } catch (error) {
    if (!(error instanceof StartupError)) throw error;
    return { outcome: failure(error.message), repoRoot: null };
  }
}

async function checkSignIn(cli: ClaudeCli): Promise<Outcome> {
  try {
    const verdict = await checkAuth(cli);
    switch (verdict.kind) {
      case "accepted":
        return ok(`${verdict.email ?? "signed in"} (${planLabel(verdict.plan)})`);
      case "not-signed-in":
        return failure("Not signed in. Run `mastermind .` to sign in.");
      case "wrong-kind":
        return failure(describeAuth(verdict));
    }
  } catch (error) {
    if (!(error instanceof AuthStatusError)) throw error;
    return failure(error.message);
  }
}

const attributionOff = { commit: "", pr: "", sessionUrl: false } as const;
const attributionKeys = ["commit", "pr", "sessionUrl"] as const;

const claudeSettingsSchema = z.looseObject({
  attribution: z
    .looseObject({
      commit: z.string().optional(),
      pr: z.string().optional(),
      sessionUrl: z.boolean().optional(),
    })
    .optional(),
});

function claudeConfigDir(env: Environment, homeDir: string): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured === undefined || configured === "" ? join(homeDir, ".claude") : configured;
}

async function readClaudeSettings(path: string): Promise<unknown> {
  const text = await readOptionalFile(path);
  return text === null ? {} : JSON.parse(text);
}

async function checkAttribution({ env, homeDir }: DoctorOptions): Promise<Outcome> {
  const path = join(claudeConfigDir(env, homeDir), "settings.json");
  const advice = `Mastermind turns it off for its own sessions, but set "attribution": ${JSON.stringify(attributionOff)} in ${path} to keep it off everywhere.`;
  let settings: z.infer<typeof claudeSettingsSchema>;
  try {
    const parsed = claudeSettingsSchema.safeParse(await readClaudeSettings(path));
    if (!parsed.success) return warning(`${path} has an unexpected attribution setting. ${advice}`);
    settings = parsed.data;
  } catch (error) {
    return warning(`Could not read ${path}: ${errorMessage(error)}. ${advice}`);
  }
  const attribution = settings.attribution ?? {};
  const stillOn = attributionKeys.filter((key) => attribution[key] !== attributionOff[key]);
  if (stillOn.length === 0) return ok(`Claude attribution is off in ${path}`);
  return warning(`Claude attribution is not fully off (${stillOn.join(", ")}). ${advice}`);
}

async function checkConfig(
  context: ConfigContext,
): Promise<{ outcome: Outcome; config: Config | null }> {
  try {
    const config = await loadConfig(context);
    return { outcome: ok(`valid (main branch ${config.mainBranch})`), config };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { outcome: failure(error.message), config: null };
  }
}

async function listDir(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function formatKilobytes(kilobytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let size = kilobytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? "KB"}`;
}

async function checkWorktrees(
  options: DoctorOptions,
  context: ConfigContext,
  config: Config,
): Promise<Outcome> {
  const dir = resolveConfigPath(config.worktreeDir, context);
  const clones = await listDir(dir);
  if (clones === null || clones.length === 0) return ok(`no task clones yet in ${dir}`);
  const { exit, stdout, stderr } = await collectOutput(options.registry, {
    kind: "utility",
    command: "du",
    args: ["-sk", dir],
    env: cleanEnv(options.env),
  });
  const kilobytes = Number(/^\d+/.exec(stdout)?.[0]);
  if (!exitedCleanly(exit) || Number.isNaN(kilobytes))
    return warning(`Could not measure ${dir}: ${stderr.trim() || "du failed"}`);
  const count = plural(clones.length, "task clone");
  return ok(`${formatKilobytes(kilobytes)} in ${count} in ${dir}`);
}

async function checkLogs(context: ConfigContext, config: Config): Promise<Outcome> {
  const dir = projectPaths(context.repoRoot).logs;
  const kept = `kept for ${config.logRetention}`;
  const files = await listLogFiles(dir);
  if (files.length === 0) return ok(`no logs yet in ${dir}, ${kept}`);
  const kilobytes = Math.ceil(files.reduce((total, { bytes }) => total + bytes, 0) / 1024);
  const count = plural(files.length, "file");
  return ok(`${formatKilobytes(kilobytes)} in ${count} in ${dir}, ${kept}`);
}

const linuxSandboxTools = [
  { command: "bwrap", label: "bubblewrap (bwrap)" },
  { command: "socat", label: "socat" },
];

function checkSandbox({ env, platform }: DoctorOptions, config: Config | null): Outcome {
  if (config?.sandbox.enabled === false)
    return warning("The sandbox is turned off for this project, so workers run unconfined.");
  switch (hostPlatform(platform)) {
    case "darwin":
      return isExecutableFile("/usr/bin/sandbox-exec")
        ? ok("macOS sandbox-exec is available")
        : failure("/usr/bin/sandbox-exec is missing, so sandboxed sessions cannot start.");
    case "linux": {
      const missing = linuxSandboxTools.filter(
        ({ command }) => locateOnPath(command, env.PATH ?? "") === null,
      );
      if (missing.length === 0) return ok("bubblewrap and socat are available");
      return failure(
        `${missing.map(({ label }) => label).join(" and ")} not found, so sandboxed sessions cannot start. Install them (for example \`sudo apt install bubblewrap socat\`) or turn the sandbox off in Settings.`,
      );
    }
    case null:
      return failure(`Mastermind runs on macOS and Linux, not ${platform}.`);
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const cli = createClaudeCli({ registry: options.registry, env: options.env });
  const git = await checkGit(options);
  const claude: Outcome = describeClaudeCheck(await checkClaude(cli));
  const signIn = claude.level === "error" ? skipped("needs Claude Code") : await checkSignIn(cli);
  const attribution = await checkAttribution(options);

  const context =
    git.repoRoot === null ? null : { repoRoot: git.repoRoot, homeDir: options.homeDir };
  const config = context === null ? null : await checkConfig(context);
  const validConfig = config?.config ?? null;
  const worktrees =
    context === null || validConfig === null
      ? skipped("needs a valid config")
      : await checkWorktrees(options, context, validConfig);
  const logs =
    context === null || validConfig === null
      ? skipped("needs a valid config")
      : await checkLogs(context, validConfig);
  const sandbox = checkSandbox(options, validConfig);

  const outcomes: Record<DoctorCheckName, Outcome> = {
    git: git.outcome,
    claude,
    "sign-in": signIn,
    attribution,
    config: config?.outcome ?? skipped("needs a git repository"),
    worktrees,
    logs,
    sandbox,
  };
  return doctorCheckNames.map((name) => ({ name, ...outcomes[name] }));
}

const marks: Record<DoctorLevel, string> = { ok: "✓", warning: "!", error: "✗", skipped: "-" };

export function doctorPassed(checks: readonly DoctorCheck[]): boolean {
  return checks.every(({ level }) => level !== "error");
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map(({ name }) => name.length));
  const lines = checks.map(
    ({ name, level, message }) => `${marks[level]} ${name.padEnd(width)}  ${message}`,
  );
  const failed = checks.filter(({ level }) => level === "error").length;
  const warned = checks.filter(({ level }) => level === "warning").length;
  const summary =
    failed > 0
      ? `${plural(failed, "check")} failed.`
      : warned > 0
        ? `All checks passed, with ${plural(warned, "warning")}.`
        : "All checks passed.";
  return [...lines, "", summary, ""].join("\n");
}
