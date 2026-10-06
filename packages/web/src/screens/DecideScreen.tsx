import type { Task } from "@mastermind/core/contracts";
import { useParams, useSearchParams } from "react-router";
import { CheckList } from "../decide/CheckList.js";
import { latestFailure, roundChecks } from "../decide/checks.js";
import { DecideFiles } from "../decide/DecideFiles.js";
import { DecideHeader } from "../decide/DecideHeader.js";
import { FailedTest } from "../decide/FailedTest.js";
import { availableDecisions, hasWorkToShow } from "../decide/task-state.js";
import { useTaskChecks } from "../decide/use-task-checks.js";
import { useLive } from "../store/hooks.js";

function noWorkText(task: Task): string {
  return task.status === "done"
    ? "This work is on main and its clone has been removed."
    : "This task has no work to review: it starts from main when it next runs.";
}

function Decide({ task, file }: { task: Task; file: string | null }) {
  const { checks, failure } = useTaskChecks(task.id);
  return (
    <>
      <DecideHeader task={task} />
      <div className="decide-body">
        <CheckList
          taskId={task.id}
          checks={roundChecks(checks, task.round)}
          canRerun={availableDecisions(task.status).rerun}
          failure={failure}
        />
        {hasWorkToShow(task) ? (
          <DecideFiles taskId={task.id} file={file} />
        ) : (
          <p className="decide-diff panel editor-message muted">{noWorkText(task)}</p>
        )}
        <div className="decide-side">
          <FailedTest failure={latestFailure(checks, task.round)} />
        </div>
      </div>
    </>
  );
}

export function DecideScreen() {
  const { taskId = "" } = useParams();
  const [params] = useSearchParams();
  const task = useLive((state) => state.tasks[taskId]);
  const live = useLive((state) => state.connection === "live");

  return (
    <section className="decide-screen" aria-label="Test and decide">
      {task === undefined ? (
        <p className="review-message muted">
          {live ? `There is no task called ${taskId}.` : "Loading…"}
        </p>
      ) : (
        <Decide key={task.id} task={task} file={params.get("file")} />
      )}
    </section>
  );
}
