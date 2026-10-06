import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { loadConfig, setConfig as writeConfig } from "../config/index.js";
import type { ConfigContext } from "../config/index.js";
import type { BusEvent, NewTaskInput, Task } from "../contracts/index.js";
import { openDb } from "../db/index.js";
import type { Clock, Db } from "../db/index.js";
import { createEventBus } from "../events.js";
import { makeTempDir } from "../testing/temp-dir.js";
import {
  ActionError,
  IllegalTransitionError,
  builtinActions,
  createActionRegistry,
  defineAction,
} from "./index.js";
import type { ActionRegistry } from "./index.js";

const clock: Clock = { now: () => new Date("2026-10-06T12:00:00.000Z") };

interface Harness {
  db: Db;
  actions: ActionRegistry;
  events: BusEvent[];
  configContext: ConfigContext;
}

async function setup(): Promise<Harness> {
  const projectRoot = await makeTempDir();
  const configContext = { repoRoot: projectRoot, homeDir: join(projectRoot, "home") };
  const db = openDb(join(projectRoot, "db.sqlite"), { clock });
  onTestFinished(() => {
    db.close();
  });
  const bus = createEventBus();
  const events: BusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const config = { set: (change: unknown) => writeConfig(configContext, change) };
  const actions = createActionRegistry({ db, bus, config }, builtinActions);
  return { db, actions, events, configContext };
}

function newTask(id: string, fields: Partial<NewTaskInput> = {}): NewTaskInput {
  return {
    id,
    title: `Build ${id}`,
    goal: `Make ${id} work`,
    acceptance: `pnpm test ${id}`,
    touches: [`src/${id}/`],
    ...fields,
  };
}

async function seed(harness: Harness, tasks: NewTaskInput[]): Promise<void> {
  await harness.actions.invoke("createTasks", { tasks });
  harness.events.length = 0;
}

async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ActionError))
    throw new Error(`expected an ActionError, got ${String(error)}`);
  return error;
}

const taskEvents = (events: BusEvent[]) =>
  events.map((event) =>
    event.type === "task.updated" ? [event.type, event.taskId] : [event.type],
  );

describe("createTasks", () => {
  it("stores a batch whose deps point forward and at existing tasks, and emits task.updated for each", async () => {
    const harness = await setup();
    await seed(harness, [newTask("ast")]);

    const created = await harness.actions.invoke("createTasks", {
      tasks: [newTask("parser", { deps: ["lexer", "ast"], priority: 3 }), newTask("lexer")],
    });

    expect(created).toMatchObject([
      { id: "parser", deps: ["ast", "lexer"], priority: 3, status: "pending" },
      { id: "lexer", deps: [], priority: 0, status: "pending" },
    ]);
    expect(harness.db.tasks.get("parser")).toMatchObject({ deps: ["ast", "lexer"] });
    expect(taskEvents(harness.events)).toEqual([
      ["task.updated", "parser"],
      ["task.updated", "lexer"],
    ]);
  });

  it.each([
    {
      name: "a cycle",
      tasks: [newTask("a", { deps: ["b"] }), newTask("b", { deps: ["a"] })],
      message: "dependency cycle: a → b → a (each task depends on the next)",
    },
    {
      name: "an unknown dependency",
      tasks: [newTask("a", { deps: ["ghost"] })],
      message: 'task "a" depends on "ghost", which does not exist',
    },
    {
      name: "a duplicate id",
      tasks: [newTask("a"), newTask("a")],
      message: 'task id "a" is used more than once',
    },
    {
      name: "an existing id",
      tasks: [newTask("b"), newTask("ast")],
      message: 'task "ast" already exists',
    },
  ])(
    "rejects $name with a precise message and stores none of the batch",
    async ({ tasks, message }) => {
      const harness = await setup();
      await seed(harness, [newTask("ast")]);

      const error = await rejection(harness.actions.invoke("createTasks", { tasks }));

      expect(error.code).toBe("invalid_input");
      expect(error.message).toBe(message);
      expect(harness.db.tasks.list().map((task) => task.id)).toEqual(["ast"]);
      expect(harness.events).toEqual([]);
    },
  );
});

