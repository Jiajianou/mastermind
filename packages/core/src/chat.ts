import type { ChatMessage } from "./contracts/index.js";
import type { Db, NewChatMessage } from "./db/index.js";
import type { EventBus } from "./events.js";

export interface ChatSink {
  db: Db;
  bus: EventBus;
}

export function postChatMessage({ db, bus }: ChatSink, message: NewChatMessage): ChatMessage {
  const posted = db.chat.append(message);
  bus.emit({ type: "chat.message", message: posted });
  return posted;
}
