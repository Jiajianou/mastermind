#!/usr/bin/env node
import { productName } from "@mastermind/core/contracts";
import { Command } from "commander";
import cliPackage from "../package.json" with { type: "json" };

const program = new Command()
  .name("mastermind")
  .description(`${productName}: a local orchestrator for headless Claude Code sessions`)
  .version(cliPackage.version);

await program.parseAsync();
