import { Link } from "react-router";
import { sessionStatusWord } from "../sessions/session-list.js";
import { reviewPath } from "./location.js";
import type { ReviewMode } from "./location.js";
import type { TaskSession } from "./selection.js";
import { useChangesView } from "./use-task-changes.js";

function fileCount(count: number): string {
  return count === 1 ? "1 file" : `${String(count)} files`;
}

function SessionTab({
  session,
  selected,
  mode,
}: {
  session: TaskSession;
  selected: boolean;
  mode: ReviewMode;
}) {
  const changes = useChangesView(session.taskId);
  const count =
    changes === undefined
      ? "…"
      : changes.kind === "failed"
        ? "no files"
        : fileCount(changes.changes.files.length);
  return (
    <Link
      className="review-tab"
      to={reviewPath({ session: session.id, mode })}
      aria-current={selected ? "page" : undefined}
    >
      <code>{session.taskId}</code>
      <span className="muted">
        {sessionStatusWord(session.status)} · {count}
      </span>
    </Link>
  );
}

export function SessionTabs({
  tabs,
  selectedId,
  mode,
}: {
  tabs: readonly TaskSession[];
  selectedId: number | null;
  mode: ReviewMode;
}) {
  return (
    <nav className="review-tabs" aria-label="Review sessions">
      {tabs.length === 0 ? (
        <p className="muted">No sessions running.</p>
      ) : (
        <ul>
          {tabs.map((session) => (
            <li key={session.id}>
              <SessionTab session={session} selected={session.id === selectedId} mode={mode} />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
