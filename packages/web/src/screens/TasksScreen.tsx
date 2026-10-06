import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useLive } from "../store/hooks.js";
import { taskBoard } from "../tasks/board.js";
import { readTasksLocation, tasksPath } from "../tasks/location.js";
import type { TasksView } from "../tasks/location.js";
import { TaskBoard } from "../tasks/TaskBoard.js";
import { TaskGraph } from "../tasks/TaskGraph.js";
import { NewTaskPanel, TaskPanel } from "../tasks/TaskSidePanel.js";

const views: readonly { view: TasksView; label: string }[] = [
  { view: "board", label: "Board" },
  { view: "graph", label: "Graph" },
];

export function TasksScreen() {
  const tasksById = useLive((state) => state.tasks);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { view, task: selectedId, creating } = readTasksLocation(params);
  const tasks = useMemo(() => Object.values(tasksById), [tasksById]);
  const board = useMemo(() => taskBoard(tasks), [tasks]);
  const selected = selectedId === null ? undefined : tasksById[selectedId];

  return (
    <section className="tasks-screen" aria-label="Tasks">
      <h1 className="visually-hidden">Tasks</h1>
      <div className="tasks-toolbar">
        <div role="tablist" aria-label="Tasks view" className="view-tabs">
          {views.map((option) => (
            <button
              key={option.view}
              type="button"
              role="tab"
              id={`tasks-tab-${option.view}`}
              aria-selected={option.view === view}
              aria-controls="tasks-view"
              onClick={() => void navigate(tasksPath({ view: option.view, task: selectedId }))}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Link className="button-link" to={tasksPath({ view, creating: true })}>
          New task
        </Link>
      </div>
      <div className="tasks-columns">
        <div id="tasks-view" role="tabpanel" aria-labelledby={`tasks-tab-${view}`}>
          {view === "board" ? (
            <TaskBoard board={board} selectedId={selectedId} />
          ) : (
            <TaskGraph tasks={tasks} selectedId={selectedId} />
          )}
        </div>
        <aside className="tasks-side" aria-label="Task details">
          {creating ? (
            <NewTaskPanel view={view} />
          ) : selected !== undefined ? (
            <TaskPanel key={selected.id} task={selected} tasks={tasks} />
          ) : (
            <p className="muted">
              {selectedId === null
                ? "Select a task to see its goal, dependencies and actions."
                : `There is no task ${selectedId}.`}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
