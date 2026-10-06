import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Clock } from "./clock.js";
import type { BusEvent, Session, Summary, Task } from "./contracts/index.js";
import { openDb } from "./db/index.js";
import type { Db } from "./db/index.js";
import { createEventBus } from "./events.js";
import type { EventBus } from "./events.js";
import { createStatusStore } from "./status.js";
import type { StatusStore } from "./status.js";
import { makeTempDir } from "./testing/temp-dir.js";

const ts = "2026-10-06T12:00:00.000Z";
const clock: Clock = { now: () => new Date(ts) };

const summary: Summary = {
  counts: { pending: 0, running: 0, checking: 0, review: 0, rebasing: 0, done: 0, blocked: 0 },
  activeWorkers: 0,
  maxWorkers: 2,
  upNext: [],
  blocked: [],
  paused: false,
  authRequired: false,
  resumeAt: null,
};

interface Harness {
  db: Db;
  bus: EventBus;
  store: StatusStore;
  lines(): string[];
}

async function setup(): Promise<Harness> {
  const root = await makeTempDir();
  const db = openDb(join(root, "db.sqlite"), { clock });
  db.tasks.create({ id: "ext2-driver", title: "ext2", goal: "g", acceptance: "true", touches: [] });
  const bus = createEventBus();
  const store = createStatusStore({
    db,
    bus,
    clock,
    header: {
      repoName: "myos",
      mainBranch: "main",
      mainCommit: "18ab0ad",
      email: "owner@example.com",
      plan: "max",
      link: "http://127.0.0.1:4700/#t=token",
    },
    summary: () => summary,
    maxAttempts: () => 3,
  });
  onTestFinished(() => {
    store.dispose();
    db.close();
  });
  return {
    db,
    bus,
    store,
    lines: () => store.getSnapshot().events.map(({ label, text }) => `${label}  ${text}`),
  };
}

function session(fields: Partial<Session>): Session {
  return {
    id: 1,
    taskId: "ext2-driver",
    role: "worker",
    round: 1,
    attempt: 1,
    claudeSessionId: null,
    pid: null,
    pgid: null,
    model: "opus",
    status: "running",
    endCommit: null,
    inputTokens: null,
    outputTokens: null,
    startedAt: ts,
    endedAt: null,
    ...fields,
  };
}

const started = (fields: Partial<Session>): BusEvent => {
  const started = session(fields);
  return {
    type: "session.started",
    sessionId: started.id,
    taskId: started.taskId,
    session: started,
  };
};

const ended = (fields: Partial<Session>): BusEvent => {
  const done = session(fields);
  return { type: "session.ended", sessionId: done.id, taskId: done.taskId, session: done };
};

const sessionEvent = (
  type: "commit" | "edit" | "error",
  summary: string,
  sessionId = 1,
): BusEvent => ({
  type: "session.event",
  sessionId,
  taskId: "ext2-driver",
  event: { id: 1, sessionId, ts, type, summary, payload: "{}" },
});

const taskIn = (status: Task["status"]): BusEvent => ({
  type: "task.updated",
  taskId: "ext2-driver",
  task: {
    id: "ext2-driver",
    title: "ext2",
    goal: "g",
    acceptance: "true",
    touches: [],
    deps: [],
    status,
    priority: 0,
    attempts: 0,
    round: 1,
    held: false,
    resumeSession: null,
    branch: null,
    worktree: null,
    baseCommit: null,
    createdAt: ts,
    updatedAt: ts,
  },
});

const branchRebase = (status: "running" | "failed"): BusEvent => ({
  type: "branch.updated",
  branch: {
    branch: "dev",
    mainBranch: "main",
    onMain: false,
    ahead: 1,
    behind: 0,
    upstream: null,
    rebase: { branch: "dev", status, startedAt: ts, endedAt: null, outcome: null, logPath: "x" },
  },
});

