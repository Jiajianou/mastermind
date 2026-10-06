import { SessionPane } from "./SessionPane.js";
import type { TaskSession } from "./selection.js";

export function SessionGrid({ sessions }: { sessions: readonly TaskSession[] }) {
  if (sessions.length === 0) return <p className="review-message muted">No sessions running.</p>;
  return (
    <div className="review-grid">
      {sessions.map((session) => (
        <SessionPane key={session.id} session={session} />
      ))}
    </div>
  );
}
