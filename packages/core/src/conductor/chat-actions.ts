import { defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { chatView } from "../chat.js";
import {
  conversationRefInputSchema,
  noInputSchema,
  proposalMetaSchema,
  sendChatInputSchema,
} from "../contracts/index.js";
import type { ProposalGate } from "../proposals.js";
import type { ChatView } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { ChatRunner } from "./runner.js";

type ConversationRunner = Pick<
  ChatRunner,
  "send" | "stop" | "status" | "newConversation" | "openConversation" | "deleteConversation"
>;

function proposalsIn(db: Db, conversationId: number): number[] {
  return db.chat.listConversation(conversationId).flatMap((message) => {
    if (message.kind !== "proposal") return [];
    const meta = proposalMetaSchema.safeParse(message.meta);
    return meta.success ? [meta.data.proposalId] : [];
  });
}

export function chatActions(runner: ConversationRunner, gate: Pick<ProposalGate, "expireQuietly">) {
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
  const deleteConversation = defineAction({
    name: "deleteConversation",
    description:
      "Delete a conversation and its messages for good. Deleting the open one stops its reply and opens a new, empty conversation; questions and confirmations that were waiting in it expire. Returns the chat as it now is.",
    input: conversationRefInputSchema,
    emits: ["chat.message", "chat.turn", "chat.opened", "conversation.deleted", "proposal.updated"],
    handler: ({ conversationId }, { db, emit }) => {
      const waiting = proposalsIn(db, conversationId);
      runner.deleteConversation(conversationId);
      gate.expireQuietly(waiting);
      emit({ type: "conversation.deleted", conversationId });
      return opened(db, emit);
    },
  });
  return [
    sendChat,
    stopChat,
    newConversation,
    openConversation,
    deleteConversation,
  ] as const satisfies readonly [
    ContractedActions<"sendChat">["sendChat"],
    ContractedActions<"stopChat">["stopChat"],
    ContractedActions<"newConversation">["newConversation"],
    ContractedActions<"openConversation">["openConversation"],
    ContractedActions<"deleteConversation">["deleteConversation"],
  ];
}
