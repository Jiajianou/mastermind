import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { maxFileBytes } from "../contracts/index.js";
import type { ChangeStatus, FileChange, FileContent } from "../contracts/index.js";
import { normalizeRelativePath, resolveInsideWorktree } from "./path-safety.js";
import type { Git } from "./runner.js";

export class NotAFileError extends Error {
  override readonly name = "NotAFileError";

  constructor(readonly path: string) {
    super(`${JSON.stringify(path)} is not a file`);
  }
}

interface LineCounts {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

interface DiffEntry {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
}

// These reads run while a worker uses the same clone, so they must never take index.lock: an opportunistic index
// refresh by status or diff could make the worker's own git add or commit fail.
const read = (git: Git, worktree: string, args: readonly string[]): Promise<string> =>
  git.run(worktree, ["--no-optional-locks", ...args]);

const diffOptions = ["--no-ext-diff", "--no-textconv", "--find-renames", "-z"];

// Git's own heuristic: a NUL byte in the first 8000 bytes makes a file binary.
const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, 8000).includes(0);

function countLines(bytes: Buffer): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const fields = (output: string): string[] => {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
};

function changeStatus(code: string): ChangeStatus {
  switch (code.charAt(0)) {
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

function parseNameStatus(output: string): DiffEntry[] {
  const tokens = fields(output);
  const entries: DiffEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index] ?? "";
    const status = changeStatus(code);
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = tokens[index + 1] ?? "";
      entries.push({
        path: tokens[index + 2] ?? "",
        oldPath: status === "renamed" ? oldPath : null,
        status,
      });
      index += 3;
    } else {
      entries.push({ path: tokens[index + 1] ?? "", oldPath: null, status });
      index += 2;
    }
  }
  return entries;
}

function parseNumstat(output: string): Map<string, LineCounts> {
  const tokens = fields(output);
  const counts = new Map<string, LineCounts>();
  for (let index = 0; index < tokens.length;) {
    const [added = "", deleted = "", path = ""] = (tokens[index] ?? "").split("\t");
    const binary = added === "-";
    const entry = {
      additions: binary ? null : Number(added),
      deletions: binary ? null : Number(deleted),
      binary,
    };
    if (path === "") {
      counts.set(tokens[index + 2] ?? "", entry);
      index += 3;
    } else {
      counts.set(path, entry);
      index += 1;
    }
  }
  return counts;
}

interface WorktreeStatus {
  dirty: Set<string>;
  untracked: string[];
}

function parseStatus(output: string): WorktreeStatus {
  const tokens = fields(output);
  const dirty = new Set<string>();
  const untracked: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index] ?? "";
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    dirty.add(path);
    if (code === "??") untracked.push(path);
    if (code.includes("R") || code.includes("C")) {
      index += 1;
      dirty.add(tokens[index] ?? "");
    }
  }
  return { dirty, untracked };
}

const unknownCounts: LineCounts = { additions: null, deletions: null, binary: false };

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function lstatIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function countUntracked(worktree: string, path: string): Promise<LineCounts | null> {
  const absolute = join(worktree, path);
  const stats = await lstatIfPresent(absolute);
  if (stats === null) return null;
  if (stats.isSymbolicLink()) return { additions: 1, deletions: 0, binary: false };
  const file = await readRegularFile(absolute);
  if (file.kind === "missing") return null;
  if (file.kind !== "file") return unknownCounts;
  if (isBinary(file.bytes)) return { additions: null, deletions: null, binary: true };
  return { additions: countLines(file.bytes), deletions: 0, binary: false };
}

// A worker can leave thousands of untracked files (build output), so opening them all at once could exhaust file
// descriptors.
const untrackedReadBatch = 32;

async function mapInBatches<Item, Result>(
  items: readonly Item[],
  size: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let start = 0; start < items.length; start += size)
    results.push(...(await Promise.all(items.slice(start, start + size).map(work))));
  return results;
}

