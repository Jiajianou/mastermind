import { randomUUID } from "node:crypto";
import type { PrintArgs } from "./args.js";
import { configDirectory } from "./auth.js";
import type { FakeConfig } from "./config.js";
import { CliError } from "./errors.js";
import { readAll, readStreamInput } from "./input.js";
import type { ControlRequest, MessageInput } from "./input.js";
import { controlResponseLine } from "./lines.js";
import type { SessionContext } from "./lines.js";
import type { InvocationLog } from "./log.js";
import { connectMcpServers } from "./mcp.js";
import { createOutput, flushAndExit } from "./output.js";
import type { Output } from "./output.js";
import { createChildProcesses } from "./processes.js";
import { loadScenario } from "./scenario.js";
import type { Scenario } from "./scenario.js";
import type { FakeState } from "./state.js";
import type { TurnRuntime } from "./steps.js";
import { runTurn } from "./turn.js";

const modelAliases: Readonly<Record<string, string>> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

const defaultModel = "claude-opus-5-5";

const builtInTools = [
  "Task",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "WebFetch",
  "WebSearch",
  "Write",
];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkPrintArgs(args: PrintArgs, config: FakeConfig, state: FakeState): string {
  if (args.outputFormat === "stream-json" && !args.verbose) {
    throw new CliError("Error: When using --print, --output-format=stream-json requires --verbose");
  }
  if (args.inputFormat === "stream-json" && args.outputFormat !== "stream-json") {
    throw new CliError("Error: --input-format=stream-json requires output-format=stream-json.");
  }
  if (args.sessionId !== undefined && args.resume !== undefined && !args.forkSession) {
    throw new CliError(
      "Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.",
    );
  }
  if (args.sessionId !== undefined) {
    if (!uuidPattern.test(args.sessionId))
      throw new CliError("Error: Invalid session ID. Must be a valid UUID.");
    if (state.hasSession(args.sessionId)) {
      throw new CliError(`Error: Session ID ${args.sessionId} is already in use.`);
    }
    return args.sessionId;
  }
  if (args.resume !== undefined) {
    const known = uuidPattern.test(args.resume) && state.hasSession(args.resume);
    if (config.stateDir !== undefined && !known) {
      throw new CliError(`No conversation found with session ID: ${args.resume}`);
    }
    return args.resume;
  }
  return randomUUID();
}

function resolveModel(alias: string | undefined): string {
  if (alias === undefined) return defaultModel;
  return modelAliases[alias] ?? alias;
}

function effectivePermissionMode(requested: string, model: string): string {
  return requested === "auto" && model.includes("haiku") ? "default" : requested;
}

export async function runPrint(
  args: PrintArgs,
  config: FakeConfig,
  state: FakeState,
  log: InvocationLog,
): Promise<number> {
  const sessionId = checkPrintArgs(args, config, state);
  state.addSession(sessionId);
  const scenario = loadScenario(config.scenarioPath);
  const mcp = await connectMcpServers(args.mcpConfigs, config.version);
  const model = resolveModel(args.model);
  const context: SessionContext = {
    sessionId,
    cwd: process.cwd(),
    model,
    permissionMode: effectivePermissionMode(args.permissionMode, model),
    tools: [
      ...(args.tools ?? builtInTools),
      ...(args.jsonSchema === undefined ? [] : ["StructuredOutput"]),
      ...mcp.toolNames,
    ],
    mcpServers: mcp.statuses,
    version: config.version,
    configDir: configDirectory(process.env),
  };
  const output = createOutput(args.outputFormat);
  const children = createChildProcesses(log);

  let ignoringSigterm = false;
  const terminate = (code: number): void => {
    children.killAll();
    void flushAndExit(code);
  };
  process.on("SIGTERM", () => {
    log.append({ kind: "signal", signal: "SIGTERM", ignored: ignoringSigterm });
    if (!ignoringSigterm) terminate(143);
  });
  process.on("SIGINT", () => {
    log.append({ kind: "signal", signal: "SIGINT", ignored: false });
    terminate(130);
  });

  let currentTurn: AbortController | undefined;
  const onControl = (request: ControlRequest): void => {
    answerControl(output, request, currentTurn);
  };
  const input =
    args.inputFormat === "stream-json" ? readStreamInput(process.stdin, onControl) : undefined;

  const runtimeFor = (resultIndex: number, signal: AbortSignal): TurnRuntime => ({
    context,
    args,
    output,
    log,
    state,
    children,
    mcp,
    input,
    signal,
    resultIndex,
    ignoreSigterm: () => {
      ignoringSigterm = true;
    },
  });

  if (input === undefined) {
    const prompt = await textPrompt(args);
    const outcome = await runTurn(runtimeFor(0, new AbortController().signal), scenario, prompt);
    return outcome.isError ? 1 : 0;
  }
  return runStreamTurns(input, scenario, (resultIndex) => {
    currentTurn = new AbortController();
    return runtimeFor(resultIndex, currentTurn.signal);
  });
}

function answerControl(
  output: Output,
  request: ControlRequest,
  turn: AbortController | undefined,
): void {
  if (request.subtype !== "interrupt") {
    output.line(
      controlResponseLine(request.requestId, {
        error: `Unsupported control request: ${request.subtype}`,
      }),
    );
    return;
  }
  output.line(controlResponseLine(request.requestId, { response: { still_queued: [] } }));
  turn?.abort();
}

async function textPrompt(args: PrintArgs): Promise<string> {
  const prompt =
    args.positionals.length > 0
      ? args.positionals.join(" ")
      : (await readAll(process.stdin)).trim();
  if (prompt === "") {
    throw new CliError(
      "Error: Input must be provided either through stdin or as a prompt argument when using --print",
    );
  }
  return prompt;
}

async function runStreamTurns(
  input: MessageInput,
  scenario: Scenario,
  startTurn: (resultIndex: number) => TurnRuntime,
): Promise<number> {
  const idle = new AbortController().signal;
  for (let resultIndex = 0; ; resultIndex += 1) {
    const prompt = await input.nextMessage(idle);
    if (prompt === undefined) return 0;
    await runTurn(startTurn(resultIndex), scenario, prompt);
  }
}
