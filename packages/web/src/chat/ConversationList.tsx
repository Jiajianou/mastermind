import type { ChatView } from "@mastermind/core/contracts";
import { useMemo, useState } from "react";
import { useRequest } from "../components/use-request.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { groupConversations } from "./conversation-groups.js";

export function ConversationList({ onOpened }: { onOpened: () => void }) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const conversations = useLive((state) => state.chat.conversations);
  const activeId = useLive((state) => state.chat.conversationId);
  const { busy, failure, run } = useRequest();
  const [confirming, setConfirming] = useState<number | null>(null);
  const groups = useMemo(
    () => groupConversations(conversations, activeId, new Date()),
    [conversations, activeId],
  );

  const remove = (conversationId: number) =>
    run(async () => {
      const view = await api.act("deleteConversation", { conversationId });
      dispatch({ type: "conversation.deleted", conversationId });
      dispatch({ type: "chat.opened", view });
      setConfirming(null);
    });

  const show = (load: () => Promise<ChatView>) =>
    run(async () => {
      dispatch({ type: "chat.opened", view: await load() });
      onOpened();
    });

  return (
    <nav className="conversations" aria-label="Conversations">
      <button
        type="button"
        className="new-conversation"
        disabled={!live || busy}
        onClick={() => void show(() => api.act("newConversation"))}
      >
        <span aria-hidden="true">＋</span> New conversation
      </button>
      {failure !== null && (
        <p role="alert" className="control-failure">
          {failure}
        </p>
      )}
      {groups.map(({ label, conversations: inGroup }) => (
        <section key={label} className="conversation-group" aria-label={label}>
          <h2>{label}</h2>
          <ul>
            {inGroup.map(({ id, title }) => {
              const name = title ?? "Untitled conversation";
              if (confirming === id)
                return (
                  <li key={id} className="conversation-confirm">
                    <span>Delete “{name}”?</span>
                    <span className="conversation-confirm-actions">
                      <button
                        type="button"
                        className="danger"
                        disabled={!live || busy}
                        onClick={() => void remove(id)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(null);
                        }}
                      >
                        Cancel
                      </button>
                    </span>
                  </li>
                );
              return (
                <li key={id} className="conversation-row">
                  <button
                    type="button"
                    className="conversation-item"
                    aria-current={id === activeId ? "true" : undefined}
                    disabled={!live || busy}
                    title={title ?? undefined}
                    onClick={() => {
                      if (id === activeId) onOpened();
                      else void show(() => api.act("openConversation", { conversationId: id }));
                    }}
                  >
                    {name}
                  </button>
                  <button
                    type="button"
                    className="conversation-delete"
                    aria-label={`Delete ${name}`}
                    title="Delete conversation"
                    disabled={!live || busy}
                    onClick={() => {
                      setConfirming(id);
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                      <path
                        d="M6 2h4M2.5 4h11M4 4l.7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.5 7v4.5M9.5 7v4.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
