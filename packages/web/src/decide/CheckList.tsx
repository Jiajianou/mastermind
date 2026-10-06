import type { Check } from "@mastermind/core/contracts";
import { durationText } from "../sessions/duration.js";
import { checkNames, checkStatusWords } from "./checks.js";
import { TaskActionButton } from "../components/TaskActionButton.js";

function CheckRow({ check }: { check: Check }) {
  return (
    <li className={`check-row check-${check.status}`}>
      <span className="check-name">{checkNames[check.kind]}</span>
      <span className="check-status">{checkStatusWords[check.status]}</span>
      {check.durationMs !== null && (
        <span className="check-duration muted">{durationText(check.durationMs)}</span>
      )}
      {check.summary !== null && <span className="check-summary muted">{check.summary}</span>}
    </li>
  );
}

export function CheckList({
  taskId,
  checks,
  canRerun,
  failure,
}: {
  taskId: string;
  checks: readonly Check[];
  canRerun: boolean;
  failure: string | null;
}) {
  return (
    <section className="check-list panel" aria-label="Checks">
      <header className="check-list-header">
        <h2>Checks</h2>
        <TaskActionButton
          taskId={taskId}
          action="rerunChecks"
          label="Re-run all"
          busyLabel="Starting…"
          failurePrefix="Couldn't re-run the checks"
          enabled={canRerun}
        />
      </header>
      {failure !== null && (
        <p className="control-failure">Couldn&apos;t read the checks: {failure}</p>
      )}
      {checks.length === 0 ? (
        <p className="muted">No checks have run in this round.</p>
      ) : (
        <ul>
          {checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      )}
    </section>
  );
}
