import { checkNames, logTail } from "./checks.js";
import type { Failure } from "./checks.js";
import { useCheckLog } from "./use-check-log.js";

const tailLines = 60;

function FailureLog({ failure }: { failure: Failure }) {
  const view = useCheckLog(failure.check);
  if (view === null) return <p className="muted">Loading the log…</p>;
  if (view.kind === "failed")
    return <p className="control-failure">Couldn&apos;t read the log: {view.message}</p>;
  const tail = logTail(view.log.text, tailLines);
  return (
    <>
      {(tail.cut || view.log.truncated) && (
        <p className="muted">Last {String(tailLines)} lines of the log</p>
      )}
      <pre className="log-tail">{tail.text}</pre>
    </>
  );
}

export function FailedTest({ failure }: { failure: Failure | null }) {
  return (
    <section className="failed-test panel" aria-label="Failed test">
      <h2>Failed test</h2>
      {failure === null ? (
        <p className="muted">No check has failed in this round.</p>
      ) : (
        <>
          <p className="failed-check">
            <span className="failed-name">{checkNames[failure.check.kind]}</span>
            {failure.passedSince && <span className="state-tag">passed since</span>}
          </p>
          {failure.check.summary !== null && (
            <p className="muted failed-summary">{failure.check.summary}</p>
          )}
          <FailureLog key={failure.check.id} failure={failure} />
        </>
      )}
    </section>
  );
}
