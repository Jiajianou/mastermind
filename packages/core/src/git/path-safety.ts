import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type UnsafePathReason =
  "empty" | "nul_byte" | "absolute" | "parent_segment" | "git_directory" | "outside_worktree";

const reasonTexts: Record<UnsafePathReason, string> = {
  empty: "is empty",
  nul_byte: "contains a NUL byte",
  absolute: "is absolute; give a path relative to the worktree",
  parent_segment: "contains a .. segment",
  git_directory: "is inside .git",
  outside_worktree: "resolves outside the task's worktree",
};

export class UnsafePathError extends Error {
  override readonly name = "UnsafePathError";

  constructor(
    readonly path: string,
    readonly reason: UnsafePathReason,
  ) {
    super(`${JSON.stringify(path)} ${reasonTexts[reason]}`);
  }
}

export type ResolvedPath =
  { kind: "found"; relative: string; real: string } | { kind: "missing"; relative: string };

const isGitDirectory = (segment: string): boolean => segment.toLowerCase() === ".git";

export function normalizeRelativePath(path: string): string {
  if (path.includes("\0")) throw new UnsafePathError(path, "nul_byte");
  if (isAbsolute(path)) throw new UnsafePathError(path, "absolute");
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) throw new UnsafePathError(path, "empty");
  if (segments.includes("..")) throw new UnsafePathError(path, "parent_segment");
  if (segments.some(isGitDirectory)) throw new UnsafePathError(path, "git_directory");
  return segments.join("/");
}

export function pathInside(root: string, path: string): string | null {
  const fromRoot = relative(root, resolve(root, path));
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return null;
  if (isAbsolute(fromRoot)) return null;
  return fromRoot.split(sep).join("/");
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
  );
}

export async function resolveInsideWorktree(worktree: string, path: string): Promise<ResolvedPath> {
  const requested = normalizeRelativePath(path);
  const root = await realpath(worktree);
  let real: string;
  try {
    real = await realpath(join(root, requested));
  } catch (error) {
    if (isMissing(error)) return { kind: "missing", relative: requested };
    throw error;
  }
  const inside = pathInside(root, real);
  if (inside === null) throw new UnsafePathError(path, "outside_worktree");
  if (inside.split("/").some(isGitDirectory)) throw new UnsafePathError(path, "git_directory");
  return { kind: "found", relative: requested, real };
}
