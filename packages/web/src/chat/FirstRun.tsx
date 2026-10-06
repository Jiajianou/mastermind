import { plural } from "@mastermind/core/contracts";
import { useRef, useState } from "react";
import { useApi, useLive } from "../store/hooks.js";
import { SetupQuestion } from "./SetupQuestion.js";
import { useRequest } from "../components/use-request.js";
import { useSend } from "./use-send.js";

export function FirstRun({
  setupConfirmed,
  onPlanFromGoal,
}: {
  setupConfirmed: boolean;
  onPlanFromGoal: () => void;
}) {
  const api = useApi();
  const send = useSend();
  const project = useLive((state) => state.instance?.project ?? null);
  const commands = useLive((state) => state.config?.commands ?? null);
  const live = useLive((state) => state.connection === "live");
  const picker = useRef<HTMLInputElement>(null);
  const { busy, failure, run } = useRequest();
  const [notice, setNotice] = useState<string | null>(null);

  const importFile = (file: File) =>
    run(async () => {
      const { tasks, warnings } = await api.act("importTasks", { yaml: await file.text() });
      setNotice([`Imported ${plural(tasks.length, "task")}.`, ...warnings].join(" "));
    });

  return (
    <div className="first-run">
      <h1>What should we build in {project ?? "this project"}?</h1>
      {!setupConfirmed && commands !== null && <SetupQuestion commands={commands} />}
      <div className="starters">
        <button type="button" disabled={!live} onClick={onPlanFromGoal}>
          Plan work from a goal
        </button>
        <button type="button" disabled={!live || busy} onClick={() => picker.current?.click()}>
          Import tasks.yaml
        </button>
        <button
          type="button"
          disabled={!live || busy}
          onClick={() => void run(() => send("What can you do?"))}
        >
          What can you do?
        </button>
        <input
          ref={picker}
          type="file"
          accept=".yaml,.yml"
          aria-label="tasks.yaml file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void importFile(file);
          }}
        />
      </div>
      {notice !== null && (
        <p role="status" className="muted-line">
          {notice}
        </p>
      )}
      {failure !== null && (
        <p role="alert" className="control-failure">
          {failure}
        </p>
      )}
    </div>
  );
}
