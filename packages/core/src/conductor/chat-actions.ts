import { defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { chatView } from "../chat.js";
import {
  conversationRefInputSchema,
  noInputSchema,
  sendChatInputSchema,
} from "../contracts/index.js";
import type { ChatView } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { ChatRunner } from "./runner.js";

export function chatActions(
  runner: Pick<ChatRunner, "send" | "stop" | "status" | "newConversation" | "openConversation">,
) {
  const opened = (db: Db, emit: (event: { type: "chat.opened"; view: ChatView }) => void) => {
    const view = chatView(db, runner.status());
    emit({ type: "chat.opened", view });
    return view;
  };
  const sendChat = defineAction({
    name: "sendChat",
    description:
      "Send the owner's message to the chat. The reply streams as chat.delta, with chat.activity naming each tool it uses, and is stored as chat messages; a message sent while a reply is running joins that turn. A model given here becomes the project's chat model.",
    input: sendChatInputSchema,
    emits: ["chat.message", "chat.turn", "chat.activity", "config.updated"],
    handler: async ({ text, model, answers }, { config, emit }) => {
      if (model !== undefined && model !== runner.status().model) {
        const merged = await config.set({ models: { conductor: model } });
        emit({ type: "config.updated", config: merged });
      }
      return runner.send(text, answers);
    },
  });
  const stopChat = defineAction({
    name: "stopChat",
    description: "Stop the reply that is running. stopped is false when nothing was replying.",
    input: noInputSchema,
    emits: ["chat.message", "chat.turn"],
    handler: () => ({ stopped: runner.stop() }),
  });
  const newConversation = defineAction({
    name: "newConversation",
    description:
      "Start a new conversation and make it the active one: any running reply stops, and the next message starts a fresh Claude conversation that remembers nothing from the others, apart from the project's current state. Returns the chat as it now is.",
    input: noInputSchema,
    emits: ["chat.message", "chat.turn", "chat.opened"],
    handler: (_input, { db, emit }) => {
      runner.newConversation();
      return opened(db, emit);
    },
  });
  const openConversation = defineAction({
    name: "openConversation",
    description:
      "Make an earlier conversation the active one, to read it and carry on in it: any running reply stops, and the next message resumes that conversation's own Claude session. Returns the chat as it now is.",
    input: conversationRefInputSchema,
    emits: ["chat.message", "chat.turn", "chat.opened"],
    handler: ({ conversationId }, { db, emit }) => {
      runner.openConversation(conversationId);
      return opened(db, emit);
    },
  });
  return [sendChat, stopChat, newConversation, openConversation] as const satisfies readonly [
    ContractedActions<"sendChat">["sendChat"],
    ContractedActions<"stopChat">["stopChat"],
    ContractedActions<"newConversation">["newConversation"],
    ContractedActions<"openConversation">["openConversation"],
  ];
}
