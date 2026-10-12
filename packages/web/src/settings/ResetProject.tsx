import { useState } from "react";
import type { SyntheticEvent } from "react";
import { useRequest } from "../components/use-request.js";
import { useApi, useLive } from "../store/hooks.js";
import { TextField } from "./fields.js";

export function ResetProject({ project }: { project: string }) {
  const api = useApi();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();
  const [typed, setTyped] = useState("");

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.act("resetProject", { project: typed });
    });
  };

  return (
    <form
      className="settings-group panel reset-project"
      aria-label="Reset project"
      onSubmit={submit}
    >
      <h2>Reset project</h2>
      <p>
        Stops every session and deletes this project&apos;s tasks, sessions, chat, review notes and
        logs, along with the task workspaces, so work not yet rebased onto your main branch is lost.
        Your settings stay, and so does everything already in your repo&apos;s branches. This
        can&apos;t be undone.
      </p>
      <TextField label={`Type ${project} to confirm`} value={typed} onChange={setTyped} />
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t reset the project: {failure}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="danger" disabled={!live || busy || typed !== project}>
          {busy ? "Resetting…" : "Reset project"}
        </button>
      </div>
    </form>
  );
}
