import type { Session } from "@mastermind/core/contracts";
import { useMemo } from "react";
import { Link } from "react-router";
import { sessionActivity } from "../sessions/activity.js";
import { Elapsed } from "../sessions/Elapsed.js";
import { FileChanges } from "../sessions/FileChanges.js";
import { FixerReason } from "../sessions/FixerReason.js";
import { sessionDiffPath, sessionPath } from "../sessions/links.js";
import { capitalized } from "../sessions/session-list.js";
import { useSessionEvents } from "../sessions/use-session-events.js";
import { useLive } from "../store/hooks.js";

export function SessionCard({ session }: { session: Session }) {
  const { taskId } = session;
  const task = useLive((state) => (taskId === null ? undefined : state.tasks[taskId]));
  const { events } = useSessionEvents(session.id);
  const activity = useMemo(() => sessionActivity(events), [events]);
  const headingId = `session-card-${String(session.id)}`;
  const latest = activity.latest;

  return (
    <article className="session-card panel" aria-labelledby={headingId}>
      <header className="session-card-header">
        <h3 id={headingId}>
          <code>{taskId ?? `session ${String(session.id)}`}</code>
        </h3>
        <span className="role-tag">{capitalized(session.role)}</span>
        <Elapsed session={session} />
      </header>
      {task !== undefined && <p className="session-card-title">{task.title}</p>}
      {session.role === "fixer" && <FixerReason session={session} />}
      <dl className="session-card-facts">
        <dt>Branch</dt>
        <dd>
          <code>{task?.branch ?? "none yet"}</code>
        </dd>
        <dt>Latest</dt>
        <dd>
          <code className="latest-action">
            {latest === null ? "starting" : `${latest.type} · ${latest.summary}`}
          </code>
        </dd>
      </dl>
      <FileChanges files={activity.files} />
      <div className="card-actions">
        <Link className="button-link" to={sessionDiffPath(session.id)}>
          View diff
        </Link>
        <Link className="button-link" to={sessionPath(session.id)}>
          Activity
        </Link>
      </div>
    </article>
  );
}
