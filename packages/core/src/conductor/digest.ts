import type { Clock } from "../clock.js";
import { taskStatusSchema } from "../contracts/index.js";
import type { Session, Summary } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { ActionDescriber } from "../proposals.js";
import { hourMinute, listWithin, truncate } from "./format.js";

export interface DigestInput {
  now: Date;
  summary: Summary;
  running: readonly Pick<Session, "taskId" | "role" | "attempt" | "startedAt">[];
  review: readonly string[];
  decisions: readonly string[];
}

export interface DigestSources {
  db: Db;
  clock: Clock;
  summary: () => Summary;
  describers: readonly ActionDescriber[];
}

const maxDecisionLength = 80;
const sessionsLength = 240;
const tasksLength = 140;
const decisionsLength = 160;

function minutesSince(startedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(startedAt)) / 60_000));
}

function countsLine({ counts }: Summary): string {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) return "Tasks: none yet.";
  const parts = taskStatusSchema.options.flatMap((status) => {
    const count = counts[status];
    return count > 0 ? [`${String(count)} ${status}`] : [];
  });
  return `Tasks (${String(total)}): ${parts.join(", ")}.`;
}

function runningLine(input: DigestInput): string {
  const { summary, running, now } = input;
  const workers = `Workers: ${String(summary.activeWorkers)} of ${String(summary.maxWorkers)} busy.`;
  if (running.length === 0) return workers;
  const sessions = running.map((session) => {
    const attempt = session.attempt === null ? "" : `, attempt ${String(session.attempt)}`;
    const label = session.taskId ?? session.role;
    return `${label} (${session.role}${attempt}, ${String(minutesSince(session.startedAt, now))}m)`;
  });
  return `${workers} Running: ${listWithin(sessions, sessionsLength)}.`;
}

function needsYouLine({ summary, review, decisions }: DigestInput): string {
  const parts = [
    review.length > 0 ? `waiting for review: ${listWithin(review, tasksLength)}` : null,
    summary.blocked.length > 0 ? `blocked: ${listWithin(summary.blocked, tasksLength)}` : null,
    decisions.length > 0
      ? `waiting for a decision: ${listWithin(
          decisions.map((question) => truncate(question, maxDecisionLength)),
          decisionsLength,
        )}`
      : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Needs the owner: nothing." : `Needs the owner: ${parts.join("; ")}.`;
}

function schedulerLine({ summary }: DigestInput): string {
  const states = [
    summary.authRequired ? "waiting for the owner to sign in to Claude again" : null,
    summary.paused ? "paused by the owner" : null,
    summary.resumeAt === null
      ? null
      : `waiting for the usage limit until ${hourMinute(new Date(summary.resumeAt))}`,
  ].filter((state) => state !== null);
  const upNext =
    summary.upNext.length === 0 ? "" : ` Up next: ${listWithin(summary.upNext, tasksLength)}.`;
  const state = states.length === 0 ? "running" : states.join("; ");
  return `Scheduler: ${state}.${upNext}`;
}

export function buildDigest(input: DigestInput): string {
  return [
    `State at ${hourMinute(input.now)}.`,
    countsLine(input.summary),
    runningLine(input),
    needsYouLine(input),
    schedulerLine(input),
  ].join("\n");
}

export function readDigestInput({ db, clock, summary, describers }: DigestSources): DigestInput {
  const decisionQuestion = (action: string, args: unknown): string => {
    const describer = describers.find((candidate) => candidate.action === action);
    return describer === undefined ? action : `${describer.describe(args)}?`;
  };
  return {
    now: clock.now(),
    summary: summary(),
    running: db.sessions.listRunning().filter((session) => session.role !== "conductor"),
    review: db.tasks
      .list()
      .filter((task) => task.status === "review")
      .map((task) => task.id),
    decisions: db.proposals
      .listPending()
      .map((proposal) => decisionQuestion(proposal.action, proposal.args)),
  };
}
