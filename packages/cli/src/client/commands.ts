import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  actionResultSchemas,
  actionRoutes,
  apiResponseSchemas,
  errorMessage,
  isActionName,
  plural,
  taskSchema,
} from "@mastermind/core/contracts";
import type { ActionName } from "@mastermind/core/contracts";
import type { Command } from "commander";
import { z } from "zod";
import { createApiClient } from "./api.js";
import { runChat } from "./chat.js";
import { ClientError } from "./errors.js";
import { summaryText, taskStateText, tasksText } from "./format.js";
import { locateInstance } from "./instance.js";
import type { Instance } from "./instance.js";
import { runLogs } from "./logs.js";
import { processOutput } from "./output.js";
import type { ClientOutput } from "./output.js";

const clientOptionsSchema = z.object({
  json: z.boolean().default(false),
  repo: z.string(),
});

const logsOptionsSchema = clientOptionsSchema.extend({ follow: z.boolean().default(false) });

const argumentSchema = z.string();

const importResultSchema = z.object({ tasks: z.array(taskSchema), warnings: z.array(z.string()) });
const exportResultSchema = z.object({ yaml: z.string() });

const controlDescriptions: Partial<Record<string, string>> = {
  hold: "hold a task: the scheduler skips it until it is released",
  release: "release a held task",
  retry: "return a blocked task to the queue with a fresh set of attempts",
  discard: "discard a task's branch and clone and return it to pending",
  approve: "approve a task in review and rebase it onto main",
};

// A task control is an action routed as POST /api/tasks/:taskId/<its own name>, so the commands follow the routes.
const taskControls: ActionName[] = Object.entries(actionRoutes).flatMap(([name, route]) =>
  isActionName(name) && route.path === `/api/tasks/:taskId/${name}` ? [name] : [],
);

const schedulerControls = [
  ["pause", "stop starting new sessions; running ones carry on"],
  ["resume", "start new sessions again"],
] as const;

type ClientRun = (instance: Instance, output: ClientOutput) => Promise<number>;

async function runClient(json: boolean, repo: string, run: ClientRun): Promise<number> {
  const output = processOutput(json);
  try {
    return await run(await locateInstance(repo), output);
  } catch (error) {
    if (error instanceof ClientError) output.warn(error.message);
    else output.warn(`mastermind: ${errorMessage(error)}`);
    return 1;
  }
}

function clientCommand(program: Command, name: string, description: string): Command {
  return program
    .command(name)
    .description(description)
    .option("--json", "print JSON for scripts")
    .option("--repo <path>", "the repository whose running mastermind to talk to", ".");
}

async function readTasksFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ClientError(`cannot read ${path}`, { cause: error });
  }
}

async function writeTasksFile(path: string, yaml: string): Promise<void> {
  try {
    await writeFile(path, yaml);
  } catch (error) {
    throw new ClientError(`cannot write ${path}`, { cause: error });
  }
}

export function registerClientCommands(program: Command): void {
  clientCommand(program, "status", "show what the running mastermind is doing").action(
    async (options: unknown) => {
      const { json, repo } = clientOptionsSchema.parse(options);
      process.exitCode = await runClient(json, repo, async (instance, output) => {
        const summary = await createApiClient(instance).read(
          "/api/summary",
          apiResponseSchemas.summary,
        );
        if (output.json) output.writeJson(summary);
        else output.write(summaryText(summary, new Date()));
        return 0;
      });
    },
  );

  clientCommand(program, "tasks", "list the tasks").action(async (options: unknown) => {
    const { json, repo } = clientOptionsSchema.parse(options);
    process.exitCode = await runClient(json, repo, async (instance, output) => {
      const tasks = await createApiClient(instance).read("/api/tasks", apiResponseSchemas.tasks);
      if (output.json) output.writeJson(tasks);
      else output.write(tasksText(tasks));
      return 0;
    });
  });

  clientCommand(program, "logs", "show a task's session events (--json: one event per line)")
    .argument("<task>", "the task id")
    .option("-f, --follow", "keep printing new events as they happen")
    .action(async (task: unknown, options: unknown) => {
      const { json, repo, follow } = logsOptionsSchema.parse(options);
      process.exitCode = await runClient(json, repo, (instance, output) =>
        runLogs(instance, argumentSchema.parse(task), follow, output),
      );
    });

  clientCommand(program, "chat", "send a message to the Conductor and print its reply")
    .argument("<message>", "what to say")
    .action(async (message: unknown, options: unknown) => {
      const { json, repo } = clientOptionsSchema.parse(options);
      process.exitCode = await runClient(json, repo, (instance, output) =>
        runChat(instance, argumentSchema.parse(message), output),
      );
    });

  for (const action of taskControls) {
    clientCommand(program, action, controlDescriptions[action] ?? `${action} a task`)
      .argument("<task>", "the task id")
      .action(async (task: unknown, options: unknown) => {
        const { json, repo } = clientOptionsSchema.parse(options);
        const taskId = argumentSchema.parse(task);
        process.exitCode = await runClient(json, repo, async (instance, output) => {
          const updated = await createApiClient(instance).invoke(action, { taskId }, taskSchema);
          if (output.json) output.writeJson(updated);
          else output.write(`${action} ${taskId}: now ${taskStateText(updated)}\n`);
          return 0;
        });
      });
  }

  for (const [action, description] of schedulerControls) {
    clientCommand(program, action, description).action(async (options: unknown) => {
      const { json, repo } = clientOptionsSchema.parse(options);
      process.exitCode = await runClient(json, repo, async (instance, output) => {
        const flags = await createApiClient(instance).invoke(
          action,
          {},
          actionResultSchemas[action],
        );
        if (output.json) output.writeJson(flags);
        else output.write(flags.paused ? "Paused: no new sessions start.\n" : "Resumed.\n");
        return 0;
      });
    });
  }

  clientCommand(program, "import", "add the tasks of a tasks.yaml file")
    .argument("<file>", "the tasks.yaml to read")
    .action(async (file: unknown, options: unknown) => {
      const { json, repo } = clientOptionsSchema.parse(options);
      const path = argumentSchema.parse(file);
      process.exitCode = await runClient(json, repo, async (instance, output) => {
        const yaml = await readTasksFile(path);
        const result = await createApiClient(instance).invoke(
          "importTasks",
          { yaml },
          importResultSchema,
        );
        if (output.json) {
          output.writeJson(result);
          return 0;
        }
        for (const warning of result.warnings) output.warn(`warning: ${warning}`);
        const ids = result.tasks.map((imported) => imported.id).join(", ");
        output.write(`Imported ${plural(result.tasks.length, "task")}: ${ids}\n`);
        return 0;
      });
    });

  clientCommand(program, "export", "write every task to a tasks.yaml file (- for stdout)")
    .argument("<file>", "the tasks.yaml to write")
    .action(async (file: unknown, options: unknown) => {
      const { json, repo } = clientOptionsSchema.parse(options);
      const path = argumentSchema.parse(file);
      process.exitCode = await runClient(json, repo, async (instance, output) => {
        const { yaml } = await createApiClient(instance).invoke(
          "exportTasks",
          {},
          exportResultSchema,
        );
        if (path === "-") {
          if (output.json) output.writeJson({ yaml });
          else output.write(yaml);
          return 0;
        }
        await writeTasksFile(path, yaml);
        if (output.json) output.writeJson({ path: resolve(path) });
        else output.write(`Exported the tasks to ${path}\n`);
        return 0;
      });
    });
}
