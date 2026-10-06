import { z } from "zod";
import type { JsonValue } from "./contracts/index.js";
import { cleanEnv } from "./env.js";
import type { Environment } from "./env.js";
import { locateOnPath } from "./executables.js";
import { collectOutput } from "./procs.js";
import type {
  ChildHandle,
  CompletedRun,
  ExitResult,
  PipedIo,
  ProcessKind,
  ProcessRegistry,
} from "./procs.js";

type VersionParts = readonly [number, number, number];

const testedVersionParts: VersionParts = [2, 1, 283];
const minimumVersionParts: VersionParts = [2, 1, 283];
export const testedClaudeVersion = testedVersionParts.join(".");
export const minimumClaudeVersion = minimumVersionParts.join(".");

export const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export interface PrintOptions {
  model: string;
  inputFormat: "text" | "stream-json";
  sessionId?: string;
  resume?: string;
  includePartialMessages?: boolean;
  replayUserMessages?: boolean;
  jsonSchema?: JsonValue;
  maxTurns?: number;
  tools?: readonly string[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  permissionMode?: PermissionMode;
  noPermissionPrompts?: boolean;
  appendSystemPromptFile?: string;
  mcpConfig?: JsonValue;
  settings?: JsonValue;
  fallbackModel?: string;
  effort?: string;
  noSessionPersistence?: boolean;
  name?: string;
}

export type ClaudeCommand =
  | { command: "version" }
  | { command: "auth-status" }
  | { command: "auth-login" }
  | { command: "auth-logout" }
  | { command: "print"; options: PrintOptions };

export class ClaudeArgumentError extends Error {
  override readonly name = "ClaudeArgumentError";

  constructor(
    readonly flag: string,
    readonly value: string,
  ) {
    super(
      `refusing to pass ${JSON.stringify(value)} to ${flag}: a value must not look like a flag`,
    );
  }
}

function valued(flag: string, value: string | number | undefined): string[] {
  if (value === undefined) return [];
  const text = String(value);
  if (text.startsWith("-")) throw new ClaudeArgumentError(flag, text);
  return [flag, text];
}

function json(flag: string, value: JsonValue | undefined): string[] {
  return value === undefined ? [] : valued(flag, JSON.stringify(value));
}

// Variadic flags take every following argument up to the next flag, so each list is followed by another flag
// and the prompt always goes on stdin. An empty list is passed as one empty argument.
function list(flag: string, values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (values.length === 0) return [flag, ""];
  return [flag, ...values.flatMap((value) => valued(flag, value).slice(1))];
}

function toggle(flag: string, on: boolean | undefined): string[] {
  return on === true ? [flag] : [];
}

function printArgs(options: PrintOptions): string[] {
  return [
    "-p",
    ...valued("--model", options.model),
    ...valued("--input-format", options.inputFormat),
    ...valued("--output-format", "stream-json"),
    "--verbose",
    "--strict-mcp-config",
    ...valued("--session-id", options.sessionId),
    ...valued("--resume", options.resume),
    ...toggle("--include-partial-messages", options.includePartialMessages),
    ...toggle("--replay-user-messages", options.replayUserMessages),
    ...json("--json-schema", options.jsonSchema),
    ...valued("--max-turns", options.maxTurns),
    ...list("--tools", options.tools),
    ...list("--allowedTools", options.allowedTools),
    ...list("--disallowedTools", options.disallowedTools),
    ...valued("--permission-mode", options.permissionMode),
    ...(options.noPermissionPrompts === true ? ["--permission-prompts", "none"] : []),
    ...valued("--append-system-prompt-file", options.appendSystemPromptFile),
    ...json("--mcp-config", options.mcpConfig),
    ...json("--settings", options.settings),
    ...valued("--fallback-model", options.fallbackModel),
    ...valued("--effort", options.effort),
    ...toggle("--no-session-persistence", options.noSessionPersistence),
    ...valued("--name", options.name),
  ];
}

export function buildClaudeArgs(invocation: ClaudeCommand): string[] {
  switch (invocation.command) {
    case "version":
      return ["--version"];
    case "auth-status":
      return ["auth", "status", "--json"];
    case "auth-login":
      return ["auth", "login", "--claudeai"];
    case "auth-logout":
      return ["auth", "logout"];
    case "print":
      return printArgs(invocation.options);
  }
}

export interface ClaudeSpawnOptions {
  cwd: string;
  io: PipedIo;
}

export interface ClaudeCli {
  locate(): string | null;
  spawn(
    kind: ProcessKind,
    invocation: ClaudeCommand,
    options: ClaudeSpawnOptions,
  ): Promise<ChildHandle>;
  run(invocation: ClaudeCommand): Promise<CompletedRun>;
  handOff(invocation: ClaudeCommand): Promise<ExitResult>;
}

export interface ClaudeCliOptions {
  registry: ProcessRegistry;
  env: Environment;
}

export function createClaudeCli({ registry, env }: ClaudeCliOptions): ClaudeCli {
  const childEnv = cleanEnv(env);
  const request = (kind: ProcessKind, invocation: ClaudeCommand) => ({
    kind,
    command: "claude",
    args: buildClaudeArgs(invocation),
    env: childEnv,
  });

  return {
    locate: () => locateOnPath("claude", childEnv.PATH ?? ""),
    spawn: (kind, invocation, { cwd, io }) =>
      registry.spawn({ ...request(kind, invocation), cwd, io }),
    run: (invocation) => collectOutput(registry, request("utility", invocation)),
    async handOff(invocation) {
      const child = await registry.spawn({ ...request("utility", invocation), io: "inherit" });
      return child.exited;
    },
  };
}

function parseVersion(text: string): VersionParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: VersionParts, right: VersionParts): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export type ClaudeCheck =
  | { status: "missing" }
  | { status: "unreadable"; path: string; output: string }
  | { status: "too-old"; path: string; version: string }
  | { status: "ok"; path: string; version: string; tested: boolean };

export async function checkClaude(cli: ClaudeCli): Promise<ClaudeCheck> {
  const path = cli.locate();
  if (path === null) return { status: "missing" };
  const { exit, stdout, stderr } = await cli.run({ command: "version" });
  const parts = exit.kind === "exited" && exit.code === 0 ? parseVersion(stdout) : null;
  if (parts === null)
    return { status: "unreadable", path, output: [stdout, stderr].join("\n").trim() };
  const version = parts.join(".");
  if (compareVersions(parts, minimumVersionParts) < 0) return { status: "too-old", path, version };
  return { status: "ok", path, version, tested: compareVersions(parts, testedVersionParts) === 0 };
}

export interface CheckMessage {
  level: "ok" | "warning" | "error";
  message: string;
}

export function describeClaudeCheck(check: ClaudeCheck): CheckMessage {
  switch (check.status) {
    case "missing":
      return {
        level: "error",
        message:
          "Claude Code is not on your PATH. Install it with `npm install -g @anthropic-ai/claude-code`, then run mastermind again.",
      };
    case "unreadable":
      return {
        level: "error",
        message: `Could not read the version of ${check.path} from \`claude --version\`: ${check.output || "no output"}`,
      };
    case "too-old":
      return {
        level: "error",
        message: `Claude Code ${check.version} is older than ${minimumClaudeVersion}, the oldest version mastermind supports. Update it with \`claude update\`.`,
      };
    case "ok":
      return check.tested
        ? { level: "ok", message: `Claude Code ${check.version} (${check.path})` }
        : {
            level: "warning",
            message: `Claude Code ${check.version} has not been tested with mastermind, which was verified on ${testedClaudeVersion}.`,
          };
  }
}
