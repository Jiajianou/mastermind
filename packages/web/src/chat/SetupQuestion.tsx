import type { Config } from "@mastermind/core/contracts";
import { useState } from "react";
import { useApi, useDispatch } from "../store/hooks.js";
import { useRequest } from "./use-request.js";

type Commands = Pick<Config["commands"], "build" | "test">;

function CommandValue({ command }: { command: string }) {
  return command === "" ? <span className="muted">none found</span> : <code>{command}</code>;
}

export function SetupQuestion({ commands }: { commands: Commands }) {
  const api = useApi();
  const dispatch = useDispatch();
  const { busy, failure, run } = useRequest();
  const [editing, setEditing] = useState<Commands | null>(null);
  const [answered, setAnswered] = useState(false);

  const confirm = (chosen: Commands) =>
    run(async () => {
      const { build, test } = chosen;
      dispatch({ type: "config.updated", config: await api.act("confirmSetup", { build, test }) });
      setAnswered(true);
    });

  if (answered) return null;

  return (
    <section className="decision setup" aria-label="Build and test commands">
      <p className="decision-question">Build and test this project with these commands?</p>
      {editing === null ? (
        <>
          <dl className="setup-commands">
            <dt>Build</dt>
            <dd>
              <CommandValue command={commands.build} />
            </dd>
            <dt>Test</dt>
            <dd>
              <CommandValue command={commands.test} />
            </dd>
          </dl>
          <div className="decision-controls">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void confirm(commands)}
            >
              Use these
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(commands);
              }}
            >
              Change
            </button>
          </div>
        </>
      ) : (
        <form
          className="setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm(editing);
          }}
        >
          <label>
            Build command
            <input
              value={editing.build}
              onChange={(event) => {
                setEditing({ ...editing, build: event.target.value });
              }}
            />
          </label>
          <label>
            Test command
            <input
              value={editing.test}
              onChange={(event) => {
                setEditing({ ...editing, test: event.target.value });
              }}
            />
          </label>
          <div className="decision-controls">
            <button type="submit" className="primary" disabled={busy}>
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t save the commands: {failure}
        </p>
      )}
    </section>
  );
}
