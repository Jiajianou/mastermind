import { z } from "zod";
import { isoTimestampSchema, rebaseStatusSchema } from "../contracts/index.js";
import type { Rebase, RebaseStatus } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import { insertRow, readRow, readRows, timestamp, updateRow } from "./rows.js";
import type { DbContext } from "./rows.js";

export interface NewRebase {
  taskId: string;
  logPath?: string | null;
}

export interface RebaseRepository {
  create(rebase: NewRebase): Rebase;
  listForTask(taskId: string): Rebase[];
  finish(id: number, status: Exclude<RebaseStatus, "running">): Rebase;
}

const rebaseRowSchema = z
  .object({
    id: z.int(),
    task_id: z.string(),
    status: rebaseStatusSchema,
    log_path: z.string().nullable(),
    ts: isoTimestampSchema,
  })
  .transform((row): Rebase => ({
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    logPath: row.log_path,
    ts: row.ts,
  }));

export function createRebaseRepository({ database, clock }: DbContext): RebaseRepository {
  const selectRebase = database.prepare("SELECT * FROM rebases WHERE id = ?");
  const selectForTask = database.prepare("SELECT * FROM rebases WHERE task_id = ? ORDER BY id");

  return {
    create(rebase) {
      const id = insertRow(database, "rebases", {
        task_id: rebase.taskId,
        status: "running",
        log_path: rebase.logPath ?? null,
        ts: timestamp(clock),
      });
      return readRow("rebases", rebaseRowSchema, selectRebase.get(id));
    },

    listForTask(taskId) {
      return readRows("rebases", rebaseRowSchema, selectForTask.all(taskId));
    },

    finish(id, status) {
      if (!updateRow(database, "rebases", id, { status })) {
        throw new RecordNotFoundError("rebases", id);
      }
      return readRow("rebases", rebaseRowSchema, selectRebase.get(id));
    },
  };
}
