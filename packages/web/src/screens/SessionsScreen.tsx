import { isEditingRole } from "@mastermind/core/contracts";
import type { Session } from "@mastermind/core/contracts";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { useNow } from "../components/use-now.js";
import { sessionActivity } from "../sessions/activity.js";
import { SessionFacts } from "../sessions/SessionFacts.js";
import { SessionHeader } from "../sessions/SessionHeader.js";
import { defaultSessionId, groupSessions } from "../sessions/session-list.js";
import { SessionList } from "../sessions/SessionList.js";
import { SessionMessageBox } from "../sessions/SessionMessageBox.js";
import { Timeline } from "../sessions/Timeline.js";
import { useSessionEvents } from "../sessions/use-session-events.js";
import { useLive } from "../store/hooks.js";

const minute = 60_000;

function requestedSessionId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function SessionDetail({ session }: { session: Session }) {
  const { taskId } = session;
  const task = useLive((state) => (taskId === null ? undefined : state.tasks[taskId]));
  const { events, failure } = useSessionEvents(session.id);
  const activity = useMemo(() => sessionActivity(events), [events]);
  return (
    <>
      <div className="session-main panel">
        <SessionHeader session={session} task={task} />
        <Timeline
          key={session.id}
          events={events}
          running={session.status === "running"}
          failure={failure}
        />
        {session.taskId !== null && isEditingRole(session) && (
          <SessionMessageBox key={session.id} session={session} />
        )}
      </div>
      <SessionFacts session={session} task={task} activity={activity} />
    </>
  );
}

export function SessionsScreen() {
  const sessionsById = useLive((state) => state.sessions);
  const [params] = useSearchParams();
  const groups = groupSessions(Object.values(sessionsById), useNow(minute));
  const requested = requestedSessionId(params.get("session"));
  const selectedId = requested ?? defaultSessionId(groups);
  const selected = selectedId === null ? undefined : sessionsById[selectedId];

  return (
    <section className="sessions-screen" aria-label="Sessions">
      <h1 className="visually-hidden">Sessions</h1>
      <SessionList groups={groups} selectedId={selectedId} />
      {selected === undefined ? (
        <p className="session-empty muted">
          {requested === null
            ? "No sessions today yet."
            : `Session ${String(requested)} isn't in today's list.`}
        </p>
      ) : (
        <SessionDetail session={selected} />
      )}
    </section>
  );
}
