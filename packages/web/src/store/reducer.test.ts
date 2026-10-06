import { busEventSchema, terminalScrollbackLimit } from "@mastermind/core/contracts";
import type { OwnerBranch, Rebase, Terminal } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import {
  at,
  check,
  comment,
  config,
  finding,
  message,
  notes,
  session,
  sessionEvent,
  snapshot,
  stateWith,
  summary,
  task,
} from "../testing/fixtures.js";
import { reduce } from "./reducer.js";
import type { LiveState, StoreAction, TerminalState } from "./state.js";

const ownerBranch: OwnerBranch = {
  branch: "dev",
  mainBranch: "main",
  onMain: false,
  ahead: 2,
  behind: 1,
  upstream: null,
  rebase: null,
};

interface Case {
  name: string;
  before: LiveState;
  action: StoreAction;
  after: (next: LiveState, before: LiveState) => void;
}

const terminal = (id: string): Terminal => ({
  id,
  taskId: "alpha",
  cwd: "/clones/alpha",
  status: "running",
});

const terminalState = (output: string): TerminalState => ({
  id: "t1",
  status: "running",
  output,
  received: output.length,
});

const rebase: Rebase = { id: 4, taskId: "alpha", status: "running", logPath: null, ts: at(5) };

const cases: Case[] = [
  {
    name: "task.updated stores the task and leaves other tasks untouched",
    before: stateWith({ tasks: { alpha: task("alpha"), beta: task("beta") } }),
    action: {
      type: "task.updated",
      taskId: "alpha",
      task: task("alpha", { status: "running", updatedAt: at(1) }),
    },
    after: (next, before) => {
      expect(next.tasks.alpha?.status).toBe("running");
      expect(next.tasks.beta).toBe(before.tasks.beta);
    },
  },
  {
    name: "task.updated ignores a task older than the one already known",
    before: stateWith({ tasks: { alpha: task("alpha", { status: "review", updatedAt: at(9) }) } }),
    action: {
      type: "task.updated",
      taskId: "alpha",
      task: task("alpha", { status: "running", updatedAt: at(1) }),
    },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "session.started adds a new session",
    before: stateWith({ sessions: { 2: session(2) } }),
    action: { type: "session.started", sessionId: 1, taskId: "alpha", session: session(1) },
    after: (next, before) => {
      expect(next.sessions[1]).toEqual(session(1));
      expect(next.sessions[2]).toBe(before.sessions[2]);
    },
  },
  {
    name: "session.started never reopens a session already known to have ended",
    before: stateWith({ sessions: { 1: session(1, { status: "succeeded", endedAt: at(4) }) } }),
    action: { type: "session.started", sessionId: 1, taskId: "alpha", session: session(1) },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "session.ended records how the session ended and moves its task's workspace",
    before: stateWith({ sessions: { 1: session(1) } }),
    action: {
      type: "session.ended",
      sessionId: 1,
      taskId: "alpha",
      session: session(1, { status: "failed", endedAt: at(4) }),
    },
    after: (next) => {
      expect(next.sessions[1]?.status).toBe("failed");
      expect(next.workspaces.alpha?.revision).toBe(1);
    },
  },
  {
    name: "session.event appends to that session's timeline in id order",
    before: stateWith({ sessionEvents: { 1: [sessionEvent(1), sessionEvent(3)], 2: [] } }),
    action: { type: "session.event", sessionId: 1, taskId: "alpha", event: sessionEvent(2) },
    after: (next, before) => {
      expect(next.sessionEvents[1]?.map((event) => event.id)).toEqual([1, 2, 3]);
      expect(next.sessionEvents[2]).toBe(before.sessionEvents[2]);
    },
  },
  {
    name: "session.event ignores an event it already has",
    before: stateWith({ sessionEvents: { 1: [sessionEvent(1)] } }),
    action: { type: "session.event", sessionId: 1, taskId: "alpha", event: sessionEvent(1) },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "session.event marks the file a session is editing now",
    before: stateWith({ editing: { 2: "other.ts" } }),
    action: {
      type: "session.event",
      sessionId: 1,
      taskId: "alpha",
      event: sessionEvent(1),
      path: "src/app.ts",
    },
    after: (next, before) => {
      expect(next.editing).toEqual({ 1: "src/app.ts", 2: "other.ts" });
      expect(next.workspaces).toBe(before.workspaces);
    },
  },
  {
    name: "a commit moves the task's workspace so its changes are read again",
    before: stateWith({ workspaces: { alpha: { revision: 3, files: { "a.ts": 2 }, anyFile: 1 } } }),
    action: {
      type: "session.event",
      sessionId: 1,
      taskId: "alpha",
      event: { ...sessionEvent(1), type: "commit" },
    },
    after: (next) => {
      expect(next.workspaces.alpha).toEqual({ revision: 4, files: { "a.ts": 2 }, anyFile: 1 });
    },
  },
  {
    name: "file.changed moves the workspace and that file, so an open copy of it is read again",
    before: stateWith({ workspaces: { alpha: { revision: 3, files: { "a.ts": 2 }, anyFile: 1 } } }),
    action: { type: "file.changed", sessionId: 1, taskId: "alpha", path: "src/app.ts" },
    after: (next) => {
      expect(next.workspaces.alpha).toEqual({
        revision: 4,
        files: { "a.ts": 2, "src/app.ts": 4 },
        anyFile: 1,
      });
      expect(next.editing[1]).toBe("src/app.ts");
    },
  },
  {
    name: "workspace.changed moves the workspace and every file, since a shell command could have changed any of them",
    before: stateWith({ workspaces: { alpha: { revision: 3, files: { "a.ts": 2 }, anyFile: 1 } } }),
    action: { type: "workspace.changed", sessionId: 1, taskId: "alpha" },
    after: (next) => {
      expect(next.workspaces.alpha).toEqual({ revision: 4, files: { "a.ts": 2 }, anyFile: 4 });
    },
  },
  {
    name: "changes.loaded stores a task's changes or why they could not be read",
    before: stateWith({ changes: { beta: { kind: "failed", message: "gone" } } }),
    action: {
      type: "changes.loaded",
      key: "alpha",
      view: {
        kind: "loaded",
        changes: { taskId: "alpha", since: "base", fromCommit: "abc1234", files: [] },
      },
    },
    after: (next, before) => {
      expect(next.changes.alpha?.kind).toBe("loaded");
      expect(next.changes.beta).toBe(before.changes.beta);
    },
  },
  {
    name: "notes.loaded stores a task's comments, findings and rounds",
    before: stateWith({}),
    action: { type: "notes.loaded", notes: notes({ comments: [comment(1)] }) },
    after: (next) => {
      expect(next.notes.alpha?.comments).toEqual([comment(1)]);
    },
  },
  {
    name: "comment.updated adds or replaces a comment in id order, for tasks whose notes were read",
    before: stateWith({ notes: { alpha: notes({ comments: [comment(1), comment(3)] }) } }),
    action: { type: "comment.updated", taskId: "alpha", comment: comment(2, { text: "new" }) },
    after: (next) => {
      expect(next.notes.alpha?.comments.map(({ id }) => id)).toEqual([1, 2, 3]);
      const unread = stateWith({});
      expect(
        reduce(unread, { type: "comment.updated", taskId: "alpha", comment: comment(1) }),
      ).toBe(unread);
    },
  },
  {
    name: "comment.deleted removes the comment",
    before: stateWith({ notes: { alpha: notes({ comments: [comment(1), comment(2)] }) } }),
    action: { type: "comment.deleted", taskId: "alpha", commentId: 1 },
    after: (next) => {
      expect(next.notes.alpha?.comments).toEqual([comment(2)]);
    },
  },
  {
    name: "finding.updated replaces the finding, such as one just dismissed",
    before: stateWith({ notes: { alpha: notes({ findings: [finding(1), finding(2)] }) } }),
    action: { type: "finding.updated", taskId: "alpha", finding: finding(2, { dismissed: true }) },
    after: (next, before) => {
      expect(next.notes.alpha?.findings[1]?.dismissed).toBe(true);
      expect(next.notes.alpha?.findings[0]).toBe(before.notes.alpha?.findings[0]);
    },
  },
  {
    name: "session.history.loaded merges the stored timeline with live events, without doubles",
    before: stateWith({ sessionEvents: { 1: [sessionEvent(4), sessionEvent(5)] } }),
    action: {
      type: "session.history.loaded",
      sessionId: 1,
      events: [sessionEvent(2), sessionEvent(3), sessionEvent(4)],
    },
    after: (next) => {
      expect(next.sessionEvents[1]?.map((event) => event.id)).toEqual([2, 3, 4, 5]);
      expect(next.historyLoaded[1]).toBe(true);
    },
  },
  {
    name: "check.updated keeps each of a task's checks by id",
    before: stateWith({ checks: { alpha: { 1: check(1) }, beta: {} } }),
    action: {
      type: "check.updated",
      taskId: "alpha",
      check: check(2, { kind: "acceptance", status: "failed" }),
    },
    after: (next, before) => {
      expect(Object.keys(next.checks.alpha ?? {})).toEqual(["1", "2"]);
      expect(next.checks.alpha?.[2]?.status).toBe("failed");
      expect(next.checks.beta).toBe(before.checks.beta);
    },
  },
  {
    name: "checks.loaded adds the loaded checks but never returns a finished check to running",
    before: stateWith({
      checks: { alpha: { 1: check(1, { status: "passed" }), 2: check(2) }, beta: {} },
    }),
    action: {
      type: "checks.loaded",
      taskId: "alpha",
      checks: [check(1), check(2, { status: "failed" }), check(3, { kind: "suite" })],
    },
    after: (next, before) => {
      expect(next.checks.alpha?.[1]?.status).toBe("passed");
      expect(next.checks.alpha?.[2]?.status).toBe("failed");
      expect(next.checks.alpha?.[3]?.kind).toBe("suite");
      expect(next.checks.beta).toBe(before.checks.beta);
    },
  },
  {
    name: "rebase.updated keeps the task's latest rebase",
    before: stateWith({}),
    action: { type: "rebase.updated", taskId: "alpha", rebase },
    after: (next) => {
      expect(next.rebases.alpha).toEqual(rebase);
    },
  },
  {
    name: "main.moved leaves the state unchanged until a screen shows main",
    before: stateWith({}),
    action: { type: "main.moved", branch: "main", commit: "a".repeat(40) },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "branch.updated keeps the owner's branch as the service last read it",
    before: stateWith({}),
    action: { type: "branch.updated", branch: ownerBranch },
    after: (next) => {
      expect(next.ownerBranch).toEqual(ownerBranch);
    },
  },
  {
    name: "checkout.updated leaves the state unchanged; the chat line tells the owner",
    before: stateWith({}),
    action: { type: "checkout.updated", branch: "main", onMain: true },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "terminal.output appends only the unseen part and keeps the most recent output",
    before: stateWith({ terminals: { alpha: terminalState("x".repeat(terminalScrollbackLimit)) } }),
    action: {
      type: "terminal.output",
      taskId: "alpha",
      terminalId: "t1",
      offset: terminalScrollbackLimit - 2,
      data: "xx$ make\n",
    },
    after: (next) => {
      const terminal = next.terminals.alpha;
      expect(terminal?.output).toHaveLength(terminalScrollbackLimit);
      expect(terminal?.output.endsWith("xxx$ make\n")).toBe(true);
      expect(terminal?.received).toBe(terminalScrollbackLimit + 7);
    },
  },
  {
    name: "terminal.output already held in the stored output changes nothing",
    before: stateWith({ terminals: { alpha: terminalState("$ make\nok\n") } }),
    action: { type: "terminal.output", taskId: "alpha", terminalId: "t1", offset: 7, data: "ok\n" },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "terminal.loaded keeps output and an exit the stream already delivered",
    before: stateWith({
      terminals: { alpha: { ...terminalState("$ make\nok\n"), status: "exited" } },
    }),
    action: {
      type: "terminal.loaded",
      taskId: "alpha",
      view: { terminal: terminal("t1"), output: "$ make\n", received: 7 },
    },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "terminal.updated for a new terminal of the task replaces the old one",
    before: stateWith({ terminals: { alpha: { ...terminalState("old\n"), status: "exited" } } }),
    action: { type: "terminal.updated", taskId: "alpha", terminal: terminal("t2") },
    after: (next) => {
      expect(next.terminals.alpha).toEqual({
        id: "t2",
        status: "running",
        output: "",
        received: 0,
      });
    },
  },
  {
    name: "chat.message appends a new message",
    before: stateWith({ chat: { ...stateWith({}).chat, messages: [message(1)] } }),
    action: { type: "chat.message", message: message(2) },
    after: (next) => {
      expect(next.chat.messages.map((known) => known.id)).toEqual([1, 2]);
    },
  },
  {
    name: "chat.message for a reply replaces the streamed draft of its turn",
    before: stateWith({
      chat: { ...stateWith({}).chat, replying: true, drafts: { "turn-1": "Hel", "turn-2": "x" } },
    }),
    action: {
      type: "chat.message",
      message: message(5, { kind: "conductor", content: "Hello", turnId: "turn-1" }),
    },
    after: (next) => {
      expect(next.chat.messages.map((known) => known.content)).toEqual(["Hello"]);
      expect(next.chat.drafts).toEqual({ "turn-2": "x" });
    },
  },
  {
    name: "chat.delta extends the draft of its turn",
    before: stateWith({ chat: { ...stateWith({}).chat, drafts: { "turn-1": "Hel" } } }),
    action: { type: "chat.delta", turnId: "turn-1", text: "lo" },
    after: (next) => {
      expect(next.chat.drafts["turn-1"]).toBe("Hello");
    },
  },
  {
    name: "chat.delta is ignored once the turn's reply is stored",
    before: stateWith({
      chat: {
        ...stateWith({}).chat,
        messages: [message(5, { kind: "conductor", turnId: "turn-1" })],
      },
    }),
    action: { type: "chat.delta", turnId: "turn-1", text: "late" },
    after: (next, before) => {
      expect(next).toBe(before);
    },
  },
  {
    name: "chat.turn marks replying and drops the draft when the turn ends",
    before: stateWith({
      chat: { ...stateWith({}).chat, replying: true, drafts: { "turn-1": "x" } },
    }),
    action: { type: "chat.turn", turnId: "turn-1", replying: false },
    after: (next) => {
      expect(next.chat.replying).toBe(false);
      expect(next.chat.drafts).toEqual({});
    },
  },
  {
    name: "proposal.updated stores the proposal by id",
    before: stateWith({}),
    action: {
      type: "proposal.updated",
      proposal: {
        id: 7,
        ts: at(6),
        action: "hold",
        args: { taskId: "alpha" },
        status: "pending",
        decidedAt: null,
        result: null,
      },
    },
    after: (next) => {
      expect(next.proposals[7]?.status).toBe("pending");
    },
  },
  {
    name: "auth.updated sets whether sign-in is needed",
    before: stateWith({}),
    action: { type: "auth.updated", authRequired: true },
    after: (next) => {
      expect(next.scheduler.authRequired).toBe(true);
    },
  },
  {
    name: "scheduler.updated sets pause and the usage-limit resume time",
    before: stateWith({}),
    action: { type: "scheduler.updated", paused: true, resumeAt: at(30) },
    after: (next) => {
      expect(next.scheduler).toEqual({ paused: true, authRequired: false, resumeAt: at(30) });
    },
  },
  {
    name: "config.updated stores the config and follows the chat model",
    before: stateWith({}),
    action: { type: "config.updated", config: config("sonnet") },
    after: (next) => {
      expect(next.config).toEqual(config("sonnet"));
      expect(next.chat.model).toBe("sonnet");
    },
  },
  {
    name: "service.stopping marks mastermind stopped",
    before: stateWith({}),
    action: { type: "service.stopping" },
    after: (next) => {
      expect(next.connection).toBe("stopped");
    },
  },
  {
    name: "snapshot.loaded replaces the normalised state and keeps unchanged entities",
    before: stateWith({
      tasks: { gone: task("gone"), alpha: task("alpha"), beta: task("beta") },
      chat: { ...stateWith({}).chat, drafts: { t: "x" } },
    }),
    action: {
      type: "snapshot.loaded",
      snapshot: snapshot({
        summary: summary({ paused: true, activeSessions: [session(3)] }),
        tasks: [task("alpha"), task("beta", { status: "running", updatedAt: at(2) })],
        sessions: [session(1, { status: "succeeded" })],
        chat: { model: "opus", replying: true, messages: [message(1)] },
      }),
    },
    after: (next, before) => {
      expect(Object.keys(next.tasks)).toEqual(["alpha", "beta"]);
      expect(next.tasks.alpha).toBe(before.tasks.alpha);
      expect(next.tasks.beta?.status).toBe("running");
      expect(Object.keys(next.sessions)).toEqual(["1", "3"]);
      expect(next.scheduler.paused).toBe(true);
      expect(next.instance?.project).toBe("demo");
      expect(next.chat).toEqual({
        model: "opus",
        replying: true,
        messages: [message(1)],
        drafts: {},
      });
    },
  },
  {
    name: "flags.changed applies the flags an action returned",
    before: stateWith({}),
    action: {
      type: "flags.changed",
      flags: { paused: true, authRequired: false, backoffResumeAt: at(40) },
    },
    after: (next) => {
      expect(next.scheduler).toEqual({ paused: true, authRequired: false, resumeAt: at(40) });
    },
  },
  {
    name: "notification keeps the latest one for the browser to show",
    before: stateWith({}),
    action: {
      type: "notification",
      notification: {
        id: 9,
        title: "mastermind · demo",
        body: "alpha is blocked",
        reason: "blocked",
        taskId: "alpha",
      },
    },
    after: (next) => {
      expect(next.notification?.id).toBe(9);
    },
  },
  {
    name: "connection.changed records the connection",
    before: stateWith({}),
    action: { type: "connection.changed", connection: "reconnecting" },
    after: (next) => {
      expect(next.connection).toBe("reconnecting");
    },
  },
];

describe("store reducer", () => {
  it.each(cases)("$name", ({ before, action, after }) => {
    after(reduce(before, action), before);
  });

  it("has a case for every action kind", () => {
    const covered = new Set(cases.map(({ action }) => action.type));
    const kinds: StoreAction["type"][] = [
      ...busEventSchema.options.map((option) => option.shape.type.value),
      "snapshot.loaded",
      "session.history.loaded",
      "changes.loaded",
      "notes.loaded",
      "checks.loaded",
      "terminal.loaded",
      "connection.changed",
      "flags.changed",
    ];
    expect([...covered].sort()).toEqual([...kinds].sort());
  });
});
