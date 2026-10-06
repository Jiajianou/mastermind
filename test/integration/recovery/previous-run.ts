import { createClaudeCli } from "@mastermind/core/claude";
import { defaultConfig, resolveConfig } from "@mastermind/core/config";
import { openDb } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import { createGit } from "@mastermind/core/git";
import { createProcessRegistry } from "@mastermind/core/procs";
import { createSessionManager } from "@mastermind/core/sessions";
import { z } from "zod";

const argsSchema = z.strictObject({
  repoRoot: z.string(),
  homeDir: z.string(),
  dbPath: z.string(),
  worktreeDir: z.string(),
  promptsDir: z.string(),
  taskId: z.string(),
});
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "null"));
const context = { repoRoot: args.repoRoot, homeDir: args.homeDir };
const config = resolveConfig(
  { ...defaultConfig(context), worktreeDir: args.worktreeDir },
  { ...context, plan: "max" },
);
const db = openDb(args.dbPath);
const registry = createProcessRegistry();
const reportError = (error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
};
const manager = createSessionManager({
  db,
  bus: createEventBus(),
  cli: createClaudeCli({ registry, env: process.env }),
  git: createGit({ registry, env: process.env }),
  registry,
  env: process.env,
  repoRoot: args.repoRoot,
  homeDir: args.homeDir,
  promptsDir: args.promptsDir,
  config: () => config,
  backoff: { reportUsageLimit: () => new Date(), reportSuccess: () => undefined },
  pathGuardCommand: ["node", "/opt/mastermind/path-guard.js"],
  onError: reportError,
});

const task = db.tasks.get(args.taskId);
if (task === null) throw new Error(`no task ${args.taskId}`);
await manager.startTask(task);
