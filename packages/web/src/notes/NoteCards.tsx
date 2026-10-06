import type { Comment, Finding } from "@mastermind/core/contracts";
import { useState } from "react";
import { useRequest } from "../components/use-request.js";
import type { LineSelection } from "../review/DiffEditor.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { commentExcerpt, lineRange } from "./notes.js";

function Failure({ prefix, failure }: { prefix: string; failure: string | null }) {
  if (failure === null) return null;
  return (
    <span role="alert" className="control-failure">
      {prefix}: {failure}
    </span>
  );
}

export function CommentCard({ comment }: { comment: Comment }) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();
  const remove = () =>
    run(async () => {
      await api.act("deleteComment", { taskId: comment.taskId, commentId: comment.id });
      dispatch({ type: "comment.deleted", taskId: comment.taskId, commentId: comment.id });
    });
  return (
    <article className="note-card note-comment" aria-label={`Comment on ${comment.file}`}>
      <header>
        <span className="note-kind">Comment</span>
        <span className="muted">{lineRange(comment.lineStart, comment.lineEnd)}</span>
      </header>
      <p className="note-text">{comment.text}</p>
      <div className="note-actions">
        <button type="button" disabled={!live || busy} onClick={() => void remove()}>
          {busy ? "Deleting…" : "Delete"}
        </button>
        <Failure prefix="Couldn't delete" failure={failure} />
      </div>
    </article>
  );
}

const severityWords: Record<Finding["severity"], string> = {
  minor: "Minor finding",
  serious: "Serious finding",
};

export function FindingCard({ finding }: { finding: Finding }) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();
  const dismiss = () =>
    run(async () => {
      const dismissed = await api.act("dismissFinding", { findingId: finding.id });
      dispatch({ type: "finding.updated", taskId: finding.taskId, finding: dismissed });
    });
  return (
    <article
      className={`note-card note-finding note-${finding.severity}`}
      aria-label={`${severityWords[finding.severity]} on ${finding.file}`}
    >
      <header>
        <span className="note-kind">{severityWords[finding.severity]}</span>
        {finding.line !== null && (
          <span className="muted">{lineRange(finding.line, finding.line)}</span>
        )}
      </header>
      <p className="note-text">{finding.text}</p>
      <div className="note-actions">
        <button type="button" disabled={!live || busy} onClick={() => void dismiss()}>
          {busy ? "Dismissing…" : "Dismiss"}
        </button>
        <Failure prefix="Couldn't dismiss" failure={failure} />
      </div>
    </article>
  );
}

export function CommentDraft({
  taskId,
  path,
  lines,
  onClose,
}: {
  taskId: string;
  path: string;
  lines: LineSelection;
  onClose: () => void;
}) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const [text, setText] = useState("");
  const { busy, failure, run } = useRequest();
  const label = `Comment on ${lineRange(lines.start, lines.end)}`;
  const save = async () => {
    const saved = await run(async () => {
      const comment = await api.act("addComment", {
        taskId,
        file: path,
        lineStart: lines.start,
        lineEnd: lines.end,
        excerpt: commentExcerpt(lines.text),
        text,
      });
      dispatch({ type: "comment.updated", taskId, comment });
    });
    if (saved) onClose();
  };
  return (
    <form
      className="note-card note-draft"
      aria-label="New comment"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        <span className="note-kind">{label}</span>
        <textarea
          value={text}
          rows={3}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>
      <div className="note-actions">
        <button type="submit" className="primary" disabled={!live || busy || text.trim() === ""}>
          {busy ? "Adding…" : "Add comment"}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <Failure prefix="Couldn't add the comment" failure={failure} />
      </div>
    </form>
  );
}
