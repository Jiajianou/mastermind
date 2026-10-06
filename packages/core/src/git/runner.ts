import { cleanEnv } from "../env.js";
import type { Environment } from "../env.js";
import { collectOutput } from "../procs.js";
import type { ExitResult, ProcessRegistry } from "../procs.js";

export class GitError extends Error {
  override readonly name = "GitError";

  constructor(
    readonly args: readonly string[],
    readonly exit: ExitResult,
    readonly stderr: string,
  ) {
    const outcome =
      exit.kind === "exited"
        ? `exited with code ${String(exit.code)}`
        : `was killed by ${exit.signal}`;
    super(`git ${args.join(" ")} ${outcome}${stderr === "" ? "" : `: ${stderr}`}`);
  }
}

export interface Git {
  run(cwd: string, args: readonly string[]): Promise<string>;
}

export interface GitOptions {
  registry: ProcessRegistry;
  env: Environment;
}

export function createGit({ registry, env }: GitOptions): Git {
  const childEnv = cleanEnv(env);

  return {
    async run(cwd, args) {
      const { exit, stdout, stderr } = await collectOutput(registry, {
        kind: "utility",
        command: "git",
        args,
        env: childEnv,
        cwd,
      });
      if (exit.kind !== "exited" || exit.code !== 0) throw new GitError(args, exit, stderr.trim());
      return stdout;
    },
  };
}
