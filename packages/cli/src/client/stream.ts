import { streamMessageSchema, streamPath, streamProtocols } from "@mastermind/core/contracts";
import type { StreamMessage } from "@mastermind/core/contracts";
import WebSocket from "ws";
import { ClientError } from "./errors.js";
import type { Instance } from "./instance.js";

export interface EventStream {
  closed: Promise<void>;
  close(): void;
}

function decode(data: WebSocket.RawData): StreamMessage {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(new Uint8Array(data));
  let content: unknown;
  try {
    content = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ClientError("mastermind sent a stream message that is not JSON", { cause: error });
  }
  const parsed = streamMessageSchema.safeParse(content);
  if (!parsed.success)
    throw new ClientError("mastermind sent an unexpected stream message", { cause: parsed.error });
  return parsed.data;
}

export async function openStream(
  { origin, token }: Instance,
  onMessage: (message: StreamMessage) => void,
): Promise<EventStream> {
  const url = `${origin.replace(/^http/, "ws")}${streamPath}`;
  const socket = new WebSocket(url, streamProtocols(token), { perMessageDeflate: false });
  let failure: Error | null = null;

  const closed = new Promise<void>((resolve, reject) => {
    socket.once("close", () => {
      if (failure === null) resolve();
      else reject(failure);
    });
  });
  closed.catch(() => undefined);

  socket.on("message", (data) => {
    try {
      onMessage(decode(data));
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new ClientError("could not read a stream message", { cause: error });
      socket.terminate();
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", (error) => {
      reject(new ClientError(`could not open the event stream at ${url}`, { cause: error }));
    });
  });
  socket.on("error", (error) => {
    failure ??= error;
  });

  return {
    closed,
    close() {
      socket.close();
    },
  };
}
