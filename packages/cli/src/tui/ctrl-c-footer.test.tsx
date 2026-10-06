import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Footer } from "./footer.js";

describe("the Ctrl+C footer", () => {
  afterEach(cleanup);

  it("always shows how to quit, and offers resume while paused", () => {
    const counts = { sessions: 2, checks: 1 };
    const running = render(<Footer armed={false} paused={false} counts={counts} />);
    const paused = render(<Footer armed={false} paused counts={counts} />);

    expect(running.lastFrame()).toBe(
      "p pause · o open · c copy link · Ctrl+C twice to quit (stops all sessions)",
    );
    expect(paused.lastFrame()).toContain("p resume ·");
    expect(paused.lastFrame()).toContain("Ctrl+C twice to quit (stops all sessions)");
  });

  it.each([
    [{ sessions: 2, checks: 1 }, "This kills 2 sessions and 1 check immediately."],
    [{ sessions: 1, checks: 0 }, "This kills 1 session and 0 checks immediately."],
  ])("warns with the live counts once armed (%o)", (counts, kills) => {
    const { lastFrame } = render(<Footer armed paused={false} counts={counts} />);

    expect(lastFrame()).toBe(`Press Ctrl+C again to quit. ${kills} Worktrees are kept.`);
  });
});
