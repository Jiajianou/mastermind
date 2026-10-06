import { z } from "zod";
import { checkKindSchema, checkStatusSchema } from "../contracts/index.js";
import type { Check, CheckKind, CheckStatus } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import { insertRow, readRow, readRows, updateRow } from "./rows.js";
import type { DbContext } from "./rows.js";

export interface NewCheck {
  taskId: string;
  round: number;
  kind: CheckKind;
  logPath?: string | null;
}

export interface CheckOutcome {
  status: Exclude<CheckStatus, "running">;
  summary?: string | null;
  durationMs: number;
}

export interface CheckRepository {
  create(check: NewCheck): Check;
  get(id: number): Check | null;
  listForTask(taskId: string): Check[];
  finish(id: number, outcome: CheckOutcome): Check;
}

const checkRowSchema = z
  .object({
    id: z.int(),
    task_id: z.string(),
    round: z.int(),
    kind: checkKindSchema,
    status: checkStatusSchema,
    summary: z.string().nullable(),
    log_path: z.string().nullable(),
    duration_ms: z.int().nullable(),
  })
  .transform((row): Check => ({
    id: row.id,
    taskId: row.task_id,
    round: row.round,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    logPath: row.log_path,
    durationMs: row.duration_ms,
  }));

export function createCheckRepository({ database }: DbContext): CheckRepository {
  const selectCheck = database.prepare("SELECT * FROM checks WHERE id = ?");
  const selectForTask = database.prepare("SELECT * FROM checks WHERE task_id = ? ORDER BY id");

  function get(id: number): Check | null {
    const row = selectCheck.get(id);
    return row === undefined ? null : readRow("checks", checkRowSchema, row);
  }

  return {
    create(check) {
      const id = insertRow(database, "checks", {
        task_id: check.taskId,
        round: check.round,
        kind: check.kind,
        status: "running",
        log_path: check.logPath ?? null,
      });
      return readRow("checks", checkRowSchema, selectCheck.get(id));
    },

    get,

    listForTask(taskId) {
      return readRows("checks", checkRowSchema, selectForTask.all(taskId));
    },

    finish(id, outcome) {
      const columns = {
        status: outcome.status,
        summary: outcome.summary,
        duration_ms: outcome.durationMs,
      };
      if (!updateRow(database, "checks", id, columns)) throw new RecordNotFoundError("checks", id);
      return readRow("checks", checkRowSchema, selectCheck.get(id));
    },
  };
}
