import type { Task } from "@mastermind/core/contracts";
import { DecisionButton } from "./DecisionButton.js";
import { availableDecisions, decideHeadline } from "./task-state.js";

export function DecideHeader({ task }: { task: Task }) {
  const decisions = availableDecisions(task.status);
  return (
    <header className="decide-header panel">
      <div className="decide-heading">
        <h1>{decideHeadline(task)}</h1>
        <p className="muted">
          <code>{task.id}</code> {task.title}
        </p>
      </div>
      <div className="decide-controls">
        <DecisionButton
          taskId={task.id}
          decision="discard"
          label="Discard branch"
          busyLabel="Discarding…"
          failurePrefix="Couldn't discard"
          enabled={decisions.discard}
        />
        <DecisionButton
          taskId={task.id}
          decision="approve"
          label="Approve and rebase"
          busyLabel="Approving…"
          failurePrefix="Couldn't approve"
          enabled={decisions.approve}
          primary
        />
      </div>
    </header>
  );
}
