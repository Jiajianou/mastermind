import type { Task, TerminalSize } from "@mastermind/core/contracts";
import { useMemo, useRef, useState } from "react";
import { hasWorkToShow } from "../decide/task-state.js";
import { useCoalescedLoad } from "../review/use-coalesced-load.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { errorMessage } from "./errors.js";
import { createInputQueue } from "./terminal-input.js";
import { useRequest } from "./use-request.js";
import { XtermView } from "./XtermView.js";

type Availability =
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

function useAvailability(taskId: string): Availability {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const [availability, setAvailability] = useState<Availability>({ kind: "checking" });

  useCoalescedLoad(live ? taskId : null, async () => {
    try {
      const read = await api.taskTerminal(taskId);
      if (!read.available) {
        setAvailability({ kind: "unavailable", message: read.message });
        return;
      }
      if (read.view !== null) dispatch({ type: "terminal.loaded", taskId, view: read.view });
      setAvailability({ kind: "available" });
    } catch (error) {
      setAvailability({ kind: "failed", message: errorMessage(error) });
    }
  });

  return availability;
}

function Unavailable({ availability }: { availability: Availability }) {
  if (availability.kind === "checking") return <p className="muted">Checking the terminal…</p>;
  if (availability.kind === "unavailable") return <p role="status">{availability.message}</p>;
  if (availability.kind === "failed")
    return (
      <p role="alert" className="control-failure">
        Couldn&apos;t read the terminal: {availability.message}
      </p>
    );
  return null;
}

export function TryIt({ task }: { task: Task }) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const terminal = useLive((state) => state.terminals[task.id]);
  const availability = useAvailability(task.id);
  const { busy, failure, run } = useRequest();
  const [inputFailure, setInputFailure] = useState<string | null>(null);
  const size = useRef<TerminalSize>({ cols: 80, rows: 24 });
  const running = terminal?.status === "running" ? terminal : null;
  const runningId = running?.id ?? null;

  const queue = useMemo(
    () =>
      runningId === null
        ? null
        : createInputQueue(
            (data) => api.terminalInput(runningId, data),
            (error) => {
              setInputFailure(errorMessage(error));
            },
          ),
    [api, runningId],
  );

  const open = () =>
    run(async () => {
      setInputFailure(null);
      const view = await api.openTerminal(task.id, size.current);
      dispatch({ type: "terminal.loaded", taskId: task.id, view });
    });

  const stop = (terminalId: string) =>
    run(async () => {
      const stopped = await api.stopTerminal(terminalId);
      dispatch({ type: "terminal.updated", taskId: task.id, terminal: stopped });
    });

  const onResize = (next: TerminalSize) => {
    size.current = next;
    if (runningId !== null)
      api.resizeTerminal(runningId, next).catch((error: unknown) => {
        setInputFailure(errorMessage(error));
      });
  };

  const canOpen = live && !busy && availability.kind === "available" && hasWorkToShow(task);

  return (
    <section className="try-it panel" aria-label="Try it yourself">
      <div className="try-it-header">
        <h2>Try it yourself</h2>
        {running === null ? (
          <button type="button" disabled={!canOpen} onClick={() => void open()}>
            {busy ? "Opening…" : terminal === undefined ? "Open terminal" : "Open a new terminal"}
          </button>
        ) : (
          <button type="button" disabled={!live || busy} onClick={() => void stop(running.id)}>
            {busy ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      <Unavailable availability={availability} />
      {availability.kind === "available" && (
        <p className="muted">
          {!hasWorkToShow(task)
            ? "There is no workspace to try."
            : terminal?.status === "exited"
              ? "The terminal has ended."
              : "Runs your shell in the task's workspace."}
        </p>
      )}
      {failure !== null && (
        <p role="alert" className="control-failure">
          {failure}
        </p>
      )}
      {inputFailure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t reach the terminal: {inputFailure}
        </p>
      )}
      {availability.kind !== "unavailable" && (
        <XtermView
          terminal={terminal}
          label="Terminal"
          onInput={(data) => queue?.push(data)}
          onResize={onResize}
        />
      )}
    </section>
  );
}
