import { steeringMessageMaxLength } from "@mastermind/core/contracts";
import type { MessageSessionResult, Session } from "@mastermind/core/contracts";
import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { useRequest } from "../components/use-request.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { sessionPath } from "./links.js";

function deliveredNote({ delivery, session }: MessageSessionResult): string {
  return delivery === "live"
    ? "Sent. The session reads it at its next step."
    : `Sent. It continues as session ${String(session.id)}.`;
}

export function SessionMessageBox({ session }: { session: Session }) {
  const api = useApi();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const hintId = useId();
  const running = session.status === "running";

  const send = async () => {
    if (text.trim() === "" || busy) return;
    setNote(null);
    await run(async () => {
      const result = await api.act("messageSession", { sessionId: session.id, text });
      setText("");
      setNote(deliveredNote(result));
      if (result.session.id === session.id) return;
      dispatch({
        type: "session.started",
        sessionId: result.session.id,
        taskId: result.session.taskId,
        session: result.session,
      });
      void navigate(sessionPath(result.session.id));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="session-message"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="session-message-box">
        <textarea
          rows={1}
          value={text}
          maxLength={steeringMessageMaxLength}
          placeholder={running ? "Message this session" : "Message this session to continue it"}
          aria-label="Message this session"
          aria-describedby={running ? undefined : hintId}
          disabled={!live}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={!live || busy || text.trim() === ""}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {!running && (
        <p id={hintId} className="muted">
          It has ended, so sending resumes it in the same workspace.
        </p>
      )}
      {failure !== null ? (
        <p role="alert" className="control-failure">
          Couldn&apos;t send: {failure}
        </p>
      ) : (
        <p role="status" className="muted">
          {note}
        </p>
      )}
    </form>
  );
}
