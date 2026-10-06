import { projectPaths } from "@mastermind/core/config";
import { openDb } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createStreamParser } from "@mastermind/core/sessions";
import { onCleanup } from "./cleanup.js";
import { spawnBuiltCli } from "./cli.js";
import type { CliProcess, CliRun } from "./cli.js";
import { waitFor } from "./processes.js";
import type { TempRepo } from "./temp-repo.js";

export interface RunningMastermind {
  mastermind: CliProcess;
  spawn(args: readonly string[]): CliProcess;
  run(args: readonly string[]): Promise<CliRun>;
}

const printedLink = /Web app → http:\/\/127\.0\.0\.1:\d+\//;

export interface StartOptions {
  launch?: (args: readonly string[], env: Record<string, string>) => CliProcess;
  startupMs?: number;
}

export async function startMastermind(
  repo: TempRepo,
  env: Record<string, string>,
  { launch = spawnBuiltCli, startupMs = 20_000 }: StartOptions = {},
): Promise<RunningMastermind> {
  const mastermind = launch([repo.path], env);
  mastermind.child.stdin.end();
  await waitFor(() => printedLink.test(mastermind.output.stdout), startupMs).catch(
    (error: unknown) => {
      const { stdout, stderr } = mastermind.output;
      throw new Error(`mastermind did not start:\n${stdout}${stderr}`, { cause: error });
    },
  );

  const spawn = (args: readonly string[]): CliProcess => {
    const client = launch([...args, "--repo", repo.path], env);
    client.child.stdin.end();
    return client;
  };
  return {
    mastermind,
    spawn,
    async run(args) {
      const { output, closed } = spawn(args);
      const code = await closed;
      return { code, ...output };
    },
  };
}

export function openProjectDb(repo: TempRepo): Db {
  const db = openDb(projectPaths(repo.path).database);
  onCleanup(() => {
    db.close();
  });
  return db;
}

export function conductorToolCalls(db: Db): string[] {
  const conductors = db.sessions.list().filter((session) => session.role === "conductor");
  return conductors.flatMap((session) => {
    const parser = createStreamParser();
    return db.events.listForSession(session.id).flatMap(({ payload }) => {
      const { details } = parser.parseLine(payload);
      return details.line === "tool_use" ? [details.toolName] : [];
    });
  });
}
