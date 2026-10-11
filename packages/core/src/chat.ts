import type { ChatMessage, ChatStatus, ChatTurnRef, ChatView } from "./contracts/index.js";
import type { Db, NewChatMessage } from "./db/index.js";
import type { EventBus } from "./events.js";

export interface ChatSink {
  db: Db;
  bus: EventBus;
}

export interface ChatState {
  status(): ChatStatus;
  activeTurn(): ChatTurnRef | null;
}

export interface ConductorChatSink extends ChatSink {
  activeTurn(): ChatTurnRef | null;
}

const maxTitleLength = 80;

export function conversationTitle(firstMessage: string): string {
  const line = firstMessage.trim().split("\n")[0]?.trim() ?? "";
  return line.length <= maxTitleLength ? line : `${line.slice(0, maxTitleLength - 1)}…`;
}

export function chatView(db: Db, status: ChatStatus, afterId?: number): ChatView {
  const active = db.conversations.active();
  return {
    ...status,
    conversationId: active.id,
    conversations: db.conversations.list(),
    messages: db.chat.listConversation(active.id, afterId),
  };
}

export function postChatMessage({ db, bus }: ChatSink, message: NewChatMessage): ChatMessage {
  const posted = db.chat.append(message);
  bus.emit({ type: "chat.message", message: posted });
  return posted;
}

export function updateChatMessage(
  { db, bus }: ChatSink,
  id: number,
  change: Pick<NewChatMessage, "content" | "meta">,
): ChatMessage {
  const updated = db.chat.update(id, change);
  bus.emit({ type: "chat.message", message: updated });
  return updated;
}

export function postConductorMessage(
  sink: ConductorChatSink,
  message: NewChatMessage,
): ChatMessage {
  return postChatMessage(sink, { ...sink.activeTurn(), ...message });
}
