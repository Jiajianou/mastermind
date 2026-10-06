import type { Check, RoundMode, Task } from "@mastermind/core/contracts";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useRequest } from "../components/use-request.js";
import { latestFailure } from "../decide/checks.js";
import { decidePath } from "../decide/task-state.js";
import { useCheckLog } from "../decide/use-check-log.js";
import { useTaskChecks } from "../decide/use-task-checks.js";
import { roundNotes } from "../notes/notes.js";
import { useTaskNotes } from "../notes/use-task-notes.js";
import {
  hasSomethingToSend,
  isIncluded,
  previewMessage,
  requestInput,
} from "../request/request.js";
import type { Included, RequestDraft, SendKey } from "../request/request.js";
import { RoundsHistory } from "../request/RoundsHistory.js";
import { WhatToSend } from "../request/WhatToSend.js";
import { WhoDoesTheWork } from "../request/WhoDoesTheWork.js";
import { useApi, useDispatch, useLive, useTask } from "../store/hooks.js";

function useFailingLog(
  failing: Check | null,
  wanted: boolean,
): { log: string | null; failure: string | null } {
  const view = useCheckLog(wanted ? failing : null);
  if (!wanted || failing === null) return { log: "", failure: null };
  if (view === null) return { log: null, failure: null };
  return view.kind === "loaded"
    ? { log: view.log.text, failure: null }
    : { log: null, failure: view.message };
}

function RequestChanges({ task }: { task: Task }) {
  const api = useApi();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const live = useLive((state) => state.connection === "live");
  const { notes, failure: notesFailure } = useTaskNotes(task.id);
  const { checks } = useTaskChecks(task.id);
  const [included, setIncluded] = useState<Included>({});
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<RoundMode>("resume");
  const { busy, failure, run } = useRequest();

  const failing = latestFailure(checks, task.round)?.check ?? null;
  const draft: RequestDraft = {
    taskId: task.id,
    notes: roundNotes(notes, task.round),
    failing,
    included,
    instruction,
    mode,
  };
  const failingLog = useFailingLog(failing, isIncluded(included, "failing"));
  const inReview = task.status === "review";
  const ready = notes !== undefined && failingLog.log !== null;
  const back = decidePath(task.id);

  const toggle = (key: SendKey, on: boolean) => {
    setIncluded((current) => ({ ...current, [key]: on }));
  };

  const send = () =>
    run(async () => {
      const started = await api.act("requestChanges", requestInput(draft));
      dispatch({ type: "task.updated", taskId: started.task.id, task: started.task });
      await navigate(back);
    });

  return (
    <>
      <header className="request-header panel">
        <Link to={back}>← Back to review</Link>
        <h1>Request changes</h1>
        <p className="muted">
          <code>{task.id}</code> {task.title} · this becomes round {task.round + 1}
        </p>
      </header>
      <div className="request-body">
        <form
          className="request-form panel"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {!inReview && (
            <p role="status" className="control-failure">
              {task.id} is no longer waiting for review, so it can&apos;t be sent back now.
            </p>
          )}
          {notesFailure !== null && (
            <p role="alert" className="control-failure">
              Couldn&apos;t read the review notes: {notesFailure}
            </p>
          )}
          <WhatToSend notes={draft.notes} failing={failing} included={included} onToggle={toggle} />
          {failingLog.failure !== null && (
            <p role="alert" className="control-failure">
              Couldn&apos;t read the failing check&apos;s log: {failingLog.failure}
            </p>
          )}
          <label className="instruction">
            <span className="field-label">Overall instruction</span>
            <textarea
              value={instruction}
              rows={5}
              placeholder="What should change, in your own words"
              onChange={(event) => {
                setInstruction(event.target.value);
              }}
            />
          </label>
          <WhoDoesTheWork mode={mode} onChange={setMode} />
          <div className="request-actions">
            <button
              type="submit"
              className="primary"
              disabled={!live || busy || !inReview || !ready || !hasSomethingToSend(draft)}
            >
              {busy ? "Sending…" : "Send to session"}
            </button>
            <Link className="button-link" to={back}>
              Cancel
            </Link>
            {failure !== null && (
              <span role="alert" className="control-failure">
                Couldn&apos;t send: {failure}
              </span>
            )}
          </div>
        </form>
        <div className="request-side">
          <RoundsHistory task={task} rounds={notes?.rounds ?? []} />
          <section className="message-preview panel" aria-label="Message preview">
            <h2>Message preview</h2>
            <p className="muted">
              {mode === "resume"
                ? "The session receives exactly this message."
                : "The fresh session receives the task and a summary of the diff, then exactly this message."}
            </p>
            <pre className="preview-text">{previewMessage(draft, failingLog.log ?? "")}</pre>
          </section>
        </div>
      </div>
    </>
  );
}

export function RequestChangesScreen() {
  const { taskId = "" } = useParams();
  const task = useTask(taskId);
  const live = useLive((state) => state.connection === "live");
  return (
    <section className="request-screen" aria-label="Request changes">
      {task === undefined ? (
        <p className="review-message muted">
          {live ? `There is no task called ${taskId}.` : "Loading…"}
        </p>
      ) : (
        <RequestChanges key={task.id} task={task} />
      )}
    </section>
  );
}