export async function listChanges(
  git: Git,
  worktree: string,
  fromCommit: string,
): Promise<FileChange[]> {
  const [nameStatus, numstat, status] = await Promise.all([
    read(git, worktree, ["diff", ...diffOptions, "--name-status", fromCommit, "--"]),
    read(git, worktree, ["diff", ...diffOptions, "--numstat", fromCommit, "--"]),
    read(git, worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const counts = parseNumstat(numstat);
  const { dirty, untracked } = parseStatus(status);
  const tracked = parseNameStatus(nameStatus).map((entry): FileChange => ({
    ...entry,
    ...(counts.get(entry.path) ?? unknownCounts),
    uncommitted: dirty.has(entry.path) || (entry.oldPath !== null && dirty.has(entry.oldPath)),
  }));
  const trackedPaths = new Set(tracked.map((change) => change.path));
  const added = await mapInBatches(
    untracked.filter((path) => !trackedPaths.has(path)),
    untrackedReadBatch,
    async (path): Promise<FileChange[]> => {
      const lineCounts = await countUntracked(worktree, path);
      if (lineCounts === null) return [];
      return [{ path, oldPath: null, status: "added", ...lineCounts, uncommitted: true }];
    },
  );
  return [...tracked, ...added.flat()].sort((a, b) => byPath(a.path, b.path));
}

function decode(path: string, side: FileContent["side"], bytes: Buffer): FileContent {
  if (isBinary(bytes)) return { path, side, kind: "binary", size: bytes.length };
  return { path, side, kind: "text", size: bytes.length, content: bytes.toString("utf8") };
}

export async function readCommittedFile(
  git: Git,
  worktree: string,
  commit: string,
  requested: string,
): Promise<FileContent> {
  const path = normalizeRelativePath(requested);
  const listing = await read(git, worktree, [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    "--long",
    commit,
    "--",
    path,
  ]);
  const entry = fields(listing).find((line) => line.slice(line.indexOf("\t") + 1) === path);
  if (entry === undefined) return { path, side: "base", kind: "missing" };
  const [, type = "", object = "", size = ""] = entry.slice(0, entry.indexOf("\t")).split(/\s+/);
  if (type !== "blob") throw new NotAFileError(path);
  const bytes = Number(size);
  if (bytes > maxFileBytes) return { path, side: "base", kind: "too_large", size: bytes };
  return decode(
    path,
    "base",
    await git.readBytes(worktree, ["--no-optional-locks", "cat-file", "blob", object]),
  );
}

type RegularFile =
  | { kind: "file"; bytes: Buffer }
  | { kind: "too_large"; size: number }
  | { kind: "not_a_file" }
  | { kind: "missing" };

// O_NOFOLLOW guards against the last component being swapped for a symlink after the path was checked, and
// O_NONBLOCK keeps a FIFO a worker left in the worktree from blocking the open.
const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function openIfPresent(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, openFlags);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readRegularFile(path: string): Promise<RegularFile> {
  const handle = await openIfPresent(path);
  if (handle === null) return { kind: "missing" };
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "not_a_file" };
    if (stats.size > maxFileBytes) return { kind: "too_large", size: stats.size };
    return { kind: "file", bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

export async function readWorktreeFile(worktree: string, path: string): Promise<FileContent> {
  const resolved = await resolveInsideWorktree(worktree, path);
  const { relative } = resolved;
  if (resolved.kind === "missing") return { path: relative, side: "current", kind: "missing" };
  const file = await readRegularFile(resolved.real);
  if (file.kind === "missing") return { path: relative, side: "current", kind: "missing" };
  if (file.kind === "not_a_file") throw new NotAFileError(relative);
  if (file.kind === "too_large")
    return { path: relative, side: "current", kind: "too_large", size: file.size };
  return decode(relative, "current", file.bytes);
}

export async function listTree(git: Git, worktree: string): Promise<string[]> {
  const [listed, deleted] = await Promise.all([
    read(git, worktree, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    read(git, worktree, ["ls-files", "-z", "--deleted"]),
  ]);
  const gone = new Set(fields(deleted));
  return [...new Set(fields(listed))].filter((path) => !gone.has(path)).sort(byPath);
}
