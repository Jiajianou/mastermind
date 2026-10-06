import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const pathGuardMatcher = "Edit|Write|MultiEdit|NotebookEdit";

const hookInputSchema = z.object({
  cwd: z.string().optional(),
  tool_input: z.object({
    file_path: z.string().optional(),
    notebook_path: z.string().optional(),
  }),
});

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

export function isInside(path: string, directory: string): boolean {
  const fromDirectory = relative(directory, path);
  return (
    fromDirectory === "" ||
    (fromDirectory !== ".." && !fromDirectory.startsWith("../") && !isAbsolute(fromDirectory))
  );
}

function denial(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `mastermind: ${reason}`,
    },
  });
}

function readHookInput(text: string): z.infer<typeof hookInputSchema> | null {
  try {
    const parsed = hookInputSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Under bypassPermissions the sandbox confines Bash but not Claude Code's file tools, and deny rules can't say
// "everything but the worktree", so this PreToolUse hook is what keeps Edit and Write inside it (decision 9).
export function pathGuardResponse(hookInput: string, worktree: string): string {
  const input = readHookInput(hookInput);
  const target = input?.tool_input.file_path ?? input?.tool_input.notebook_path;
  if (input === null || target === undefined) return denial("could not read the file path");
  const path = resolve(input.cwd ?? worktree, target);
  if (isInside(realPath(path), realPath(worktree))) return "";
  return denial(`${path} is outside this task's worktree`);
}
