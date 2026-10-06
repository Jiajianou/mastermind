import type { Session, Task } from "@mastermind/core/contracts";
import { Link } from "react-router";
import { capitalized } from "@mastermind/core/contracts";
import { clockTime } from "../components/format.js";
import { sessionDiffPath } from "./links.js";
import { sessionStatusWord } from "./session-list.js";
import { StopSessionButton } from "./StopSessionButton.js";

export function SessionHeader({ session, task }: { session: Session; task: Task | undefined }) {
  const branch = task?.branch ?? null;
  return (
    <header className="session-header">
      <div className="session-heading">
        <h2>
          <code>{session.taskId ?? `session ${String(session.id)}`}</code>
          {task !== undefined && <span className="muted"> {task.title}</span>}
        </h2>
        <p className="session-meta">
          {capitalized(session.role)} · started{" "}
          <time dateTime={session.startedAt}>{clockTime(session.startedAt)}</time>
          {branch !== null && (
            <>
              {" "}
              · <code>{branch}</code>
            </>
          )}
        </p>
      </div>
      <div className="session-controls">
        <Link className="button-link" to={sessionDiffPath(session.id)}>
          View diff
        </Link>
        {session.status === "running" ? (
          <StopSessionButton session={session} />
        ) : (
          <span className="session-status">{sessionStatusWord(session.status)}</span>
        )}
      </div>
    </header>
  );
}
