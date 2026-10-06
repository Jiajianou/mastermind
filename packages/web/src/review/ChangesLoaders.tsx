import { useLoadTaskChanges } from "./use-task-changes.js";

function ChangesLoader({ taskId }: { taskId: string }) {
  useLoadTaskChanges(taskId);
  return null;
}

export function ChangesLoaders({ taskIds }: { taskIds: readonly string[] }) {
  return [...new Set(taskIds)].map((taskId) => <ChangesLoader key={taskId} taskId={taskId} />);
}
