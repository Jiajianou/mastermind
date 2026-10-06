import { defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { noInputSchema, sendChatInputSchema } from "../contracts/index.js";
import type { ChatRunner } from "./runner.js";

export function chatActions(runner: Pick<ChatRunner, "send" | "stop" | "status">) {
  const sendChat = defineAction({
    name: "sendChat",
    description:
      "Send the owner's message to the chat. The reply streams as chat.delta and is stored as chat messages; a message sent while a reply is running joins that turn. A model given here becomes the project's chat model.",
    input: sendChatInputSchema,
    emits: ["chat.message", "chat.turn", "config.updated"],
    handler: async ({ text, model }, { config, emit }) => {
      if (model !== undefined && model !== runner.status().model) {
        const merged = await config.set({ models: { conductor: model } });
        emit({ type: "config.updated", config: merged });
      }
      return runner.send(text);
    },
  });
  const stopChat = defineAction({
    name: "stopChat",
    description: "Stop the reply that is running. stopped is false when nothing was replying.",
    input: noInputSchema,
    emits: ["chat.message", "chat.turn"],
    handler: () => ({ stopped: runner.stop() }),
  });
  return [sendChat, stopChat] as const satisfies readonly [
    ContractedActions<"sendChat">["sendChat"],
    ContractedActions<"stopChat">["stopChat"],
  ];
}
