import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, writeFiles } from "../testing/temp-dir.js";
import { resolveInsideWorktree, UnsafePathError } from "./path-safety.js";
import type { UnsafePathReason } from "./path-safety.js";

async function worktreeWithLinks(): Promise<{ worktree: string; outside: string }> {
  const root = await makeTempDir();
  const worktree = join(root, "worktree");
  const outside = join(root, "outside");
  await writeFiles(worktree, { "src/a.ts": "export {};\n", ".git/config": "[core]\n" });
  await writeFiles(outside, { "secret.txt": "secret\n" });
  await mkdir(join(worktree, "links"));
  await symlink(join(outside, "secret.txt"), join(worktree, "links", "secret"));
  await symlink("../../outside", join(worktree, "links", "outside-dir"));
  await symlink("../src/a.ts", join(worktree, "links", "inner"));
  await symlink("../.git/config", join(worktree, "links", "git-config"));
  await symlink(join(outside, "nothing.txt"), join(worktree, "links", "dangling"));
  await symlink(worktree, join(root, "worktree-link"));
  return { worktree, outside };
}

describe("resolveInsideWorktree", () => {
  it.each<[string, string, string, string]>([
    ["a plain path", "src/a.ts", "src/a.ts", "src/a.ts"],
    ["a path with . and empty segments", "./src//a.ts", "src/a.ts", "src/a.ts"],
    ["a symlink to a file inside the worktree", "links/inner", "links/inner", "src/a.ts"],
  ])("accepts %s", async (_case, path, relative, target) => {
    const { worktree } = await worktreeWithLinks();

    const resolved = await resolveInsideWorktree(worktree, path);

    expect(resolved).toEqual({ kind: "found", relative, real: join(worktree, target) });
  });

  it.each<[string, string]>([
    ["a file that does not exist", "src/new.ts"],
    ["a symlink whose target outside does not exist", "links/dangling"],
  ])("reports %s as missing without reading anything", async (_case, path) => {
    const { worktree } = await worktreeWithLinks();

    expect(await resolveInsideWorktree(worktree, path)).toMatchObject({ kind: "missing" });
  });

  it.each<[string, string, UnsafePathReason]>([
    ["an empty path", "", "empty"],
    ["the worktree itself", ".", "empty"],
    ["a parent segment", "../outside/secret.txt", "parent_segment"],
    ["a parent segment that climbs back in", "src/../src/a.ts", "parent_segment"],
    ["an absolute path", "/etc/passwd", "absolute"],
    ["an absolute path into the worktree", "WORKTREE/src/a.ts", "absolute"],
    ["a NUL byte", "src/a.ts\0.png", "nul_byte"],
    ["the .git directory", ".git/config", "git_directory"],
    ["a .git directory in another case", "src/.GIT/config", "git_directory"],
    ["a symlink into .git", "links/git-config", "git_directory"],
    ["a symlink to a file outside", "links/secret", "outside_worktree"],
    [
      "a file under a symlinked directory outside",
      "links/outside-dir/secret.txt",
      "outside_worktree",
    ],
  ])("rejects %s", async (_case, path, reason) => {
    const { worktree } = await worktreeWithLinks();

    const attempt = resolveInsideWorktree(worktree, path.replace("WORKTREE", worktree));

    await expect(attempt).rejects.toBeInstanceOf(UnsafePathError);
    await expect(attempt).rejects.toMatchObject({ reason });
  });

  it("checks against the real worktree when the worktree path is itself a symlink", async () => {
    const { worktree } = await worktreeWithLinks();

    const resolved = await resolveInsideWorktree(join(worktree, "..", "worktree-link"), "src/a.ts");

    expect(resolved).toEqual({
      kind: "found",
      relative: "src/a.ts",
      real: join(worktree, "src/a.ts"),
    });
  });
});
