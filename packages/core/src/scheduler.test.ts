import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { BusEvent, Session, Task } from "./contracts/index.js";
import { openDb } from "./db/index.js";
import type { Db } from "./db/index.js";
import { builtinActions, createActionRegistry } from "./actions/index.js";
import type { ActionRegistry } from "./actions/index.js";
import { createEventBus } from "./events.js";
import { createScheduler, selectReady, summarize, touchesOverlap } from "./scheduler.js";
import type { Scheduler, SchedulerState } from "./scheduler.js";

const noon = "2026-10-06T12:00:00.000Z";
const minute = 60_000;

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    goal: `Build ${id}`,
    acceptance: "true",
    touches: [`src/${id}/`],
    deps: [],
    status: "pending",
    priority: 0,
    attempts: 0,
    round: 1,
    held: false,
    resumeSession: null,
    branch: null,
    worktree: null,
    baseCommit: null,
    createdAt: noon,
    updatedAt: noon,
    ...fields,
  };
}

function running(role: Session["role"]): Pick<Session, "role" | "status"> {
  return { role, status: "running" };
}

function state(tasks: Task[], overrides: Partial<SchedulerState> = {}): SchedulerState {
  return {
    tasks,
    sessions: [],
    flags: { paused: false, authRequired: false, backoffResumeAt: null },
    starting: [],
    maxWorkers: 2,
    now: new Date(noon),
    ...overrides,
  };
}

describe("touchesOverlap", () => {
  it.each([
    { first: ["src/a"], second: ["src/a/b.ts"], overlap: true },
    { first: ["src/a/b.ts"], second: ["src/a"], overlap: true },
    { first: ["src/a/"], second: ["src/a"], overlap: true },
    { first: ["src/a"], second: ["src/ab"], overlap: false },
    { first: ["src/ab/"], second: ["src/a/"], overlap: false },
    { first: ["docs/", "package.json"], second: ["src/", "package.json"], overlap: true },
    { first: ["."], second: ["src/a"], overlap: true },
    { first: [], second: ["src/a"], overlap: false },
  ])("$first and $second overlap: $overlap", ({ first, second, overlap }) => {
    expect(touchesOverlap(first, second)).toBe(overlap);
  });
});

