import type { ChatView } from "@mastermind/core/contracts";
import { useMemo } from "react";
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
  const groups = useMemo(
    () => groupConversations(conversations, activeId, new Date()),
    [conversations, activeId],
  );

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
            {inGroup.map(({ id, title }) => (
              <li key={id}>
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
                  {title ?? "Untitled conversation"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
