import type { Task } from "@mastermind/core/contracts";
import { Link } from "react-router";
import { TaskActionButton } from "../components/TaskActionButton.js";
import { hasWorkToShow, taskReviewPath } from "../decide/task-state.js";
import { depStatuses, unblocks } from "./board.js";
import { DepList } from "./DepList.js";
import { StatusWord } from "./StatusWord.js";

function TaskActions({ task, onEdit }: { task: Task; onEdit: () => void }) {
  if (task.status === "done") return null;
  return (
    <div className="task-actions">
      {task.status === "blocked" && (
        <TaskActionButton
          taskId={task.id}
          action="retry"
          label="Retry"
          busyLabel="Retrying…"
          failurePrefix="Couldn't retry it"
          enabled
          primary
        />
      )}
      <button type="button" onClick={onEdit}>
        Edit
      </button>
      <TaskActionButton
        taskId={task.id}
        action="moveToTop"
        label="Move to top"
        busyLabel="Moving…"
        failurePrefix="Couldn't move it"
        enabled
      />
      <TaskActionButton
        key={String(task.held)}
        taskId={task.id}
        action={task.held ? "release" : "hold"}
        label={task.held ? "Release" : "Hold"}
        busyLabel={task.held ? "Releasing…" : "Holding…"}
        failurePrefix={task.held ? "Couldn't release it" : "Couldn't hold it"}
        enabled
      />
    </div>
  );
}

export function TaskDetails({
  task,
  tasks,
  onEdit,
}: {
  task: Task;
  tasks: readonly Task[];
  onEdit: () => void;
}) {
  return (
    <section className="task-details panel" aria-label={`Task ${task.id}`}>
      <header className="task-details-head">
        <span className="task-card-head">
          <code>{task.id}</code>
          <StatusWord status={task.status} />
          {task.held && <span className="held-tag">Held</span>}
        </span>
        <h2>{task.title}</h2>
      </header>
      <TaskActions task={task} onEdit={onEdit} />
      <dl className="task-facts">
        <dt>Goal</dt>
        <dd className="task-goal">{task.goal}</dd>
        <dt>Acceptance</dt>
        <dd>
          <code>{task.acceptance}</code>
        </dd>
        <dt>Depends on</dt>
        <dd>
          <DepList deps={depStatuses(task.deps, tasks)} empty="Nothing" />
        </dd>
        <dt>Unblocks</dt>
        <dd>
          <DepList deps={unblocks(task, tasks)} empty="Nothing" />
        </dd>
        <dt>Touches</dt>
        <dd>
          {task.touches.length === 0 ? (
            <span className="muted">No paths listed</span>
          ) : (
            <ul className="touch-list">
              {task.touches.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Priority</dt>
        <dd>{task.priority}</dd>
      </dl>
      {hasWorkToShow(task) && (
        <Link className="button-link" to={taskReviewPath(task.id, task.status)}>
          Review changes
        </Link>
      )}
    </section>
  );
}
