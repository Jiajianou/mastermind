import type { ChatMessage, StreamMessage } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { createTurnFollower } from "./chat.js";
import type { TurnEnd } from "./chat.js";

const turnId = "turn-1";

const delta = (text: string, turn = turnId): StreamMessage => ({
  type: "chat.delta",
  turnId: turn,
  text,
});

const message = (
  kind: ChatMessage["kind"],
  content: string,
  meta: ChatMessage["meta"] = null,
  turn = turnId,
): StreamMessage => ({
  type: "chat.message",
  message: {
    id: 1,
    ts: "2026-10-06T10:00:00.000Z",
    kind,
    content,
    meta,
    conductorSession: null,
    turnId: turn,
  },
});

const turnEnded = (turn = turnId): StreamMessage => ({
  type: "chat.turn",
  turnId: turn,
  replying: false,
});

describe("following one chat turn", () => {
  it.each<[string, StreamMessage[], string, TurnEnd | null, boolean]>([
    [
      "streams the reply once, then prints the action line",
      [
        message("user", "add a task"),
        delta("Adding "),
        delta("it."),
        message("conductor", "Adding it."),
        message("action", "✓ Added 1 task"),
        turnEnded(),
      ],
      "Adding it.\n✓ Added 1 task\n",
      "finished",
      false,
    ],
    [
      "prints the rest of a reply whose deltas were missed",
      [delta("Hel"), message("conductor", "Hello there."), turnEnded()],
      "Hello there.\n",
      "finished",
      false,
    ],
    [
      "marks a stopped reply",
      [delta("Once upon"), message("conductor", "Once upon", { stopped: true }), turnEnded()],
      "Once upon\n(stopped)\n",
      "finished",
      false,
    ],
    [
      "points a proposal to the web app",
      [message("proposal", "Hold alpha?"), turnEnded()],
      "Hold alpha?\nConfirm or decline it in the web app.\n",
      "finished",
      false,
    ],
    [
      "reports a failed turn",
      [message("system", "Mastermind couldn't reply: boom"), turnEnded()],
      "Mastermind couldn't reply: boom\n",
      "finished",
      true,
    ],
    [
      "ignores other turns and keeps waiting",
      [
        delta("elsewhere", "turn-2"),
        message("action", "✓ Held b", null, "turn-2"),
        turnEnded("turn-2"),
      ],
      "",
      null,
      false,
    ],
    [
      "stops when mastermind shuts down mid-reply",
      [delta("Partial"), { type: "service.stopping" }],
      "Partial",
      "service-stopped",
      false,
    ],
  ])("%s", (_name, events, output, end, failed) => {
    let written = "";
    const follower = createTurnFollower(turnId, (text) => (written += text));

    const ends = events.map((event) => follower.take(event)).filter((taken) => taken !== null);

    expect(written).toBe(output);
    expect(ends.at(-1) ?? null).toBe(end);
    expect(follower.failed()).toBe(failed);
  });
});
