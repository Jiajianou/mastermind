import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CloneLocationError,
  commitLeftovers,
  createGit,
  createTaskClone,
  deleteClone,
  fetchMainIntoClone,
  fetchTaskIntoRepo,
} from "@mastermind/core/git";
import { createProcessRegistry } from "@mastermind/core/procs";
import { describe, expect, it } from "vitest";
import { makeTempDir, onCleanup } from "../../support/cleanup.js";
import { createTempRepo, owner } from "../../support/temp-repo.js";

describe("task clones", () => {
  it("cuts the clone off from the repo, so commits move only through mastermind's own fetches", async () => {
    const repo = await createTempRepo();
    const root = await makeTempDir("clones");
    const registry = createProcessRegistry();
    onCleanup(() => {
      registry.killAllSync();
    });
    const homeWithoutIdentity = join(root, "home");
    const git = createGit({
      registry,
      env: { PATH: process.env.PATH, HOME: homeWithoutIdentity, GIT_CONFIG_NOSYSTEM: "1" },
    });
    const worktreeDir = join(root, "worktrees");
    const path = join(worktreeDir, "ext2");

    const clone = await createTaskClone(git, {
      repoRoot: repo.path,
      mainBranch: "main",
      taskId: "ext2",
      path,
    });

    expect(clone).toEqual({
      path,
      branch: "task/ext2",
      baseCommit: await repo.git("rev-parse", "main"),
    });
    expect(await git.run(path, ["remote"])).toBe("");
    expect(await git.run(path, ["branch", "--show-current"])).toBe("task/ext2");
    expect(await readFile(join(path, ".git", "info", "exclude"), "utf8")).toMatch(
      /^\/\.mastermind-result\.md$/m,
    );

    await writeFile(join(path, "driver.rs"), "fn main() {}\n");
    await writeFile(join(path, ".mastermind-result.md"), "Wrote the driver.\n");
    const wip = await commitLeftovers(git, path, "WIP: interrupted");
    expect((await git.run(path, ["log", "-1", "--format=%an <%ae>|%B"])).trimEnd()).toBe(
      `${owner.name} <${owner.email}>|WIP: interrupted`,
    );
    expect(await git.run(path, ["ls-files"])).not.toContain(".mastermind-result.md");
    expect(await commitLeftovers(git, path, "WIP: interrupted")).toBeNull();

    await writeFile(join(repo.path, "CHANGELOG.md"), "main moved\n");
    await repo.git("add", "CHANGELOG.md");
    await repo.git("commit", "--quiet", "--message", "Main moved");
    expect(
      await fetchMainIntoClone(git, { repoRoot: repo.path, mainBranch: "main", clonePath: path }),
    ).toBe(await repo.git("rev-parse", "main"));
    expect(
      await fetchTaskIntoRepo(git, { repoRoot: repo.path, taskId: "ext2", clonePath: path }),
    ).toBe(wip);
    expect(await repo.git("rev-parse", "refs/mastermind/ext2")).toBe(wip);
    expect(await repo.git("branch", "--list")).toBe("* main");

    await expect(deleteClone(repo.path, worktreeDir)).rejects.toBeInstanceOf(CloneLocationError);
    await deleteClone(path, worktreeDir);
    expect(existsSync(path)).toBe(false);
  });
});
