import { useMemo, useRef, useState } from "react";
import { Composer } from "../chat/Composer.js";
import { FirstRun } from "../chat/FirstRun.js";
import { StatusPill } from "../chat/StatusPill.js";
import { Transcript } from "../chat/Transcript.js";
import {
  buildTranscript,
  isFirstRun,
  isSetupConfirmed,
  pendingDecisions,
} from "../chat/entries.js";
import { useLive } from "../store/hooks.js";

const goalPrompt = "Plan work from this goal: ";

export function ChatScreen() {
  const chat = useLive((state) => state.chat);
  const proposals = useLive((state) => state.proposals);
  const live = useLive((state) => state.connection === "live");
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const entries = useMemo(() => buildTranscript(chat, proposals), [chat, proposals]);
  const waiting =
    chat.replying && !entries.some((entry) => entry.kind === "reply" && entry.streaming);

  const planFromGoal = () => {
    setText(goalPrompt);
    input.current?.focus();
  };

  return (
    <section className="chat" aria-label="Chat">
      <StatusPill pendingDecisions={pendingDecisions(entries)} />
      {live && isFirstRun(chat.messages) && (
        <FirstRun setupConfirmed={isSetupConfirmed(chat.messages)} onPlanFromGoal={planFromGoal} />
      )}
      <Transcript entries={entries} waiting={waiting} />
      <Composer text={text} onTextChange={setText} input={input} />
    </section>
  );
}
