import { z } from "zod";
import { isoTimestampSchema, taskStatusSchema } from "../contracts/index.js";
import type { Task, TaskStatus } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import {
  booleanColumn,
  insertRow,
  jsonColumn,
  readRow,
  readRows,
  timestamp,
  toBooleanColumn,
  updateRow,
} from "./rows.js";
import type { Columns, DbContext } from "./rows.js";

export interface NewTask {
  id: string;
  title: string;
  goal: string;
  acceptance: string;
  touches: string[];
  deps?: string[];
  priority?: number;
  status?: TaskStatus;
}

export type TaskPatch = Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>;

export interface TaskRepository {
  create(task: NewTask): Task;
  get(id: string): Task | null;
  list(): Task[];
  update(id: string, patch: TaskPatch): Task;
}

const taskRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    goal: z.string(),
    acceptance: z.string(),
    touches: jsonColumn(z.array(z.string())),
    status: taskStatusSchema,
    priority: z.int(),
    attempts: z.int(),
    round: z.int(),
    held: booleanColumn,
    resume_session: z.string().nullable(),
    branch: z.string().nullable(),
    worktree: z.string().nullable(),
    base_commit: z.string().nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .transform((row): Omit<Task, "deps"> => ({
    id: row.id,
    title: row.title,
    goal: row.goal,
    acceptance: row.acceptance,
    touches: row.touches,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    round: row.round,
    held: row.held,
    resumeSession: row.resume_session,
    branch: row.branch,
    worktree: row.worktree,
    baseCommit: row.base_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

const depRowSchema = z.object({ task_id: z.string(), depends_on: z.string() });

function taskColumns(fields: TaskPatch): Columns {
  return {
    title: fields.title,
    goal: fields.goal,
    acceptance: fields.acceptance,
    touches: fields.touches && JSON.stringify(fields.touches),
    status: fields.status,
    priority: fields.priority,
    attempts: fields.attempts,
    round: fields.round,
    held: toBooleanColumn(fields.held),
    resume_session: fields.resumeSession,
    branch: fields.branch,
    worktree: fields.worktree,
    base_commit: fields.baseCommit,
  };
}

const latestCreatedSchema = z.object({ latest: isoTimestampSchema.nullable() });

// Board and start order break priority ties by created_at, so a batch created within one millisecond must still
// keep the order it was given in rather than falling back to id order.
function creationTimestamp(now: Date, latest: string | null): string {
  if (latest === null || now.toISOString() > latest) return now.toISOString();
  return new Date(Date.parse(latest) + 1).toISOString();
}

export function createTaskRepository({ database, clock, transaction }: DbContext): TaskRepository {
  const selectLatestCreated = database.prepare("SELECT MAX(created_at) AS latest FROM tasks");
  const selectTask = database.prepare("SELECT * FROM tasks WHERE id = ?");
  const selectTasks = database.prepare(
    "SELECT * FROM tasks ORDER BY priority DESC, created_at, id",
  );
  const selectDeps = database.prepare(
    "SELECT task_id, depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on",
  );
  const selectAllDeps = database.prepare(
    "SELECT task_id, depends_on FROM task_deps ORDER BY task_id, depends_on",
  );
  const deleteDeps = database.prepare("DELETE FROM task_deps WHERE task_id = ?");
  const insertDep = database.prepare("INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)");

  function replaceDeps(id: string, deps: readonly string[]): void {
    deleteDeps.run(id);
    for (const dep of new Set(deps)) insertDep.run(id, dep);
  }

  function get(id: string): Task | null {
    const row = selectTask.get(id);
    if (row === undefined) return null;
    const deps = readRows("task_deps", depRowSchema, selectDeps.all(id));
    return { ...readRow("tasks", taskRowSchema, row), deps: deps.map((dep) => dep.depends_on) };
  }

  function getExisting(id: string): Task {
    const task = get(id);
    if (task === null) throw new RecordNotFoundError("tasks", id);
    return task;
  }

  return {
    create(task) {
      return transaction(() => {
        const { latest } = readRow("tasks", latestCreatedSchema, selectLatestCreated.get());
        const now = creationTimestamp(clock.now(), latest);
        insertRow(database, "tasks", {
          ...taskColumns({ status: "pending", priority: 0, ...task }),
          id: task.id,
          created_at: now,
          updated_at: now,
        });
        replaceDeps(task.id, task.deps ?? []);
        return getExisting(task.id);
      });
    },

    get,

    list() {
      const depsByTask = new Map<string, string[]>();
      for (const dep of readRows("task_deps", depRowSchema, selectAllDeps.all())) {
        depsByTask.set(dep.task_id, [...(depsByTask.get(dep.task_id) ?? []), dep.depends_on]);
      }
      return readRows("tasks", taskRowSchema, selectTasks.all()).map((task) => ({
        ...task,
        deps: depsByTask.get(task.id) ?? [],
      }));
    },

    update(id, patch) {
      return transaction(() => {
        const columns = { ...taskColumns(patch), updated_at: timestamp(clock) };
        if (!updateRow(database, "tasks", id, columns)) throw new RecordNotFoundError("tasks", id);
        if (patch.deps !== undefined) replaceDeps(id, patch.deps);
        return getExisting(id);
      });
    },
  };
}
