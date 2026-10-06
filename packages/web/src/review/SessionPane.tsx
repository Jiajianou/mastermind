import { useMemo } from "react";
import { Link } from "react-router";
import { capitalized } from "@mastermind/core/contracts";
import { sessionStatusWord } from "../sessions/session-list.js";
import { useSessionEvents } from "../sessions/use-session-events.js";
import { useLive } from "../store/hooks.js";
import { DiffContents } from "./FileContents.js";
import { reviewPath } from "./location.js";
import { sessionProblem } from "./problem.js";
import type { TaskSession } from "./selection.js";
import { useLatestEdit } from "./use-editing.js";
import { changeRefresh, diffTarget, useFileSides } from "./use-file-sides.js";
import { useChangesView } from "./use-task-changes.js";
import type { ChangesView } from "../store/state.js";

function LatestDiff({
  taskId,
  path,
  changes,
}: {
  taskId: string;
  path: string;
  changes: ChangesView | undefined;
}) {
  const change =
    changes?.kind === "loaded"
      ? (changes.changes.files.find((file) => file.path === path) ?? null)
      : null;
  const sides = useFileSides(diffTarget(taskId, path, change, "base"), changeRefresh(change));
  return (
    <>
      <p className="pane-file">
        <code>{path}</code>
        {change?.uncommitted === true && <span className="state-tag">uncommitted</span>}
      </p>
      <div className="pane-diff">
        <DiffContents path={path} sides={sides} compact />
      </div>
    </>
  );
}

export function SessionPane({ session }: { session: TaskSession }) {
  const { taskId } = session;
  const changes = useChangesView(taskId);
  const { events } = useSessionEvents(session.id);
  const path = useLatestEdit(session.id, events);
  const checks = useLive((state) => state.checks[taskId]);
  const rebase = useLive((state) => state.rebases[taskId]);
  const problem = useMemo(
    () => sessionProblem(events.at(-1) ?? null, Object.values(checks ?? {}), rebase),
    [events, checks, rebase],
  );
  const headingId = `review-pane-${String(session.id)}`;

  return (
    <article
      className={problem === null ? "review-pane panel" : "review-pane panel has-problem"}
      aria-labelledby={headingId}
    >
      <header className="review-pane-header">
        <h2 id={headingId}>
          <code>{taskId}</code>
        </h2>
        <span className="muted">
          {capitalized(session.role)} · {sessionStatusWord(session.status)}
        </span>
        <Link className="button-link" to={reviewPath({ session: session.id, file: path })}>
          Open
        </Link>
      </header>
      {problem !== null && (
        <p className="problem-label">
          <span aria-hidden="true">⚠ </span>
          {problem}
        </p>
      )}
      {path === null ? (
        <p className="muted pane-empty">No edits yet.</p>
      ) : (
        <LatestDiff taskId={taskId} path={path} changes={changes} />
      )}
    </article>
  );
}
