import { basename, extname } from "node:path";
import { CliError } from "./errors.js";

const aliases: Readonly<Record<string, string>> = {
  "-p": "--print",
  "-v": "--version",
  "-r": "--resume",
  "-c": "--continue",
  "-h": "--help",
  "-d": "--debug",
};

const switchFlags = new Set([
  "--print",
  "--version",
  "--help",
  "--continue",
  "--verbose",
  "--debug",
  "--include-partial-messages",
  "--replay-user-messages",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--fork-session",
  "--bare",
  "--dangerously-skip-permissions",
  "--json",
  "--claudeai",
  "--console",
]);

const valueFlags = new Set([
  "--model",
  "--fallback-model",
  "--output-format",
  "--input-format",
  "--session-id",
  "--resume",
  "--json-schema",
  "--max-turns",
  "--permission-mode",
  "--permission-prompts",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--system-prompt",
  "--system-prompt-file",
  "--settings",
  "--setting-sources",
  "--effort",
  "--name",
  "--max-budget-usd",
]);

const listFlags = new Set([
  "--tools",
  "--allowedTools",
  "--disallowedTools",
  "--mcp-config",
  "--add-dir",
]);

export interface RawArgs {
  switches: Set<string>;
  values: Map<string, string>;
  lists: Map<string, string[]>;
  positionals: string[];
  unknownFlags: string[];
}

export function parseRawArgs(argv: readonly string[]): RawArgs {
  const parsed: RawArgs = {
    switches: new Set(),
    values: new Map(),
    lists: new Map(),
    positionals: [],
    unknownFlags: [],
  };
  let index = 0;
  const next = (): string | undefined => argv[index++];

  for (let token = next(); token !== undefined; token = next()) {
    if (token === "--") {
      parsed.positionals.push(...argv.slice(index));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      parsed.positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const written = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const flag = aliases[written] ?? written;

    if (switchFlags.has(flag)) {
      parsed.switches.add(flag);
    } else if (valueFlags.has(flag)) {
      const value = inline ?? next();
      if (value === undefined) throw new CliError(`error: option '${flag}' argument missing`);
      parsed.values.set(flag, value);
    } else if (listFlags.has(flag)) {
      const items = parsed.lists.get(flag) ?? [];
      if (inline !== undefined) {
        items.push(inline);
      } else {
        while (index < argv.length && !(argv[index] ?? "-").startsWith("-"))
          items.push(argv[index++] ?? "");
      }
      parsed.lists.set(flag, items);
    } else {
      parsed.unknownFlags.push(token);
    }
  }
  return parsed;
}

const outputFormats = ["text", "json", "stream-json"] as const;
const inputFormats = ["text", "stream-json"] as const;
export type OutputFormat = (typeof outputFormats)[number];
export type InputFormat = (typeof inputFormats)[number];

export interface PrintArgs {
  argv: readonly string[];
  model: string | undefined;
  outputFormat: OutputFormat;
  inputFormat: InputFormat;
  verbose: boolean;
  includePartialMessages: boolean;
  replayUserMessages: boolean;
  sessionId: string | undefined;
  resume: string | undefined;
  forkSession: boolean;
  jsonSchema: string | undefined;
  permissionMode: string;
  role: string | undefined;
  tools: string[] | undefined;
  mcpConfigs: string[];
  positionals: string[];
  unknownFlags: string[];
}

function pickFormat<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  const match = allowed.find((format) => format === value);
  if (match === undefined) {
    throw new CliError(
      `error: option '${flag} <format>' argument '${value}' is invalid. Allowed choices are ${allowed.join(", ")}.`,
    );
  }
  return match;
}

function roleFrom(promptFile: string | undefined): string | undefined {
  return promptFile === undefined ? undefined : basename(promptFile, extname(promptFile));
}

export function toPrintArgs(argv: readonly string[], raw: RawArgs): PrintArgs {
  const tools = raw.lists.get("--tools");
  return {
    argv,
    model: raw.values.get("--model"),
    outputFormat: pickFormat(
      "--output-format",
      raw.values.get("--output-format"),
      outputFormats,
      "text",
    ),
    inputFormat: pickFormat(
      "--input-format",
      raw.values.get("--input-format"),
      inputFormats,
      "text",
    ),
    verbose: raw.switches.has("--verbose"),
    includePartialMessages: raw.switches.has("--include-partial-messages"),
    replayUserMessages: raw.switches.has("--replay-user-messages"),
    sessionId: raw.values.get("--session-id"),
    resume: raw.values.get("--resume"),
    forkSession: raw.switches.has("--fork-session"),
    jsonSchema: raw.values.get("--json-schema"),
    permissionMode: raw.values.get("--permission-mode") ?? "default",
    role: roleFrom(raw.values.get("--append-system-prompt-file")),
    tools: tools?.flatMap((entry) => entry.split(/[\s,]+/)).filter((name) => name !== ""),
    mcpConfigs: raw.lists.get("--mcp-config") ?? [],
    positionals: raw.positionals,
    unknownFlags: raw.unknownFlags,
  };
}
