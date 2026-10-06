import { buildChangeRequest } from "@mastermind/core/contracts";
import type { ActionInputs, Check, RoundMode } from "@mastermind/core/contracts";
import type { RoundNotes } from "../notes/notes.js";

export type SendKey = `comment-${string}` | `finding-${string}` | "failing";

export type Included = Readonly<Partial<Record<SendKey, boolean>>>;

export const commentKey = (id: number): SendKey => `comment-${String(id)}`;
export const findingKey = (id: number): SendKey => `finding-${String(id)}`;

// Comments go by default; findings and the failing check's log only when the owner ticks them.
export function isIncluded(included: Included, key: SendKey): boolean {
  return included[key] ?? key.startsWith("comment-");
}

export interface RequestDraft {
  taskId: string;
  notes: RoundNotes;
  failing: Check | null;
  included: Included;
  instruction: string;
  mode: RoundMode;
}

export function requestInput(draft: RequestDraft): ActionInputs["requestChanges"] {
  const { notes, included } = draft;
  return {
    taskId: draft.taskId,
    instruction: draft.instruction,
    commentIds: notes.comments
      .filter(({ id }) => isIncluded(included, commentKey(id)))
      .map(({ id }) => id),
    findingIds: notes.findings
      .filter(({ id }) => isIncluded(included, findingKey(id)))
      .map(({ id }) => id),
    includeFailingTest: draft.failing !== null && isIncluded(included, "failing"),
    mode: draft.mode,
  };
}

export function hasSomethingToSend(draft: RequestDraft): boolean {
  const input = requestInput(draft);
  return (
    draft.instruction.trim() !== "" ||
    (input.commentIds ?? []).length > 0 ||
    (input.findingIds ?? []).length > 0 ||
    input.includeFailingTest === true
  );
}

// The same builder the server uses, so the preview is exactly the message the session receives.
export function previewMessage(draft: RequestDraft, failingLog: string): string {
  const input = requestInput(draft);
  const commentIds = new Set(input.commentIds);
  const findingIds = new Set(input.findingIds);
  return buildChangeRequest({
    instruction: draft.instruction,
    comments: draft.notes.comments.filter(({ id }) => commentIds.has(id)),
    findings: draft.notes.findings.filter(({ id }) => findingIds.has(id)),
    failingTest:
      input.includeFailingTest === true && draft.failing !== null
        ? { check: draft.failing, log: failingLog }
        : null,
  });
}
