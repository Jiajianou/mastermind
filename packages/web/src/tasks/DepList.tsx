import { Link, useSearchParams } from "react-router";
import { depStatusWord } from "./board.js";
import type { DepStatus } from "./board.js";
import { readTasksLocation, tasksPath } from "./location.js";

export function DepList({ deps, empty }: { deps: readonly DepStatus[]; empty: string }) {
  const [params] = useSearchParams();
  const { view } = readTasksLocation(params);
  if (deps.length === 0) return <span className="muted">{empty}</span>;
  return (
    <ul className="dep-list">
      {deps.map((dep) => (
        <li key={dep.id}>
          {dep.status === null ? (
            <code>{dep.id}</code>
          ) : (
            <Link to={tasksPath({ view, task: dep.id })}>
              <code>{dep.id}</code>
            </Link>
          )}{" "}
          <span className={dep.status === "done" ? "muted" : "dep-unmet"}>
            {depStatusWord(dep)}
          </span>
        </li>
      ))}
    </ul>
  );
}