describe("action input validation", () => {
  it.each([
    { action: "createTasks", input: { tasks: [] }, path: "tasks" },
    { action: "createTasks", input: { tasks: [newTask("Not A Slug")] }, path: "tasks[0].id" },
    {
      action: "createTasks",
      input: { tasks: [newTask("a", { touches: ["../outside"] })] },
      path: "tasks[0].touches[0]",
    },
    {
      action: "createTasks",
      input: { tasks: [{ ...newTask("a"), prio: 1 }] },
      path: "tasks[0].prio",
    },
    {
      action: "createTasks",
      input: { tasks: [newTask("a", { title: "  " })] },
      path: "tasks[0].title",
    },
    { action: "updateTask", input: { taskId: "ast" }, path: null },
    { action: "setPriority", input: { taskId: "ast", priority: 1.5 }, path: "priority" },
    { action: "hold", input: {}, path: "taskId" },
    { action: "setConfig", input: { maxWorkers: 0 }, path: "maxWorkers" },
    { action: "setConfig", input: { models: { wroker: "opus" } }, path: "models.wroker" },
    { action: "importTasks", input: { yaml: 42 }, path: "yaml" },
  ])("$action rejects invalid input, naming $path", async ({ action, input, path }) => {
    const harness = await setup();
    await seed(harness, [newTask("ast")]);

    const error = await rejection(harness.actions.invoke(action, input));

    expect(error.code).toBe("invalid_input");
    expect(error.issues.map((issue) => issue.path)).toContain(path);
    expect(harness.events).toEqual([]);
  });

  it("refuses an unknown action and an unknown task as not found", async () => {
    const harness = await setup();

    const unknownAction = await rejection(harness.actions.invoke("launchRockets", {}));
    const unknownTask = await rejection(harness.actions.invoke("hold", { taskId: "ghost" }));

    expect([unknownAction.code, unknownAction.message]).toEqual([
      "not_found",
      'unknown action "launchRockets"',
    ]);
    expect([unknownTask.code, unknownTask.message]).toEqual(["not_found", 'no task "ghost"']);
  });
});

describe("task controls", () => {
  it.each<{ action: string; input: Record<string, unknown>; expected: Partial<Task> }>([
    { action: "hold", input: { taskId: "lexer" }, expected: { held: true } },
    { action: "setPriority", input: { taskId: "lexer", priority: -2 }, expected: { priority: -2 } },
    { action: "moveToTop", input: { taskId: "lexer" }, expected: { priority: 8 } },
    {
      action: "updateTask",
      input: { taskId: "lexer", title: "Tokeniser", touches: ["src/tokens.ts"], deps: ["ast"] },
      expected: {
        title: "Tokeniser",
        touches: ["src/tokens.ts"],
        deps: ["ast"],
        goal: "Make lexer work",
      },
    },
  ])("$action changes the task and emits task.updated", async ({ action, input, expected }) => {
    const harness = await setup();
    await seed(harness, [
      newTask("ast", { priority: 7 }),
      newTask("lexer", { priority: 1 }),
      newTask("legacy", { priority: 50 }),
    ]);
    harness.db.tasks.update("legacy", { status: "done" });

    const result = await harness.actions.invoke(action, input);

    expect(result).toMatchObject(expected);
    expect(harness.db.tasks.get("lexer")).toMatchObject(expected);
    expect(taskEvents(harness.events)).toEqual([["task.updated", "lexer"]]);
  });

  it("release clears the hold", async () => {
    const harness = await setup();
    await seed(harness, [newTask("lexer")]);
    await harness.actions.invoke("hold", { taskId: "lexer" });

    await harness.actions.invoke("release", { taskId: "lexer" });

    expect(harness.db.tasks.get("lexer")?.held).toBe(false);
    expect(taskEvents(harness.events)).toEqual([
      ["task.updated", "lexer"],
      ["task.updated", "lexer"],
    ]);
  });

  it("updateTask rejects deps that would close a cycle and leaves the task unchanged", async () => {
    const harness = await setup();
    await seed(harness, [newTask("lexer"), newTask("parser", { deps: ["lexer"] })]);

    const error = await rejection(
      harness.actions.invoke("updateTask", { taskId: "lexer", deps: ["parser"], title: "Lexer" }),
    );

    expect(error.message).toBe(
      "dependency cycle: lexer → parser → lexer (each task depends on the next)",
    );
    expect(harness.db.tasks.get("lexer")).toMatchObject({ deps: [], title: "Build lexer" });
    expect(harness.events).toEqual([]);
  });

  it("retry returns a blocked task to pending with fresh attempts, and refuses any other status", async () => {
    const harness = await setup();
    await seed(harness, [newTask("lexer"), newTask("parser")]);
    harness.db.tasks.update("lexer", { status: "blocked", attempts: 3 });

    const retried = await harness.actions.invoke("retry", { taskId: "lexer" });
    const refused = await rejection(harness.actions.invoke("retry", { taskId: "parser" }));

    expect(retried).toMatchObject({ status: "pending", attempts: 0 });
    expect(refused).toBeInstanceOf(IllegalTransitionError);
    expect([refused.code, refused.message]).toEqual([
      "conflict",
      'task "parser" cannot move from pending to pending',
    ]);
    expect(taskEvents(harness.events)).toEqual([["task.updated", "lexer"]]);
  });
});

