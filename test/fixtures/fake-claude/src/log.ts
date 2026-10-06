import { appendFileSync } from "node:fs";
import { z } from "zod";

const invocationRecordSchema = z.object({
  kind: z.literal("invocation"),
  time: z.string(),
  pid: z.number(),
  ppid: z.number(),
  pgid: z.number(),
  cwd: z.string(),
  argv: z.array(z.string()),
  unknownFlags: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

const messageRecordSchema = z.object({
  kind: z.literal("message"),
  time: z.string(),
  pid: z.number(),
  text: z.string(),
});

const spawnRecordSchema = z.object({
  kind: z.literal("spawn"),
  time: z.string(),
  pid: z.number(),
  childPid: z.number(),
  childPgid: z.number(),
  command: z.string(),
});

const signalRecordSchema = z.object({
  kind: z.literal("signal"),
  time: z.string(),
  pid: z.number(),
  signal: z.enum(["SIGTERM", "SIGINT"]),
  ignored: z.boolean(),
});

export const logRecordSchema = z.discriminatedUnion("kind", [
  invocationRecordSchema,
  messageRecordSchema,
  spawnRecordSchema,
  signalRecordSchema,
]);
export type FakeClaudeLogRecord = z.infer<typeof logRecordSchema>;
export type InvocationRecord = z.infer<typeof invocationRecordSchema>;

type WithoutStamp<T> = T extends unknown ? Omit<T, "time" | "pid"> : never;
export type LogEntry = WithoutStamp<FakeClaudeLogRecord>;

export interface InvocationLog {
  append(entry: LogEntry): void;
}

const loggedEnvNames = /^(ANTHROPIC_|CLAUDE|AI_AGENT$|HOME$|GIT_EDITOR$)/;

export function loggedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => loggedEnvNames.test(entry[0]) && entry[1] !== undefined,
    ),
  );
}

export function openLog(path: string | undefined): InvocationLog {
  return {
    append(entry) {
      if (path === undefined) return;
      const record = { ...entry, time: new Date().toISOString(), pid: process.pid };
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    },
  };
}
