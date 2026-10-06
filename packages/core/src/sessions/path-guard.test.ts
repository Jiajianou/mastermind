import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/temp-dir.js";
import { pathGuardResponse } from "./path-guard.js";

async function layout() {
  const root = await makeTempDir();
  const worktree = join(root, "worktrees", "task");
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(worktree, "escape"));
  await symlink(worktree, join(root, "alias"));
  return { root, worktree };
}

const hookInput = (toolInput: object, cwd?: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: toolInput, cwd });

const denial = {
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
};

describe("path guard", () => {
  it.each([
    { name: "a relative path inside", input: { file_path: "src/a.ts" }, allowed: true },
    { name: "a new file in a new folder", input: { file_path: "new/dir/a.ts" }, allowed: true },
    { name: "a notebook inside", input: { notebook_path: "src/n.ipynb" }, allowed: true },
    { name: "a .. escape", input: { file_path: "../other/a.ts" }, allowed: false },
    {
      name: "a sibling with the worktree as a prefix",
      input: { file_path: "../task2/a.ts" },
      allowed: false,
    },
    { name: "a symlink that leads outside", input: { file_path: "escape/a.ts" }, allowed: false },
    { name: "an absolute path outside", input: { file_path: "/etc/hosts" }, allowed: false },
    { name: "no path at all", input: { command: "ls" }, allowed: false },
  ])("decides $name (allowed: $allowed)", async ({ input, allowed }) => {
    const { worktree } = await layout();

    const response = pathGuardResponse(hookInput(input, worktree), worktree);

    if (allowed) expect(response).toBe("");
    else {
      expect(JSON.parse(response)).toMatchObject(denial);
      expect(response).toContain('"permissionDecisionReason":"mastermind: ');
    }
  });

  it("allows a path reached through a symlinked alias of the worktree", async () => {
    const { root, worktree } = await layout();

    expect(pathGuardResponse(hookInput({ file_path: join(root, "alias", "a.ts") }), worktree)).toBe(
      "",
    );
  });

  it("refuses input it cannot read", () => {
    expect(pathGuardResponse("not json", "/work")).toContain('"permissionDecision":"deny"');
  });
});
