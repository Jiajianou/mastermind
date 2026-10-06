import { Link } from "react-router";
import { useLive } from "../store/hooks.js";
import { decidePath } from "./task-state.js";

export function ReadyForReview() {
  const tasks = useLive((state) => state.tasks);
  const ready = Object.values(tasks).filter((task) => task.status === "review");
  if (ready.length === 0) return null;
  return (
    <nav className="review-tabs" aria-label="Ready for review">
      <ul>
        {ready.map((task) => (
          <li key={task.id}>
            <Link className="review-tab" to={decidePath(task.id)}>
              <code>{task.id}</code>
              <span className="muted">Ready for review · round {String(task.round)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
