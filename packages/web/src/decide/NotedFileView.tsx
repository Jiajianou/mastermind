import type { FileChange, Task } from "@mastermind/core/contracts";
import { useState } from "react";
import { CommentCard, CommentDraft, FindingCard } from "../notes/NoteCards.js";
import { lineRange } from "../notes/notes.js";
import type { RoundNotes } from "../notes/notes.js";
import type { LineSelection } from "../review/DiffEditor.js";
import { FileView } from "../review/FileView.js";
import type { EditorZone } from "../review/view-zones.js";

export interface NotedFileViewProps {
  task: Task;
  path: string;
  change: FileChange | null;
  fromCommit: string;
  since: string;
  notes: RoundNotes;
}

export function NotedFileView({
  task,
  path,
  change,
  fromCommit,
  since,
  notes,
}: NotedFileViewProps) {
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [draft, setDraft] = useState<LineSelection | null>(null);
  const zones: EditorZone[] = [
    ...notes.findings.map((finding) => ({
      key: `finding-${String(finding.id)}`,
      afterLine: finding.line ?? 0,
      content: <FindingCard finding={finding} />,
    })),
    ...notes.comments.map((comment) => ({
      key: `comment-${String(comment.id)}`,
      afterLine: comment.lineEnd,
      content: <CommentCard comment={comment} />,
    })),
    ...(draft === null
      ? []
      : [
          {
            key: "draft",
            afterLine: draft.end,
            content: (
              <CommentDraft
                taskId={task.id}
                path={path}
                lines={draft}
                onClose={() => {
                  setDraft(null);
                }}
              />
            ),
          },
        ]),
  ];
  const actions =
    task.status === "review" ? (
      <button
        type="button"
        className="comment-lines"
        disabled={selection === null || draft !== null}
        onClick={() => {
          setDraft(selection);
        }}
      >
        {selection === null
          ? "Select lines to comment"
          : `Comment on ${lineRange(selection.start, selection.end)}`}
      </button>
    ) : null;
  return (
    <FileView
      taskId={task.id}
      path={path}
      change={change}
      fromCommit={fromCommit}
      since={since}
      mode="diff"
      notes={{ zones, onSelectLines: setSelection, actions }}
    />
  );
}
