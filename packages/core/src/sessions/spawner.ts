import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { ClaudeCli, PrintOptions } from "../claude.js";
import type { ExitOutcome, Session } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import { stopGroup } from "../procs.js";
import type { ChildHandle, ExitResult } from "../procs.js";
import { classifyExit } from "./exit.js";
import { createStreamParser } from "./parser.js";
import type { ParsedEvent, TokenUsage } from "./parser.js";

export type SessionEnd =
  | { kind: "exited"; outcome: ExitOutcome }
  | { kind: "stopped" }
  | { kind: "aborted"; reason: string };

export interface SessionReport {
  end: SessionEnd;
  conversationStarted: boolean;
}

export interface LiveSession {
  session: Session;
  finished: Promise<SessionReport>;
  stop(): Promise<void>;
}

export interface SessionSpawnerOptions {
  db: Db;
  bus: EventBus;
  cli: ClaudeCli;
  logsDir: string;
  onError: (error: unknown) => void;
  resultGraceMs?: number;
}

export interface LaunchRequest {
  session: Session;
  cwd: string;
  prompt: string;
  print: PrintOptions;
}

export interface SessionSpawner {
  launch(request: LaunchRequest): Promise<LiveSession>;
}

const userMessage = (text: string): string =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

const totalInput = (usage: TokenUsage): number =>
  usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;

function closeStream(stream: Writable): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

function exitCode(exit: ExitResult): number | null {
  return exit.kind === "exited" ? exit.code : null;
}

export function createSessionSpawner(options: SessionSpawnerOptions): SessionSpawner {
  const { db, bus, cli, onError, resultGraceMs = 30_000 } = options;
  const sessionLogsDir = join(options.logsDir, "sessions");

  async function launch({ session, cwd, prompt, print }: LaunchRequest): Promise<LiveSession> {
    await mkdir(sessionLogsDir, { recursive: true });
    const rawLog = createWriteStream(join(sessionLogsDir, `${String(session.id)}.jsonl`));
    rawLog.on("error", onError);
    const parser = createStreamParser();
    const evidence: ParsedEvent[] = [];
    const stderr: string[] = [];
    let child: ChildHandle | null = null;
    let resultEvent: ParsedEvent | null = null;
    let initSeen = false;
    let conversationStarted = false;
    let endedByMastermind: SessionEnd | null = null;
    let stoppedAfterResult = false;
    let lingerTimer: ReturnType<typeof setTimeout> | undefined;
    const usage = { inputTokens: 0, outputTokens: 0 };

    const stopChild = async (end: SessionEnd): Promise<void> => {
      endedByMastermind ??= end;
      if (child !== null) await stopGroup(child);
    };

    const onResult = (event: ParsedEvent): void => {
      if (event.details.line !== "result") return;
      resultEvent = event;
      if (event.details.usage !== null) {
        usage.inputTokens += totalInput(event.details.usage);
        usage.outputTokens += event.details.usage.outputTokens;
        db.sessions.update(session.id, usage);
      }
      child?.stdin?.end();
      clearTimeout(lingerTimer);
      // Claude exits about half a second after stdin closes. If it lingers, it is stopped, and how it then exits
      // says nothing about the run, which its result line has already reported.
      lingerTimer = setTimeout(() => {
        stoppedAfterResult = true;
        if (child !== null) stopGroup(child).catch(onError);
      }, resultGraceMs);
    };

    const follow = (event: ParsedEvent): void => {
      const { details } = event;
      if (details.line === "init" && !initSeen) {
        initSeen = true;
        const requested = print.permissionMode;
        if (requested !== undefined && details.permissionMode !== requested) {
          const reason = `claude ran in ${details.permissionMode} mode instead of ${requested} with model ${details.model}`;
          stopChild({ kind: "aborted", reason }).catch(onError);
        }
      }
      if (details.line === "assistant" || details.line === "tool_use") conversationStarted = true;
      if (details.line === "api_error" || details.line === "rate_limit") evidence.push(event);
      onResult(event);
    };

    const onStdoutLine = (line: string): void => {
      rawLog.write(`${line}\n`);
      try {
        const event = parser.parseLine(line);
        if (event.stored) {
          const stored = db.events.append({
            sessionId: session.id,
            type: event.type,
            summary: event.summary,
            payload: event.payload,
          });
          bus.emit({
            type: "session.event",
            sessionId: session.id,
            taskId: session.taskId,
            event: stored,
          });
        }
        follow(event);
      } catch (error) {
        onError(error);
      }
    };

    try {
      child = await cli.spawn(
        session.role === "conductor" ? "conductor" : "session",
        { command: "print", options: print },
        { cwd, io: { stdin: "pipe", onStdoutLine, onStderrLine: (line) => stderr.push(line) } },
      );
    } catch (error) {
      await closeStream(rawLog);
      throw error;
    }
    const started = db.sessions.update(session.id, { pid: child.pid, pgid: child.pgid });
    bus.emit({
      type: "session.started",
      sessionId: session.id,
      taskId: session.taskId,
      session: started,
    });
    child.stdin?.on("error", (error) => stderr.push(`stdin: ${error.message}`));
    child.stdin?.write(userMessage(prompt));

    const finished = child.exited.then(async (exit): Promise<SessionReport> => {
      clearTimeout(lingerTimer);
      await closeStream(rawLog);
      if (stderr.length > 0)
        await writeFile(
          join(sessionLogsDir, `${String(session.id)}.stderr`),
          stderr.join("\n"),
        ).catch(onError);
      if (endedByMastermind !== null) return { end: endedByMastermind, conversationStarted };
      const code = stoppedAfterResult ? 0 : exitCode(exit);
      const outcome = classifyExit(resultEvent, code, stderr.join("\n"), evidence);
      return { end: { kind: "exited", outcome }, conversationStarted };
    });

    return { session: started, finished, stop: () => stopChild({ kind: "stopped" }) };
  }

  return { launch };
}
