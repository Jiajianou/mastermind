import type { Clock } from "../clock.js";
import type { ChatMessage, ChatTurnRef, StepMeta } from "../contracts/index.js";
import type { NewChatMessage } from "../db/index.js";
import type { EventDetails } from "../sessions/index.js";
import { finishedLabel, runningLabel, showsOwnCard, stepDetail } from "./tool-labels.js";

export interface StepSink {
  post(message: NewChatMessage): ChatMessage;
  update(id: number, change: Pick<NewChatMessage, "content" | "meta">): ChatMessage;
}

export interface StepRecorder {
  record(details: EventDetails): void;
  stop(): void;
}

export interface StepRecorderOptions {
  sink: StepSink;
  ref: () => ChatTurnRef;
  repoRoot: string;
  clock: Clock;
}

interface RunningTool {
  messageId: number;
  label: string;
  name: string;
  input: Record<string, unknown>;
}

const maxDetailChars = 4000;

function clip(text: string | null): string | null {
  if (text === null || text.length <= maxDetailChars) return text;
  return `${text.slice(0, maxDetailChars)}\n…`;
}

export function elapsedText(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

const stepMeta = (step: StepMeta["step"], status: StepMeta["status"], detail: string | null) =>
  ({ step, status, detail }) satisfies StepMeta;

// What the Conductor does between its text blocks becomes chat rows: one per thinking block and one per tool call. Claude Code closes a thinking block with its
// own assistant line, so that line, or the next block starting, ends the thinking row.
export function createStepRecorder({
  sink,
  ref,
  repoRoot,
  clock,
}: StepRecorderOptions): StepRecorder {
  let thinking: { messageId: number; startedAt: number } | null = null;
  const tools = new Map<string, RunningTool>();

  const post = (content: string, meta: StepMeta): ChatMessage =>
    sink.post({ kind: "step", content, meta, ...ref() });

  function endThinking(): void {
    if (thinking === null) return;
    const took = elapsedText(clock.now().getTime() - thinking.startedAt);
    sink.update(thinking.messageId, {
      content: `Thought for ${took}`,
      meta: stepMeta("thinking", "done", null),
    });
    thinking = null;
  }

  function startThinking(): void {
    if (thinking !== null) return;
    const message = post("Thinking", stepMeta("thinking", "running", null));
    thinking = { messageId: message.id, startedAt: clock.now().getTime() };
  }

  return {
    record(details) {
      switch (details.line) {
        case "partial":
          if (details.blockStart?.type === "thinking") startThinking();
          else if (details.blockStart !== null) endThinking();
          return;
        case "assistant":
          endThinking();
          return;
        case "tool_use": {
          endThinking();
          if (showsOwnCard(details.toolName)) return;
          const label = runningLabel(details.toolName, details.input, repoRoot);
          const message = post(label, stepMeta("tool", "running", null));
          tools.set(details.toolUseId, {
            messageId: message.id,
            label,
            name: details.toolName,
            input: details.input,
          });
          return;
        }
        case "tool_result": {
          const started = tools.get(details.toolUseId);
          if (started === undefined) return;
          tools.delete(details.toolUseId);
          const call = { ...started, isError: details.isError, output: details.output };
          sink.update(started.messageId, {
            content: finishedLabel(call, repoRoot),
            meta: stepMeta("tool", call.isError ? "failed" : "done", clip(stepDetail(call))),
          });
          return;
        }
        default:
          return;
      }
    },

    stop() {
      endThinking();
      for (const { messageId, label } of tools.values())
        sink.update(messageId, {
          content: label,
          meta: stepMeta("tool", "failed", "Stopped before it finished."),
        });
      tools.clear();
    },
  };
}
