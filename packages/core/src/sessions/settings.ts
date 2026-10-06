import { realpathSync } from "node:fs";
import type { PermissionMode } from "../claude.js";
import type { Config, JsonValue, WorkerPermissions } from "../contracts/index.js";
import { isInside, pathGuardMatcher } from "./path-guard.js";

export const attributionOff = { commit: "", pr: "", sessionUrl: false };

export interface PermissionOptions {
  permissionMode: PermissionMode;
  allowedTools?: string[];
}

export function workerPermissionOptions(
  permissions: WorkerPermissions,
  allowedTools: readonly string[],
): PermissionOptions {
  switch (permissions) {
    case "bypass":
      return { permissionMode: "bypassPermissions" };
    case "auto":
      return { permissionMode: "auto" };
    case "allowlist":
      return { permissionMode: "acceptEdits", allowedTools: [...allowedTools] };
  }
}

export interface EditingSessionSettings {
  worktree: string;
  protectedPaths: readonly string[];
  sandbox: Config["sandbox"];
  pathGuardCommand: readonly string[];
}

function pathVariants(path: string): string[] {
  try {
    return [...new Set([path, realpathSync(path)])];
  } catch {
    return [path];
  }
}

function denyRules(worktree: string, protectedPaths: readonly string[]): string[] {
  return protectedPaths
    .filter((path) => !isInside(worktree, path))
    .flatMap(pathVariants)
    .flatMap((path) => [`Edit(/${path}/**)`, `Write(/${path}/**)`]);
}

function sandboxSettings(sandbox: Config["sandbox"]): JsonValue {
  if (!sandbox.enabled) return { enabled: false };
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    network: { allowedDomains: [...sandbox.allowedDomains], strictAllowlist: true },
    filesystem: { allowWrite: [...sandbox.allowWrite] },
  };
}

export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

export function editingSessionSettings(input: EditingSessionSettings): JsonValue {
  const guard = [...input.pathGuardCommand, input.worktree].map(shellQuote).join(" ");
  return {
    attribution: attributionOff,
    sandbox: sandboxSettings(input.sandbox),
    permissions: { deny: denyRules(input.worktree, input.protectedPaths) },
    hooks: {
      PreToolUse: [{ matcher: pathGuardMatcher, hooks: [{ type: "command", command: guard }] }],
    },
  };
}
