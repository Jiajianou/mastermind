import { describeAuth } from "@mastermind/core/auth";
import { cleanEnv } from "@mastermind/core/env";
import type { Environment } from "@mastermind/core/env";
import type { ProcessRegistry, SpawnRequest } from "@mastermind/core/procs";
import type { Runtime } from "@mastermind/core/runtime";

export type TerminalCommand = "open" | "copy" | "pause" | "sign-in";

export interface TerminalCommandsOptions {
  runtime: Runtime;
  registry: ProcessRegistry;
  env: Environment;
  platform: NodeJS.Platform;
  handOffTerminal: <T>(work: () => Promise<T>) => Promise<T>;
  onError: (error: unknown) => void;
}

type Launch = Pick<SpawnRequest, "command" | "args">;

function openerFor(platform: NodeJS.Platform, link: string): Launch {
  return platform === "darwin"
    ? { command: "open", args: [link] }
    : { command: "xdg-open", args: [link] };
}

function clipboardFor(platform: NodeJS.Platform, env: Environment): Launch {
  if (platform === "darwin") return { command: "pbcopy", args: [] };
  if (env.WAYLAND_DISPLAY !== undefined) return { command: "wl-copy", args: [] };
  return { command: "xclip", args: ["-selection", "clipboard"] };
}

export function createTerminalCommands(
  options: TerminalCommandsOptions,
): (command: TerminalCommand) => void {
  const { runtime, registry, env, platform, handOffTerminal, onError } = options;
  const childEnv = cleanEnv(env);
  const { store } = runtime;

  async function launch(request: Launch, input?: string): Promise<boolean> {
    const child = await registry.spawn({
      kind: "utility",
      ...request,
      env: childEnv,
      io: { stdin: input === undefined ? "ignore" : "pipe" },
    });
    child.stdin?.end(input);
    const exit = await child.exited;
    const succeeded = exit.kind === "exited" && exit.code === 0;
    if (!succeeded) store.notice(`${request.command} did not succeed`);
    return succeeded;
  }

  async function copyLink(link: string): Promise<void> {
    if (await launch(clipboardFor(platform, env), link)) store.notice("Copied the web app link");
  }

  async function signIn(): Promise<void> {
    const verdict = await handOffTerminal(() => runtime.signIn());
    if (verdict === null || verdict.kind === "accepted") return;
    store.notice(
      verdict.kind === "not-signed-in"
        ? "Still not signed in to Claude. Press Enter to try again."
        : describeAuth(verdict),
    );
  }

  return (command) => {
    const { link } = store.getSnapshot().header;
    switch (command) {
      case "open":
        launch(openerFor(platform, link)).catch(onError);
        return;
      case "copy":
        copyLink(link).catch(onError);
        return;
      case "pause":
        runtime.togglePause().catch(onError);
        return;
      case "sign-in":
        signIn().catch(onError);
        return;
    }
  };
}
