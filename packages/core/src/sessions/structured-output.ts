import { z } from "zod";
import { jsonValueSchema } from "../contracts/index.js";
import type { JsonValue } from "../contracts/index.js";
import type { ParsedEvent } from "./parser.js";

export type StructuredOutputFailure = "no-result" | "error-result" | "missing" | "invalid";

export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";

  constructor(
    readonly reason: StructuredOutputFailure,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

export function readStructuredOutput<Schema extends z.ZodType>(
  resultEvent: ParsedEvent | null,
  schema: Schema,
): z.output<Schema> {
  const details = resultEvent?.details;
  if (details?.line !== "result") {
    throw new StructuredOutputError("no-result", "claude ended without a result");
  }
  if (details.isError) {
    const reason = details.resultText ?? details.terminalReason ?? "error";
    throw new StructuredOutputError("error-result", `claude reported an error: ${reason}`);
  }
  if (details.structuredOutput === undefined) {
    throw new StructuredOutputError("missing", "the result has no structured_output");
  }
  const parsed = schema.safeParse(details.structuredOutput);
  if (!parsed.success) {
    throw new StructuredOutputError("invalid", "structured_output does not match the schema", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

// The CLI validates --json-schema itself, so the zod-generated `$schema` dialect line is left out rather than risk
// a validator that only knows an older draft.
export function jsonSchemaFor(schema: z.ZodType): JsonValue {
  const generated = Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== "$schema");
  return jsonValueSchema.parse(Object.fromEntries(generated));
}
