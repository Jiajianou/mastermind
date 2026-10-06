import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { apiErrorSchema, apiResponseSchemas } from "@mastermind/core/contracts";
import type { FileChange } from "@mastermind/core/contracts";
import { commitLeftovers, createTaskClone, headCommit } from "@mastermind/core/git";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeTempDir } from "../support/cleanup.js";
import { createTempRepo } from "../support/temp-repo.js";
import { serveTestApi } from "./api/harness.js";
import type { TestApi } from "./api/harness.js";
import { callTool, connect, text } from "./api/mcp-client.js";

const execFileAsync = promisify(execFile);

interface TaskWorkspace {
  test: TestApi;
  worktree: string;
  baseCommit: string;
  write(files: Record<string, string | Buffer>): Promise<void>;
  git(...args: string[]): Promise<string>;
  commit(message: string): Promise<string>;
  get<Schema extends z.ZodType>(path: string, schema: Schema): Promise<z.output<Schema>>;
  refusal(path: string): Promise<{ status: number; message: string }>;
}

async function taskWorkspace(files: Record<string, string>): Promise<TaskWorkspace> {
  const test = await serveTestApi();
  const repo = await createTempRepo({ files });
  const worktree = join(await makeTempDir("worktrees"), "feature");
  const clone = await createTaskClone(test.git, {
    repoRoot: repo.path,
    mainBranch: repo.mainBranch,
    taskId: "feature",
    path: worktree,
  });
  test.db.tasks.create({
    id: "feature",
    title: "Feature",
    goal: "Build the feature.",
    acceptance: "true",
    touches: ["."],
  });
  test.db.tasks.update("feature", {
    status: "running",
    worktree,
    branch: clone.branch,
    baseCommit: clone.baseCommit,
  });

  const request = (path: string) =>
    fetch(test.url(`/api/tasks/feature${path}`), {
      headers: { authorization: test.authorization },
    });

  return {
    test,
    worktree,
    baseCommit: clone.baseCommit,
    async write(changes) {
      for (const [path, content] of Object.entries(changes)) {
        await mkdir(dirname(join(worktree, path)), { recursive: true });
        await writeFile(join(worktree, path), content);
      }
    },
    git: (...args) => test.git.run(worktree, args),
    async commit(message) {
      await commitLeftovers(test.git, worktree, message);
      return headCommit(test.git, worktree);
    },
    async get(path, schema) {
      const response = await request(path);
      expect(response.status).toBe(200);
      return schema.parse(await response.json());
    },
    async refusal(path) {
      const response = await request(path);
      const { message } = apiErrorSchema.parse(await response.json());
      return { status: response.status, message };
    },
  };
}

const change = (path: string, details: Partial<FileChange>): FileChange => ({
  path,
  oldPath: null,
  status: "modified",
  additions: 0,
  deletions: 0,
  binary: false,
  uncommitted: false,
  ...details,
});

const fileUrl = (path: string, query = "") =>
  `/file?path=${encodeURIComponent(path)}${query === "" ? "" : `&${query}`}`;

