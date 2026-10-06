import type { Task } from "@mastermind/core/contracts";
import { SidePanel } from "./SidePanel.js";

export function RebaseQueue({ tasks }: { tasks: readonly Task[] }) {
  return (
    <SidePanel title="Rebase queue">
      {tasks.length === 0 ? (
        <p className="muted">Nothing waiting to rebase.</p>
      ) : (
        <ol className="side-list">
          {tasks.map((task) => (
            <li key={task.id}>
              <code>{task.id}</code> <span className="muted">{task.title}</span>
            </li>
          ))}
        </ol>
      )}
    </SidePanel>
  );
}
