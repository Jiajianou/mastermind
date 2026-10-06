import type { ExitOutcome } from "../contracts/index.js";
import type { EventDetails, ParsedEvent, RateLimit } from "./parser.js";
import { firstLine } from "./summary.js";

type ResultDetails = Extract<EventDetails, { line: "result" }>;

const authErrors = new Set(["authentication_failed", "oauth_org_not_allowed"]);
const usageLimitErrors = new Set(["rate_limit", "billing_error"]);
const authText =
  /not logged in|please run \/login|failed to authenticate|oauth (?:access )?token (?:has expired|has been revoked|is invalid)|invalid bearer token|login expired/i;
const usageLimitText =
  /usage limit|hit your (?:\w+ )?limit|weekly (?:usage )?limit|out of extra usage|spend limit/i;

function resultDetails(event: ParsedEvent | null): ResultDetails | null {
  return event?.details.line === "result" ? event.details : null;
}

function apiErrors(events: readonly ParsedEvent[]): string[] {
  return events.flatMap(({ details }) => (details.line === "api_error" ? [details.error] : []));
}

function rejectedRateLimits(events: readonly ParsedEvent[]): RateLimit[] {
  return events.flatMap(({ details }) =>
    details.line === "rate_limit" && details.rateLimit.status === "rejected"
      ? [details.rateLimit]
      : [],
  );
}

function failureReason(
  result: ResultDetails | null,
  exitCode: number | null,
  stderr: string,
): string {
  const resultPart =
    result === null
      ? "claude ended without a result"
      : result.isError
        ? (result.resultText ?? `claude ended: ${result.terminalReason ?? "error"}`)
        : null;
  const exitPart =
    exitCode === null
      ? "claude was killed by a signal"
      : exitCode === 0
        ? null
        : `claude exited with code ${String(exitCode)}`;
  return [resultPart, exitPart, firstLine(stderr) || null]
    .filter((part) => part !== null)
    .join("; ");
}

export function classifyExit(
  resultEvent: ParsedEvent | null,
  exitCode: number | null,
  stderr: string,
  events: readonly ParsedEvent[],
): ExitOutcome {
  const result = resultDetails(resultEvent);
  if (result !== null && !result.isError && exitCode === 0) return { status: "succeeded" };

  const errors = apiErrors(events);
  const errorText = [result?.isError === true ? result.resultText : null, stderr].join("\n");
  if (
    errors.some((error) => authErrors.has(error)) ||
    result?.apiErrorStatus === 401 ||
    authText.test(errorText)
  ) {
    return { status: "auth_failed", reason: failureReason(result, exitCode, stderr) };
  }

  const rejected = rejectedRateLimits(events);
  if (
    rejected.length > 0 ||
    errors.some((error) => usageLimitErrors.has(error)) ||
    result?.apiErrorStatus === 429 ||
    usageLimitText.test(errorText)
  ) {
    const resetAt = rejected.at(-1)?.resetsAt ?? null;
    return resetAt === null ? { status: "rate_limited" } : { status: "rate_limited", resetAt };
  }

  return { status: "failed", reason: failureReason(result, exitCode, stderr) };
}
