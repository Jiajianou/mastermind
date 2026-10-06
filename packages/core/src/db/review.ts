import { z } from "zod";
import { findingSeveritySchema } from "../contracts/index.js";
import type { Comment, Finding } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import { booleanColumn, changedRows, insertRow, readRow, readRows, updateRow } from "./rows.js";
import type { DbContext } from "./rows.js";

export type NewFinding = Omit<Finding, "id" | "dismissed">;
export type NewComment = Omit<Comment, "id">;

export interface FindingRepository {
  create(finding: NewFinding): Finding;
  listForTask(taskId: string): Finding[];
  setDismissed(id: number, dismissed: boolean): Finding;
}

export interface CommentRepository {
  create(comment: NewComment): Comment;
  listForTask(taskId: string): Comment[];
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

    listForTask(taskId) {
      return readRows("comments", commentRowSchema, selectForTask.all(taskId));
    },

    delete(id) {
      if (changedRows(deleteComment.run(id)) === 0) throw new RecordNotFoundError("comments", id);
    },
  };
}