describe("the terminal view's event lines", () => {
  it.each<{ name: string; events: BusEvent[]; lines: string[] }>([
    {
      name: "a worker starting, with its attempt",
      events: [started({ attempt: 2 })],
      lines: ["ext2-driver  Start worker, attempt 2 of 3"],
    },
    {
      name: "commits and errors, but not edits",
      events: [
        sessionEvent("edit", "Edit kernel/fs/ext2/inode.rs"),
        sessionEvent("commit", 'Commit "ext2: read superblock"'),
        sessionEvent("error", "Session failed: crashed"),
      ],
      lines: [
        'ext2-driver  Commit "ext2: read superblock"',
        "ext2-driver  Session failed: crashed",
      ],
    },
    {
      name: "how a session ended",
      events: [ended({ status: "rate_limited" }), ended({ role: "fixer", status: "auth_failed" })],
      lines: [
        "ext2-driver  Worker hit the usage limit",
        "ext2-driver  Fixer lost its Claude sign-in",
      ],
    },
    {
      name: "nothing for the Conductor's own sessions",
      events: [
        started({ role: "conductor", taskId: null }),
        ended({ role: "conductor", taskId: null, status: "succeeded" }),
      ],
      lines: [],
    },
    {
      name: "checks",
      events: [
        {
          type: "check.updated",
          taskId: "ext2-driver",
          check: {
            id: 1,
            taskId: "ext2-driver",
            round: 1,
            kind: "build",
            status: "failed",
            summary: null,
            logPath: null,
            durationMs: 10,
          },
        },
      ],
      lines: ["ext2-driver  Build check failed"],
    },
    {
      name: "a task reaching review once, and blocked, but not routine moves",
      events: [taskIn("running"), taskIn("review"), taskIn("review"), taskIn("blocked")],
      lines: ["ext2-driver  Waiting for review", "ext2-driver  Blocked"],
    },
    {
      name: "a finished or failed rebase onto main",
      events: (["running", "succeeded", "failed"] as const).map((status) => ({
        type: "rebase.updated",
        taskId: "ext2-driver",
        rebase: { id: 1, taskId: "ext2-driver", status, logPath: null, ts },
      })),
      lines: ["rebase  ext2-driver rebased onto main", "rebase  ext2-driver rebase failed"],
    },
    {
      name: "the owner's checkout moving onto main and off it",
      events: [
        { type: "checkout.updated", branch: "main", onMain: true },
        { type: "checkout.updated", branch: "main", onMain: false },
      ],
      lines: [
        "rebase  You're on main: rebasing onto main is paused until you switch to another branch",
        "rebase  You left main; rebasing onto main continues",
      ],
    },
    {
      name: "each change of the owner's branch rebase once",
      events: [branchRebase("running"), branchRebase("running"), branchRebase("failed")],
      lines: ["rebase  Rebasing dev onto main", "rebase  dev rebase failed"],
    },
    {
      name: "pausing and the usage-limit wait",
      events: [
        { type: "scheduler.updated", paused: true, resumeAt: null },
        {
          type: "scheduler.updated",
          paused: true,
          resumeAt: new Date(2026, 9, 6, 14, 5).toISOString(),
        },
        { type: "scheduler.updated", paused: false, resumeAt: null },
      ],
      lines: [
        "scheduler  Paused",
        "scheduler  Usage limit reached; new sessions wait until 14:05:00",
        "scheduler  Resumed",
        "scheduler  Usage limit wait is over",
      ],
    },
    {
      name: "the sign-in expiring and coming back",
      events: [
        { type: "auth.updated", authRequired: true },
        { type: "auth.updated", authRequired: false },
      ],
      lines: [
        "sign-in  Your Claude sign-in expired. New sessions wait until you sign in again.",
        "sign-in  Signed in again",
      ],
    },
  ])("shows $name", async ({ events, lines }) => {
    const harness = await setup();

    for (const event of events) harness.bus.emit(event);

    expect(harness.lines()).toEqual(lines);
  });

  it("keeps only the latest five lines", async () => {
    const harness = await setup();

    for (const index of [1, 2, 3, 4, 5, 6, 7]) harness.store.notice(`notice ${String(index)}`);

    expect(harness.lines()).toEqual(
      [3, 4, 5, 6, 7].map((index) => `mastermind  notice ${String(index)}`),
    );
  });
});

describe("the terminal view's state", () => {
  it("lists running sessions with their latest activity and follows main and the owner's checkout", async () => {
    const harness = await setup();
    const worker = harness.db.sessions.create({
      role: "worker",
      taskId: "ext2-driver",
      attempt: 1,
    });
    harness.db.sessions.create({ role: "conductor" });
    let published = 0;
    harness.store.subscribe(() => published++);

    harness.bus.emit(sessionEvent("edit", "Edit inode.rs", worker.id));
    harness.bus.emit({ type: "main.moved", branch: "main", commit: "4f9a16a0123456789" });
    harness.bus.emit({ type: "checkout.updated", branch: "main", onMain: true });

    const snapshot = harness.store.getSnapshot();
    expect(snapshot.running).toEqual([
      {
        sessionId: worker.id,
        label: "ext2-driver",
        role: "worker",
        attempt: 1,
        model: null,
        startedAt: worker.startedAt,
        activity: "Edit inode.rs",
      },
    ]);
    expect(snapshot.header.mainCommit).toBe("4f9a16a");
    expect(snapshot.ownerOnMain).toBe(true);
    expect(published).toBe(3);
  });
});
