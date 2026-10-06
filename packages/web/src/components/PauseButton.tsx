import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { useRequest } from "./use-request.js";

export function PauseButton() {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const paused = useLive((state) => state.scheduler.paused);
  const { busy, failure, run } = useRequest();

  const toggle = () =>
    run(async () => {
      dispatch({ type: "flags.changed", flags: await api.act(paused ? "resume" : "pause") });
    });

  return (
    <div className="pause-control">
      <button type="button" disabled={!live || busy} onClick={() => void toggle()}>
        {paused ? "Resume" : "Pause"}
      </button>
      {failure !== null && (
        <span role="alert" className="control-failure">
          Couldn&apos;t {paused ? "resume" : "pause"}: {failure}
        </span>
      )}
    </div>
  );
}
