import type { EventDetails } from "../sessions/index.js";
import { runningLabel } from "./tool-labels.js";

function thinkingActivity(tokens: number): string {
  const amount = tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
  return `Thinking (${amount} tokens)`;
}

export interface ActivityTracker {
  record(details: EventDetails): string | null;
}

// Returns the activity to show only when it changes. Streamed text replaces the activity on screen, so the next one
// is shown again even if it repeats the last.
export function createActivityTracker(repoRoot: string): ActivityTracker {
  let thinkingTokens = 0;
  let shown: string | null = null;

  const show = (activity: string): string | null => {
    if (activity === shown) return null;
    shown = activity;
    return activity;
  };

  return {
    record(details) {
      if (details.line === "tool_use")
        return show(runningLabel(details.toolName, details.input, repoRoot));
      if (details.line !== "partial") return null;
      if (details.textDelta !== null && details.textDelta !== "") {
        shown = null;
        return null;
      }
      if (details.thinkingTokens !== null) {
        thinkingTokens += details.thinkingTokens;
        return show(thinkingActivity(thinkingTokens));
      }
      const block = details.blockStart;
      if (block?.type === "tool_use" && block.name !== null)
        return show(runningLabel(block.name, {}, repoRoot));
      return null;
    },
  };
}
