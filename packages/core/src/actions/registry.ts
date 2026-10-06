import { z } from "zod";
import type {
  ActionName,
  ActionResults,
  BusEventOf,
  BusEventType,
  Config,
  ConfigLayer,
} from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import { ActionError } from "./errors.js";

export interface ConfigWriter {
  set(change: ConfigLayer): Promise<Config>;
}

export interface ActionContext {
  db: Db;
  bus: EventBus;
  config: ConfigWriter;
}

export interface ActionScope<Emits extends BusEventType> {
  db: Db;
  config: ConfigWriter;
  emit: (event: BusEventOf<Emits>) => void;
}

export interface ActionDefinition<Input extends z.ZodType, Output, Emits extends BusEventType> {
  name: string;
  description: string;
  input: Input;
  emits: readonly Emits[];
  handler(input: z.output<Input>, scope: ActionScope<Emits>): Output | Promise<Output>;
}

export type AnyActionDefinition = ActionDefinition<z.ZodType, unknown, BusEventType>;

export type ContractedActions<Names extends ActionName> = {
  [Name in Names]: {
    handler(...args: never[]): ActionResults[Name] | Promise<ActionResults[Name]>;
  };
};

export type ActionInfo = Pick<AnyActionDefinition, "name" | "description" | "input" | "emits">;

export interface ActionRegistry {
  register(definition: AnyActionDefinition): void;
  list(): ActionInfo[];
  invoke(name: string, input: unknown): Promise<unknown>;
  run<Input extends z.ZodType, Output>(
    definition: ActionDefinition<Input, Output, BusEventType>,
    input: z.input<Input>,
  ): Promise<Output>;
}

export function defineAction<Input extends z.ZodType, Output, Emits extends BusEventType>(
  definition: ActionDefinition<Input, Output, Emits>,
): ActionDefinition<Input, Output, Emits> {
  return definition;
}

export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) throw ActionError.invalidInput(result.error);
  return result.data;
}

export function createActionRegistry(
  context: ActionContext,
  definitions: readonly AnyActionDefinition[] = [],
): ActionRegistry {
  const actions = new Map<string, AnyActionDefinition>();
  const scope: ActionScope<BusEventType> = {
    db: context.db,
    config: context.config,
    emit: (event) => {
      context.bus.emit(event);
    },
  };

  async function run<Input extends z.ZodType, Output>(
    definition: ActionDefinition<Input, Output, BusEventType>,
    input: unknown,
  ): Promise<Output> {
    return definition.handler(parseInput(definition.input, input), scope);
  }

  const registry: ActionRegistry = {
    register(definition) {
      if (actions.has(definition.name)) {
        throw new Error(`action "${definition.name}" is already registered`);
      }
      actions.set(definition.name, definition);
    },

    list() {
      return [...actions.values()].map(({ name, description, input, emits }) => ({
        name,
        description,
        input,
        emits,
      }));
    },

    invoke(name, input) {
      const definition = actions.get(name);
      if (definition === undefined) {
        return Promise.reject(ActionError.fromMessage("not_found", `unknown action "${name}"`));
      }
      return run(definition, input);
    },

    run,
  };

  for (const definition of definitions) registry.register(definition);
  return registry;
}
