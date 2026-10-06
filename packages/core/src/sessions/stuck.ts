import { z } from "zod";
import type { Session, SessionEvent, Task } from "../contracts/index.js";
import { createStreamParser } from "./parser.js";
import type { EventDetails } from "./parser.js";
import { taskBrief } from "./prompts.js";
import { displayPath, firstLine } from "./summary.js";

export const stuckVerdictSchema = z.strictObject({
  stuck: z.boolean(),
  reason: z.string(),
  suggestion: z.string(),
});
export type StuckJudgement = z.infer<typeof stuckVerdictSchema>;

export interface RepeatedFailure {
  command: string;
  failures: number;
}

export interface BackAndForthEdit {
  path: string;
  edits: number;
  undone: number;
}

export interface SilentCommand {
  command: string;
  minutes: number;
}

export interface StuckSignals {
  minutesRunning: number;
  minutesSinceEdit: number | null;
  minutesSinceCommit: number | null;
  minutesSinceOutput: number;
  repeatedFailures: RepeatedFailure[];
  backAndForthEdits: BackAndForthEdit[];
  silentCommand: SilentCommand | null;
}

export interface StuckSignalInput {
  startedAt: string;
  events: readonly SessionEvent[];
  now: Date;
}

export const stuckCheckLineType = "stuck_check";
export const repeatedFailureThreshold = 3;
export const silentCommandMinutes = 5;
export const judgedEventCount = 50;

const textEditSchema = z.object({ old_string: z.string(), new_string: z.string() });
const multiEditSchema = z.object({ edits: z.array(textEditSchema) });
type TextEdit = z.infer<typeof textEditSchema>;

type ToolUse = Extract<EventDetails, { line: "tool_use" }>;

function textEdits({ toolName, input }: ToolUse): TextEdit[] {
  if (toolName === "Edit") {
    const edit = textEditSchema.safeParse(input);
    return edit.success ? [edit.data] : [];
  }
  if (toolName === "MultiEdit") return multiEditSchema.safeParse(input).data?.edits ?? [];
  return [];
}

const minutesBetween = (from: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));

interface FileEdits {
  edits: number;
  undone: number;
  seen: Set<string>;
}

// An edit undoes an earlier one when it turns that edit's new text back into its old text.
function recordEdit(files: Map<string, FileEdits>, path: string, edits: readonly TextEdit[]) {
  const file = files.get(path) ?? { edits: 0, undone: 0, seen: new Set<string>() };
  file.edits += 1;
  for (const { old_string: before, new_string: after } of edits) {
    if (file.seen.has(`${after}\0${before}`)) file.undone += 1;
    file.seen.add(`${before}\0${after}`);
  }
  files.set(path, file);
}

function backAndForth(files: ReadonlyMap<string, FileEdits>): BackAndForthEdit[] {
  return [...files]
    .filter(([, file]) => file.undone > 0)
    .map(([path, { edits, undone }]) => ({ path, edits, undone }))
    .sort((a, b) => b.undone - a.undone || a.path.localeCompare(b.path));
}

function repeated(failures: ReadonlyMap<string, number>): RepeatedFailure[] {
  return [...failures]
    .filter(([, count]) => count >= repeatedFailureThreshold)
    .map(([command, count]) => ({ command, failures: count }))
    .sort((a, b) => b.failures - a.failures || a.command.localeCompare(b.command));
}

// Mastermind's own check notes and the owner's steering are stored with the session's events but are not its output.
const isSessionOutput = (event: SessionEvent, details: EventDetails): boolean =>
  event.type !== "steer" && !(details.line === "other" && details.lineType === stuckCheckLineType);

// Successful tool results are not stored, so a command is still running if nothing has been stored since it started.
function silentCommandOf(
  last: { event: SessionEvent; details: EventDetails } | null,
  now: Date,
): SilentCommand | null {
  if (last === null) return null;
  const { event, details } = last;
  if (details.line !== "tool_use" || details.toolName !== "Bash" || details.command === null)
    return null;
  const running = minutesBetween(event.ts, now);
  return running >= silentCommandMinutes
    ? { command: firstLine(details.command), minutes: running }
    : null;
}

