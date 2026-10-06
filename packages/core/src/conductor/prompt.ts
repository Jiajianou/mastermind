import type { ChatMessage } from "../contracts/index.js";
import { hourMinute } from "./format.js";

export interface TurnPromptInput {
  digest: string;
  updates: readonly Pick<ChatMessage, "ts" | "content">[];
  text: string;
}

const maxUpdates = 20;

export function turnPrompt({ digest, updates, text }: TurnPromptInput): string {
  const recent = updates.slice(-maxUpdates);
  const updateBlock =
    recent.length === 0
      ? []
      : [
          "<updates>",
          ...recent.map(({ ts, content }) => `- ${hourMinute(new Date(ts))} ${content}`),
          "</updates>",
        ];
  return ["<state>", digest, "</state>", ...updateBlock, "", text].join("\n");
}
