import { useMemo } from "react";
import { Link } from "react-router";
import { useLive } from "../store/hooks.js";
import { progressText } from "./progress.js";

export function StatusPill({ pendingDecisions }: { pendingDecisions: number }) {
  const tasks = useLive((state) => state.tasks);
  const text = useMemo(
    () => progressText(Object.values(tasks), pendingDecisions),
    [tasks, pendingDecisions],
  );
  return (
    <Link to="/overview" className="status-pill">
      {text}
    </Link>
  );
}
