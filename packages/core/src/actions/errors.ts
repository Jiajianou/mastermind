import type { z } from "zod";
import { issuesFromZod } from "../config/errors.js";
import type { ActionErrorCode, ActionIssue, Task, TaskStatus } from "../contracts/index.js";
import type { Db } from "../db/index.js";

export class ActionError extends Error {
  override readonly name: string = "ActionError";

  constructor(
    readonly code: ActionErrorCode,
    readonly issues: readonly ActionIssue[],
  ) {
    super(issues.map(describeIssue).join("; "));
  }

  static invalidInput(error: z.ZodError): ActionError {
    return new ActionError(
      "invalid_input",
      issuesFromZod(error).map(({ key, message }) => ({ path: key, message })),
    );
  }

  static fromMessage(code: ActionErrorCode, message: string): ActionError {
    return new ActionError(code, [{ path: null, message }]);
  }
}

export class IllegalTransitionError extends ActionError {
  override readonly name = "IllegalTransitionError";

  constructor(
    readonly taskId: string,
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super("conflict", [
      { path: null, message: `task "${taskId}" cannot move from ${from} to ${to}` },
    ]);
  }
}

function describeIssue({ path, message }: ActionIssue): string {
  return path === null ? message : `${path}: ${message}`;
}

export function requireTask(db: Pick<Db, "tasks">, taskId: string): Task {
  const task = db.tasks.get(taskId);
  if (task === null) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
  return task;
}
