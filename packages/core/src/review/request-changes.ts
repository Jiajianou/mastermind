import { ActionError, defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { checkLogMaxBytes, readLogTail } from "../checks/log.js";
import { isMissingFileError } from "../errno.js";
import { buildChangeRequest, requestChangesInputSchema } from "../contracts/index.js";
import type { Check, FailingTest, Task } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { SessionManager } from "../sessions/manager.js";

interface Identified {
  id: number;
  taskId: string;
}

function selected<Note extends Identified>(
  notes: readonly Note[],
  ids: readonly number[],
  field: string,
  noun: string,
  taskId: string,
): Note[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const issues = ids.flatMap((id, index) =>
    byId.has(id)
      ? []
      : [{ path: `${field}[${String(index)}]`, message: `no ${noun} ${String(id)} on ${taskId}` }],
  );
  if (issues.length > 0) throw new ActionError("invalid_input", issues);
  return [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
}

function latestFailedCheck(db: Db, task: Task): Check {
  const failed = db.checks
    .listForTask(task.id)
    .filter((check) => check.round === task.round && check.status === "failed")
    .at(-1);
  if (failed === undefined)
    throw new ActionError("invalid_input", [
      {
        path: "includeFailingTest",
        message: `no check of ${task.id} failed in round ${String(task.round)}`,
      },
    ]);
  return failed;
}

// The same tail the check log read gives the web app, so the sent message matches the preview exactly.
async function failingTest(check: Check): Promise<FailingTest> {
  if (check.logPath === null) return { check, log: "" };
  try {
    return { check, log: (await readLogTail(check.logPath, { maxBytes: checkLogMaxBytes })).text };
  } catch (error) {
    if (isMissingFileError(error)) return { check, log: "" };
    throw error;
  }
}

export function requestChangesAction(rounds: Pick<SessionManager, "startRound">) {
  return defineAction({
    name: "requestChanges",
    description:
      "Send a task in review back for changes as a new round: one message built from the owner's instruction, the chosen comments and findings and, optionally, the failing check's log. mode resume continues the task's latest session in the same workspace; fresh starts a new worker that reads the task, a summary of the diff and the message. The round goes up by one and the checks run again when it ends. Returns the task, the new session and the round.",
    input: requestChangesInputSchema,
    emits: [],
    handler: async (input, { db }) => {
      const { taskId } = input;
      const task = db.tasks.get(taskId);
      if (task === null) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
      if (task.status !== "review")
        throw ActionError.fromMessage(
          "conflict",
          `only a task in review can be sent back for changes; ${taskId} is ${task.status}`,
        );
      const comments = selected(
        db.comments.listForTask(taskId),
        input.commentIds,
        "commentIds",
        "comment",
        taskId,
      );
      const findings = selected(
        db.findings.listForTask(taskId).filter(({ dismissed }) => !dismissed),
        input.findingIds,
        "findingIds",
        "open finding",
        taskId,
      );
      const failing = input.includeFailingTest ? latestFailedCheck(db, task) : null;
      const message = buildChangeRequest({
        instruction: input.instruction,
        comments,
        findings,
        failingTest: failing === null ? null : await failingTest(failing),
      });
      return rounds.startRound({
        taskId,
        mode: input.mode,
        message,
        sent: {
          instruction: input.instruction,
          commentIds: comments.map(({ id }) => id),
          findingIds: findings.map(({ id }) => id),
          failingCheckId: failing?.id ?? null,
        },
      });
    },
  }) satisfies ContractedActions<"requestChanges">["requestChanges"];
}
