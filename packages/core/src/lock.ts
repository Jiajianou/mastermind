import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const lockRecordSchema = z.strictObject({
  pid: z.int().positive(),
  port: z.int().min(1).max(65_535).nullable(),
});
export type LockRecord = z.infer<typeof lockRecordSchema>;

export interface InstanceLock {
  readonly path: string;
  setPort(port: number): void;
  releaseSync(): void;
}

export type LockAttempt =
  { kind: "acquired"; lock: InstanceLock } | { kind: "held"; pid: number; link: string | null };

export type RunningInstance =
  | { kind: "none" }
  | { kind: "starting"; pid: number }
  | { kind: "running"; pid: number; port: number; token: string };

export interface AcquireLockOptions {
  pid?: number;
}

export class LockError extends Error {
  override readonly name = "LockError";
}

const maxTakeoverRounds = 5;

export const lockPath = (stateDir: string): string => join(stateDir, "lock");

export const tokenPath = (stateDir: string): string => join(stateDir, "token");

export const webAppLink = (port: number, token: string): string =>
  `http://127.0.0.1:${String(port)}/#t=${token}`;

export function alreadyRunningMessage(held: { pid: number; link: string | null }): string {
  const where = held.link === null ? ", still starting" : ` → ${held.link}`;
  return `mastermind is already running for this repo (pid ${String(held.pid)})${where}`;
}

export function readLock(stateDir: string): LockRecord | null {
  const text = readText(lockPath(stateDir));
  return text === null ? null : parseRecord(text);
}

export function findRunningInstance(stateDir: string): RunningInstance {
  const record = readLock(stateDir);
  if (record === null || !isAlive(record.pid)) return { kind: "none" };
  const token = readToken(stateDir);
  if (record.port === null || token === "") return { kind: "starting", pid: record.pid };
  return { kind: "running", pid: record.pid, port: record.port, token };
}

export function acquireLock(stateDir: string, options: AcquireLockOptions = {}): LockAttempt {
  const pid = options.pid ?? process.pid;
  const path = lockPath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  for (let round = 0; round < maxTakeoverRounds; round += 1) {
    const written = serialize({ pid, port: null });
    if (createExclusive(path, written)) return { kind: "acquired", lock: ownedLock(path, written) };
    const observed = readText(path);
    if (observed === null) continue;
    const holder = parseRecord(observed);
    if (holder !== null && holder.pid !== pid && isAlive(holder.pid))
      return { kind: "held", pid: holder.pid, link: linkFor(stateDir, holder) };
    removeIfUnchanged(path, observed);
  }
  throw new LockError(`could not take ${path}: other instances keep replacing it`);
}

function ownedLock(path: string, initial: string): InstanceLock {
  let current = initial;
  const stillOurs = (): boolean => readText(path) === current;

  return {
    path,

    setPort(port) {
      if (!stillOurs()) throw new LockError(`${path} was taken over by another instance`);
      const record = parseRecord(current);
      if (record === null) throw new LockError(`${path} holds an unreadable record`);
      const next = serialize({ ...record, port });
      const temp = tempPath(path);
      writeFileSync(temp, next);
      renameSync(temp, path);
      current = next;
    },

    releaseSync() {
      if (!stillOurs()) return;
      try {
        unlinkSync(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    },
  };
}

// A hard link to a fully written temp file appears all at once or fails with EEXIST, so no reader ever sees a
// half-written lock and two instances can never both create it.
function createExclusive(path: string, content: string): boolean {
  const temp = tempPath(path);
  writeFileSync(temp, content);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

// The stale lock is moved aside before it is deleted. If another instance replaced it in the meantime, the
// moved file is that instance's live lock, so it is put back instead.
function removeIfUnchanged(path: string, observed: string): void {
  const aside = tempPath(path);
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  try {
    if (readText(aside) !== observed) linkSync(aside, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  } finally {
    unlinkSync(aside);
  }
}

function readToken(stateDir: string): string {
  return readText(tokenPath(stateDir))?.trim() ?? "";
}

function linkFor(stateDir: string, holder: LockRecord): string | null {
  const token = readToken(stateDir);
  return holder.port === null || token === "" ? null : webAppLink(holder.port, token);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

function parseRecord(text: string): LockRecord | null {
  try {
    const parsed = lockRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const serialize = (record: LockRecord): string => `${JSON.stringify(record)}\n`;

const tempPath = (path: string): string => `${path}.${randomUUID()}.tmp`;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
