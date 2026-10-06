import { ActionError, defineAction, requireTask } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import {
  addCommentInputSchema,
  commentRefInputSchema,
  findingRefInputSchema,
  updateCommentInputSchema,
} from "../contracts/index.js";
import type { Comment } from "../contracts/index.js";
import type { Db } from "../db/index.js";

const conflict = (message: string) => ActionError.fromMessage("conflict", message);

// Comments sent with an earlier round are part of that round's request, so only the current round's can change.
function editableComment(db: Db, taskId: string, commentId: number): Comment {
  const task = requireTask(db, taskId);
  const comment = db.comments.get(commentId);
  if (comment?.taskId !== taskId)
    throw ActionError.fromMessage("not_found", `no comment ${String(commentId)} on ${taskId}`);
  if (comment.round !== task.round)
    throw conflict(
      `comment ${String(commentId)} belongs to round ${String(comment.round)}, which has been sent; only round ${String(task.round)} comments can change`,
    );
  return comment;
}

export const addComment = defineAction({
  name: "addComment",
  description:
    "Add a review comment on lines of a file in a task's workspace, tagged with the task's current round. Returns the comment.",
  input: addCommentInputSchema,
  emits: ["comment.updated"],
  handler: (input, { db, emit }) => {
    const task = requireTask(db, input.taskId);
    if (task.worktree === null || task.status === "done")
      throw conflict(`${task.id} has no work to comment on`);
    const comment = db.comments.create({ ...input, round: task.round });
    emit({ type: "comment.updated", taskId: task.id, comment });
    return comment;
  },
}) satisfies ContractedActions<"addComment">["addComment"];

export const updateComment = defineAction({
  name: "updateComment",
  description: "Change the text of a review comment of the task's current round. Returns it.",
  input: updateCommentInputSchema,
  emits: ["comment.updated"],
  handler: ({ taskId, commentId, text }, { db, emit }) => {
    editableComment(db, taskId, commentId);
    const comment = db.comments.updateText(commentId, text);
    emit({ type: "comment.updated", taskId, comment });
    return comment;
  },
}) satisfies ContractedActions<"updateComment">["updateComment"];

export const deleteComment = defineAction({
  name: "deleteComment",
  description: "Delete a review comment of the task's current round. Returns the deleted comment.",
  input: commentRefInputSchema,
  emits: ["comment.deleted"],
  handler: ({ taskId, commentId }, { db, emit }) => {
    const comment = editableComment(db, taskId, commentId);
    db.comments.delete(commentId);
    emit({ type: "comment.deleted", taskId, commentId });
    return comment;
  },
}) satisfies ContractedActions<"deleteComment">["deleteComment"];

export const dismissFinding = defineAction({
  name: "dismissFinding",
  description:
    "Dismiss a reviewer finding, so it is no longer shown or offered. Returns the finding.",
  input: findingRefInputSchema,
  emits: ["finding.updated"],
  handler: ({ findingId }, { db, emit }) => {
    if (db.findings.get(findingId) === null)
      throw ActionError.fromMessage("not_found", `no finding ${String(findingId)}`);
    const finding = db.findings.setDismissed(findingId, true);
    emit({ type: "finding.updated", taskId: finding.taskId, finding });
    return finding;
  },
}) satisfies ContractedActions<"dismissFinding">["dismissFinding"];

export const reviewNoteActions = [addComment, updateComment, deleteComment, dismissFinding];
