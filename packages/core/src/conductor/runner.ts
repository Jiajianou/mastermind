import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../contracts/index.js";
import { conversationTitle, postChatMessage, updateChatMessage } from "../chat.js";
import type { ClaudeCli, PrintOptions } from "../claude.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import type {
  AnswersMeta,
  ChatMessage,
  ChatStatus,
  ChatTurn,
  ChatTurnRef,
  Conversation,
  ExitOutcome,
  QuestionAnswer,
  Session,
} from "../contracts/index.js";
import { RecordNotFoundError } from "../db/index.js";
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
import { createActivityTracker } from "./activity.js";
import type { ActivityTracker } from "./activity.js";
import { turnPrompt, wakeText, withSummary } from "./prompt.js";
import { conductorRolloverTokens } from "./rollover.js";
import type { ConductorSummariser } from "./rollover.js";
import { createStepRecorder } from "./steps.js";
import type { StepRecorder } from "./steps.js";
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
  clock?: Clock;
}

export interface ChatRunner {
  send(text: string, answers?: QuestionAnswer[]): ChatTurn;
  wake(): void;
  stop(): boolean;
  newConversation(): Conversation;
  openConversation(conversationId: number): Conversation;
  deleteConversation(conversationId: number): void;
  status(): ChatStatus;
  activeTurn(): ChatTurnRef | null;
  dispose(): void;
}

interface ClaudeSession {
  id: string;
  stored: boolean;
}

interface DeferredTurn {
  ref: ChatTurnRef;
  texts: string[];
}

interface ConductorProcess {
  session: Session;
  claudeSessionId: string;
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
  activity: ActivityTracker;
  steps: StepRecorder;
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
  const { db, bus, cli, onError, idleMs = conductorIdleMs, clock = systemClock } = options;
  const rolloverTokens = options.rolloverTokens ?? conductorRolloverTokens;
  const sessionLogsDir = join(options.logsDir, "sessions");
  const post = (message: NewChatMessage) =>
    postChatMessage({ db, bus }, { conversationId, ...message });
  const stepSink = {
    post,
    update: (id: number, change: Pick<NewChatMessage, "content" | "meta">) =>
      updateChatMessage({ db, bus }, id, change),
  };

  let conversationId = db.conversations.active().id;
  let claude = claudeSessionOf(conversationId);
  let cursor = lastOwnerMessage(conversationId);
  let live: ConductorProcess | null = null;
  let previousExit: Promise<void> = Promise.resolve();
  let turn: Turn | null = null;
  let deferred: DeferredTurn | null = null;
  let rollover: Promise<void> | null = null;
  let rolloverTried: { claudeSessionId: string; tokens: number } | null = null;
  let wakeQueued = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  // A conversation continues its latest Claude session, unless that one was rolled over into a summary.
  function claudeSessionOf(conversation: number): ClaudeSession {
    const latest = db.conductorSessions.latest(conversation);
    return latest?.summary === null
      ? { id: latest.id, stored: true }
      : { id: randomUUID(), stored: false };
  }

  function lastOwnerMessage(conversation: number): number {
    return (
      db.chat.listConversation(conversation).findLast((message) => message.kind === "user")?.id ?? 0
    );
  }

  function forgetClaudeSession(claudeSessionId: string): void {
    if (claude.id !== claudeSessionId) return;
    if (claude.stored) db.conductorSessions.end(claude.id);
    claude = { id: randomUUID(), stored: false };
  }

  function rolloverDue(): number | null {
    if (!claude.stored) return null;
    const stored = db.conductorSessions.latest(conversationId);
    const tokens = stored?.id === claude.id ? stored.tokens : null;
    if (tokens === null || tokens < rolloverTokens) return null;
    const tried = rolloverTried?.claudeSessionId === claude.id && rolloverTried.tokens === tokens;
    return tried ? null : tokens;
  }

  // The Claude session is replaced only once its summary exists, so a judge call that fails leaves the chat where it
  // was, and the rollover is tried again after the next turn.
  async function rollOver(claudeSessionId: string, tokens: number): Promise<void> {
    rolloverTried = { claudeSessionId, tokens };
    const summary = await options.summariser.summarise(claudeSessionId, conversationId);
    if (summary === null || disposed || claude.id !== claudeSessionId) return;
    if (live !== null) await endProcess(live);
    db.conductorSessions.end(claudeSessionId, summary);
    claude = { id: randomUUID(), stored: false };
  }

  function rollOverIfDue(): Promise<void> {
    const tokens = rollover === null ? rolloverDue() : null;
    if (tokens !== null)
      rollover = rollOver(claude.id, tokens)
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
    const news = db.chat
      .listConversation(conversationId, cursor)
      .some((message) => message.kind === "system");
    return news && !disposed && !authRequired && !backingOff;
  }

