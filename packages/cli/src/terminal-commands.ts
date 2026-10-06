import { cleanEnv } from "@mastermind/core/env";
import type { Environment } from "@mastermind/core/env";
import type { ProcessRegistry, SpawnRequest } from "@mastermind/core/procs";
import type { Runtime } from "@mastermind/core/runtime";
import { noLinkNotice } from "./messages.js";

export type TerminalCommand = "open" | "copy" | "pause";

export interface TerminalCommandsOptions {
  runtime: Runtime;
  registry: ProcessRegistry;
  env: Environment;
  platform: NodeJS.Platform;
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
  const { runtime, registry, env, platform, onError } = options;
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

  function withLink(use: (link: string) => Promise<void>): void {
    const { link } = store.getSnapshot().header;
    if (link === null) {
      store.notice(noLinkNotice);
      return;
    }
    use(link).catch(onError);
  }

  return (command) => {
    switch (command) {
      case "open":
        withLink(async (link) => {
          await launch(openerFor(platform, link));
        });
        return;
      case "copy":
        withLink(async (link) => {
          if (await launch(clipboardFor(platform, env), link))
            store.notice("Copied the web app link");
        });
        return;
      case "pause":
        runtime.togglePause().catch(onError);
        return;
    }
  };
}
