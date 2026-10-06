import { signInExpiredPrompt } from "@mastermind/core/auth";
import type { StatusSnapshot, StatusStore } from "@mastermind/core/status";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCtrlCGuard } from "../ctrl-c.js";
import type { TerminalCommand } from "../terminal-commands.js";
import { StatusApp } from "./app.js";

function snapshot(authRequired: boolean, resumeAt: string | null = null): StatusSnapshot {
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
      resumeAt,
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

  it("reads Ctrl+C as a key in raw mode: the first press arms the footer, the second kills", async () => {
    const onFire = vi.fn();
    const guard = createCtrlCGuard({ onFire });
    const received: TerminalCommand[] = [];
    const { lastFrame, stdin } = render(
      <StatusApp
        store={staticStore(snapshot(false))}
        guard={guard}
        onCommand={(command) => received.push(command)}
      />,
    );
    await vi.waitFor(() => {
      stdin.write("o");
      expect(received).toContain("open");
    });

    stdin.write("c");
    stdin.write("\x03");
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Press Ctrl+C again to quit.");
    });
    stdin.write("\x03");

    await vi.waitFor(() => {
      expect(onFire).toHaveBeenCalledTimes(1);
    });
    expect(received.at(-1)).toBe("copy");
    guard.dispose();
  });

  it("shows when new sessions may start again after the usage limit", () => {
    const resumeAt = new Date(2026, 9, 6, 14, 5, 0);
    const guard = createCtrlCGuard({ onFire: () => undefined });

    const { lastFrame } = render(
      <StatusApp
        store={staticStore(snapshot(false, resumeAt.toISOString()))}
        guard={guard}
        onCommand={() => undefined}
      />,
    );

    expect(lastFrame()).toContain("RUNNING 0 of 2 workers · usage limit until 14:05:00");
    guard.dispose();
  });
});
