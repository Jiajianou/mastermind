import type { Session } from "@mastermind/core/contracts";
import { useFollowScroll } from "../components/use-follow-scroll.js";
import { SessionTranscript } from "./SessionTranscript.js";
import { useSessionTranscript } from "./use-session-transcript.js";

export function TranscriptPanel({ session }: { session: Session }) {
  const { ref, following, onScroll, follow } = useFollowScroll<HTMLDivElement>();
  const { entries, workingSince, live, failure } = useSessionTranscript(session);

  return (
    <div className="transcript-panel">
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t load the earlier activity: {failure}
        </p>
      )}
      <div
        ref={ref}
        className="transcript-scroll"
        role="region"
        aria-label="Transcript"
        tabIndex={0}
        onScroll={onScroll}
      >
        {entries.length === 0 && workingSince === null ? (
          <p className="muted">Nothing happened in this session.</p>
        ) : (
          <SessionTranscript entries={entries} workingSince={workingSince} live={live} />
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
