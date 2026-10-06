import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PrintArgs } from "./args.js";
import { FakeExit, FakeSetupError } from "./errors.js";
import { emitAuthFailure, emitUsageLimit, defaultResetsAt } from "./failures.js";
import { waitUnlessInterrupted } from "./interrupt.js";
import type { MessageInput } from "./input.js";
import {
  assistantLine,
  newMessageId,
  newToolUseId,
  partialClosingLines,
  partialOpeningLines,
  rateLimitLine,
  replayLine,
  toolResultLine,
  vcsStateLine,
} from "./lines.js";
import type { AssistantBlock, SessionContext, ToolResult, ToolUseMeta } from "./lines.js";
import type { InvocationLog } from "./log.js";
import type { McpClients } from "./mcp.js";
import type { Output } from "./output.js";
import type { ChildProcesses, CommandOutput } from "./processes.js";
import { matchesText } from "./scenario.js";
import type { Step } from "./scenario.js";
import type { FakeState } from "./state.js";

export const defaultTrailer = "Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>";

export interface TurnRuntime {
  context: SessionContext;
  args: PrintArgs;
  output: Output;
  log: InvocationLog;
  state: FakeState;
  children: ChildProcesses;
  mcp: McpClients;
  input: MessageInput | undefined;
  signal: AbortSignal;
  resultIndex: number;
  ignoreSigterm(): void;
}

export interface TurnProgress {
  numTurns: number;
  rateLimitReported: boolean;
  lastText: string;
  structuredOutput: unknown;
}

export function receiveMessage(runtime: TurnRuntime, text: string): void {
  if (runtime.args.replayUserMessages) runtime.output.line(replayLine(runtime.context, text));
  runtime.log.append({ kind: "message", text });
}

function emitAssistant(runtime: TurnRuntime, progress: TurnProgress, block: AssistantBlock): void {
  const { context, output } = runtime;
  const messageId = newMessageId();
  const partial = runtime.args.includePartialMessages;
  if (partial) for (const line of partialOpeningLines(context, messageId, block)) output.line(line);
  output.line(assistantLine(context, messageId, block));
  if (partial) {
    const stopReason = block.type === "text" ? "end_turn" : "tool_use";
    for (const line of partialClosingLines(context, stopReason)) output.line(line);
  }
  if (!progress.rateLimitReported) {
    const resetsAt = Math.floor(Date.now() / 1000) + 5 * 3600;
    output.line(rateLimitLine(context, { status: "allowed", resetsAt, utilization: 0.11 }));
    progress.rateLimitReported = true;
  }
}

async function useTool(
  runtime: TurnRuntime,
  progress: TurnProgress,
  name: string,
  input: Record<string, unknown>,
  perform: () => Promise<ToolResult> | ToolResult,
  { wireInput = input, meta }: { wireInput?: Record<string, unknown>; meta?: ToolUseMeta } = {},
): Promise<void> {
  const id = newToolUseId();
  emitAssistant(runtime, progress, { type: "tool_use", id, name, input, wireInput, meta });
  const result = await perform();
  runtime.output.line(toolResultLine(runtime.context, id, result));
  progress.numTurns += 1;
}

const failedTool = (text: string): ToolResult => ({
  content: text,
  toolUseResult: `Error: ${text}`,
  isError: true,
});

function readFile(path: string, cwd: string): ToolResult {
  if (!existsSync(path)) {
    return failedTool(`File does not exist. Note: your current working directory is ${cwd}.`);
  }
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  return {
    content: lines.map((line, index) => `${String(index + 1)}\t${line}`).join("\n"),
    toolUseResult: {
      type: "text",
      file: {
        filePath: path,
        content,
        numLines: lines.length,
        startLine: 1,
        totalLines: lines.length,
      },
    },
  };
}

function writeFile(path: string, content: string): ToolResult {
  const originalFile = existsSync(path) ? readFileSync(path, "utf8") : null;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return {
    content:
      originalFile === null
        ? `File created successfully at: ${path}`
        : `The file ${path} has been updated successfully.`,
    toolUseResult: {
      type: originalFile === null ? "create" : "update",
      filePath: path,
      content,
      structuredPatch: [],
      originalFile,
      userModified: false,
    },
  };
}

