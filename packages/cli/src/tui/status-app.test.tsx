import { signInExpiredPrompt } from "@mastermind/core/auth";
import type { StatusSnapshot, StatusStore } from "@mastermind/core/status";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCtrlCGuard } from "../ctrl-c.js";
import type { TerminalCommand } from "../terminal-commands.js";
import { StatusApp } from "./app.js";

function snapshot(authRequired: boolean): StatusSnapshot {
  return {
    header: {
      repoName: "demo",
      mainBranch: "main",
      mainCommit: "abc1234",
      email: "owner@example.com",
      plan: "max",
      link: "http://127.0.0.1:4700/#t=token",
    },
    ownerOnMain: false,
    running: [],
    summary: {
      counts: { pending: 1, running: 0, checking: 0, review: 0, rebasing: 0, done: 0, blocked: 0 },
      activeWorkers: 0,
      maxWorkers: 2,
      upNext: [],
      blocked: [],
      paused: authRequired,
      authRequired,
      resumeAt: null,
    },
    runningChecks: 0,
    events: [],
  };
}

function staticStore(current: StatusSnapshot): StatusStore {
  return {
    getSnapshot: () => current,
    subscribe: () => () => undefined,
    notice: () => undefined,
    dispose: () => undefined,
  };
}

describe("the terminal view", () => {
  afterEach(cleanup);

  it.each([
    { authRequired: true, prompt: true, commands: ["sign-in"] },
    { authRequired: false, prompt: false, commands: [] },
  ])(
    "offers to sign in again with Enter only while the sign-in has expired (authRequired: $authRequired)",
    async ({ authRequired, prompt, commands }) => {
      const received: TerminalCommand[] = [];
      const guard = createCtrlCGuard({ onFire: () => undefined });
      const { lastFrame, stdin } = render(
        <StatusApp
          store={staticStore(snapshot(authRequired))}
          guard={guard}
          onCommand={(command) => received.push(command)}
        />,
      );

      // Ink starts reading keys after its first render; "p" shows when Enter has been read too.
      await vi.waitFor(() => {
        stdin.write("\r");
        stdin.write("p");
        expect(received.at(-1)).toBe("pause");
      });

      expect(lastFrame()?.includes(signInExpiredPrompt)).toBe(prompt);
      expect(received).toEqual([...commands, "pause"]);
    },
  );
});
