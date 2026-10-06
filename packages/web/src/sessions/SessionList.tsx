import type { Session } from "@mastermind/core/contracts";
import { Link } from "react-router";
import { clockTime } from "../components/format.js";
import { sessionPath } from "./links.js";
import { capitalized, sessionStatusWord } from "./session-list.js";
import type { SessionGroups } from "./session-list.js";

function SessionLink({ session, selected }: { session: Session; selected: boolean }) {
  return (
    <Link
      className="session-link"
      to={sessionPath(session.id)}
      aria-current={selected ? "page" : undefined}
    >
      <code>{session.taskId ?? `session ${String(session.id)}`}</code>
      <span className="muted">
        {capitalized(session.role)} · {sessionStatusWord(session.status)} ·{" "}
        {clockTime(session.endedAt ?? session.startedAt)}
      </span>
    </Link>
  );
}

function Group({
  title,
  sessions,
  selectedId,
  empty,
}: {
  title: string;
  sessions: readonly Session[];
  selectedId: number | null;
  empty: string;
}) {
  return (
    <>
      <h2>{title}</h2>
      {sessions.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <SessionLink session={session} selected={session.id === selectedId} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function SessionList({
  groups,
  selectedId,
}: {
  groups: SessionGroups;
  selectedId: number | null;
}) {
  return (
    <nav className="session-list panel" aria-label="Session list">
      <Group
        title="Active"
        sessions={groups.active}
        selectedId={selectedId}
        empty="No sessions running."
      />
      <Group
        title="Finished today"
        sessions={groups.finishedToday}
        selectedId={selectedId}
        empty="None yet today."
      />
    </nav>
  );
}
