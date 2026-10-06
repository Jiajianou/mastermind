import type { Session } from "@mastermind/core/contracts";
import { useRequest } from "../components/use-request.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";

export function StopSessionButton({ session }: { session: Session }) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();

  const stop = () =>
    run(async () => {
      const stopped = await api.act("stopSession", { sessionId: session.id });
      dispatch({
        type: "session.ended",
        sessionId: stopped.id,
        taskId: stopped.taskId,
        session: stopped,
      });
    });

  return (
    <>
      <button type="button" disabled={!live || busy} onClick={() => void stop()}>
        {busy ? "Stopping…" : "Stop session"}
      </button>
      {failure !== null && (
        <span role="alert" className="control-failure">
          Couldn&apos;t stop the session: {failure}
        </span>
      )}
    </>
  );
}
