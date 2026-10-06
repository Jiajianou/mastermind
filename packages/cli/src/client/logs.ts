import { apiResponseSchemas } from "@mastermind/core/contracts";
import type { Session, SessionEvent, StreamMessage } from "@mastermind/core/contracts";
import { createApiClient } from "./api.js";
import type { ApiClient } from "./api.js";
import { ClientError } from "./errors.js";
import { sessionEndText, sessionEventText } from "./format.js";
import type { Instance } from "./instance.js";
import type { ClientOutput } from "./output.js";
import { openStream } from "./stream.js";

interface LogPrinter {
  remember(session: Session): void;
  event(event: SessionEvent): void;
  end(session: Session): void;
  take(message: StreamMessage): "service-stopped" | null;
}

function createLogPrinter(taskId: string, output: ClientOutput): LogPrinter {
  const sessions = new Map<number, Session>();
  const lastEventIds = new Map<number, number>();
  const endedIds = new Set<number>();

  const printer: LogPrinter = {
    remember(session) {
      sessions.set(session.id, session);
    },

    event(event) {
      if (event.id <= (lastEventIds.get(event.sessionId) ?? 0)) return;
      lastEventIds.set(event.sessionId, event.id);
      output.write(
        output.json
          ? `${JSON.stringify(event)}\n`
          : sessionEventText(sessions.get(event.sessionId), event),
      );
    },

    end(session) {
      printer.remember(session);
      const text = sessionEndText(session);
      if (text === null || endedIds.has(session.id)) return;
      endedIds.add(session.id);
      if (!output.json) output.write(text);
    },

    take(message) {
      switch (message.type) {
        case "session.started":
          if (message.taskId === taskId) printer.remember(message.session);
          return null;
        case "session.event":
          if (message.taskId === taskId) printer.event(message.event);
          return null;
        case "session.ended":
          if (message.taskId === taskId) printer.end(message.session);
          return null;
        case "service.stopping":
          return "service-stopped";
        default:
          return null;
      }
    },
  };
  return printer;
}

async function printHistory(
  api: ApiClient,
  taskId: string,
  printer: LogPrinter,
  output: ClientOutput,
): Promise<void> {
  await api.read(`/api/tasks/${encodeURIComponent(taskId)}`, apiResponseSchemas.task);
  const sessions = await api.read(
    `/api/sessions?taskId=${encodeURIComponent(taskId)}`,
    apiResponseSchemas.sessions,
  );
  if (sessions.length === 0 && !output.json) output.write(`No sessions yet for ${taskId}.\n`);
  for (const session of sessions) {
    printer.remember(session);
    const events = await api.read(
      `/api/sessions/${String(session.id)}/events`,
      apiResponseSchemas.sessionEvents,
    );
    for (const event of events) printer.event(event);
    printer.end(session);
  }
}

export async function runLogs(
  instance: Instance,
  taskId: string,
  follow: boolean,
  output: ClientOutput,
): Promise<number> {
  const api = createApiClient(instance);
  const printer = createLogPrinter(taskId, output);
  if (!follow) {
    await printHistory(api, taskId, printer, output);
    return 0;
  }

  let early: StreamMessage[] | null = [];
  let settle: () => void = () => undefined;
  const stopped = new Promise<"service-stopped">((resolve) => {
    settle = () => {
      resolve("service-stopped");
    };
  });
  const take = (message: StreamMessage): void => {
    if (printer.take(message) !== null) settle();
  };

  const stream = await openStream(instance, (message) => {
    if (early === null) take(message);
    else early.push(message);
  });
  try {
    await printHistory(api, taskId, printer, output);
    const buffered = early;
    early = null;
    for (const message of buffered) take(message);
    const end = await Promise.race([stopped, stream.closed.then(() => "disconnected" as const)]);
    if (end === "disconnected") throw new ClientError("lost the connection to mastermind");
    output.warn("mastermind stopped.");
    return 0;
  } finally {
    stream.close();
  }
}
