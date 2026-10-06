export type TasksView = "board" | "graph";

export interface TasksLocation {
  view: TasksView;
  task: string | null;
  creating: boolean;
}

export function readTasksLocation(params: URLSearchParams): TasksLocation {
  return {
    view: params.get("view") === "graph" ? "graph" : "board",
    task: params.get("task"),
    creating: params.has("new"),
  };
}

export function tasksPath(location: Partial<TasksLocation>): string {
  const params = new URLSearchParams();
  if (location.view === "graph") params.set("view", "graph");
  if (location.task !== undefined && location.task !== null) params.set("task", location.task);
  if (location.creating === true) params.set("new", "");
  const search = params.toString();
  return search === "" ? "/tasks" : `/tasks?${search}`;
}
