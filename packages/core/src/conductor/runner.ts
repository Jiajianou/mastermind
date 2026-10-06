import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../contracts/index.js";
import { postChatMessage } from "../chat.js";
import type { ClaudeCli, PrintOptions } from "../claude.js";
import type {
  ChatStatus,
  ChatTurn,
  ChatTurnRef,
  ExitOutcome,
  Session,
} from "../contracts/index.js";
import type { Db, NewChatMessage } from "../db/index.js";
import type { EventBus } from "../events.js";
import { exitCode, stopGroup } from "../procs.js";
import type { ChildHandle, ExitResult } from "../procs.js";
import {
  attributionOff,
  classifyExit,
  createStreamParser,
  userMessageLine,
} from "../sessions/index.js";
import type { EventDetails, ParsedEvent, StreamParser, UsageBackoff } from "../sessions/index.js";
import { summariseActions } from "./action-line.js";
import { turnPrompt, wakeText, withSummary } from "./prompt.js";
import { conductorRolloverTokens } from "./rollover.js";
import type { ConductorSummariser } from "./rollover.js";
import { createTurnRecorder } from "./turn.js";
import type { TurnRecorder } from "./turn.js";

export const conductorIdleMs = 10 * 60_000;
const interruptGraceMs = 10_000;

export class ConductorToolsUnavailableError extends Error {
  override readonly name = "ConductorToolsUnavailableError";

  constructor(readonly status: string | null) {
    super(`the chat could not reach mastermind's tools (MCP server ${status ?? "missing"})`);
  }
}

export interface ChatRunnerOptions {
  db: Db;
  bus: EventBus;
  cli: ClaudeCli;
  repoRoot: string;
  systemPromptFile: string;
  logsDir: string;
  mcpConfigPath: string;
  model: () => string;
  digest: () => string;
  backoff: Pick<UsageBackoff, "reportUsageLimit">;
  summariser: ConductorSummariser;
  onError: (error: unknown) => void;
  idleMs?: number;
  rolloverTokens?: number;
}

export interface ChatRunner {
  send(text: string): ChatTurn;
  wake(): void;
  stop(): boolean;
  status(): ChatStatus;
  activeTurn(): ChatTurnRef | null;
  dispose(): void;
}

interface Conversation {
  id: string;
  stored: boolean;
}

interface DeferredTurn {
  ref: ChatTurnRef;
  texts: string[];
}

interface ConductorProcess {
  session: Session;
  conversationId: string;
  model: string;
  resumed: boolean;
  prompted: boolean;
  parser: StreamParser;
  rawLog: WriteStream;
  stderr: string[];
  evidence: ParsedEvent[];
  lastResult: ParsedEvent | null;
  initSeen: boolean;
  endedByMastermind: boolean;
  child: ChildHandle | null;
  closed: Promise<void>;
}

interface Turn {
  ref: ChatTurnRef;
  recorder: TurnRecorder;
  process: ConductorProcess | null;
  queued: string[];
  written: number;
  delivered: number;
  stopRequested: boolean;
}

type TurnEnd =
  { kind: "result"; event: ParsedEvent } | { kind: "stopped" } | { kind: "failed"; reason: string };

type InitDetails = Extract<EventDetails, { line: "init" }>;

const interruptLine = (): string =>
  `${JSON.stringify({
    type: "control_request",
    request_id: `stop-${randomUUID()}`,
    request: { subtype: "interrupt" },
  })}\n`;

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

function failureText(outcome: ExitOutcome): string | null {
  switch (outcome.status) {
    case "succeeded":
      return null;
    case "auth_failed":
      return "Mastermind couldn't reply: your Claude sign-in has expired.";
    case "rate_limited":
      return "Mastermind couldn't reply: the usage limit was reached.";
    case "failed":
      return `Mastermind couldn't reply: ${outcome.reason}`;
  }
}

