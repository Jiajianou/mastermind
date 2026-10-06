import type { Task } from "@mastermind/core/contracts";
import { Link } from "react-router";
import { plural } from "@mastermind/core/contracts";
import { TaskActionButton } from "../components/TaskActionButton.js";
import { availableDecisions, decideHeadline, requestChangesPath } from "./task-state.js";

function RequestChanges({ task, comments }: { task: Task; comments: number }) {
  const label = `Request changes · ${plural(comments, "comment")}`;
  return availableDecisions(task.status).requestChanges ? (
    <Link className="button-link" to={requestChangesPath(task.id)}>
      {label}
    </Link>
  ) : (
    <button type="button" disabled>
      {label}
    </button>
  );
}

export function DecideHeader({ task, comments }: { task: Task; comments: number }) {
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
        <TaskActionButton
          taskId={task.id}
          action="discard"
          label="Discard branch"
          busyLabel="Discarding…"
          failurePrefix="Couldn't discard"
          enabled={decisions.discard}
        />
        <RequestChanges task={task} comments={comments} />
        <TaskActionButton
          taskId={task.id}
          action="approve"
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