export function stuckSignals({ startedAt, events, now }: StuckSignalInput): StuckSignals {
  const parser = createStreamParser();
  const failures = new Map<string, number>();
  const files = new Map<string, FileEdits>();
  let cwd: string | null = null;
  let lastEdit: string | null = null;
  let lastCommit: string | null = null;
  let last: { event: SessionEvent; details: EventDetails } | null = null;

  for (const event of events) {
    const { details } = parser.parseLine(event.payload);
    if (isSessionOutput(event, details)) last = { event, details };
    if (details.line === "init") cwd = details.cwd;
    if (event.type === "edit") lastEdit = event.ts;
    if (event.type === "commit") lastCommit = event.ts;
    if (details.line === "tool_use" && event.type === "edit" && details.filePath !== null)
      recordEdit(files, displayPath(details.filePath, cwd), textEdits(details));
    if (details.line === "tool_result" && details.isError && details.command !== null) {
      const command = firstLine(details.command);
      failures.set(command, (failures.get(command) ?? 0) + 1);
    }
  }

  const lastOutput = last?.event.ts ?? startedAt;
  return {
    minutesRunning: minutesBetween(startedAt, now),
    minutesSinceEdit: lastEdit === null ? null : minutesBetween(lastEdit, now),
    minutesSinceCommit: lastCommit === null ? null : minutesBetween(lastCommit, now),
    minutesSinceOutput: minutesBetween(lastOutput, now),
    repeatedFailures: repeated(failures),
    backAndForthEdits: backAndForth(files),
    silentCommand: silentCommandOf(last, now),
  };
}

const minutes = (count: number): string => `${String(count)} min`;
const sinceLine = (what: string, count: number | null): string =>
  `- Since the last ${what}: ${count === null ? "none yet" : minutes(count)}`;

function signalLines(signals: StuckSignals): string[] {
  const failing = signals.repeatedFailures.map(
    ({ command, failures }) => `  - \`${command}\` failed ${String(failures)} times`,
  );
  const edited = signals.backAndForthEdits.map(
    ({ path, edits, undone }) =>
      `  - ${path}: ${String(edits)} edits, ${String(undone)} of them undoing an earlier edit`,
  );
  const { silentCommand } = signals;
  return [
    sinceLine("edit", signals.minutesSinceEdit),
    sinceLine("commit", signals.minutesSinceCommit),
    sinceLine("output", signals.minutesSinceOutput),
    failing.length === 0
      ? "- No command failed again and again."
      : ["- Commands failing again and again:", ...failing].join("\n"),
    edited.length === 0
      ? "- No file was edited back and forth."
      : ["- Files edited back and forth:", ...edited].join("\n"),
    silentCommand === null
      ? "- No command is running long without output."
      : `- \`${silentCommand.command}\` has been running for ${minutes(silentCommand.minutes)} with no output.`,
  ];
}

export interface StuckJudgeMaterial {
  task: Task;
  session: Pick<Session, "role" | "startedAt">;
  signals: StuckSignals;
  events: readonly SessionEvent[];
}

export function stuckJudgePrompt({ task, session, signals, events }: StuckJudgeMaterial): string {
  const recent = events
    .slice(-judgedEventCount)
    .map(
      (event) =>
        `- +${minutes(minutesBetween(session.startedAt, new Date(event.ts)))} ${event.type}: ${event.summary}`,
    );
  return [
    `# Is this ${session.role} session stuck?`,
    `A Claude Code ${session.role} session has been working on task ${task.id} (${task.title}) for ${minutes(signals.minutesRunning)}. ` +
      "There is no time limit: a long session that keeps making progress is not stuck. " +
      "It is stuck if it is going round in circles: running the same failing command again and again, undoing its own edits, " +
      "waiting on something that will never finish, or no longer moving towards the goal.",
    ...taskBrief(task),
    "## Signals",
    ...signalLines(signals),
    `## The last ${String(recent.length)} events`,
    recent.length === 0 ? "(no events yet)" : recent.join("\n"),
    "## Answer",
    "Set stuck. Give a short reason, such as `looping on make test`. If it is stuck, give a suggestion: a different approach a fresh session should try; otherwise leave the suggestion empty.",
  ].join("\n\n");
}
