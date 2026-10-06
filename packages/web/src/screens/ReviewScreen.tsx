import { useSearchParams } from "react-router";
import { useNow } from "../components/use-now.js";
import { ChangesLoaders } from "../review/ChangesLoaders.js";
import { readReviewLocation } from "../review/location.js";
import { ReviewToggles } from "../review/ReviewToggles.js";
import { reviewSessions } from "../review/selection.js";
import { SessionGrid } from "../review/SessionGrid.js";
import { SessionReview } from "../review/SessionReview.js";
import { SessionTabs } from "../review/SessionTabs.js";
import { useLive } from "../store/hooks.js";

const minute = 60_000;

export function ReviewScreen() {
  const [params] = useSearchParams();
  const location = readReviewLocation(params);
  const sessionsById = useLive((state) => state.sessions);
  const { tabs, selected } = reviewSessions(Object.values(sessionsById), location, useNow(minute));
  const showAll = location.view === "all";
  const running = tabs.filter((session) => session.status === "running");

  return (
    <section className="review-screen" aria-label="Review">
      <h1 className="visually-hidden">Review</h1>
      <ChangesLoaders taskIds={(showAll ? running : tabs).map((session) => session.taskId)} />
      <div className="review-toolbar">
        {!showAll && (
          <SessionTabs tabs={tabs} selectedId={selected?.id ?? null} mode={location.mode} />
        )}
        <ReviewToggles location={location} />
      </div>
      {showAll ? (
        <SessionGrid sessions={running} />
      ) : selected === undefined ? (
        <p className="review-message muted">
          {location.session === null && location.task === null
            ? "No sessions to review yet."
            : "That session isn't in today's list."}
        </p>
      ) : (
        <SessionReview key={selected.id} session={selected} location={location} />
      )}
    </section>
  );
}
