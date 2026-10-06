import type { z } from "zod";
import type { ProposalStatus } from "../contracts/index.js";

export class SchemaVersionError extends Error {
  override readonly name = "SchemaVersionError";

  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `database schema version ${String(found)} is newer than this mastermind supports (${String(supported)})`,
    );
  }
}

export class InvalidRowError extends Error {
  override readonly name = "InvalidRowError";

  constructor(
    readonly table: string,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    super(`invalid row in ${table}: ${issues.map(describeIssue).join("; ")}`);
  }
}

export class RecordNotFoundError extends Error {
  override readonly name = "RecordNotFoundError";

  constructor(
    readonly table: string,
    readonly id: string | number,
  ) {
    super(`no row in ${table} with id ${String(id)}`);
  }
}

export class ProposalAlreadyDecidedError extends Error {
  override readonly name = "ProposalAlreadyDecidedError";

  constructor(
    readonly id: number,
    readonly status: ProposalStatus,
  ) {
    super(`proposal ${String(id)} is already ${status}`);
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const column = issue.path.map(String).join(".");
  return column === "" ? issue.message : `${column}: ${issue.message}`;
}
