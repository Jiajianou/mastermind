import { describe, expect, it } from "vitest";
import { buildClaudeArgs, ClaudeArgumentError } from "./claude.js";
import type { ClaudeCommand, PrintOptions } from "./claude.js";

const forbiddenFlags = ["--bare", "--max-budget-usd", "--dangerously-skip-permissions"];

const everyOption: PrintOptions = {
  model: "opus",
  inputFormat: "stream-json",
  sessionId: "8f3c2a91-0000-4000-8000-000000000001",
  resume: "8f3c2a91-0000-4000-8000-000000000002",
  includePartialMessages: true,
  replayUserMessages: true,
  jsonSchema: { type: "object" },
  maxTurns: 1,
  tools: ["Read", "Grep", "Glob"],
  allowedTools: ["Bash(make test)", "mcp__mastermind__*"],
  disallowedTools: ["WebFetch"],
  permissionMode: "bypassPermissions",
  noPermissionPrompts: true,
  appendSystemPromptFile: "prompts/worker.md",
  mcpConfigFile: ".mastermind/run/conductor-mcp.json",
  settings: { attribution: { commit: "", pr: "" } },
  fallbackModel: "sonnet",
  effort: "high",
  noSessionPersistence: true,
  name: "ext2-driver",
};

const invocations: ClaudeCommand[] = [
  { command: "version" },
  { command: "auth-status" },
  { command: "auth-login" },
  { command: "auth-logout" },
  { command: "print", options: { model: "haiku", inputFormat: "text" } },
  { command: "print", options: everyOption },
];

const startsLikeAFlag = (arg: string) => forbiddenFlags.some((flag) => arg.startsWith(flag));

describe("buildClaudeArgs", () => {
  it.each(invocations)("never emits a forbidden flag for $command", (invocation) => {
    expect(buildClaudeArgs(invocation).filter(startsLikeAFlag)).toEqual([]);
  });

  it("builds a stream-json print run with lists closed by the next flag and no positional prompt", () => {
    const args = buildClaudeArgs({
      command: "print",
      options: {
        model: "haiku",
        inputFormat: "text",
        tools: [],
        allowedTools: ["Read", "Bash(make test)"],
        maxTurns: 1,
      },
    });

    expect(args).toEqual([
      "-p",
      "--model",
      "haiku",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--max-turns",
      "1",
      "--tools",
      "",
      "--allowedTools",
      "Read",
      "Bash(make test)",
    ]);
  });

  it.each([
    { field: "model", options: { model: "--bare" } },
    { field: "name", options: { name: "--dangerously-skip-permissions" } },
    { field: "effort", options: { effort: "--max-budget-usd=5" } },
    { field: "tools", options: { tools: ["Read", "--bare"] } },
    { field: "allowedTools", options: { allowedTools: ["--dangerously-skip-permissions"] } },
    { field: "resume", options: { resume: "-r" } },
  ])("refuses a $field value that would smuggle in a flag", ({ options }) => {
    const invocation: ClaudeCommand = {
      command: "print",
      options: { model: "haiku", inputFormat: "text", ...options },
    };

    expect(() => buildClaudeArgs(invocation)).toThrow(ClaudeArgumentError);
  });
});