describe("selectReady", () => {
  it.each<{ name: string; state: SchedulerState; ready: string[] }>([
    {
      name: "starts the highest priorities first, oldest first within a priority",
      state: state(
        [
          task("low", { priority: 1 }),
          task("newer", { priority: 5, createdAt: "2026-10-06T12:00:01.000Z" }),
          task("older", { priority: 5 }),
        ],
        { maxWorkers: 3 },
      ),
      ready: ["older", "newer", "low"],
    },
    {
      name: "fills only the free worker slots",
      state: state([task("a", { priority: 3 }), task("b", { priority: 2 }), task("c")], {
        maxWorkers: 2,
        sessions: [running("worker")],
      }),
      ready: ["a"],
    },
    {
      name: "counts fixers but not reviewer, judge or conductor sessions toward maxWorkers",
      state: state([task("a"), task("b")], {
        maxWorkers: 2,
        sessions: [running("fixer"), running("reviewer"), running("judge"), running("conductor")],
      }),
      ready: ["a"],
    },
    {
      name: "ignores sessions that have ended",
      state: state([task("a")], {
        maxWorkers: 1,
        sessions: [{ role: "worker", status: "succeeded" }],
      }),
      ready: ["a"],
    },
    {
      name: "starts nothing when every slot is taken",
      state: state([task("a")], { maxWorkers: 1, sessions: [running("worker")] }),
      ready: [],
    },
    {
      name: "counts starts still in flight toward maxWorkers and as occupying their paths",
      state: state(
        [
          task("launching", { touches: ["src/a/"] }),
          task("clash", { priority: 2, touches: ["src/a/x.ts"] }),
          task("free", { priority: 1 }),
          task("later"),
        ],
        { maxWorkers: 2, starting: ["launching"] },
      ),
      ready: ["free"],
    },
    {
      name: "waits until every dependency is done",
      state: state([
        task("base", { status: "done" }),
        task("other", { status: "review" }),
        task("ready", { deps: ["base"] }),
        task("waiting", { deps: ["base", "other"] }),
        task("orphan", { deps: ["missing"] }),
      ]),
      ready: ["ready"],
    },
    {
      name: "skips a task whose touches are a prefix of an active task's touches",
      state: state([
        task("active", { status: "running", touches: ["src/a/deep/"] }),
        task("wide", { touches: ["src/a/"] }),
      ]),
      ready: [],
    },
    {
      name: "skips a task whose touches lie under an active task's touches",
      state: state([
        task("active", { status: "checking", touches: ["src/a/"] }),
        task("deep", { touches: ["src/a/deep/file.ts"] }),
      ]),
      ready: [],
    },
    {
      name: "treats review and rebasing tasks as still occupying their paths",
      state: state([
        task("in-review", { status: "review", touches: ["src/a/"] }),
        task("landing", { status: "rebasing", touches: ["src/b/"] }),
        task("a", { touches: ["src/a/x.ts"] }),
        task("b", { touches: ["src/b/"] }),
      ]),
      ready: [],
    },
    {
      name: "lets a sibling path start: src/a and src/ab do not overlap",
      state: state([
        task("active", { status: "running", touches: ["src/a"] }),
        task("sibling", { touches: ["src/ab"] }),
      ]),
      ready: ["sibling"],
    },
    {
      name: "frees the paths of done, blocked and pending tasks",
      state: state(
        [
          task("finished", { status: "done", touches: ["src/a/"] }),
          task("stuck", { status: "blocked", touches: ["src/a/"] }),
          task("a", { touches: ["src/a/"] }),
        ],
        { maxWorkers: 3 },
      ),
      ready: ["a"],
    },
    {
      name: "never starts two overlapping tasks in the same pass",
      state: state([
        task("first", { priority: 2, touches: ["src/"] }),
        task("second", { priority: 1, touches: ["src/a/"] }),
        task("third", { touches: ["docs/"] }),
      ]),
      ready: ["first", "third"],
    },
    {
      name: "skips held tasks",
      state: state([task("held", { held: true, priority: 9 }), task("free")]),
      ready: ["free"],
    },
    {
      name: "starts nothing while paused",
      state: state([task("a")], {
        flags: { paused: true, authRequired: false, backoffResumeAt: null },
      }),
      ready: [],
    },
    {
      name: "starts nothing while sign-in is required",
      state: state([task("a")], {
        flags: { paused: false, authRequired: true, backoffResumeAt: null },
      }),
      ready: [],
    },
    {
      name: "starts nothing before the usage-limit back-off ends",
      state: state([task("a")], {
        flags: { paused: false, authRequired: false, backoffResumeAt: "2026-10-06T12:00:01.000Z" },
      }),
      ready: [],
    },
    {
      name: "starts again once the back-off time has passed",
      state: state([task("a")], {
        flags: { paused: false, authRequired: false, backoffResumeAt: noon },
      }),
      ready: ["a"],
    },
  ])("$name", ({ state, ready }) => {
    expect(selectReady(state).map((task) => task.id)).toEqual(ready);
  });
});

describe("summarize", () => {
  it("counts tasks by status and lists what is up next even while paused", () => {
    const summary = summarize(
      state(
        [
          task("done", { status: "done" }),
          task("work", { status: "running", touches: ["src/"] }),
          task("next", { priority: 1, touches: ["docs/"] }),
          task("clash", { priority: 2, touches: ["src/x/"] }),
          task("stuck", { status: "blocked" }),
        ],
        {
          sessions: [running("worker"), running("reviewer")],
          flags: { paused: true, authRequired: false, backoffResumeAt: "2026-10-06T12:05:00.000Z" },
        },
      ),
    );

    expect(summary).toEqual({
      counts: { pending: 2, running: 1, checking: 0, review: 0, rebasing: 0, done: 1, blocked: 1 },
      activeWorkers: 1,
      maxWorkers: 2,
      upNext: ["next"],
      blocked: ["stuck"],
      paused: true,
      authRequired: false,
      resumeAt: "2026-10-06T12:05:00.000Z",
    });
  });
});

