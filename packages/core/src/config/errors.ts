import type { z } from "zod";

export interface ConfigIssue {
  key: string | null;
  message: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(
    readonly file: string,
    readonly issues: readonly ConfigIssue[],
  ) {
    super(`${file}: ${issues.map(describeIssue).join("; ")}`);
  }
}

function describeIssue({ key, message }: ConfigIssue): string {
  return key === null ? message : `${key}: ${message}`;
}

function formatKey(path: readonly PropertyKey[]): string | null {
  let key = "";
  for (const segment of path) {
    if (typeof segment === "number") key += `[${String(segment)}]`;
    else key += key === "" ? String(segment) : `.${String(segment)}`;
  }
  return key === "" ? null : key;
}

export function issuesFromZod(error: z.ZodError): ConfigIssue[] {
  return error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => ({ key: formatKey([...issue.path, key]), message: "unknown key" }))
      : [{ key: formatKey(issue.path), message: issue.message }],
  );
}
