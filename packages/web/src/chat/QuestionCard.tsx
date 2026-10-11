import type { QuestionAnswer } from "@mastermind/core/contracts";
import { useId, useState } from "react";
import { useRequest } from "../components/use-request.js";
import { useLive } from "../store/hooks.js";
import type { QuestionItem } from "./entries.js";
import { useSend } from "./use-send.js";

const recommendedSuffix = /\s*\(recommended\)$/i;

const optionText = (label: string): string => label.replace(recommendedSuffix, "");

interface Draft {
  picked: readonly string[];
  own: string;
}

const emptyDraft: Draft = { picked: [], own: "" };

const draftAnswer = ({ picked, own }: Draft): string =>
  own.trim() !== "" ? own.trim() : picked.join(", ");

function Question({
  item,
  draft,
  open,
  disabled,
  onDraft,
  onPick,
}: {
  item: QuestionItem;
  draft: Draft;
  open: boolean;
  disabled: boolean;
  onDraft: (draft: Draft) => void;
  onPick: (text: string) => void;
}) {
  const ownId = useId();
  const answered = item.answer?.split(", ") ?? [];

  const choose = (text: string) => {
    if (item.multiSelect) {
      const picked = draft.picked.includes(text)
        ? draft.picked.filter((known) => known !== text)
        : [...draft.picked, text];
      onDraft({ picked, own: "" });
    } else onPick(text);
  };

  return (
    <div className="question-item">
      <fieldset className="question-fieldset" disabled={disabled}>
        <legend>
          {item.header !== null && <span className="question-header">{item.header}</span>}
          <span className="question-text">{item.question}</span>
        </legend>
        <ul className="question-options">
          {item.options.map(({ label, description }, index) => {
            const text = optionText(label);
            const chosen = open ? draft.picked.includes(text) : answered.includes(text);
            return (
              <li key={label}>
                <button
                  type="button"
                  role={item.multiSelect ? "checkbox" : undefined}
                  aria-checked={item.multiSelect ? chosen : undefined}
                  aria-pressed={item.multiSelect ? undefined : chosen}
                  className={`option${chosen ? " option-chosen" : ""}`}
                  onClick={() => {
                    choose(text);
                  }}
                >
                  <span className="option-number" aria-hidden="true">
                    {item.multiSelect ? (chosen ? "☑" : "☐") : index + 1}
                  </span>
                  <span className="option-body">
                    <span className="option-label">
                      {text}
                      {recommendedSuffix.test(label) && (
                        <span className="option-badge">Recommended</span>
                      )}
                    </span>
                    {description !== undefined && (
                      <span className="option-description">{description}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {open ? (
          <>
            <label htmlFor={ownId} className="visually-hidden">
              Your own answer
            </label>
            <input
              id={ownId}
              className="question-own"
              value={draft.own}
              placeholder="Or type your own answer"
              onChange={(event) => {
                onDraft({ picked: [], own: event.target.value });
              }}
            />
          </>
        ) : (
          item.answer !== null && <p className="question-answer">You answered: {item.answer}</p>
        )}
      </fieldset>
    </div>
  );
}

// One question sends on the click that answers it; several asked together are answered together, in one message.
export function QuestionCard({ items, open }: { items: readonly QuestionItem[]; open: boolean }) {
  const send = useSend();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();
  const [drafts, setDrafts] = useState<Readonly<Record<number, Draft>>>({});
  const disabled = !open || !live || busy;
  const single = items.length === 1 && items[0]?.multiSelect === false;

  const draftOf = (item: QuestionItem): Draft => drafts[item.id] ?? emptyDraft;
  const answers = items.flatMap((item): QuestionAnswer[] => {
    const answer = draftAnswer(draftOf(item));
    return answer === "" ? [] : [{ questionId: item.id, answer }];
  });
  const complete = answers.length === items.length;

  const submit = (sent: readonly QuestionAnswer[]) =>
    run(async () => {
      const answerTo = (item: QuestionItem) =>
        sent.find(({ questionId }) => questionId === item.id)?.answer ?? "";
      const text =
        items.length === 1
          ? sent.map(({ answer }) => answer).join("")
          : items.map((item) => `${item.header ?? item.question}: ${answerTo(item)}`).join("\n");
      await send(text, [...sent]);
    });

  const pick = (item: QuestionItem, text: string) => {
    if (single) {
      void submit([{ questionId: item.id, answer: text }]);
      return;
    }
    setDrafts((current) => ({ ...current, [item.id]: { picked: [text], own: "" } }));
  };

  return (
    <section className="question" aria-label={items.length === 1 ? "Question" : "Questions"}>
      {items.map((item) => (
        <Question
          key={item.id}
          item={item}
          draft={draftOf(item)}
          open={open}
          disabled={disabled}
          onDraft={(draft) => {
            setDrafts((current) => ({ ...current, [item.id]: draft }));
          }}
          onPick={(text) => {
            pick(item, text);
          }}
        />
      ))}
      {open && (
        <div className="question-submit">
          {!single && (
            <span className="muted-line">
              {answers.length} of {items.length} answered
            </span>
          )}
          <button
            type="button"
            className="primary"
            disabled={disabled || !complete}
            onClick={() => void submit(answers)}
          >
            {items.length === 1 ? "Send" : "Submit answers"}
          </button>
        </div>
      )}
      {failure !== null && (
        <p role="alert" className="control-failure">
          {failure}
        </p>
      )}
    </section>
  );
}
