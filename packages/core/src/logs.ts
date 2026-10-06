import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "./clock.js";
import { isMissingFileError } from "./config/files.js";

export interface LogFile {
  path: string;
  bytes: number;
  modifiedAt: Date;
}

async function listEntries(logsDir: string): Promise<Dirent[]> {
  try {
    return await readdir(logsDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function describeFile(path: string): Promise<LogFile[]> {
  try {
    const { size, mtime } = await stat(path);
    return [{ path, bytes: size, modifiedAt: mtime }];
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

export async function listLogFiles(logsDir: string): Promise<LogFile[]> {
  const files = (await listEntries(logsDir)).filter((entry) => entry.isFile());
  const described = await Promise.all(
    files.map((entry) => describeFile(join(entry.parentPath, entry.name))),
  );
  return described.flat();
}

export interface PruneLogsOptions {
  logsDir: string;
  retentionMs: number;
  clock: Clock;
}

export interface PruneFailure {
  path: string;
  error: unknown;
}

export interface PruneReport {
  removed: string[];
  failed: PruneFailure[];
}

async function removeLog(path: string): Promise<PruneFailure | null> {
  try {
    await rm(path, { force: true });
    return null;
  } catch (error) {
    return { path, error };
  }
}

export async function pruneLogs({
  logsDir,
  retentionMs,
  clock,
}: PruneLogsOptions): Promise<PruneReport> {
  const cutoff = clock.now().getTime() - retentionMs;
  const expired = (await listLogFiles(logsDir))
    .filter(({ modifiedAt }) => modifiedAt.getTime() < cutoff)
    .map(({ path }) => path);
  const failed = (await Promise.all(expired.map(removeLog))).filter((failure) => failure !== null);
  const failedPaths = new Set(failed.map(({ path }) => path));
  return { removed: expired.filter((path) => !failedPaths.has(path)), failed };
}