// One persistent stream-json process (docs/claude-cli-notes.md): each owner message is a stdin line, a message sent
// mid-turn joins the running turn, Stop is a control_request interrupt, and an idle process is stopped and later
// resumed by its session id.
export function createChatRunner(options: ChatRunnerOptions): ChatRunner {
  const { db, bus, cli, onError, idleMs = conductorIdleMs } = options;
  const rolloverTokens = options.rolloverTokens ?? conductorRolloverTokens;
  const sessionLogsDir = join(options.logsDir, "sessions");
  const post = (message: NewChatMessage) => postChatMessage({ db, bus }, message);

  let conversation = currentConversation();
  let cursor = db.chat.list().findLast((message) => message.kind === "user")?.id ?? 0;
  let live: ConductorProcess | null = null;
  let previousExit: Promise<void> = Promise.resolve();
  let turn: Turn | null = null;
  let deferred: DeferredTurn | null = null;
  let rollover: Promise<void> | null = null;
  let rolloverTried: { conversationId: string; tokens: number } | null = null;
  let wakeQueued = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function currentConversation(): Conversation {
    const stored = db.conductorSessions.current();
    return stored === null ? { id: randomUUID(), stored: false } : { id: stored.id, stored: true };
  }

  function forgetConversation(conversationId: string): void {
    if (conversation.id !== conversationId) return;
    if (conversation.stored) db.conductorSessions.end(conversation.id);
    conversation = { id: randomUUID(), stored: false };
  }

  function rolloverDue(): number | null {
    if (!conversation.stored) return null;
    const stored = db.conductorSessions.current();
    const tokens = stored?.id === conversation.id ? stored.tokens : null;
    if (tokens === null || tokens < rolloverTokens) return null;
    const tried =
      rolloverTried?.conversationId === conversation.id && rolloverTried.tokens === tokens;
    return tried ? null : tokens;
  }

  // The conversation is replaced only once its summary exists, so a judge call that fails leaves the chat where it
  // was, and the rollover is tried again after the next turn.
  async function rollOver(conversationId: string, tokens: number): Promise<void> {
    rolloverTried = { conversationId, tokens };
    const summary = await options.summariser.summarise(conversationId);
    if (summary === null || disposed || conversation.id !== conversationId) return;
    if (live !== null) await endProcess(live);
    db.conductorSessions.end(conversationId, summary);
    conversation = { id: randomUUID(), stored: false };
  }

  function rollOverIfDue(): Promise<void> {
    const tokens = rollover === null ? rolloverDue() : null;
    if (tokens !== null)
      rollover = rollOver(conversation.id, tokens)
        .catch(onError)
        .finally(() => {
          rollover = null;
        });
    return rollover ?? Promise.resolve();
  }

  // A wake turn needs event lines the Conductor hasn't seen, and a Claude that can answer.
  function wakeAllowed(): boolean {
    const { authRequired, backoffResumeAt } = db.flags.get();
    const backingOff = backoffResumeAt !== null && Date.parse(backoffResumeAt) > Date.now();
    const news = db.chat.list(cursor).some((message) => message.kind === "system");
    return news && !disposed && !authRequired && !backingOff;
  }

  function printOptions(model: string): PrintOptions {
    const session = conversation.stored
      ? { resume: conversation.id }
      : { sessionId: conversation.id };
    return {
      model,
      inputFormat: "stream-json",
      ...session,
      includePartialMessages: true,
      replayUserMessages: true,
      mcpConfigFile: options.mcpConfigPath,
      tools: ["Read,Grep,Glob"],
      allowedTools: ["mcp__mastermind__* Read Grep Glob"],
      appendSystemPromptFile: options.systemPromptFile,
      settings: { attribution: attributionOff },
    };
  }

  function write(proc: ConductorProcess, line: string): void {
    proc.child?.stdin?.write(line);
  }

  function deliver(current: Turn, proc: ConductorProcess, text: string): void {
    write(proc, `${userMessageLine(text)}\n`);
    current.written += 1;
  }

  const newTurnRef = (): ChatTurnRef => ({
    turnId: randomUUID(),
    conductorSession: conversation.id,
  });

  function startTurn(process: ConductorProcess | null, written = 0, ref = newTurnRef()): Turn {
    const started: Turn = {
      ref,
      recorder: createTurnRecorder(),
      process,
      queued: [],
      written,
      delivered: 0,
      stopRequested: false,
    };
    turn = started;
    bus.emit({ type: "chat.turn", turnId: started.ref.turnId, replying: true });
    return started;
  }

  function endProcess(proc: ConductorProcess): Promise<void> {
    proc.endedByMastermind = true;
    if (live === proc) live = null;
    if (proc.child !== null) stopGroup(proc.child).catch(onError);
    return proc.closed;
  }

  function scheduleIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (turn === null && live !== null) void endProcess(live);
    }, idleMs);
    idleTimer.unref();
  }

  function checkInit(proc: ConductorProcess, details: InitDetails): void {
    if (!proc.initSeen) {
      proc.initSeen = true;
      if (!conversation.stored && conversation.id === proc.conversationId) {
        db.conductorSessions.open(conversation.id);
        conversation = { id: conversation.id, stored: true };
      }
    }
    const server = details.mcpServers.find(({ name }) => name === "mastermind");
    if (server?.status === "connected") return;
    const error = new ConductorToolsUnavailableError(server?.status ?? null);
    onError(error);
    void endProcess(proc);
    if (turn?.process === proc) finish(turn, { kind: "failed", reason: error.message });
  }

  function turnFailure(current: Turn, end: TurnEnd): string | null {
    if (end.kind === "stopped" || current.stopRequested) return null;
    if (end.kind === "failed") return `Mastermind couldn't reply: ${end.reason}`;
    if (end.event.details.line !== "result" || !end.event.details.isError) return null;
    // The process stays alive after an error result, so there is no exit code yet; the result line decides.
    const outcome = classifyExit(end.event, 0, "", current.recorder.evidence());
    if (outcome.status === "rate_limited")
      options.backoff.reportUsageLimit(
        outcome.resetAt === undefined ? undefined : new Date(outcome.resetAt),
      );
    return failureText(outcome);
  }

  function finish(current: Turn, end: TurnEnd): void {
    if (turn !== current) return;
    turn = null;
    clearTimeout(interruptTimer);
    try {
      const stopped = end.kind === "stopped" || current.stopRequested;
      const reply = current.recorder.reply();
      if (reply !== "")
        post({
          kind: "conductor",
          content: reply,
          meta: stopped ? { stopped } : null,
          ...current.ref,
        });
      const actions = summariseActions(current.recorder.toolCalls());
      if (actions !== null) post({ kind: "action", content: actions, ...current.ref });
      const failure = turnFailure(current, end);
      if (failure !== null) post({ kind: "system", content: failure, ...current.ref });
      const tokens = current.recorder.contextTokens();
      if (tokens !== null && current.process?.initSeen === true)
        db.conductorSessions.setTokens(current.process.conversationId, tokens);
    } catch (error) {
      onError(error);
    }
    bus.emit({ type: "chat.turn", turnId: current.ref.turnId, replying: false });
    // A message written just as the turn ended was not folded into it; the CLI answers it as its own turn.
    const undelivered = current.written - current.delivered;
    if (end.kind === "result" && !current.stopRequested && undelivered > 0) {
      startTurn(current.process, undelivered);
      return;
    }
    const next = deferred;
    deferred = null;
    const wake = wakeQueued && wakeAllowed();
    wakeQueued = false;
    if (next !== null) openTurn(next.ref, next.texts.join("\n\n"));
    else if (wake) openTurn(newTurnRef(), wakeText);
    else {
      scheduleIdle();
      void rollOverIfDue();
    }
  }

  function promptFor(text: string): string {
    const recent = db.chat.list(cursor);
    cursor = recent.at(-1)?.id ?? cursor;
    const updates = recent.filter((message) => message.kind === "system");
    return turnPrompt({ digest: options.digest(), updates, text });
  }

  function openTurn(ref: ChatTurnRef, text: string): void {
    try {
      const prompt = promptFor(text);
      void begin(startTurn(null, 0, ref), prompt);
    } catch (error) {
      onError(error);
      post({
        kind: "system",
        content: `Mastermind couldn't reply: ${errorMessage(error)}`,
        ...ref,
      });
    }
  }

  function onLine(proc: ConductorProcess, line: string): void {
    if (disposed) return;
    proc.rawLog.write(`${line}\n`);
    try {
      const event = proc.parser.parseLine(line);
      if (event.stored) {
        const stored = db.events.append({
          sessionId: proc.session.id,
          type: event.type,
          summary: event.summary,
          payload: event.payload,
        });
        bus.emit({
          type: "session.event",
          sessionId: proc.session.id,
          taskId: null,
          event: stored,
        });
      }
      const { details } = event;
      if (details.line === "api_error" || details.line === "rate_limit") proc.evidence.push(event);
      if (details.line === "result") proc.lastResult = event;
      const current = turn?.process === proc ? turn : null;
      if (details.line === "init") checkInit(proc, details);
      if (current === null || turn !== current) return;
      if (details.line === "user" && details.isReplay) current.delivered += 1;
      const delta = current.recorder.record(event);
      if (delta !== null) bus.emit({ type: "chat.delta", turnId: current.ref.turnId, text: delta });
      if (details.line === "result") finish(current, { kind: "result", event });
    } catch (error) {
      onError(error);
    }
  }

  async function onExit(proc: ConductorProcess, exit: ExitResult): Promise<void> {
    await closeStream(proc.rawLog);
    if (disposed) return;
    if (live === proc) live = null;
    const outcome = classifyExit(
      proc.lastResult,
      exitCode(exit),
      proc.stderr.join("\n"),
      proc.evidence,
    );
    const ended = db.sessions.end(proc.session.id, {
      status: proc.endedByMastermind ? "stopped" : outcome.status,
    });
    bus.emit({ type: "session.ended", sessionId: ended.id, taskId: null, session: ended });
    // A process that failed without printing a single init or result was refused by the CLI (an id already in use,
    // or a resume of a conversation it can't find), so the next turn starts a fresh conversation instead of failing
    // forever. Sign-in and usage-limit failures keep the conversation.
    const refused =
      !proc.initSeen &&
      proc.lastResult === null &&
      !proc.endedByMastermind &&
      outcome.status === "failed";
    if (refused) forgetConversation(proc.conversationId);
    if (turn?.process !== proc) return;
    const reason =
      outcome.status === "failed" ? outcome.reason : (failureText(outcome) ?? "the chat ended");
    finish(turn, turn.stopRequested ? { kind: "stopped" } : { kind: "failed", reason });
  }

  async function spawnProcess(model: string): Promise<ConductorProcess> {
    await mkdir(sessionLogsDir, { recursive: true });
    const print = printOptions(model);
    const session = db.sessions.create({
      role: "conductor",
      claudeSessionId: conversation.id,
      model,
    });
    const proc: ConductorProcess = {
      session,
      conversationId: conversation.id,
      model,
      resumed: conversation.stored,
      prompted: false,
      parser: createStreamParser(),
      rawLog: createWriteStream(join(sessionLogsDir, `${String(session.id)}.jsonl`)),
      stderr: [],
      evidence: [],
      lastResult: null,
      initSeen: false,
      endedByMastermind: false,
      child: null,
      closed: Promise.resolve(),
    };
    proc.rawLog.on("error", onError);
    let child: ChildHandle;
    try {
      child = await cli.spawn(
        "conductor",
        { command: "print", options: print },
        {
          cwd: options.repoRoot,
          io: {
            stdin: "pipe",
            onStdoutLine: (line) => {
              onLine(proc, line);
            },
            onStderrLine: (line) => proc.stderr.push(line),
          },
        },
      );
    } catch (error) {
      await closeStream(proc.rawLog);
      const ended = db.sessions.end(session.id, { status: "failed" });
      bus.emit({ type: "session.ended", sessionId: ended.id, taskId: null, session: ended });
      throw error;
    }
    proc.child = child;
    child.stdin?.on("error", (error) => proc.stderr.push(`stdin: ${error.message}`));
    proc.closed = child.exited.then((exit) => onExit(proc, exit)).catch(onError);
    previousExit = proc.closed;
    proc.session = db.sessions.update(session.id, { pid: child.pid, pgid: child.pgid });
    bus.emit({
      type: "session.started",
      sessionId: session.id,
      taskId: null,
      session: proc.session,
    });
    return proc;
  }

  async function ensureProcess(): Promise<ConductorProcess> {
    const model = options.model();
    if (live !== null && live.model !== model) await endProcess(live);
    if (live !== null) return live;
    await previousExit;
    live = await spawnProcess(model);
    return live;
  }

  async function begin(current: Turn, prompt: string): Promise<void> {
    try {
      await rollOverIfDue();
      current.ref = { ...current.ref, conductorSession: conversation.id };
      const proc = await ensureProcess();
      if (disposed || turn !== current) return;
      if (current.stopRequested) {
        finish(current, { kind: "stopped" });
        return;
      }
      current.process = proc;
      // A new conversation starts from the summary of the ones before it (PLAN 6.2).
      const opening =
        proc.resumed || proc.prompted
          ? prompt
          : withSummary(db.conductorSessions.latestSummary(), prompt);
      proc.prompted = true;
      for (const text of [opening, ...current.queued.splice(0)]) deliver(current, proc, text);
    } catch (error) {
      onError(error);
      finish(current, { kind: "failed", reason: errorMessage(error) });
    }
  }

  return {
    send(text) {
      clearTimeout(idleTimer);
      const running = turn;
      // After Stop the running turn is ending, so a new message waits for it and starts the next turn.
      if (running?.stopRequested === true) {
        deferred ??= { ref: newTurnRef(), texts: [] };
        deferred.texts.push(text);
        const message = post({ kind: "user", content: text, ...deferred.ref });
        return { turnId: deferred.ref.turnId, message };
      }
      if (running !== null) {
        const message = post({ kind: "user", content: text, ...running.ref });
        if (running.process === null) running.queued.push(text);
        else deliver(running, running.process, text);
        return { turnId: running.ref.turnId, message };
      }
      const prompt = promptFor(text);
      const started = startTurn(null);
      const message = post({ kind: "user", content: text, ...started.ref });
      cursor = message.id;
      void begin(started, prompt);
      return { turnId: started.ref.turnId, message };
    },

    stop() {
      const current = turn;
      if (current === null) return false;
      current.stopRequested = true;
      const proc = current.process;
      if (proc === null) return true;
      write(proc, interruptLine());
      clearTimeout(interruptTimer);
      interruptTimer = setTimeout(() => {
        if (turn === current) void endProcess(proc);
      }, interruptGraceMs);
      return true;
    },

    // Coalesces the event lines posted together into one turn, and waits for a running turn to end.
    wake() {
      if (turn !== null) {
        wakeQueued = true;
        return;
      }
      if (wakeTimer !== undefined) return;
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        if (!wakeAllowed()) return;
        if (turn !== null) {
          wakeQueued = true;
          return;
        }
        clearTimeout(idleTimer);
        openTurn(newTurnRef(), wakeText);
      }, 0);
    },

    status: () => ({ model: options.model(), replying: turn !== null }),

    activeTurn: () => turn?.ref ?? null,

    dispose() {
      disposed = true;
      clearTimeout(idleTimer);
      clearTimeout(wakeTimer);
      clearTimeout(interruptTimer);
    },
  };
}
