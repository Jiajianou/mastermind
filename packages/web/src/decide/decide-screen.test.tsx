import type { Check, Task } from "@mastermind/core/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { DecideScreen } from "../screens/DecideScreen.js";
import { LiveProvider } from "../store/hooks.js";
import { createStore } from "../store/store.js";
import { check, notes, stateWith, task } from "../testing/fixtures.js";

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

function serve(afterRerun: Task): void {
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
});
