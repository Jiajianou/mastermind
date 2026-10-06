import { isAbsolute, join, resolve } from "node:path";
import { parseDuration, resolveMaxWorkers } from "../contracts/config.js";
import type { Config, SubscriptionPlan } from "../contracts/config.js";
import type { ConfigContext } from "./paths.js";

export interface ResolvedConfig extends Omit<Config, "maxWorkers" | "stuckCheck"> {
  maxWorkers: number;
  stuckCheck: { afterMs: number; everyMs: number };
}

export interface ResolveContext extends ConfigContext {
  plan: SubscriptionPlan;
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  return path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
}

export function resolveConfigPath(path: string, { repoRoot, homeDir }: ConfigContext): string {
  const expanded = expandHome(path, homeDir);
  return isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
}

export function durationMs(text: string): number {
  const ms = parseDuration(text);
  if (ms === null) throw new RangeError(`Invalid duration "${text}" in a validated config`);
  return ms;
}

export function resolveConfig(config: Config, context: ResolveContext): ResolvedConfig {
  return {
    ...config,
    worktreeDir: resolveConfigPath(config.worktreeDir, context),
    maxWorkers: resolveMaxWorkers(config.maxWorkers, context.plan),
    stuckCheck: {
      afterMs: durationMs(config.stuckCheck.after),
      everyMs: durationMs(config.stuckCheck.every),
    },
    sandbox: {
      ...config.sandbox,
      allowWrite: config.sandbox.allowWrite.map((path) => resolveConfigPath(path, context)),
    },
  };
}
