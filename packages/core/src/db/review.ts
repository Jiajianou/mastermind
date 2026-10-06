import { z } from "zod";
import { findingSeveritySchema, isoTimestampSchema, roundModeSchema } from "../contracts/index.js";
import type { Comment, Finding, Round } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import {
  booleanColumn,
  changedRows,
  insertRow,
  jsonColumn,
  readRow,
  readRows,
  timestamp,
  updateRow,
} from "./rows.js";
import type { DbContext } from "./rows.js";

export type NewFinding = Omit<Finding, "id" | "dismissed">;
export type NewComment = Omit<Comment, "id">;
export type NewRound = Omit<Round, "id" | "createdAt">;

export interface FindingRepository {
  create(finding: NewFinding): Finding;
  get(id: number): Finding | null;
  listForTask(taskId: string): Finding[];
  setDismissed(id: number, dismissed: boolean): Finding;
}

export interface CommentRepository {
  create(comment: NewComment): Comment;
  get(id: number): Comment | null;
  listForTask(taskId: string): Comment[];
  updateText(id: number, text: string): Comment;
  delete(id: number): void;
}

export interface RoundRepository {
  create(round: NewRound): Round;
  get(taskId: string, round: number): Round | null;
  listForTask(taskId: string): Round[];
  delete(id: number): void;
}

const findingRowSchema = z
  .object({
    id: z.int(),
    task_id: z.string(),
    round: z.int(),
    file: z.string(),
    line: z.int().nullable(),
    text: z.string(),
    severity: findingSeveritySchema,
    dismissed: booleanColumn,
  })
  .transform((row): Finding => ({
    id: row.id,
    taskId: row.task_id,
    round: row.round,
    file: row.file,
    line: row.line,
    text: row.text,
    severity: row.severity,
    dismissed: row.dismissed,
  }));

const commentRowSchema = z
  .object({
    id: z.int(),
    task_id: z.string(),
    round: z.int(),
    file: z.string(),
    line_start: z.int(),
    line_end: z.int(),
    excerpt: z.string(),
    text: z.string(),
  })
  .transform((row): Comment => ({
    id: row.id,
    taskId: row.task_id,
    round: row.round,
    file: row.file,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    excerpt: row.excerpt,
    text: row.text,
  }));

const roundRowSchema = z
  .object({
    id: z.int(),
    task_id: z.string(),
    round: z.int(),
    mode: roundModeSchema,
    instruction: z.string(),
    message: z.string(),
    comment_ids: jsonColumn(z.array(z.int())),
    finding_ids: jsonColumn(z.array(z.int())),
    failing_check_id: z.int().nullable(),
    start_commit: z.string().nullable(),
    session_id: z.int().nullable(),
    created_at: isoTimestampSchema,
  })
  .transform((row): Round => ({
    id: row.id,
    taskId: row.task_id,
    round: row.round,
    mode: row.mode,
    instruction: row.instruction,
    message: row.message,
    commentIds: row.comment_ids,
    findingIds: row.finding_ids,
    failingCheckId: row.failing_check_id,
    startCommit: row.start_commit,
    sessionId: row.session_id,
    createdAt: row.created_at,
  }));

const readOptional = <Schema extends z.ZodType>(
  table: string,
  schema: Schema,
  row: unknown,
): z.output<Schema> | null => (row === undefined ? null : readRow(table, schema, row));

export function createFindingRepository({ database }: DbContext): FindingRepository {
  const selectFinding = database.prepare("SELECT * FROM findings WHERE id = ?");
  const selectForTask = database.prepare(
    "SELECT * FROM findings WHERE task_id = ? ORDER BY round, id",
  );

  return {
    create(finding) {
      const id = insertRow(database, "findings", {
        task_id: finding.taskId,
        round: finding.round,
        file: finding.file,
        line: finding.line,
        text: finding.text,
        severity: finding.severity,
        dismissed: 0,
      });
      return readRow("findings", findingRowSchema, selectFinding.get(id));
    },

    get(id) {
      return readOptional("findings", findingRowSchema, selectFinding.get(id));
    },

    listForTask(taskId) {
      return readRows("findings", findingRowSchema, selectForTask.all(taskId));
    },

    setDismissed(id, dismissed) {
      if (!updateRow(database, "findings", id, { dismissed: Number(dismissed) })) {
        throw new RecordNotFoundError("findings", id);
      }
      return readRow("findings", findingRowSchema, selectFinding.get(id));
    },
  };
}

export function createCommentRepository({ database }: DbContext): CommentRepository {
  const selectComment = database.prepare("SELECT * FROM comments WHERE id = ?");
  const selectForTask = database.prepare(
    "SELECT * FROM comments WHERE task_id = ? ORDER BY round, id",
  );
  const deleteComment = database.prepare("DELETE FROM comments WHERE id = ?");

  return {
    create(comment) {
      const id = insertRow(database, "comments", {
        task_id: comment.taskId,
        round: comment.round,
        file: comment.file,
        line_start: comment.lineStart,
        line_end: comment.lineEnd,
        excerpt: comment.excerpt,
        text: comment.text,
      });
      return readRow("comments", commentRowSchema, selectComment.get(id));
    },

    get(id) {
      return readOptional("comments", commentRowSchema, selectComment.get(id));
    },

    listForTask(taskId) {
      return readRows("comments", commentRowSchema, selectForTask.all(taskId));
    },

    updateText(id, text) {
      if (!updateRow(database, "comments", id, { text }))
        throw new RecordNotFoundError("comments", id);
      return readRow("comments", commentRowSchema, selectComment.get(id));
    },

    delete(id) {
      if (changedRows(deleteComment.run(id)) === 0) throw new RecordNotFoundError("comments", id);
    },
  };
}

export function createRoundRepository({ database, clock }: DbContext): RoundRepository {
  const selectRound = database.prepare("SELECT * FROM rounds WHERE id = ?");
  const selectTaskRound = database.prepare("SELECT * FROM rounds WHERE task_id = ? AND round = ?");
  const selectForTask = database.prepare("SELECT * FROM rounds WHERE task_id = ? ORDER BY round");
  const deleteRound = database.prepare("DELETE FROM rounds WHERE id = ?");

  return {
    create(round) {
      const id = insertRow(database, "rounds", {
        task_id: round.taskId,
        round: round.round,
        mode: round.mode,
        instruction: round.instruction,
        message: round.message,
        comment_ids: JSON.stringify(round.commentIds),
        finding_ids: JSON.stringify(round.findingIds),
        failing_check_id: round.failingCheckId,
        start_commit: round.startCommit,
        session_id: round.sessionId,
        created_at: timestamp(clock),
      });
      return readRow("rounds", roundRowSchema, selectRound.get(id));
    },

    get(taskId, round) {
      return readOptional("rounds", roundRowSchema, selectTaskRound.get(taskId, round));
    },

    listForTask(taskId) {
      return readRows("rounds", roundRowSchema, selectForTask.all(taskId));
    },

    delete(id) {
      if (changedRows(deleteRound.run(id)) === 0) throw new RecordNotFoundError("rounds", id);
    },
  };
}
