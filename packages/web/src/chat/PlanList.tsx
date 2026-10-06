import type { PlanMeta } from "@mastermind/core/contracts";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import type { PlanItem } from "./entries.js";
import { useRequest } from "./use-request.js";

export function PlanList({ items, tasks }: { items: PlanItem[]; tasks: PlanMeta["tasks"] }) {
  const api = useApi();
  const dispatch = useDispatch();
  const started = useLive((state) => tasks.every((task) => task.id in state.tasks));
  const { busy, failure, run } = useRequest();

  const start = () =>
    run(async () => {
      for (const task of await api.act("createTasks", { tasks })) {
        dispatch({ type: "task.updated", taskId: task.id, task });
      }
    });

  return (
    <section className="plan" aria-label="Plan">
      <ol className="plan-items">
        {items.map(({ id, note }) => (
          <li key={id}>
            <code>{id}</code> {note}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="primary"
        disabled={started || busy}
        onClick={() => void start()}
      >
        {started ? "Started" : "Start"}
      </button>
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t start the plan: {failure}
        </p>
      )}
    </section>
  );
}
