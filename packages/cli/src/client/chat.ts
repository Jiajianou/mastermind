import { chatTurnSchema } from "@mastermind/core/contracts";
import type { ChatMessage, StreamMessage } from "@mastermind/core/contracts";
import { z } from "zod";
import { createApiClient } from "./api.js";
import { ClientError } from "./errors.js";
import type { Instance } from "./instance.js";
import { openStream } from "./stream.js";
import type { ClientOutput } from "./output.js";

export type TurnEnd = "finished" | "service-stopped";

export interface TurnFollower {
  take(message: StreamMessage): TurnEnd | null;
  messages(): readonly ChatMessage[];
  failed(): boolean;
}

const stoppedMetaSchema = z.object({ stopped: z.literal(true) });

const decisionHints: Partial<Record<ChatMessage["kind"], string>> = {
  proposal: "Confirm or decline it in the web app.",
  plan: 'Reply "go ahead" to start the plan, or start it from the web app.',
};

export function createTurnFollower(turnId: string, write: (text: string) => void): TurnFollower {
  const messages: ChatMessage[] = [];
  let streamed = "";
  let atLineStart = true;

  function print(text: string): void {
    if (text === "") return;
    write(text);
    atLineStart = text.endsWith("\n");
  }

  function line(text: string): void {
    if (!atLineStart) print("\n");
    print(`${text}\n`);
  }

  function show(message: ChatMessage): void {
    switch (message.kind) {
      case "user":
        return;
      case "conductor":
        if (message.content.startsWith(streamed)) print(message.content.slice(streamed.length));
        if (stoppedMetaSchema.safeParse(message.meta).success) line("(stopped)");
        else if (!atLineStart) print("\n");
        return;
      case "action":
      case "system":
      case "proposal":
      case "plan": {
        line(message.content);
        const hint = decisionHints[message.kind];
        if (hint !== undefined) line(hint);
        return;
      }
    }
  }

  return {
    take(event) {
      switch (event.type) {
        case "chat.delta":
          if (event.turnId !== turnId) return null;
          print(event.text);
          streamed += event.text;
          return null;
        case "chat.message":
          if (event.message.turnId !== turnId) return null;
          messages.push(event.message);
          show(event.message);
          return null;
        case "chat.turn":
          if (event.turnId !== turnId || event.replying) return null;
          if (!atLineStart) print("\n");
          return "finished";
        case "service.stopping":
          return "service-stopped";
        default:
          return null;
      }
    },
    messages: () => messages,
    failed: () => messages.some((message) => message.kind === "system"),
  };
}

export async function runChat(
  instance: Instance,
  text: string,
  output: ClientOutput,
): Promise<number> {
  const early: StreamMessage[] = [];
  let follower: TurnFollower | null = null;
  let settle: (end: TurnEnd) => void = () => undefined;
  const ended = new Promise<TurnEnd>((resolve) => {
    settle = resolve;
  });
  const feed = (active: TurnFollower, message: StreamMessage): void => {
    const end = active.take(message);
    if (end !== null) settle(end);
  };

  const stream = await openStream(instance, (message) => {
    if (follower === null) early.push(message);
    else feed(follower, message);
  });
  try {
    const turn = await createApiClient(instance).invoke("sendChat", { text }, chatTurnSchema);
    const active = createTurnFollower(turn.turnId, output.json ? () => undefined : output.write);
    follower = active;
    for (const message of early.splice(0)) feed(active, message);
    const end = await Promise.race([ended, stream.closed.then(() => "disconnected" as const)]);
    if (end !== "finished") throw new ClientError("mastermind stopped before the reply finished");
    if (output.json) output.writeJson({ turnId: turn.turnId, messages: active.messages() });
    return active.failed() ? 1 : 0;
  } finally {
    stream.close();
  }
}
