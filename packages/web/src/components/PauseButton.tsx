import { useState } from "react";
import { useApi, useDispatch, useLive } from "../store/hooks.js";

export function PauseButton() {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const paused = useLive((state) => state.scheduler.paused);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setFailure(null);
    try {
      dispatch({ type: "flags.changed", flags: await api.act(paused ? "resume" : "pause") });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

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
