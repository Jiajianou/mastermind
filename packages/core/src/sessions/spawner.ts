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
import { fileEdit, ranShellCommand } from "./file-edits.js";
import { createStreamParser } from "./parser.js";
import type { ParsedEvent, TokenUsage } from "./parser.js";

export type SessionEnd =
  | { kind: "exited"; outcome: ExitOutcome }
  | { kind: "stopped" }
  | { kind: "aborted"; reason: string };

export interface SessionReport {
  end: SessionEnd;
  conversationStarted: boolean;
  undeliveredMessages: string[];
}

export interface LiveSession {
  session: Session;
  finished: Promise<SessionReport>;
  steer(text: string): boolean;
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

export const userMessageLine = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });

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
    let editRoots = [cwd];
    let conversationStarted = false;
    let acceptingMessages = true;
    let replays = 0;
    const steeringMessages: string[] = [];
    let endedByMastermind: SessionEnd | null = null;
    let stoppedAfterResult = false;
    let lingerTimer: ReturnType<typeof setTimeout> | undefined;
    const usage = { inputTokens: 0, outputTokens: 0 };

    const stopChild = async (end: SessionEnd): Promise<void> => {
      endedByMastermind ??= end;
      acceptingMessages = false;
      if (child !== null) await stopGroup(child);
    };

    const onResult = (event: ParsedEvent): void => {
      if (event.details.line !== "result") return;
      resultEvent = event;
      acceptingMessages = false;
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
      if (details.line === "init") editRoots = [...new Set([cwd, details.cwd])];
      if (details.line === "init" && !initSeen) {
        initSeen = true;
        const requested = print.permissionMode;
        if (requested !== undefined && details.permissionMode !== requested) {
          const reason = `claude ran in ${details.permissionMode} mode instead of ${requested} with model ${details.model}`;
          stopChild({ kind: "aborted", reason }).catch(onError);
        }
      }
      if (details.line === "assistant" || details.line === "tool_use") conversationStarted = true;
      if (details.line === "user" && details.isReplay) replays += 1;
      if (details.line === "api_error" || details.line === "rate_limit") evidence.push(event);
      onResult(event);
    };

    const onStdoutLine = (line: string): void => {
      rawLog.write(`${line}\n`);
      try {
        const event = parser.parseLine(line);
        const edit = session.taskId === null ? null : fileEdit(event.details, editRoots);
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
            ...(edit?.stage === "editing" ? { path: edit.path } : {}),
          });
        }
        if (edit?.stage === "written" && session.taskId !== null)
          bus.emit({
            type: "file.changed",
            sessionId: session.id,
            taskId: session.taskId,
            path: edit.path,
          });
        if (session.taskId !== null && ranShellCommand(event.details))
          bus.emit({ type: "workspace.changed", sessionId: session.id, taskId: session.taskId });
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
    child.stdin?.write(`${userMessageLine(prompt)}\n`);

    const { stdin } = child;
    const steer = (text: string): boolean => {
      if (!acceptingMessages || !stdin?.writable) return false;
      steeringMessages.push(text);
      stdin.write(`${userMessageLine(text)}\n`);
      return true;
    };

    const finished = child.exited.then(async (exit): Promise<SessionReport> => {
      acceptingMessages = false;
      clearTimeout(lingerTimer);
      await closeStream(rawLog);
      if (stderr.length > 0)
        await writeFile(
          join(sessionLogsDir, `${String(session.id)}.stderr`),
          stderr.join("\n"),
        ).catch(onError);
      // Every replayed line after the prompt's own is a steering message the CLI took in, in the order written.
      const undeliveredMessages = steeringMessages.slice(Math.max(replays - 1, 0));
      if (endedByMastermind !== null)
        return { end: endedByMastermind, conversationStarted, undeliveredMessages };
      const code = stoppedAfterResult ? 0 : exitCode(exit);
      const outcome = classifyExit(resultEvent, code, stderr.join("\n"), evidence);
      return { end: { kind: "exited", outcome }, conversationStarted, undeliveredMessages };
    });

    return {
      session: started,
      finished,
      steer,
      stop: () => stopChild({ kind: "stopped" }),
    };
  }

  return { launch };
}
