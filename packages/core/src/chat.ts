import type { ChatMessage, ChatStatus, ChatTurnRef } from "./contracts/index.js";
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

export function postChatMessage({ db, bus }: ChatSink, message: NewChatMessage): ChatMessage {
  const posted = db.chat.append(message);
  bus.emit({ type: "chat.message", message: posted });
  return posted;
}

export function postConductorMessage(
  sink: ConductorChatSink,
  message: NewChatMessage,
): ChatMessage {
  return postChatMessage(sink, { ...sink.activeTurn(), ...message });
}