  function printOptions(model: string): PrintOptions {
    const session = claude.stored ? { resume: claude.id } : { sessionId: claude.id };
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
    conductorSession: claude.id,
  });

  function startTurn(process: ConductorProcess | null, written = 0, ref = newTurnRef()): Turn {
    const started: Turn = {
      ref,
      recorder: createTurnRecorder(),
      activity: createActivityTracker(options.repoRoot),
      steps: createStepRecorder({
        sink: stepSink,
        ref: () => started.ref,
        repoRoot: options.repoRoot,
        clock,
      }),
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
      if (!claude.stored && claude.id === proc.claudeSessionId) {
        db.conductorSessions.open(claude.id, conversationId);
        claude = { id: claude.id, stored: true };
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
      current.steps.stop();
      const unfinished = current.recorder.unfinished();
      if (unfinished !== "" || stopped)
        post({
          kind: "conductor",
          content: unfinished,
          meta: stopped ? { stopped } : null,
          ...current.ref,
        });
      const failure = turnFailure(current, end);
      if (failure !== null) post({ kind: "system", content: failure, ...current.ref });
      const tokens = current.recorder.contextTokens();
      if (tokens !== null && current.process?.initSeen === true)
        db.conductorSessions.setTokens(current.process.claudeSessionId, tokens);
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
    const recent = db.chat.listConversation(conversationId, cursor);
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
      const text = current.recorder.record(event);
      if (text?.kind === "delta")
        bus.emit({ type: "chat.delta", turnId: current.ref.turnId, text: text.text });
      if (text?.kind === "block") post({ kind: "conductor", content: text.text, ...current.ref });
      current.steps.record(details);
      const activity = current.activity.record(details);
      if (activity !== null)
        bus.emit({ type: "chat.activity", turnId: current.ref.turnId, text: activity });
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
    // or a resume of a session it can't find), so the next turn starts a fresh Claude session instead of failing
    // forever. Sign-in and usage-limit failures keep the session.
    const refused =
      !proc.initSeen &&
      proc.lastResult === null &&
      !proc.endedByMastermind &&
      outcome.status === "failed";
    if (refused) forgetClaudeSession(proc.claudeSessionId);
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
      claudeSessionId: claude.id,
      model,
    });
    const proc: ConductorProcess = {
      session,
      claudeSessionId: claude.id,
      model,
      resumed: claude.stored,
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
    if (live !== null && (live.model !== model || live.claudeSessionId !== claude.id))
      await endProcess(live);
    if (live !== null) return live;
    await previousExit;
    live = await spawnProcess(model);
    return live;
  }

  function postOwnerMessage(
    text: string,
    answers: QuestionAnswer[] | undefined,
    ref: ChatTurnRef,
  ): ChatMessage {
    const meta = answers === undefined ? null : ({ answers } satisfies AnswersMeta);
    const message = post({ kind: "user", content: text, meta, ...ref });
    if (db.conversations.get(conversationId)?.title === null) {
      const conversation = db.conversations.setTitle(conversationId, conversationTitle(text));
      bus.emit({ type: "conversation.updated", conversation });
    }
    return message;
  }

  // Leaving a conversation stops its reply and its process, but not its Claude session, so coming back resumes it.
  function leave(): void {
    deferred = null;
    wakeQueued = false;
    const current = turn;
    if (current !== null) {
      current.stopRequested = true;
      finish(current, { kind: "stopped" });
    }
    clearTimeout(idleTimer);
    if (live !== null) void endProcess(live);
  }

  function enter(conversation: Conversation): Conversation {
    conversationId = conversation.id;
    claude = claudeSessionOf(conversation.id);
    cursor = lastOwnerMessage(conversation.id);
    rolloverTried = null;
    return conversation;
  }

  async function begin(current: Turn, prompt: string): Promise<void> {
    try {
      await rollOverIfDue();
      current.ref = { ...current.ref, conductorSession: claude.id };
      const proc = await ensureProcess();
      if (disposed || turn !== current) return;
      if (current.stopRequested) {
        finish(current, { kind: "stopped" });
        return;
      }
      current.process = proc;
      // A conversation's new Claude session starts from the summary of the ones before it (PLAN 6.2).
      const opening =
        proc.resumed || proc.prompted
          ? prompt
          : withSummary(db.conductorSessions.latestSummary(conversationId), prompt);
      proc.prompted = true;
      for (const text of [opening, ...current.queued.splice(0)]) deliver(current, proc, text);
    } catch (error) {
      onError(error);
      finish(current, { kind: "failed", reason: errorMessage(error) });
    }
  }

  return {
    send(text, answers) {
      clearTimeout(idleTimer);
      const running = turn;
      // After Stop the running turn is ending, so a new message waits for it and starts the next turn.
      if (running?.stopRequested === true) {
        deferred ??= { ref: newTurnRef(), texts: [] };
        deferred.texts.push(text);
        const message = postOwnerMessage(text, answers, deferred.ref);
        return { turnId: deferred.ref.turnId, message };
      }
      if (running !== null) {
        const message = postOwnerMessage(text, answers, running.ref);
        if (running.process === null) running.queued.push(text);
        else deliver(running, running.process, text);
        return { turnId: running.ref.turnId, message };
      }
      const prompt = promptFor(text);
      const started = startTurn(null);
      const message = postOwnerMessage(text, answers, started.ref);
      cursor = message.id;
      void begin(started, prompt);
      return { turnId: started.ref.turnId, message };
    },

    newConversation() {
      if (turn === null && db.chat.listConversation(conversationId).length === 0)
        return db.conversations.open(conversationId);
      leave();
      return enter(db.conversations.create());
    },

    deleteConversation(id) {
      if (db.conversations.get(id) === null) throw new RecordNotFoundError("conversations", id);
      const open = id === conversationId;
      if (open) leave();
      db.conversations.delete(id);
      if (open) enter(db.conversations.create());
    },

    openConversation(id) {
      if (id === conversationId) return db.conversations.open(id);
      const conversation = db.conversations.get(id);
      if (conversation === null) throw new RecordNotFoundError("conversations", id);
      leave();
      return enter(db.conversations.open(id));
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