describe("scheduler loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  interface LoopHarness {
    db: Db;
    actions: ActionRegistry;
    scheduler: Scheduler;
    started: string[];
    events: BusEvent[];
    errors: unknown[];
  }

  function startLoop(
    startTask: (task: Task, db: Db) => Promise<void> = (task, db) => {
      db.tasks.update(task.id, { status: "running" });
      return Promise.resolve();
    },
    maxWorkers = 1,
  ): LoopHarness {
    vi.useFakeTimers({ now: new Date(noon) });
    const clock = { now: () => new Date() };
    const db = openDb(":memory:", { clock });
    const bus = createEventBus();
    const events: BusEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const unusedConfig = { set: () => Promise.reject(new Error("config is not used here")) };
    const actions = createActionRegistry({ db, bus, config: unusedConfig }, builtinActions);
    const started: string[] = [];
    const errors: unknown[] = [];
    const scheduler = createScheduler({
      db,
      bus,
      clock,
      maxWorkers: () => maxWorkers,
      startTask: (task) => {
        started.push(task.id);
        return startTask(task, db);
      },
      onError: (error) => errors.push(error),
    });
    onTestFinished(() => {
      scheduler.stop();
      db.close();
    });
    scheduler.start();
    return { db, actions, scheduler, started, events, errors };
  }

  const newTask = (id: string) => ({ id, title: id, goal: id, acceptance: "true", touches: [] });

  it("starts a task as soon as an action changes state, and the next on a later tick once a slot frees", async () => {
    const { db, actions, started, errors } = startLoop();
    await vi.advanceTimersByTimeAsync(0);

    await actions.invoke("createTasks", { tasks: [newTask("a"), newTask("b")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["a"]);

    db.tasks.update("a", { status: "done" });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(started).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["a", "b"]);
    expect(errors).toEqual([]);
  });

  it("keeps starting other tasks while a slow start is in flight, and never starts the same task twice", async () => {
    const pendingStarts = new Map<string, () => void>();
    const { db, actions, started, errors } = startLoop(
      (task) =>
        new Promise((resolve) => {
          pendingStarts.set(task.id, () => {
            db.tasks.update(task.id, { status: "running" });
            resolve();
          });
        }),
      2,
    );

    await actions.invoke("createTasks", { tasks: [newTask("a"), newTask("b"), newTask("c")] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toEqual(["a", "b"]);

    pendingStarts.get("a")?.();
    db.tasks.update("a", { status: "done" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(started).toEqual(["a", "b", "c"]);
    expect(errors).toEqual([]);
  });

  it("reports a failed start and tries the task again on a later tick", async () => {
    const failure = new Error("clone failed");
    const { actions, started, errors } = startLoop(() => Promise.reject(failure));

    await actions.invoke("createTasks", { tasks: [newTask("a")] });
    await vi.advanceTimersByTimeAsync(0);
    expect([started, errors]).toEqual([["a"], [failure]]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(started).toEqual(["a", "a"]);
  });

  it("backs off 5, 10, 20, 40, 60 and 60 minutes, starts nothing meanwhile, and resets after a success", async () => {
    const { db, scheduler, started, events, errors } = startLoop();
    await vi.advanceTimersByTimeAsync(0);
    const delays: number[] = [];

    for (let limit = 0; limit < 6; limit += 1) {
      const resumeAt = scheduler.reportUsageLimit();
      const delay = resumeAt.getTime() - Date.now();
      delays.push(delay / minute);
      expect(scheduler.summary().resumeAt).toBe(resumeAt.toISOString());
      expect(scheduler.reportUsageLimit()).toEqual(resumeAt);
      await vi.advanceTimersByTimeAsync(delay);
    }
    scheduler.reportSuccess();
    const afterSuccess = scheduler.reportUsageLimit();

    expect(delays).toEqual([5, 10, 20, 40, 60, 60]);
    expect((afterSuccess.getTime() - Date.now()) / minute).toBe(5);

    db.tasks.create(newTask("a"));
    await vi.advanceTimersByTimeAsync(5 * minute - 1);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["a"]);
    expect(scheduler.summary().resumeAt).toBeNull();
    expect(events.filter((event) => event.type === "scheduler.updated").slice(0, 2)).toEqual([
      { type: "scheduler.updated", paused: false, resumeAt: "2026-10-06T12:05:00.000Z" },
      { type: "scheduler.updated", paused: false, resumeAt: null },
    ]);
    expect(errors).toEqual([]);
  });
});
