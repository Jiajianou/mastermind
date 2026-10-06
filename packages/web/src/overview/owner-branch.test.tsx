import type { OwnerBranch } from "@mastermind/core/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { LiveProvider } from "../store/hooks.js";
import { createStore } from "../store/store.js";
import { at, stateWith } from "../testing/fixtures.js";
import { OwnerBranchPanel } from "./OwnerBranchPanel.js";

const dev: OwnerBranch = {
  branch: "dev",
  mainBranch: "main",
  onMain: false,
  ahead: 2,
  behind: 3,
  upstream: { name: "origin/main", ahead: 4 },
  rebase: null,
};

const dirty = {
  code: "conflict",
  message: "Your checkout of dev has uncommitted changes. Commit them first, then ask again.",
  issues: [],
};

function serve(rebaseReply: Response, views: readonly OwnerBranch[] = [dev]): RequestInit[] {
  const posts: RequestInit[] = [];
  let reads = 0;
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    if (path === "/api/branch") {
      const view = views[Math.min(reads, views.length - 1)];
      reads += 1;
      return Promise.resolve(Response.json(view));
    }
    if (path === "/api/branch/rebase") {
      posts.push(init);
      return Promise.resolve(rebaseReply);
    }
    return Promise.reject(new TypeError(`no stub for ${path}`));
  });
  return posts;
}

function renderPanel(): void {
  const store = createStore(stateWith({}));
  render(
    <LiveProvider store={store} api={createApiClient("8f3c2a91".repeat(8))}>
      <OwnerBranchPanel />
    </LiveProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Your branch panel", () => {
  it("rebases the checked-out branch and then shows it rebasing", async () => {
    const started = {
      branch: "dev",
      status: "running",
      startedAt: at(5),
      endedAt: null,
      outcome: null,
      logPath: "/logs/dev.log",
    };
    const posts = serve(Response.json(started));
    renderPanel();

    await screen.findByText("2 commits not on main");
    expect(screen.getByText("main moved 3 commits")).toBeDefined();
    expect(screen.getByText("main is 4 commits ahead of origin/main")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Rebase" }));

    await screen.findByText("Rebasing dev onto main…");
    expect(posts.map((init) => init.body)).toEqual([JSON.stringify({ branch: "dev" })]);
    expect(screen.getByRole("button", { name: "Rebase" })).toHaveProperty("disabled", true);
  });

  it("reads the branch again when the owner comes back, and shows a refusal", async () => {
    const stale = { ...dev, ahead: 0, behind: 0, upstream: null };
    serve(Response.json(dirty, { status: 409 }), [stale, dev]);
    renderPanel();

    await screen.findByText("No commits that main lacks");
    fireEvent.focus(window);
    await screen.findByText("2 commits not on main");
    await userEvent.click(screen.getByRole("button", { name: "Rebase" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      `Couldn't rebase: ${dirty.message}`,
    );
    expect(screen.getByRole("button", { name: "Rebase" })).toHaveProperty("disabled", false);
  });
});
