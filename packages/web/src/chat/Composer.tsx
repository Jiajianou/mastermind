import { useId, useMemo, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useApi, useLive } from "../store/hooks.js";
import { completeMention, mentionAt, suggestTaskIds } from "./mentions.js";
import type { Mention } from "./mentions.js";
import { ModelMenu } from "./ModelMenu.js";
import { useRequest } from "../components/use-request.js";
import { useSend } from "./use-send.js";

export interface ComposerProps {
  text: string;
  onTextChange: (text: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
}

interface Suggestions {
  mention: Mention;
  taskIds: string[];
}

export function Composer({ text, onTextChange, input }: ComposerProps) {
  const api = useApi();
  const send = useSend();
  const live = useLive((state) => state.connection === "live");
  const replying = useLive((state) => state.chat.replying);
  const tasks = useLive((state) => state.tasks);
  const sending = useRequest();
  const stopping = useRequest();
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState<Mention | null>(null);
  const listId = useId();

  const suggestions = useMemo((): Suggestions | null => {
    const mention = mentionAt(text, caret);
    if (mention === null || mention.start === dismissed?.start) return null;
    const taskIds = suggestTaskIds(Object.keys(tasks), mention.query);
    return taskIds.length === 0 ? null : { mention, taskIds };
  }, [text, caret, tasks, dismissed]);
  const activeIndex = Math.min(highlighted, (suggestions?.taskIds.length ?? 1) - 1);
  const active = suggestions?.taskIds[activeIndex];

  const edit = (next: string, nextCaret: number) => {
    onTextChange(next);
    setCaret(nextCaret);
    setHighlighted(0);
    setDismissed(null);
  };

  const accept = (taskId: string) => {
    if (suggestions === null) return;
    const completed = completeMention(text, caret, suggestions.mention, taskId);
    edit(completed.text, completed.caret);
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(completed.caret, completed.caret);
    });
  };

  const submit = async () => {
    if (text.trim() === "" || sending.busy) return;
    if (await sending.run(() => send(text))) edit("", 0);
  };

  const stop = () =>
    stopping.run(async () => {
      await api.act("stopChat");
    });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions !== null && active !== undefined) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = suggestions.taskIds.length;
        setHighlighted((activeIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(active);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(suggestions.mention);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const optionId = (taskId: string) => `${listId}-${taskId}`;
  const failure =
    sending.failure !== null
      ? `Couldn't send: ${sending.failure}`
      : stopping.failure !== null
        ? `Couldn't stop: ${stopping.failure}`
        : null;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {suggestions !== null && (
        <ul id={listId} role="listbox" aria-label="Tasks" className="suggestions">
          {suggestions.taskIds.map((taskId) => (
            <li
              key={taskId}
              id={optionId(taskId)}
              role="option"
              aria-selected={taskId === active}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(taskId);
              }}
            >
              {taskId}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder="Ask or tell mastermind anything"
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={suggestions === null ? undefined : listId}
          aria-activedescendant={active === undefined ? undefined : optionId(active)}
          disabled={!live}
          onChange={(event) => {
            edit(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-controls">
          <ModelMenu disabled={!live} />
          {replying ? (
            <button type="button" disabled={!live || stopping.busy} onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={!live || sending.busy || text.trim() === ""}
            >
              Send
            </button>
          )}
        </div>
      </div>
      {failure !== null && (
        <p role="alert" className="control-failure">
          {failure}
        </p>
      )}
    </form>
  );
}
