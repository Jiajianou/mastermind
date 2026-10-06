import {
  actionResultSchemas,
  actionRoutes,
  apiErrorSchema,
  apiResponseSchemas,
  taskSchema,
} from "@mastermind/core/contracts";
import type {
  ActionInputs,
  ActionName,
  ActionResults,
  ApiError,
  SessionEvent,
} from "@mastermind/core/contracts";
import { z } from "zod";

export class UnauthorizedError extends Error {
  override readonly name = "UnauthorizedError";
}

export class UnreachableError extends Error {
  override readonly name = "UnreachableError";
}

export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";

  constructor(
    message: string,
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(message);
  }
}

// The store derives what each task unblocks from the tasks' deps, so the tasks read keeps only the task fields.
const readSchemas = {
  instance: apiResponseSchemas.instance,
  summary: apiResponseSchemas.summary,
  tasks: z.array(taskSchema),
  sessions: apiResponseSchemas.sessions,
  chat: apiResponseSchemas.chat,
  config: apiResponseSchemas.config,
};

export type ReadName = keyof typeof readSchemas;
export type ReadResults = { [Name in ReadName]: z.output<(typeof readSchemas)[Name]> };

const readRoutes: { [Name in ReadName]: { path: string; schema: z.ZodType<ReadResults[Name]> } } = {
  instance: { path: "/api/instance", schema: readSchemas.instance },
  summary: { path: "/api/summary", schema: readSchemas.summary },
  tasks: { path: "/api/tasks", schema: readSchemas.tasks },
  sessions: { path: "/api/sessions", schema: readSchemas.sessions },
  chat: { path: "/api/chat", schema: readSchemas.chat },
  config: { path: "/api/config", schema: readSchemas.config },
};

const resultSchemas: { [Name in ActionName]: z.ZodType<ActionResults[Name]> } = actionResultSchemas;

export type ReadQuery = Readonly<Record<string, string>>;

export type ActionArgs<Name extends ActionName> = undefined extends ActionInputs[Name]
  ? [input?: ActionInputs[Name]]
  : [input: ActionInputs[Name]];

export interface ApiClient {
  read<Name extends ReadName>(name: Name, query?: ReadQuery): Promise<ReadResults[Name]>;
  sessionEvents(sessionId: number): Promise<SessionEvent[]>;
  act<Name extends ActionName>(name: Name, ...args: ActionArgs<Name>): Promise<ActionResults[Name]>;
}

type RequestBody = Readonly<Record<string, unknown>>;

function routeAction(name: ActionName, input: object): { path: string; body: RequestBody } {
  const route = actionRoutes[name];
  const fields = new Map<string, unknown>(Object.entries(input));
  const params = new Set<string>();
  const path = route.path.replace(/:(\w+)/g, (_match, param: string) => {
    const value = fields.get(param);
    if (typeof value !== "string" && typeof value !== "number")
      throw new Error(`${name} needs ${param} for ${route.path}`);
    params.add(param);
    return encodeURIComponent(String(value));
  });
  const body = Object.fromEntries([...fields].filter(([field]) => !params.has(field)));
  return { path, body };
}

function failureMessage(method: string, path: string, status: number, body: ApiError | null) {
  return body?.message ?? `${method} ${path} failed with ${String(status)}`;
}

export function createApiClient(token: string | null): ApiClient {
  async function request<Result>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: z.ZodType<Result>,
    body?: RequestBody,
  ): Promise<Result> {
    if (token === null) throw new UnauthorizedError("this page has no access token");
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new UnreachableError(`could not reach mastermind for ${method} ${path}`, {
        cause: error,
      });
    }
    if (response.status === 401) throw new UnauthorizedError("mastermind refused the access token");
    const content: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsedError = apiErrorSchema.safeParse(content);
      const error = parsedError.success ? parsedError.data : null;
      throw new ApiRequestError(
        failureMessage(method, path, response.status, error),
        response.status,
        error,
      );
    }
    const parsed = schema.safeParse(content);
    if (!parsed.success)
      throw new ApiRequestError(
        `mastermind answered ${method} ${path} with an unexpected body`,
        response.status,
        null,
      );
    return parsed.data;
  }

  return {
    read<Name extends ReadName>(name: Name, query?: ReadQuery) {
      const { path, schema } = readRoutes[name];
      const search = query === undefined ? "" : `?${new URLSearchParams(query).toString()}`;
      return request("GET", `${path}${search}`, schema);
    },

    sessionEvents(sessionId) {
      const path = `/api/sessions/${String(sessionId)}/events`;
      return request("GET", path, apiResponseSchemas.sessionEvents);
    },

    act<Name extends ActionName>(name: Name, ...[input]: ActionArgs<Name>) {
      const { path, body } = routeAction(name, input ?? {});
      return request(actionRoutes[name].method, path, resultSchemas[name], body);
    },
  };
}
