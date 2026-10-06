import {
  actionResultSchemas,
  actionRequest,
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
  Check,
  CheckLog,
  FileContent,
  FileSide,
  ReviewNotes,
  SessionEvent,
  TaskChanges,
  TaskTerminal,
  TaskTree,
  Terminal,
  TerminalSize,
  TerminalView,
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
  branch: apiResponseSchemas.branch,
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
  branch: { path: "/api/branch", schema: readSchemas.branch },
};

const resultSchemas: { [Name in ActionName]: z.ZodType<ActionResults[Name]> } = actionResultSchemas;

export type ReadQuery = Readonly<Record<string, string>>;

export type ActionArgs<Name extends ActionName> = undefined extends ActionInputs[Name]
  ? [input?: ActionInputs[Name]]
  : [input: ActionInputs[Name]];

export interface ApiClient {
  read<Name extends ReadName>(name: Name, query?: ReadQuery): Promise<ReadResults[Name]>;
  sessionEvents(sessionId: number): Promise<SessionEvent[]>;
  changes(taskId: string, since?: string): Promise<TaskChanges>;
  file(taskId: string, path: string, side: FileSide, since?: string): Promise<FileContent>;
  tree(taskId: string): Promise<TaskTree>;
  checks(taskId: string): Promise<Check[]>;
  notes(taskId: string): Promise<ReviewNotes>;
  checkLog(checkId: number): Promise<CheckLog>;
  taskTerminal(taskId: string): Promise<TaskTerminal>;
  openTerminal(taskId: string, size: TerminalSize): Promise<TerminalView>;
  terminalInput(terminalId: string, data: string): Promise<Terminal>;
  resizeTerminal(terminalId: string, size: TerminalSize): Promise<Terminal>;
  stopTerminal(terminalId: string): Promise<Terminal>;
  act<Name extends ActionName>(name: Name, ...args: ActionArgs<Name>): Promise<ActionResults[Name]>;
}

type RequestBody = Readonly<Record<string, unknown>>;

type TaskResource = "changes" | "file" | "tree" | "checks" | "notes" | "terminal";

function taskPath(taskId: string, resource: TaskResource): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/${resource}`;
}

type TerminalCommand = "input" | "resize" | "stop";

function terminalPath(terminalId: string, command: TerminalCommand): string {
  return `/api/terminals/${encodeURIComponent(terminalId)}/${command}`;
}

function failureMessage(method: string, path: string, status: number, body: ApiError | null) {
  return body?.message ?? `${method} ${path} failed with ${String(status)}`;
}

export function createApiClient(token: string | null): ApiClient {
  async function request<Result>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

    changes(taskId, since = "base") {
      const search = new URLSearchParams({ since }).toString();
      return request("GET", `${taskPath(taskId, "changes")}?${search}`, apiResponseSchemas.changes);
    },

    file(taskId, path, side, since = "base") {
      const search = new URLSearchParams({ path, side, since }).toString();
      return request("GET", `${taskPath(taskId, "file")}?${search}`, apiResponseSchemas.file);
    },

    tree(taskId) {
      return request("GET", taskPath(taskId, "tree"), apiResponseSchemas.tree);
    },

    checks(taskId) {
      return request("GET", taskPath(taskId, "checks"), apiResponseSchemas.checks);
    },

    notes(taskId) {
      return request("GET", taskPath(taskId, "notes"), apiResponseSchemas.notes);
    },

    checkLog(checkId) {
      const path = `/api/checks/${String(checkId)}/log`;
      return request("GET", path, apiResponseSchemas.checkLog);
    },

    taskTerminal(taskId) {
      return request("GET", taskPath(taskId, "terminal"), apiResponseSchemas.taskTerminal);
    },

    openTerminal(taskId, size) {
      return request("POST", taskPath(taskId, "terminal"), apiResponseSchemas.terminalView, size);
    },

    terminalInput(terminalId, data) {
      return request("POST", terminalPath(terminalId, "input"), apiResponseSchemas.terminal, {
        data,
      });
    },

    resizeTerminal(terminalId, size) {
      return request("POST", terminalPath(terminalId, "resize"), apiResponseSchemas.terminal, size);
    },

    stopTerminal(terminalId) {
      return request("POST", terminalPath(terminalId, "stop"), apiResponseSchemas.terminal);
    },

    act<Name extends ActionName>(name: Name, ...[input]: ActionArgs<Name>) {
      const { path, body } = actionRequest(name, input ?? {});
      return request(actionRoutes[name].method, path, resultSchemas[name], body);
    },
  };
}
