import type { PlanMeta } from "@mastermind/core/contracts";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import type { PlanItem, PlanStatus } from "./entries.js";
import { useRequest } from "../components/use-request.js";

export function PlanList({
  planId,
  status,
  items,
  tasks,
}: {
  planId: number;
  status: PlanStatus;
  items: PlanItem[];
  tasks: PlanMeta["tasks"];
}) {
  const api = useApi();
  const dispatch = useDispatch();
  const created = useLive((state) => tasks.every((task) => task.id in state.tasks));
  const started = status === "started" || created;
  const { busy, failure, run } = useRequest();

  const start = () =>
    run(async () => {
      for (const task of await api.act("startPlan", { planId })) {
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
      {status === "replaced" && !started ? (
        <p className="muted-line">Replaced by a newer plan</p>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={started || busy}
          onClick={() => void start()}
        >
          {started ? "Started" : "Start"}
        </button>
      )}
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t start the plan: {failure}
        </p>
      )}
    </section>
  );
}
