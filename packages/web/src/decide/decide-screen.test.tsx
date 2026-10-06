import type { Check, Task, TaskTerminal } from "@mastermind/core/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { DecideScreen } from "../screens/DecideScreen.js";
import { LiveProvider } from "../store/hooks.js";
import { createStore } from "../store/store.js";
import { check, notes, stateWith, task } from "../testing/fixtures.js";

// jsdom has no canvas or matchMedia for xterm; the terminal itself is covered by the Playwright spec.
vi.mock("../components/XtermView.js", () => ({
  XtermView: ({ label }: { label: string }) => <div role="region" aria-label={label} />,
}));

const posted: string[] = [];

const inReview = task("alpha", {
  status: "review",
  worktree: "/tmp/worktrees/alpha",
  baseCommit: "a".repeat(40),
});

const checks: Check[] = [
  check(1, { kind: "build", status: "passed", durationMs: 2_000 }),
  check(2, { kind: "acceptance", status: "failed", summary: "exit 1", logPath: "/l/2" }),
  check(3, { kind: "acceptance", status: "passed", durationMs: 1_000 }),
  check(4, { kind: "rebase", status: "passed" }),
];

const failedLog = Array.from({ length: 80 }, (_, line) => `line ${String(line + 1)}`).join("\n");

function serve(afterRerun: Task, terminal: TaskTerminal = { available: true, view: null }): void {
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    if (init.method === "POST") {
      posted.push(path);
      return Promise.resolve(Response.json(afterRerun));
    }
    if (path === "/api/tasks/alpha/checks") return Promise.resolve(Response.json(checks));
    if (path === "/api/checks/2/log")
      return Promise.resolve(
        Response.json({ check: checks[1], text: `${failedLog}\n`, truncated: false }),
      );
    if (path === "/api/tasks/alpha/changes?since=base")
      return Promise.resolve(
        Response.json({ taskId: "alpha", since: "base", fromCommit: "a".repeat(40), files: [] }),
      );
    if (path === "/api/tasks/alpha/notes") return Promise.resolve(Response.json(notes()));
    if (path === "/api/tasks/alpha/terminal") return Promise.resolve(Response.json(terminal));
    return Promise.reject(new TypeError(`no stub for ${path}`));
  });
}

function renderDecide(): void {
  const store = createStore(stateWith({ tasks: { alpha: inReview } }));
  render(
    <LiveProvider store={store} api={createApiClient("8f3c2a91".repeat(8))}>
      <MemoryRouter initialEntries={["/review/decide/alpha"]}>
        <Routes>
          <Route path="/review/decide/:taskId" element={<DecideScreen />} />
        </Routes>
      </MemoryRouter>
    </LiveProvider>,
  );
}

afterEach(() => {
  cleanup();
  posted.length = 0;
  vi.unstubAllGlobals();
});

describe("Test and decide screen", () => {
  it("shows the round's checks and the tail of the failed check's log", async () => {
    serve(inReview);
    renderDecide();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Ready for review · round 1",
    );
    const list = screen.getByRole("region", { name: "Checks" });
    await within(list).findByText("Rebase onto main");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["BuildPassed2s", "AcceptancePassed1s", "Rebase onto mainPassed"]);
    const failed = screen.getByRole("region", { name: "Failed test" });
    expect(failed.textContent).toContain("Acceptance");
    expect(failed.textContent).toContain("passed since");
    const log = await within(failed).findByText(/line 80$/);
    expect(log.textContent.startsWith("line 21\n")).toBe(true);
  });

  it("re-runs every check on one click and leaves no decision open while they run", async () => {
    serve({ ...inReview, status: "checking", updatedAt: "2026-10-06T10:00:00.000Z" });
    renderDecide();

    await userEvent.click(screen.getByRole("button", { name: "Re-run all" }));

    expect(posted).toEqual(["/api/tasks/alpha/checks/rerun"]);
    expect((await screen.findByRole("heading", { name: "Checks running · round 1" })).tagName).toBe(
      "H1",
    );
    for (const name of ["Re-run all", "Discard branch", "Approve and rebase"])
      expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
  });

  it("says why Try it yourself is unavailable and still shows the checks", async () => {
    const message = "Try it yourself needs node-pty, which could not be loaded: no binary";
    serve(inReview, { available: false, message });
    renderDecide();

    const tryIt = screen.getByRole("region", { name: "Try it yourself" });
    expect((await within(tryIt).findByRole("status")).textContent).toBe(message);
    expect(within(tryIt).getByRole("button", { name: "Open terminal" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(tryIt).queryByRole("region", { name: "Terminal" })).toBeNull();
    await within(screen.getByRole("region", { name: "Checks" })).findByText("Rebase onto main");
  });
});
