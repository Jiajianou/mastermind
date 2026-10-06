import { z } from "zod";
import type { ChatMessage } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { OneShotRunner } from "../sessions/one-shot.js";
import { attributionOff } from "../sessions/settings.js";

export const conductorRolloverTokens = 100_000;
const maxTranscriptChars = 120_000;

const conductorSummarySchema = z.strictObject({ summary: z.string().trim().min(1) });

export interface ConductorSummariserOptions {
  db: Db;
  oneShot: OneShotRunner;
  repoRoot: string;
  model: () => string;
}

export interface ConductorSummariser {
  summarise(conversationId: string): Promise<string | null>;
}

const speakers: Record<ChatMessage["kind"], string> = {
  user: "Owner",
  conductor: "Mastermind",
  action: "Mastermind did",
  proposal: "Mastermind asked the owner to confirm",
  plan: "Mastermind proposed a plan",
  system: "Mastermind noted",
};

function transcript(messages: readonly ChatMessage[]): string {
  const lines = messages.map(({ ts, kind, content }) => `[${ts}] ${speakers[kind]}: ${content}`);
  let kept = 0;
  let length = 0;
  for (const line of lines.toReversed()) {
    if (length + line.length > maxTranscriptChars && kept > 0) break;
    length += line.length + 1;
    kept += 1;
  }
  const cut = lines.length - kept;
  return [
    ...(cut === 0 ? [] : [`(${String(cut)} earlier messages left out)`]),
    ...lines.slice(cut),
  ].join("\n");
}

export function summaryPrompt(previous: string | null, messages: readonly ChatMessage[]): string {
  return [
    "Below is a chat between the owner of a software project and mastermind, the assistant that runs coding work on the project for them. The chat will continue in a fresh conversation that starts from your summary alone, so write what mastermind must remember to carry on seamlessly: the owner's goals and preferences, decisions made and their reasons, open questions, promises mastermind made, and anything the owner asked for that isn't finished. Leave out task statuses that will be looked up again, pleasantries and tool details. Use plain sentences, at most about 400 words.",
    ...(previous === null ? [] : ["Summary of the chat before this part:", previous]),
    "The chat:",
    transcript(messages),
  ].join("\n\n");
}

// A judge call (PLAN 6.2) condenses a conversation that has grown large, so the next one starts small.
export function createConductorSummariser(
  options: ConductorSummariserOptions,
): ConductorSummariser {
  const { db, oneShot } = options;
  return {
    async summarise(conversationId) {
      if (db.flags.get().authRequired) return null;
      const result = await oneShot.run({
        role: "judge",
        taskId: null,
        round: null,
        cwd: options.repoRoot,
        prompt: summaryPrompt(
          db.conductorSessions.latestSummary(),
          db.chat.listForConversation(conversationId),
        ),
        schema: conductorSummarySchema,
        print: {
          model: options.model(),
          maxTurns: 1,
          tools: [],
          settings: { attribution: attributionOff },
        },
      });
      return result.kind === "answered" ? result.value.summary : null;
    },
  };
}
