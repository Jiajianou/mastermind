import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PrintOptions } from "../claude.js";
import type { ResolvedConfig } from "../config/index.js";
import { editingSessionSettings, workerPermissionOptions } from "./settings.js";

export type EditingRole = "worker" | "fixer";

export type SystemPrompt = EditingRole | "refine" | "branch-fixer";

export interface EditingPrintContext {
  repoRoot: string;
  homeDir: string;
  promptsDir: string;
  pathGuardCommand: readonly string[];
}

export interface EditingPrintRequest {
  role: EditingRole;
  config: ResolvedConfig;
  worktree: string;
  resume: string | null;
  systemPrompt?: SystemPrompt;
}

export function editingPrintOptions(
  context: EditingPrintContext,
  request: EditingPrintRequest,
): PrintOptions {
  const { role, config, worktree, resume, systemPrompt = role } = request;
  const session = resume === null ? { sessionId: randomUUID() } : { resume };
  return {
    model: config.models[role],
    inputFormat: "stream-json",
    ...session,
    replayUserMessages: true,
    ...workerPermissionOptions(config.workerPermissions, config.workerAllowedTools),
    noPermissionPrompts: true,
    appendSystemPromptFile: join(context.promptsDir, `${systemPrompt}.md`),
    settings: editingSessionSettings({
      worktree,
      protectedPaths: [context.repoRoot, join(context.homeDir, ".claude")],
      sandbox: config.sandbox,
      pathGuardCommand: context.pathGuardCommand,
    }),
  };
}
