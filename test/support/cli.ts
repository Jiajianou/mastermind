import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { trackChild } from "./processes.js";

// tsx only applies a tsconfig whose `include` covers the file, so the CLI runs from its own package to get its JSX
// settings.
const cliPackage = fileURLToPath(new URL("../../packages/cli/", import.meta.url));
const cliSource = fileURLToPath(new URL("../../packages/cli/src/index.ts", import.meta.url));
export const builtCliPath = fileURLToPath(
  new URL("../../packages/cli/dist/index.js", import.meta.url),
);

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  env: Record<string, string>;
  stdin?: string;
}

export interface CliProcess {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  output: { stdout: string; stderr: string };
  closed: Promise<number | null>;
}

function spawnNode(
  nodeArgs: readonly string[],
  cwd: string,
  env: Record<string, string>,
): CliProcess {
  const child = spawn(process.execPath, nodeArgs, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  trackChild(child);
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output.stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output.stderr += chunk));
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  return { child, output, closed };
}

export function spawnCli(args: readonly string[], env: Record<string, string>): CliProcess {
  return spawnNode(["--import", "tsx", cliSource, ...args], cliPackage, env);
}

export function spawnBuiltCli(args: readonly string[], env: Record<string, string>): CliProcess {
  return spawnNode([builtCliPath, ...args], cliPackage, env);
}

export async function runCli(args: readonly string[], options: CliRunOptions): Promise<CliRun> {
  const { child, output, closed } = spawnCli(args, options.env);
  child.stdin.end(options.stdin ?? "");
  const code = await closed;
  return { code, ...output };
}