describe("scheduler and settings actions", () => {
  it("pause and resume set the flag and emit scheduler.updated", async () => {
    const harness = await setup();

    await harness.actions.invoke("pause", undefined);
    const pausedFlags = harness.db.flags.get();
    await harness.actions.invoke("resume", {});

    expect(pausedFlags.paused).toBe(true);
    expect(harness.db.flags.get().paused).toBe(false);
    expect(harness.events).toEqual([
      { type: "scheduler.updated", paused: true, resumeAt: null },
      { type: "scheduler.updated", paused: false, resumeAt: null },
    ]);
  });

  it("setConfig writes the change and emits the merged config", async () => {
    const harness = await setup();

    await harness.actions.invoke("setConfig", { maxWorkers: 3, models: { judge: "sonnet" } });

    const saved = await loadConfig(harness.configContext);
    expect(saved).toMatchObject({ maxWorkers: 3, models: { judge: "sonnet", worker: "opus" } });
    expect(harness.events).toEqual([{ type: "config.updated", config: saved }]);
  });
});

describe("tasks.yaml import", () => {
  it.each([
    { name: "malformed YAML", yaml: "tasks: [\n", message: /^tasks\.yaml: / },
    {
      name: "a task missing its acceptance command",
      yaml: "- id: a\n  title: A\n  goal: G\n  touches: []\n",
      message: /^tasks\[0\]\.acceptance: /,
    },
    { name: "a file without tasks", yaml: "version: 1\n", message: /^tasks: / },
  ])("rejects $name", async ({ yaml, message }) => {
    const harness = await setup();

    const error = await rejection(harness.actions.invoke("importTasks", { yaml }));

    expect(error.code).toBe("invalid_input");
    expect(error.message).toMatch(message);
    expect(harness.db.tasks.list()).toEqual([]);
  });
});

describe("action registry", () => {
  it("lets later modules register an action that is invoked by name and emits through the bus", async () => {
    const harness = await setup();
    await seed(harness, [newTask("lexer")]);
    const rename = defineAction({
      name: "renameTask",
      description: "Rename a task.",
      input: z.strictObject({ taskId: z.string(), title: z.string() }),
      emits: ["task.updated"],
      handler: ({ taskId, title }, { db, emit }) => {
        const task = db.tasks.update(taskId, { title });
        emit({ type: "task.updated", taskId, task });
        return task;
      },
    });

    harness.actions.register(rename);
    const renamed = await harness.actions.run(rename, { taskId: "lexer", title: "Tokeniser" });

    expect(renamed.title).toBe("Tokeniser");
    expect(harness.actions.list().map((action) => action.name)).toContain("renameTask");
    expect(taskEvents(harness.events)).toEqual([["task.updated", "lexer"]]);
    expect(() => {
      harness.actions.register(rename);
    }).toThrow('action "renameTask" is already registered');
  });

  it("reports a listener that throws without failing the action or starving later listeners", async () => {
    const db = openDb(":memory:", { clock });
    onTestFinished(() => {
      db.close();
    });
    const failures: [unknown, BusEvent["type"]][] = [];
    const bus = createEventBus({
      onListenerError: (error, event) => failures.push([error, event.type]),
    });
    const crash = new Error("listener crashed");
    bus.subscribe(() => {
      throw crash;
    });
    const received: BusEvent[] = [];
    bus.subscribe((event) => received.push(event));
    const unusedConfig = { set: () => Promise.reject(new Error("config is not used here")) };
    const actions = createActionRegistry({ db, bus, config: unusedConfig }, builtinActions);

    await actions.invoke("pause", {});

    expect(db.flags.get().paused).toBe(true);
    expect(received.map((event) => event.type)).toEqual(["scheduler.updated"]);
    expect(failures).toEqual([[crash, "scheduler.updated"]]);
  });
});
