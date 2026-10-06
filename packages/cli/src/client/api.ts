import { actionRequest, actionRoutes, apiErrorSchema } from "@mastermind/core/contracts";
import type { ActionName, ActionRoute, ApiError } from "@mastermind/core/contracts";
import type { z } from "zod";
import { ClientError } from "./errors.js";
import type { Instance } from "./instance.js";

export type ActionInput = Readonly<Record<string, string | number>>;

export interface ApiClient {
  read<Schema extends z.ZodType>(path: string, schema: Schema): Promise<z.output<Schema>>;
  invoke<Schema extends z.ZodType>(
    action: ActionName,
    input: ActionInput,
    schema: Schema,
  ): Promise<z.output<Schema>>;
}

function errorText({ message, issues }: ApiError): string {
  if (issues.length <= 1) return message;
  return issues
    .map(({ path, message: issue }) => (path === null ? issue : `${path}: ${issue}`))
    .join("\n");
}

export function createApiClient({ origin, token }: Instance): ApiClient {
  async function request<Schema extends z.ZodType>(
    method: "GET" | ActionRoute["method"],
    path: string,
    schema: Schema,
    body?: object,
  ): Promise<z.output<Schema>> {
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ClientError(`could not reach mastermind at ${origin}`, { cause: error });
    }
    const content: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = apiErrorSchema.safeParse(content);
      throw new ClientError(
        failure.success
          ? errorText(failure.data)
          : `${method} ${path} failed with ${String(response.status)}`,
      );
    }
    const parsed = schema.safeParse(content);
    if (!parsed.success)
      throw new ClientError(`mastermind answered ${method} ${path} with an unexpected body`, {
        cause: parsed.error,
      });
    return parsed.data;
  }

  return {
    read: (path, schema) => request("GET", path, schema),
    invoke(action, input, schema) {
      const { path, body } = actionRequest(action, input);
      return request(actionRoutes[action].method, path, schema, body);
    },
  };
}
