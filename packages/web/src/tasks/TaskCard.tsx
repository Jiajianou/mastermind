import { Link } from "react-router";
import type { BoardCard } from "./board.js";
import { DepPills } from "./DepPills.js";
import { tasksPath } from "./location.js";
import { StatusWord } from "./StatusWord.js";

export function TaskCard({ card, selected }: { card: BoardCard; selected: boolean }) {
  const { task, unmet } = card;
  return (
    <li className="task-card-item">
      <Link
        className="task-card panel"
        to={tasksPath({ task: task.id })}
        aria-current={selected ? "true" : undefined}
      >
        <span className="task-card-head">
          <code>{task.id}</code>
          <StatusWord status={task.status} />
          {task.held && <span className="held-tag">Held</span>}
        </span>
        <span className="task-card-title">{task.title}</span>
      </Link>
      {unmet.length > 0 && <DepPills deps={unmet} />}
    </li>
  );
}
