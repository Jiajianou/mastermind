import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trackChild } from "./processes.js";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliSource = fileURLToPath(new URL("../../packages/cli/src/index.ts", import.meta.url));

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  env: Record<string, string>;
  stdin?: string;
}

export async function runCli(args: readonly string[], options: CliRunOptions): Promise<CliRun> {
  const child = spawn(process.execPath, ["--import", "tsx", cliSource, ...args], {
    cwd: workspaceRoot,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  trackChild(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  child.stdin.end(options.stdin ?? "");
  return { code: await closed, stdout, stderr };
}
