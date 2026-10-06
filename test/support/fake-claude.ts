import { fileURLToPath } from "node:url";

export const fakeClaudeBinDir = fileURLToPath(
  new URL("../fixtures/fake-claude/bin/", import.meta.url),
);
export const fakeClaudePath = fileURLToPath(
  new URL("../fixtures/fake-claude/bin/claude", import.meta.url),
);
export const claudeSamplesDir = fileURLToPath(
  new URL("../fixtures/claude-samples/", import.meta.url),
);

export type { AccountKind } from "../fixtures/fake-claude/src/config.js";
export type { FakeClaudeLogRecord, InvocationRecord } from "../fixtures/fake-claude/src/log.js";
export type { Scenario, Step } from "../fixtures/fake-claude/src/scenario.js";
