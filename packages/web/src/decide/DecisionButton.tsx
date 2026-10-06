import { useRequest } from "../components/use-request.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";

export type TaskDecision = "approve" | "discard" | "rerunChecks";

export interface DecisionButtonProps {
  taskId: string;
  decision: TaskDecision;
  label: string;
  busyLabel: string;
  failurePrefix: string;
  enabled: boolean;
  primary?: boolean;
}

export function DecisionButton({
  taskId,
  decision,
  label,
  busyLabel,
  failurePrefix,
  enabled,
  primary = false,
}: DecisionButtonProps) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();

  const decide = () =>
    run(async () => {
      const task = await api.act(decision, { taskId });
      dispatch({ type: "task.updated", taskId, task });
    });

  return (
    <>
      <button
        type="button"
        className={primary ? "primary" : undefined}
        disabled={!live || busy || !enabled}
        onClick={() => void decide()}
      >
        {busy ? busyLabel : label}
      </button>
      {failure !== null && (
        <span role="alert" className="control-failure">
          {failurePrefix}: {failure}
        </span>
      )}
    </>
  );
}
