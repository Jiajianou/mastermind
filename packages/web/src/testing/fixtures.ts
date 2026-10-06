import type {
  ApiSummary,
  ChatMessage,
  Check,
  Comment,
  Config,
  Finding,
  ReviewNotes,
  Session,
  SessionEvent,
  Task,
} from "@mastermind/core/contracts";
import { initialState } from "../store/state.js";
import type { LiveState, Snapshot } from "../store/state.js";

export const at = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 6, 9, minute)).toISOString();

export function task(id: string, change: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    goal: `Build ${id}.`,
    acceptance: "true",
    touches: [],
    deps: [],
    status: "pending",
    priority: 0,
    attempts: 0,
    round: 1,
    held: false,
    resumeSession: null,
    branch: null,
    worktree: null,
    baseCommit: null,
    createdAt: at(0),
    updatedAt: at(0),
    ...change,
  };
}

export function session(id: number, change: Partial<Session> = {}): Session {
  return {
    id,
    taskId: "alpha",
    role: "worker",
    round: 1,
    attempt: 1,
    claudeSessionId: null,
    pid: null,
    pgid: null,
    model: "opus",
    status: "running",
    endCommit: null,
    inputTokens: null,
    outputTokens: null,
    startedAt: at(1),
    endedAt: null,
    ...change,
  };
}

export function sessionEvent(id: number, sessionId = 1): SessionEvent {
  return {
    id,
    sessionId,
    ts: at(2),
    type: "edit",
    summary: `Edit file ${String(id)}`,
    payload: "{}",
  };
}

export function message(id: number, change: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    ts: at(3),
    kind: "user",
    content: `message ${String(id)}`,
    meta: null,
    conductorSession: null,
    turnId: null,
    ...change,
  };
}

export function check(id: number, change: Partial<Check> = {}): Check {
  return {
    id,
    taskId: "alpha",
    round: 1,
    kind: "build",
    status: "running",
    summary: null,
    logPath: null,
    durationMs: null,
    ...change,
  };
}

export function comment(id: number, change: Partial<Comment> = {}): Comment {
  return {
    id,
    taskId: "alpha",
    round: 1,
    file: "src/app.ts",
    lineStart: 2,
    lineEnd: 2,
    excerpt: "const a = 1;",
    text: `comment ${String(id)}`,
    ...change,
  };
}

export function finding(id: number, change: Partial<Finding> = {}): Finding {
  return {
    id,
    taskId: "alpha",
    round: 1,
    file: "src/app.ts",
    line: 3,
    text: `finding ${String(id)}`,
    severity: "minor",
    dismissed: false,
    ...change,
  };
}

export function notes(change: Partial<ReviewNotes> = {}): ReviewNotes {
  return { taskId: "alpha", round: 1, comments: [], findings: [], rounds: [], ...change };
}

export function summary(change: Partial<ApiSummary> = {}): ApiSummary {
  return {
    counts: {
      pending: 0,
      running: 0,
      checking: 0,
      review: 0,
      rebasing: 0,
      done: 0,
      blocked: 0,
    },
    activeWorkers: 0,
    maxWorkers: 2,
    upNext: [],
    blocked: [],
    paused: false,
    authRequired: false,
    resumeAt: null,
    activeSessions: [],
    rebaseQueue: [],
    ...change,
  };
}

export function snapshot(change: Partial<Snapshot> = {}): Snapshot {
  return {
    instance: { project: "demo", account: { email: "owner@example.com", plan: "max" } },
    summary: summary(),
    tasks: [],
    sessions: [],
    chat: { model: "opus", replying: false, messages: [] },
    config: config("opus"),
    ...change,
  };
}

export function stateWith(change: Partial<LiveState>): LiveState {
  return { ...initialState, connection: "live", ...change };
}

export function config(conductorModel: string): Config {
  return {
    mainBranch: "main",
    worktreeDir: "/tmp/worktrees",
    maxWorkers: "auto",
    maxAttempts: 3,
    models: {
      worker: "opus",
      fixer: "opus",
      reviewer: "sonnet",
      judge: "haiku",
      conductor: conductorModel,
    },
    commands: { setup: "", build: "", test: "" },
    autoRebase: true,
    requireReviewFor: [],
    workerPermissions: "bypass",
    workerAllowedTools: [],
    reviewer: { enabled: true },
    notifications: { desktop: true },
    stuckCheck: { after: "60m", every: "20m" },
    sandbox: { enabled: true, allowedDomains: [], allowWrite: [] },
    conductor: { confirm: [], wakeOnEvents: [] },
    port: 4700,
  };
}
