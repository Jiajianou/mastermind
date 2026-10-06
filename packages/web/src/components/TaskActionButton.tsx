import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { useRequest } from "./use-request.js";

export type TaskAction =
  "approve" | "discard" | "rerunChecks" | "retry" | "moveToTop" | "hold" | "release";

export interface TaskActionButtonProps {
  taskId: string;
  action: TaskAction;
  label: string;
  busyLabel: string;
  failurePrefix: string;
  enabled: boolean;
  primary?: boolean;
}

export function TaskActionButton({
  taskId,
  action,
  label,
  busyLabel,
  failurePrefix,
  enabled,
  primary = false,
}: TaskActionButtonProps) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();

  const perform = () =>
    run(async () => {
      const task = await api.act(action, { taskId });
      dispatch({ type: "task.updated", taskId, task });
    });

  return (
    <>
      <button
        type="button"
        className={primary ? "primary" : undefined}
        disabled={!live || busy || !enabled}
        onClick={() => void perform()}
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
