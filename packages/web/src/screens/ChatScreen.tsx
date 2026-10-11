import { useMemo, useRef, useState } from "react";
import { Composer } from "../chat/Composer.js";
import { FirstRun } from "../chat/FirstRun.js";
import { ConversationList } from "../chat/ConversationList.js";
import { StatusPill } from "../chat/StatusPill.js";
import { Transcript } from "../chat/Transcript.js";
import {
  buildTranscript,
  isFirstRun,
  isSetupConfirmed,
  pendingDecisions,
} from "../chat/entries.js";
import { useFollowScroll } from "../components/use-follow-scroll.js";
import { useLive } from "../store/hooks.js";

const goalPrompt = "Plan work from this goal: ";

export function ChatScreen() {
  const chat = useLive((state) => state.chat);
  const proposals = useLive((state) => state.proposals);
  const live = useLive((state) => state.connection === "live");
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const { ref, following, onScroll, follow } = useFollowScroll<HTMLDivElement>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const projectIsNew = chat.conversations.every((conversation) => conversation.title === null);
  const entries = useMemo(() => buildTranscript(chat, proposals), [chat, proposals]);
  const streaming = entries.some((entry) => entry.kind === "reply" && entry.streaming);
  const progress = chat.replying
    ? { label: chat.activity ?? (streaming ? "Writing" : "Thinking") }
    : null;

  const planFromGoal = () => {
    setText(goalPrompt);
    input.current?.focus();
  };

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar" data-open={drawerOpen}>
        <ConversationList
          onOpened={() => {
            setDrawerOpen(false);
          }}
        />
      </aside>
      {drawerOpen && (
        <button
          type="button"
          className="chat-backdrop"
          aria-label="Close conversations"
          onClick={() => {
            setDrawerOpen(false);
          }}
        />
      )}
      <section className="chat" aria-label="Chat">
        <div className="chat-header">
          <button
            type="button"
            className="conversations-toggle"
            aria-expanded={drawerOpen}
            onClick={() => {
              setDrawerOpen((open) => !open);
            }}
          >
            Conversations
          </button>
          <StatusPill pendingDecisions={pendingDecisions(entries)} />
        </div>
        <div ref={ref} className="chat-scroll" onScroll={onScroll}>
          <div className="chat-column">
            {live && isFirstRun(chat.messages) && (
              <FirstRun
                setupConfirmed={!projectIsNew || isSetupConfirmed(chat.messages)}
                onPlanFromGoal={planFromGoal}
              />
            )}
            <Transcript entries={entries} progress={progress} />
          </div>
        </div>
        <div className="chat-footer">
          {!following && (
            <button type="button" className="jump-latest" onClick={follow}>
              Jump to latest
            </button>
          )}
          <Composer text={text} onTextChange={setText} input={input} />
        </div>
      </section>
    </div>
  );
}
