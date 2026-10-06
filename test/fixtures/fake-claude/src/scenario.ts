import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { FakeSetupError } from "./errors.js";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

const textMatchSchema = z.union([z.string(), z.object({ pattern: z.string() })]);
export type TextMatch = z.infer<typeof textMatchSchema>;

export function matchesText(match: TextMatch, text: string): boolean {
  return typeof match === "string" ? text.includes(match) : new RegExp(match.pattern).test(text);
}

export interface MessageBranch {
  when: TextMatch;
  steps: Step[];
}

export type Step =
  | { kind: "text"; text: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string }
  | {
      kind: "edit";
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean | undefined;
    }
  | { kind: "bash"; command: string; description?: string | undefined }
  | { kind: "commit"; message: string; trailer?: true | string | undefined }
  | { kind: "resultFile"; content: string }
  | { kind: "structuredOutput"; output: Record<string, JsonValue> }
  | {
      kind: "mcp";
      server?: string | undefined;
      tool: string;
      arguments?: Record<string, JsonValue> | undefined;
    }
  | { kind: "sleep"; ms: number }
  | { kind: "hang"; ignoreSigterm?: boolean | undefined }
  | { kind: "spawnGrandchild"; marker?: string | undefined; sameGroup?: boolean | undefined }
  | { kind: "awaitMessage"; branches: MessageBranch[]; otherwise?: Step[] | undefined }
  | { kind: "usageLimit"; resetsAt?: number | undefined }
  | {
      kind: "authExpired";
      variant?: "invalid-token" | "not-logged-in" | undefined;
      signOut?: boolean | undefined;
    }
  | { kind: "crash"; exitCode?: number | undefined; stderr?: string | undefined };

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), text: z.string() }),
    z.strictObject({ kind: z.literal("read"), path: z.string() }),
    z.strictObject({ kind: z.literal("write"), path: z.string(), content: z.string() }),
    z.strictObject({
      kind: z.literal("edit"),
      path: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal("bash"),
      command: z.string(),
      description: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal("commit"),
      message: z.string().min(1),
      trailer: z.union([z.literal(true), z.string()]).optional(),
    }),
    z.strictObject({ kind: z.literal("resultFile"), content: z.string() }),
    z.strictObject({
      kind: z.literal("structuredOutput"),
      output: z.record(z.string(), z.json()),
    }),
    z.strictObject({
      kind: z.literal("mcp"),
      server: z.string().optional(),
      tool: z.string(),
      arguments: z.record(z.string(), z.json()).optional(),
    }),
    z.strictObject({ kind: z.literal("sleep"), ms: z.number().int().nonnegative() }),
    z.strictObject({ kind: z.literal("hang"), ignoreSigterm: z.boolean().optional() }),
    z.strictObject({
      kind: z.literal("spawnGrandchild"),
      marker: z.string().optional(),
      sameGroup: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal("awaitMessage"),
      branches: z.array(z.strictObject({ when: textMatchSchema, steps: z.array(stepSchema) })),
      otherwise: z.array(stepSchema).optional(),
    }),
    z.strictObject({ kind: z.literal("usageLimit"), resetsAt: z.number().int().optional() }),
    z.strictObject({
      kind: z.literal("authExpired"),
      variant: z.enum(["invalid-token", "not-logged-in"]).optional(),
      signOut: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal("crash"),
      exitCode: z.number().int().min(1).max(255).optional(),
      stderr: z.string().optional(),
    }),
  ]),
);

const turnMatchSchema = z.strictObject({
  role: z.string().optional(),
  prompt: textMatchSchema.optional(),
  flags: z.array(z.string()).optional(),
});

const scenarioTurnSchema = z.strictObject({
  match: turnMatchSchema.optional(),
  steps: z.array(stepSchema),
});

export const scenarioSchema = z.strictObject({ turns: z.array(scenarioTurnSchema) });
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioTurn = z.infer<typeof scenarioTurnSchema>;

const defaultScenario: Scenario = { turns: [{ steps: [{ kind: "text", text: "Done." }] }] };

export function loadScenario(path: string | undefined): Scenario {
  if (path === undefined || !existsSync(path)) return defaultScenario;
  const parsed = scenarioSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw new FakeSetupError(`invalid scenario ${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface TurnRequest {
  prompt: string;
  role: string | undefined;
  argv: readonly string[];
}

export function selectTurn(scenario: Scenario, request: TurnRequest): ScenarioTurn | undefined {
  return scenario.turns.find(({ match }) => {
    if (match === undefined) return true;
    if (match.role !== undefined && match.role !== request.role) return false;
    if (match.prompt !== undefined && !matchesText(match.prompt, request.prompt)) return false;
    return (match.flags ?? []).every((flag) => request.argv.includes(flag));
  });
}
