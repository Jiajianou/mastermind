import { ActionError } from "../actions/index.js";
import { ConfigError } from "../config/index.js";
import type { ActionErrorCode, ApiError, ApiErrorCode } from "../contracts/index.js";

export interface ErrorReply {
  status: number;
  body: ApiError;
}

const actionStatuses: Record<ActionErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
};

const clientErrorCodes: Partial<Record<number, ApiErrorCode>> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
};

export const apiError = (code: ApiErrorCode, message: string): ApiError => ({
  code,
  message,
  issues: [],
});

function clientStatus(error: unknown): number | null {
  if (!(error instanceof Error) || !("statusCode" in error)) return null;
  const { statusCode } = error;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
    ? statusCode
    : null;
}

export function errorReply(error: unknown): ErrorReply | null {
  if (error instanceof ActionError) {
    const { code, message, issues } = error;
    return { status: actionStatuses[code], body: { code, message, issues: [...issues] } };
  }
  if (error instanceof ConfigError) {
    const issues = error.issues.map(({ key, message }) => ({ path: key, message }));
    return { status: 400, body: { code: "invalid_input", message: error.message, issues } };
  }
  const status = clientStatus(error);
  if (status === null || !(error instanceof Error)) return null;
  return { status, body: apiError(clientErrorCodes[status] ?? "invalid_input", error.message) };
}
