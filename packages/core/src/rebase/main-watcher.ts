import type { ResolvedConfig } from "../config/index.js";
import type { EventBus } from "../events.js";
import type { Git } from "../git/index.js";
import { readMain } from "./main-ref.js";

export interface MainWatcherOptions {
  git: Git;
  bus: EventBus;
  repoRoot: string;
  config: () => Pick<ResolvedConfig, "mainBranch">;
  onError: (error: unknown) => void;
  pollMs?: number;
}

export interface MainWatcher {
  start(): void;
  stop(): void;
}

// Main can move outside mastermind too (the owner fetches into it, or commits from another worktree), and finished
// branches must still be rebased onto every new main (PLAN 9.2).
export function createMainWatcher(options: MainWatcherOptions): MainWatcher {
  const { git, bus, repoRoot, onError, pollMs = 5_000 } = options;
  let known: string | null = null;
  let reading = false;
  let failing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  async function poll(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      const { mainBranch } = options.config();
      const commit = await readMain(git, repoRoot, mainBranch);
      failing = false;
      if (timer === null || commit === known) return;
      const moved = known !== null;
      known = commit;
      if (moved) bus.emit({ type: "main.moved", branch: mainBranch, commit });
    } catch (error) {
      if (!failing) onError(error);
      failing = true;
    } finally {
      reading = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      unsubscribe = bus.subscribe((event) => {
        if (event.type === "main.moved") known = event.commit;
      });
      timer = setInterval(() => void poll(), pollMs);
      void poll();
    },

    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