function editFile(
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ToolResult {
  if (!existsSync(path)) return failedTool("<tool_use_error>File does not exist.</tool_use_error>");
  const originalFile = readFileSync(path, "utf8");
  if (!originalFile.includes(oldString)) {
    return failedTool(
      `<tool_use_error>String to replace not found in file.\nString: ${oldString}</tool_use_error>`,
    );
  }
  const updated = replaceAll
    ? originalFile.replaceAll(oldString, newString)
    : originalFile.replace(oldString, () => newString);
  writeFileSync(path, updated);
  return {
    content: `The file ${path} has been updated successfully.`,
    toolUseResult: {
      filePath: path,
      oldString,
      newString,
      originalFile,
      structuredPatch: [],
      userModified: false,
      replaceAll,
    },
  };
}

function commandResult(output: CommandOutput, extra: object = {}): ToolResult {
  const combined = [output.stdout, output.stderr].filter((text) => text !== "").join("\n");
  if (output.exitCode !== 0) return failedTool(`Exit code ${String(output.exitCode)}\n${combined}`);
  return {
    content: combined,
    toolUseResult: {
      stdout: output.stdout,
      stderr: output.stderr,
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      ...extra,
    },
    isError: false,
  };
}

function commitCommand(message: string, trailer: true | string | undefined): string {
  const trailerLine = trailer === true ? defaultTrailer : trailer;
  const fullMessage = trailerLine === undefined ? message : `${message}\n\n${trailerLine}`;
  return `git add -A && git commit -m "$(cat <<'EOF'\n${fullMessage}\nEOF\n)"`;
}

async function commit(runtime: TurnRuntime, command: string): Promise<ToolResult> {
  const output = await runtime.children.runCommand(command, runtime.context.cwd, runtime.signal);
  const made = /^\[(\S+)(?: \(root-commit\))? ([0-9a-f]+)\]/.exec(output.stdout);
  const branch = made?.[1];
  const sha = made?.[2];
  if (output.exitCode !== 0 || branch === undefined || sha === undefined)
    return commandResult(output);
  runtime.output.line(vcsStateLine(runtime.context, branch));
  return commandResult(output, { gitOperation: { commit: { sha, kind: "committed", branch } } });
}

function requireInput(runtime: TurnRuntime): MessageInput {
  if (runtime.input === undefined) {
    throw new FakeSetupError("an awaitMessage step needs --input-format stream-json");
  }
  return runtime.input;
}

async function runStep(runtime: TurnRuntime, step: Step, progress: TurnProgress): Promise<void> {
  const { context, signal } = runtime;
  const inCwd = (path: string): string => resolve(context.cwd, path);

  switch (step.kind) {
    case "text":
      emitAssistant(runtime, progress, { type: "text", text: step.text });
      progress.lastText = step.text;
      return;
    case "read":
      return useTool(runtime, progress, "Read", { file_path: inCwd(step.path) }, () =>
        readFile(inCwd(step.path), context.cwd),
      );
    case "write":
    case "resultFile": {
      const path = inCwd(step.kind === "write" ? step.path : ".mastermind-result.md");
      return useTool(runtime, progress, "Write", { file_path: path, content: step.content }, () =>
        writeFile(path, step.content),
      );
    }
    case "edit": {
      const replaceAll = step.replaceAll ?? false;
      const wireInput = {
        file_path: inCwd(step.path),
        old_string: step.oldString,
        new_string: step.newString,
        ...(step.replaceAll === undefined ? {} : { replace_all: step.replaceAll }),
      };
      const input = { replace_all: replaceAll, ...wireInput };
      return useTool(
        runtime,
        progress,
        "Edit",
        input,
        () => editFile(inCwd(step.path), step.oldString, step.newString, replaceAll),
        { wireInput },
      );
    }
    case "bash": {
      const input =
        step.description === undefined
          ? { command: step.command }
          : { command: step.command, description: step.description };
      return useTool(runtime, progress, "Bash", input, async () =>
        commandResult(await runtime.children.runCommand(step.command, context.cwd, signal)),
      );
    }
    case "commit": {
      const command = commitCommand(step.message, step.trailer);
      return useTool(runtime, progress, "Bash", { command }, () => commit(runtime, command));
    }
    case "structuredOutput": {
      if (runtime.args.jsonSchema === undefined) {
        throw new FakeSetupError("a structuredOutput step needs --json-schema");
      }
      progress.structuredOutput = step.output;
      progress.lastText = JSON.stringify(step.output);
      const confirmation = "Structured output provided successfully";
      return useTool(runtime, progress, "StructuredOutput", step.output, () => ({
        content: confirmation,
        toolUseResult: confirmation,
      }));
    }
    case "mcp": {
      const server = step.server ?? "mastermind";
      const args = step.arguments ?? {};
      const meta = runtime.mcp.toolMeta(server, step.tool);
      return useTool(
        runtime,
        progress,
        `mcp__${server}__${step.tool}`,
        args,
        async () => {
          const result = await runtime.mcp.callTool(server, step.tool, args);
          const errorFlag = result.isError === true ? { isError: true } : {};
          return { content: result.content, toolUseResult: result.content, ...errorFlag };
        },
        meta === undefined ? {} : { meta },
      );
    }
    case "sleep":
      return waitUnlessInterrupted(step.ms, signal);
    case "hang":
      if (step.ignoreSigterm === true) runtime.ignoreSigterm();
      return waitUnlessInterrupted(undefined, signal);
    case "spawnGrandchild":
      runtime.children.spawnGrandchild(step.marker ?? "", step.sameGroup !== true);
      return;
    case "awaitMessage": {
      const text = await requireInput(runtime).nextMessage(signal);
      if (text === undefined) return;
      receiveMessage(runtime, text);
      const branch = step.branches.find(({ when }) => matchesText(when, text));
      return runSteps(runtime, branch?.steps ?? step.otherwise ?? [], progress);
    }
    case "usageLimit":
      emitUsageLimit(
        runtime.output,
        context,
        step.resetsAt ?? defaultResetsAt(Date.now()),
        runtime.resultIndex,
      );
      throw new FakeExit(1);
    case "authExpired":
      emitAuthFailure(
        runtime.output,
        context,
        step.variant ?? "invalid-token",
        runtime.resultIndex,
      );
      if (step.signOut === true) runtime.state.setAccount("signed-out");
      throw new FakeExit(1);
    case "crash":
      process.stderr.write(`${step.stderr ?? "fake-claude: simulated crash"}\n`);
      throw new FakeExit(step.exitCode ?? 1);
  }
}

export async function runSteps(
  runtime: TurnRuntime,
  steps: readonly Step[],
  progress: TurnProgress,
): Promise<void> {
  for (const step of steps) {
    await runStep(runtime, step, progress);
    for (const text of runtime.input?.takeQueued() ?? []) receiveMessage(runtime, text);
  }
}
