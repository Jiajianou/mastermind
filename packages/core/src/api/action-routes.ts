import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ActionRegistry } from "../actions/index.js";
import { actionRoutes, isActionName, isPlainRecord } from "../contracts/index.js";
import type { ActionRoute } from "../contracts/index.js";

const pathParamsSchema = z.record(z.string(), z.string());

function actionInput(route: ActionRoute, params: unknown, body: unknown): unknown {
  const intParams = new Set(route.intParams);
  const fields = Object.fromEntries(
    Object.entries(pathParamsSchema.parse(params)).map(([key, value]) => [
      key,
      intParams.has(key) && /^\d+$/.test(value) ? Number(value) : value,
    ]),
  );
  if (body === undefined) return fields;
  return isPlainRecord(body) ? { ...body, ...fields } : body;
}

export function registerActionRoutes(app: FastifyInstance, actions: ActionRegistry): void {
  for (const { name } of actions.list()) {
    if (!isActionName(name)) throw new Error(`action "${name}" has no HTTP route in actionRoutes`);
    const route: ActionRoute = actionRoutes[name];
    app.route({
      method: route.method,
      url: route.path,
      handler: (request) => actions.invoke(name, actionInput(route, request.params, request.body)),
    });
  }
}