describe("git service", () => {
  it("shows an uncommitted edit and a new untracked file in the changes, with both versions of the file", async () => {
    const workspace = await taskWorkspace({ "src/app.ts": "one\ntwo\n", "README.md": "# Demo\n" });

    await workspace.write({ "src/app.ts": "one\n2\nthree\n", "notes/todo.md": "a\nb\n" });
    const changes = await workspace.get("/changes", apiResponseSchemas.changes);

    expect(changes).toEqual({
      taskId: "feature",
      since: "base",
      fromCommit: workspace.baseCommit,
      files: [
        change("notes/todo.md", { status: "added", additions: 2, uncommitted: true }),
        change("src/app.ts", { additions: 2, deletions: 1, uncommitted: true }),
      ],
    });
    expect(
      await workspace.get(fileUrl("src/app.ts", "side=base"), apiResponseSchemas.file),
    ).toEqual({ path: "src/app.ts", side: "base", kind: "text", size: 8, content: "one\ntwo\n" });
    expect(await workspace.get(fileUrl("src/app.ts"), apiResponseSchemas.file)).toEqual({
      path: "src/app.ts",
      side: "current",
      kind: "text",
      size: 12,
      content: "one\n2\nthree\n",
    });
    expect(
      await workspace.get(fileUrl("notes/todo.md", "side=base"), apiResponseSchemas.file),
    ).toEqual({ path: "notes/todo.md", side: "base", kind: "missing" });

    await workspace.commit("WIP: app");
    const committed = await workspace.get("/changes", apiResponseSchemas.changes);
    expect(committed.files.map(({ path, uncommitted }) => ({ path, uncommitted }))).toEqual([
      { path: "notes/todo.md", uncommitted: false },
      { path: "src/app.ts", uncommitted: false },
    ]);

    const client = await connect(workspace.test);
    const viaTool = await callTool(client, "get_changes", { taskId: "feature" });
    expect(apiResponseSchemas.changes.parse(JSON.parse(text(viaTool)))).toEqual(committed);
  });

  it("reports renames, deletes, binary and oversized files, and lists the tree without deleted files", async () => {
    const guide = Array.from({ length: 20 }, (_, line) => `Step ${String(line + 1)}.`).join("\n");
    const workspace = await taskWorkspace({
      "docs/guide.md": `${guide}\n`,
      "old.txt": "first\nsecond\n",
      "logo.png": "\u0089PNG\0\0\u0001",
      "README.md": "# Demo\n",
    });

    await workspace.git("mv", "docs/guide.md", "docs/manual.md");
    await workspace.write({ "docs/manual.md": `${guide}\nStep 21.\n` });
    await workspace.commit("docs: rename the guide");
    await rm(join(workspace.worktree, "old.txt"));
    await workspace.write({
      "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 2]),
      "assets/icon.bin": Buffer.from([0, 1, 2, 3]),
      "build.log": "line\n".repeat(220_000),
      ".mastermind-result.md": "Renamed the guide.\n",
    });

    const { files } = await workspace.get("/changes", apiResponseSchemas.changes);

    expect(files).toEqual([
      change("assets/icon.bin", {
        status: "added",
        additions: null,
        deletions: null,
        binary: true,
        uncommitted: true,
      }),
      change("build.log", { status: "added", additions: null, deletions: null, uncommitted: true }),
      change("docs/manual.md", { status: "renamed", oldPath: "docs/guide.md", additions: 1 }),
      change("logo.png", { additions: null, deletions: null, binary: true, uncommitted: true }),
      change("old.txt", { status: "deleted", deletions: 2, uncommitted: true }),
    ]);
    expect(await workspace.get(fileUrl("logo.png"), apiResponseSchemas.file)).toEqual({
      path: "logo.png",
      side: "current",
      kind: "binary",
      size: 7,
    });
    expect(await workspace.get(fileUrl("build.log"), apiResponseSchemas.file)).toMatchObject({
      kind: "too_large",
      size: 1_100_000,
    });
    expect(await workspace.get(fileUrl("old.txt"), apiResponseSchemas.file)).toEqual({
      path: "old.txt",
      side: "current",
      kind: "missing",
    });
    expect(
      await workspace.get(fileUrl("old.txt", "side=base"), apiResponseSchemas.file),
    ).toMatchObject({ kind: "text", content: "first\nsecond\n" });

    const tree = await workspace.get("/tree", apiResponseSchemas.tree);
    expect(tree).toEqual({
      taskId: "feature",
      files: ["README.md", "assets/icon.bin", "build.log", "docs/manual.md", "logo.png"],
    });
  });

  it("diffs against the end of a round, so only the work since that round shows", async () => {
    const workspace = await taskWorkspace({ "src/a.ts": "a1\n", "src/b.ts": "b1\n" });
    const { db } = workspace.test;

    await workspace.write({ "src/a.ts": "a2\n" });
    const roundOneEnd = await workspace.commit("WIP: round 1");
    const roundOne = db.sessions.create({ role: "worker", taskId: "feature", round: 1 });
    db.sessions.end(roundOne.id, { status: "succeeded", endCommit: roundOneEnd });
    db.tasks.update("feature", { round: 2 });
    await workspace.write({ "src/a.ts": "a3\n", "src/b.ts": "b2\n" });

    const sinceRound = await workspace.get("/changes?since=round:1", apiResponseSchemas.changes);
    const sinceBase = await workspace.get("/changes", apiResponseSchemas.changes);

    expect(sinceRound).toMatchObject({ since: "round:1", fromCommit: roundOneEnd });
    expect(sinceRound.files.map(({ path }) => path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(
      await workspace.get(fileUrl("src/a.ts", "side=base&since=round:1"), apiResponseSchemas.file),
    ).toMatchObject({ kind: "text", content: "a2\n" });
    expect(
      await workspace.get(fileUrl("src/a.ts", "side=base"), apiResponseSchemas.file),
    ).toMatchObject({ kind: "text", content: "a1\n" });
    expect(sinceBase.files).toEqual([
      change("src/a.ts", { additions: 1, deletions: 1, uncommitted: true }),
      change("src/b.ts", { additions: 1, deletions: 1, uncommitted: true }),
    ]);

    await workspace.git("commit", "--quiet", "--all", "--message", "round 2");
    const afterCommit = await workspace.get("/changes?since=round:1", apiResponseSchemas.changes);
    expect(afterCommit.files.map(({ path }) => path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(await workspace.refusal("/changes?since=round:2")).toEqual({
      status: 404,
      message: 'round 2 of task "feature" has no finished session',
    });
  });

  it("refuses files outside the worktree, inside .git or that are not regular files", async () => {
    const workspace = await taskWorkspace({ "src/app.ts": "export {};\n" });
    const outside = await makeTempDir("outside");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(workspace.worktree, "leak"));
    await symlink(outside, join(workspace.worktree, "leak-dir"));
    await execFileAsync("mkfifo", [join(workspace.worktree, "pipe")]);

    const refused = async (path: string, side: string) => {
      const { status } = await workspace.refusal(fileUrl(path, `side=${side}`));
      return status === 400;
    };
    for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), ".git/config"]) {
      expect(await refused(path, "current"), path).toBe(true);
      expect(await refused(path, "base"), path).toBe(true);
    }
    expect(await refused("src/app.ts\0.png", "current")).toBe(true);
    for (const path of ["leak", "leak-dir/secret.txt"]) {
      expect(await workspace.refusal(fileUrl(path))).toEqual({
        status: 400,
        message: `path: "${path}" resolves outside the task's worktree`,
      });
    }
    expect(await workspace.refusal(fileUrl("pipe"))).toEqual({
      status: 400,
      message: 'path: "pipe" is not a file',
    });
    const { files } = await workspace.get("/changes", apiResponseSchemas.changes);
    expect(files).toEqual([
      change("leak", { status: "added", additions: 1, uncommitted: true }),
      change("leak-dir", { status: "added", additions: 1, uncommitted: true }),
    ]);
    expect(await workspace.refusal(fileUrl("src"))).toMatchObject({ status: 400 });
    expect(await workspace.refusal(fileUrl("src", "side=base"))).toMatchObject({ status: 400 });
  });

  it("answers 409 for a task without a workspace and 404 for an unknown task", async () => {
    const test = await serveTestApi();
    test.db.tasks.create({
      id: "later",
      title: "Later",
      goal: "Not started.",
      acceptance: "true",
      touches: [],
    });
    const status = async (path: string) =>
      (await fetch(test.url(path), { headers: { authorization: test.authorization } })).status;

    expect(await status("/api/tasks/later/changes")).toBe(409);
    expect(await status("/api/tasks/later/tree")).toBe(409);
    expect(await status("/api/tasks/missing/changes")).toBe(404);
    expect(await status("/api/tasks/later/changes?since=round:0")).toBe(400);
  });
});
