import { apiRetryLine, rateLimitLine, resultLine, syntheticErrorLine } from "./lines.js";
import type { SessionContext } from "./lines.js";
import type { Output } from "./output.js";

export const notLoggedInText = "Not logged in · Please run /login";
export const invalidTokenText =
  "Failed to authenticate. API Error: 401 OAuth access token is invalid.";

function resetTime(resetsAt: number): string {
  const date = new Date(resetsAt * 1000);
  const hour = date.getUTCHours();
  return `${String(hour % 12 === 0 ? 12 : hour % 12)}${hour < 12 ? "am" : "pm"} (UTC)`;
}

export function usageLimitText(resetsAt: number): string {
  return `You've hit your limit · resets ${resetTime(resetsAt)}`;
}

export function defaultResetsAt(now: number): number {
  const hour = 3600;
  return Math.ceil(now / 1000 / hour) * hour + hour;
}

export function emitUsageLimit(
  output: Output,
  context: SessionContext,
  resetsAt: number,
  resultIndex: number,
): void {
  const text = usageLimitText(resetsAt);
  output.line(rateLimitLine(context, { status: "rejected", resetsAt, utilization: 1.02 }));
  output.line(syntheticErrorLine(context, text, "rate_limit"));
  const result = resultLine(
    context,
    { kind: "api_error", text, apiErrorStatus: 429 },
    resultIndex,
    380,
  );
  output.result(result, text);
}

export function emitAuthFailure(
  output: Output,
  context: SessionContext,
  variant: "invalid-token" | "not-logged-in",
  resultIndex: number,
): void {
  if (variant === "invalid-token") {
    output.line(apiRetryLine(context, 1, 401, "authentication_failed"));
    output.line(apiRetryLine(context, 2, 401, "authentication_failed"));
  }
  const text = variant === "invalid-token" ? invalidTokenText : notLoggedInText;
  output.line(syntheticErrorLine(context, text, "authentication_failed"));
  const apiErrorStatus = variant === "invalid-token" ? 401 : null;
  const durationMs = variant === "invalid-token" ? 1921 : 43;
  output.result(
    resultLine(context, { kind: "api_error", text, apiErrorStatus }, resultIndex, durationMs),
    text,
  );
}
