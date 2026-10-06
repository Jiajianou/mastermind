import { buildChangeRequest } from "@mastermind/core/contracts";
import type { Round } from "@mastermind/core/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { RequestChangesScreen } from "../screens/RequestChangesScreen.js";
import { LiveProvider } from "../store/hooks.js";
import { createStore } from "../store/store.js";
import {
  at,
  check,
  comment,
  finding,
  notes,
  session,
  stateWith,
  task,
} from "../testing/fixtures.js";

const inReview = task("alpha", { status: "review", worktree: "/tmp/worktrees/alpha" });
const lineComment = comment(1, { text: "Rename this." });
const minorFinding = finding(2, { text: "Unused import." });
const failedCheck = check(3, { kind: "acceptance", status: "failed", summary: "exit 1" });

const sentRound: Round = {
  id: 1,
  taskId: "alpha",
  round: 2,
  mode: "fresh",
  instruction: "Tidy it.",
  message: "…",
  commentIds: [1],
  findingIds: [2],
  failingCheckId: null,
  startCommit: "b".repeat(40),
  sessionId: 7,
  createdAt: at(30),
};

const posted: { path: string; body: unknown }[] = [];

function serve(): void {
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    if (init.method === "POST") {
      posted.push({ path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return Promise.resolve(
        Response.json({
          task: { ...inReview, status: "running", round: 2, updatedAt: at(40) },
          session: session(7, { round: 2 }),
          round: sentRound,
        }),
      );
    }
    if (path === "/api/tasks/alpha/notes")
      return Promise.resolve(
        Response.json(notes({ comments: [lineComment], findings: [minorFinding] })),
      );
    if (path === "/api/tasks/alpha/checks") return Promise.resolve(Response.json([failedCheck]));
    return Promise.reject(new TypeError(`no stub for ${path}`));
  });
}

function renderScreen(): void {
  const store = createStore(stateWith({ tasks: { alpha: inReview } }));
  render(
    <LiveProvider store={store} api={createApiClient("8f3c2a91".repeat(8))}>
      <MemoryRouter initialEntries={["/review/decide/alpha/request-changes"]}>
        <Routes>
          <Route path="/review/decide/:taskId/request-changes" element={<RequestChangesScreen />} />
          <Route path="/review/decide/:taskId" element={<p>Back on review</p>} />
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

describe("Request changes screen", () => {
  it("offers comments by default and findings only when ticked, and previews the exact message", async () => {
    serve();
    renderScreen();

    expect(screen.getByText(/this becomes round 2/)).toBeTruthy();
    const commentBox = await screen.findByRole("checkbox", { name: /Comment.*Rename this\./ });
    const findingBox = screen.getByRole("checkbox", { name: /Minor finding.*Unused import\./ });
    const failingBox = await screen.findByRole("checkbox", { name: /Failing check.*Acceptance/ });
    expect([commentBox, findingBox, failingBox]).toMatchObject([
      { checked: true },
      { checked: false },
      { checked: false },
    ]);

    await userEvent.type(screen.getByRole("textbox", { name: "Overall instruction" }), "Tidy it.");
    await userEvent.click(findingBox);

    const preview = screen.getByRole("region", { name: "Message preview" });
    expect(within(preview).getByText(/^The owner reviewed/).textContent).toBe(
      buildChangeRequest({
        instruction: "Tidy it.",
        comments: [lineComment],
        findings: [minorFinding],
        failingTest: null,
      }),
    );
    const rounds = screen.getByRole("region", { name: "Rounds" });
    expect(
      within(rounds)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Round 1The first run of the task", "Round 2This request"]);
  });

  it("sends the chosen notes with the chosen mode and returns to review", async () => {
    serve();
    renderScreen();
    await screen.findByRole("checkbox", { name: /Comment.*Rename this\./ });

    await userEvent.click(screen.getByRole("radio", { name: /Start a fresh session/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send to session" }));

    expect(await screen.findByText("Back on review")).toBeTruthy();
    expect(posted).toEqual([
      {
        path: "/api/tasks/alpha/request-changes",
        body: {
          instruction: "",
          commentIds: [1],
          findingIds: [],
          includeFailingTest: false,
          mode: "fresh",
        },
      },
    ]);
  });
});
