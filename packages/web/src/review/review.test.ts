import type { FileChange, Rebase, SessionEvent } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { at, check, session } from "../testing/fixtures.js";
import { changedFileGroups, defaultFile, treeFileGroups } from "./file-list.js";
import type { DirectoryGroup } from "./file-list.js";
import { sessionProblem } from "./problem.js";
import { reviewSessions } from "./selection.js";

function change(path: string, status: FileChange["status"] = "modified"): FileChange {
  return {
    path,
    oldPath: status === "renamed" ? `old/${path}` : null,
    status,
    additions: 1,
    deletions: 0,
    binary: false,
    uncommitted: true,
  };
}

const outline = (groups: readonly DirectoryGroup[]) =>
  groups.map(({ directory, files }) => ({
    directory,
    files: files.map(
      ({ name, marker, editing }) => `${marker ?? "-"} ${name}${editing ? " editing" : ""}`,
    ),
  }));

describe("changedFileGroups", () => {
  it("groups files by directory, root first, both sorted, each marked by its status", () => {
    const groups = changedFileGroups(
      [
        change("src/web/b.ts"),
        change("README.md"),
        change("src/web/a.ts", "added"),
        change("docs/gone.md", "deleted"),
        change("src/core.ts", "renamed"),
      ],
      null,
    );

    expect(outline(groups)).toEqual([
      { directory: "", files: ["M README.md"] },
      { directory: "docs", files: ["D gone.md"] },
      { directory: "src", files: ["R core.ts"] },
      { directory: "src/web", files: ["A a.ts", "M b.ts"] },
    ]);
  });

  it("tags only the file being edited now", () => {
    const groups = changedFileGroups([change("a.ts"), change("lib/a.ts")], "lib/a.ts");

    expect(outline(groups)).toEqual([
      { directory: "", files: ["M a.ts"] },
      { directory: "lib", files: ["M a.ts editing"] },
    ]);
  });

  it("opens the file being edited by default, else the first file listed", () => {
    const changes = [change("z.ts"), change("lib/a.ts")];

    expect(defaultFile(changedFileGroups(changes, "lib/a.ts"))).toBe("lib/a.ts");
    expect(defaultFile(changedFileGroups(changes, null))).toBe("z.ts");
    expect(defaultFile(changedFileGroups(changes, "elsewhere.ts"))).toBe("z.ts");
    expect(defaultFile([])).toBeNull();
  });
});

describe("treeFileGroups", () => {
  it("lists the full tree and marks only the changed files", () => {
    const groups = treeFileGroups(
      ["package.json", "src/index.ts", "src/new.ts"],
      [change("src/new.ts", "added"), change("src/index.ts"), change("removed.ts", "deleted")],
      "src/new.ts",
    );

    expect(outline(groups)).toEqual([
      { directory: "", files: ["- package.json"] },
      { directory: "src", files: ["M index.ts", "A new.ts editing"] },
    ]);
  });
});

describe("sessionProblem", () => {
  const event = (type: SessionEvent["type"], summary: string): SessionEvent => ({
    id: 9,
    sessionId: 1,
    ts: at(9),
    type,
    summary,
    payload: "{}",
  });
  const failedRebase: Rebase = {
    id: 1,
    taskId: "alpha",
    status: "failed",
    logPath: null,
    ts: at(2),
  };

  it.each([
    {
      name: "no problem",
      latest: event("edit", "Edit a.ts"),
      checks: [],
      rebase: undefined,
      problem: null,
    },
    {
      name: "an error as the latest event",
      latest: event("error", "API overloaded"),
      checks: [],
      rebase: undefined,
      problem: "Error: API overloaded",
    },
    {
      name: "a failed rebase",
      latest: null,
      checks: [],
      rebase: failedRebase,
      problem: "Rebase conflict",
    },
    {
      name: "the latest run of a check failed",
      latest: null,
      checks: [
        check(1, { kind: "build", status: "passed" }),
        check(2, { kind: "acceptance", status: "failed" }),
      ],
      rebase: undefined,
      problem: "Acceptance check failed",
    },
    {
      name: "a failed check that later passed",
      latest: null,
      checks: [
        check(3, { kind: "suite", status: "passed" }),
        check(1, { kind: "suite", status: "failed" }),
      ],
      rebase: undefined,
      problem: null,
    },
  ])("$name", ({ latest, checks, rebase, problem }) => {
    expect(sessionProblem(latest, checks, rebase)).toBe(problem);
  });
});

describe("reviewSessions", () => {
  const now = new Date(at(30));
  const sessions = [
    session(1, { taskId: null, role: "conductor" }),
    session(2, { taskId: "alpha", status: "failed", startedAt: at(1), endedAt: at(5) }),
    session(3, { taskId: "beta", startedAt: at(2) }),
    session(4, { taskId: "alpha", role: "fixer", startedAt: at(6) }),
  ];

  it.each([
    { name: "the oldest running session by default", request: {}, tabs: [3, 4], selected: 3 },
    { name: "the session asked for", request: { session: 4 }, tabs: [3, 4], selected: 4 },
    {
      name: "a finished session, added to the tabs",
      request: { session: 2 },
      tabs: [3, 4, 2],
      selected: 2,
    },
    { name: "a task's running session", request: { task: "alpha" }, tabs: [3, 4], selected: 4 },
    {
      name: "nothing for the chat's own session",
      request: { session: 1 },
      tabs: [3, 4],
      selected: undefined,
    },
  ])("selects $name", ({ request, tabs, selected }) => {
    const chosen = reviewSessions(sessions, { session: null, task: null, ...request }, now);

    expect(chosen.tabs.map((tab) => tab.id)).toEqual(tabs);
    expect(chosen.selected?.id).toBe(selected);
  });
});
