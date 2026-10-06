import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Clock } from "../clock.js";
import { makeTempDir } from "../testing/temp-dir.js";
import {
  InvalidRowError,
  ProposalAlreadyDecidedError,
  SchemaVersionError,
  openDb,
} from "./index.js";
import type { Db, NewTask } from "./index.js";

const noon = "2026-10-06T12:00:00.000Z";
const fixedClock: Clock = { now: () => new Date(noon) };

async function tempDbPath(): Promise<string> {
  return join(await makeTempDir(), "db.sqlite");
}

function useDb(path: string, clock: Clock = fixedClock): Db {
  const db = openDb(path, { clock });
  onTestFinished(() => {
    db.close();
  });
  return db;
}

function rawQuery(path: string, sql: string): Record<string, SQLOutputValue>[] {
  const database = new DatabaseSync(path);
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

const lexer: NewTask = {
  id: "lexer",
  title: "Lexer",
  goal: "Tokenise the input",
  acceptance: "pnpm test lexer",
  touches: ["src/lexer/"],
};

const parser: NewTask = {
  id: "parser",
  title: "Parser",
  goal: "Parse the tokens",
  acceptance: "pnpm test parser",
  touches: ["src/parser/", "src/ast.ts"],
  deps: ["lexer", "ast"],
  priority: 5,
};

describe("openDb", () => {
  it("migrates an empty file to the current schema, and reopening keeps the data and the version", async () => {
    const path = await tempDbPath();
    const first = openDb(path, { clock: fixedClock });
    first.tasks.create(lexer);
    first.close();

    const tables = rawQuery(path, "SELECT name FROM sqlite_schema WHERE type = 'table'");
    expect(tables.map((table) => table.name).sort()).toEqual([
      "chat_messages",
      "checks",
      "comments",
      "conductor_sessions",
      "events",
      "findings",
      "proposals",
      "rebases",
      "runtime_flags",
      "schema_version",
      "sessions",
      "task_deps",
      "tasks",
    ]);
    expect(rawQuery(path, "PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);

    const reopened = useDb(path);
    expect(reopened.tasks.get("lexer")?.title).toBe("Lexer");
    expect(rawQuery(path, "SELECT version FROM schema_version")).toEqual([{ version: 1 }]);
  });

  it("refuses a database written by a newer schema", async () => {
    const path = await tempDbPath();
    openDb(path).close();
    rawQuery(path, "UPDATE schema_version SET version = 99");

    expect(() => openDb(path)).toThrow(SchemaVersionError);
  });
});

describe("tasks", () => {
  it("round-trips a task with its deps and replaces the deps on update", async () => {
    const db = useDb(await tempDbPath());
    db.tasks.create(lexer);
    db.tasks.create(parser);

    expect(db.tasks.get("parser")).toEqual({
      id: "parser",
      title: "Parser",
      goal: "Parse the tokens",
      acceptance: "pnpm test parser",
      touches: ["src/parser/", "src/ast.ts"],
      deps: ["ast", "lexer"],
      status: "pending",
      priority: 5,
      attempts: 0,
      round: 1,
      held: false,
      resumeSession: null,
      branch: null,
      worktree: null,
      baseCommit: null,
      createdAt: noon,
      updatedAt: noon,
    });

    const updated = db.tasks.update("parser", {
      deps: ["lexer"],
      status: "running",
      held: true,
      branch: "task/parser",
    });

    expect(updated).toMatchObject({ deps: ["lexer"], status: "running", held: true });
    expect(db.tasks.list().map((task) => [task.id, task.deps])).toEqual([
      ["parser", ["lexer"]],
      ["lexer", []],
    ]);
  });
});

describe("transaction", () => {
  it("rolls back every write when the work throws", async () => {
    const db = useDb(await tempDbPath());

    expect(() =>
      db.transaction(() => {
        db.tasks.create(parser);
        db.sessions.create({ role: "worker", taskId: "parser" });
        throw new Error("spawn failed");
      }),
    ).toThrow("spawn failed");

    expect(db.tasks.list()).toEqual([]);
    expect(db.sessions.listRunning()).toEqual([]);
  });

  it("rolls back only a failing nested transaction", async () => {
    const db = useDb(await tempDbPath());

    db.transaction(() => {
      db.tasks.create(lexer);
      expect(() =>
        db.transaction(() => {
          db.tasks.create(parser);
          throw new Error("invalid parser");
        }),
      ).toThrow("invalid parser");
    });

    expect(db.tasks.list().map((task) => task.id)).toEqual(["lexer"]);
  });
});

describe("killRunning", () => {
  it("marks exactly the running sessions, checks and rebases killed", async () => {
    let now = new Date("2026-10-06T09:00:00.000Z");
    const db = useDb(await tempDbPath(), { now: () => now });
    db.tasks.create(lexer);
    const worker = db.sessions.create({ role: "worker", taskId: "lexer", pid: 41, pgid: 41 });
    const conductor = db.sessions.create({ role: "conductor" });
    const finished = db.sessions.end(db.sessions.create({ role: "reviewer" }).id, {
      status: "succeeded",
    });
    const runningCheck = db.checks.create({ taskId: "lexer", round: 1, kind: "build" });
    const passedCheck = db.checks.finish(
      db.checks.create({ taskId: "lexer", round: 1, kind: "setup" }).id,
      { status: "passed", durationMs: 1200 },
    );
    const runningRebase = db.rebases.create({ taskId: "lexer" });
    const failedRebase = db.rebases.finish(db.rebases.create({ taskId: "lexer" }).id, "failed");

    now = new Date("2026-10-06T09:30:00.000Z");
    const counts = db.killRunning();

    expect(counts).toEqual({ sessions: 2, checks: 1, rebases: 1 });
    expect(db.sessions.listRunning()).toEqual([]);
    expect(db.sessions.get(worker.id)).toMatchObject({
      status: "killed",
      endedAt: "2026-10-06T09:30:00.000Z",
    });
    expect(db.sessions.get(conductor.id)?.status).toBe("killed");
    expect(db.sessions.get(finished.id)).toEqual(finished);
    expect(db.checks.listForTask("lexer")).toEqual([
      { ...runningCheck, status: "killed" },
      passedCheck,
    ]);
    expect(db.rebases.listForTask("lexer")).toEqual([
      { ...runningRebase, status: "killed" },
      failedRebase,
    ]);
  });
});

describe("JSON columns", () => {
  it("keeps runtime flags, chat metadata and a decided proposal across a reopen", async () => {
    const path = await tempDbPath();
    const first = openDb(path, { clock: fixedClock });
    first.flags.set({ paused: true, backoffResumeAt: "2026-10-06T12:05:00.000Z" });
    first.chat.append({ kind: "action", content: "Started lexer", meta: { taskId: "lexer" } });
    const proposal = first.proposals.create({ action: "discard_task", args: { id: "lexer" } });
    first.proposals.decide(proposal.id, "confirmed", { discarded: true });
    expect(() => first.proposals.decide(proposal.id, "expired")).toThrow(
      ProposalAlreadyDecidedError,
    );
    first.close();

    const db = useDb(path);

    expect(db.flags.get()).toEqual({
      paused: true,
      authRequired: false,
      backoffResumeAt: "2026-10-06T12:05:00.000Z",
    });
    expect(db.chat.list()).toMatchObject([{ kind: "action", meta: { taskId: "lexer" } }]);
    expect(db.proposals.get(proposal.id)).toMatchObject({
      args: { id: "lexer" },
      status: "confirmed",
      decidedAt: noon,
      result: { discarded: true },
    });
    expect(db.proposals.listPending()).toEqual([]);
  });

  it.each([
    { column: "tasks.touches", sql: "UPDATE tasks SET touches = 'src/'", read: readTask },
    { column: "tasks.touches", sql: "UPDATE tasks SET touches = '[1]'", read: readTask },
    { column: "tasks.status", sql: "UPDATE tasks SET status = 'merged'", read: readTask },
    {
      column: "runtime_flags.paused",
      sql: `INSERT INTO runtime_flags (key, value) VALUES ('paused', '"yes"')`,
      read: readFlags,
    },
    {
      column: "runtime_flags.key",
      sql: "INSERT INTO runtime_flags (key, value) VALUES ('colour', '1')",
      read: readFlags,
    },
  ])("reports a corrupt $column as an invalid row", async ({ sql, read }) => {
    const path = await tempDbPath();
    const db = useDb(path);
    db.tasks.create(lexer);
    rawQuery(path, sql);

    expect(() => read(db)).toThrow(InvalidRowError);
  });
});

function readTask(db: Db): unknown {
  return db.tasks.get("lexer");
}

function readFlags(db: Db): unknown {
  return db.flags.get();
}
