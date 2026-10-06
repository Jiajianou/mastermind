#!/usr/bin/env node
import { productName } from "@mastermind/core/contracts";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import cliPackage from "../package.json" with { type: "json" };
import { registerClientCommands } from "./client/commands.js";
import { runDoctorCommand, runForeground, runPathGuard } from "./commands.js";

const portSchema = z.coerce.number().int().min(1).max(65_535);

function parsePort(value: string): number {
  const parsed = portSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError("expected a port number from 1 to 65535");
  return parsed.data;
}

const foregroundOptionsSchema = z.object({
  port: z.number().optional(),
  open: z.boolean().default(false),
});

const pathSchema = z.string();

const program = new Command()
  .name("mastermind")
  .description(`${productName}: a local orchestrator for headless Claude Code sessions`)
  .version(cliPackage.version)
  .argument("[path]", "the git repository to run in", ".")
  .option(
    "--port <n>",
    "serve the web app on this port (default: config port, or the next free one)",
    parsePort,
  )
  .option("--open", "open the web app in the browser")
  .action(async (path: unknown, options: unknown) => {
    process.exitCode = await runForeground(
      pathSchema.parse(path),
      foregroundOptionsSchema.parse(options),
    );
  });

program
  .command("doctor")
  .description(
    "check git, Claude Code, the sign-in and plan, attribution, config, disk and sandbox",
  )
  .argument("[path]", "the git repository to check", ".")
  .action(async (path: unknown) => {
    process.exitCode = await runDoctorCommand(pathSchema.parse(path));
  });

registerClientCommands(program);

program
  .command("path-guard", { hidden: true })
  .description("answer a PreToolUse hook: allow edits inside the worktree only")
  .argument("<worktree>", "the task worktree that edits must stay inside")
  .action(async (worktree: unknown) => {
    process.exitCode = await runPathGuard(pathSchema.parse(worktree));
  });

await program.parseAsync();
