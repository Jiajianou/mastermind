import type { SessionEvent } from "@mastermind/core/contracts";
import { useFollowScroll } from "./use-follow-scroll.js";

const timeOfDay = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function rowClass(event: SessionEvent, isLive: boolean): string | undefined {
  const classes = [event.type === "error" ? "failure" : "", isLive ? "live" : ""].filter(Boolean);
  return classes.length === 0 ? undefined : classes.join(" ");
}

export function Timeline({
  events,
  running,
  failure,
}: {
  events: readonly SessionEvent[];
  running: boolean;
  failure: string | null;
}) {
  const { ref, following, onScroll, follow } = useFollowScroll<HTMLDivElement>(events);
  const liveId = running ? (events.at(-1)?.id ?? null) : null;

  return (
    <div className="timeline">
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t load the earlier events: {failure}
        </p>
      )}
      <div
        ref={ref}
        className="timeline-scroll"
        role="region"
        aria-label="Timeline"
        tabIndex={0}
        onScroll={onScroll}
      >
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <table>
            <thead className="visually-hidden">
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Type</th>
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const isLive = event.id === liveId;
                return (
                  <tr
                    key={event.id}
                    className={rowClass(event, isLive)}
                    aria-current={isLive ? "true" : undefined}
                  >
                    <td className="timeline-time">
                      <time dateTime={event.ts}>{timeOfDay(event.ts)}</time>
                    </td>
                    <td className="timeline-type">{event.type}</td>
                    <td className="timeline-summary">
                      {event.summary}
                      {isLive && <span className="live-tag">now</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {!following && (
        <button type="button" className="jump-latest" onClick={follow}>
          Jump to latest
        </button>
      )}
    </div>
  );
}
