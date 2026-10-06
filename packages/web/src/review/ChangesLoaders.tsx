import { useLoadTaskChanges } from "./use-task-changes.js";

function ChangesLoader({ taskId, since }: { taskId: string; since: string }) {
  useLoadTaskChanges(taskId, since);
  return null;
}

export function ChangesLoaders({
  taskIds,
  since = "base",
}: {
  taskIds: readonly string[];
  since?: string;
}) {
  return [...new Set(taskIds)].map((taskId) => (
    <ChangesLoader key={taskId} taskId={taskId} since={since} />
  ));
}
