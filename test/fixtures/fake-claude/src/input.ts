import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";
import { Interrupted } from "./interrupt.js";

const contentSchema = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
]);

const inputLineSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("user"),
    message: z.looseObject({ role: z.literal("user"), content: contentSchema }),
  }),
  z.looseObject({
    type: z.literal("control_request"),
    request_id: z.string(),
    request: z.looseObject({ subtype: z.string() }),
  }),
]);

export interface ControlRequest {
  requestId: string;
  subtype: string;
}

export interface MessageInput {
  nextMessage(signal: AbortSignal): Promise<string | undefined>;
  takeQueued(): string[];
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function messageText(content: z.infer<typeof contentSchema>): string {
  if (typeof content === "string") return content;
  return content.map((block) => block.text ?? "").join("");
}

export function readStreamInput(
  stdin: Readable,
  onControl: (request: ControlRequest) => void,
): MessageInput {
  const queued: string[] = [];
  const waiters: ((text: string | undefined) => void)[] = [];
  let closed = false;

  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  lines.on("line", (raw) => {
    if (raw.trim() === "") return;
    const parsed = inputLineSchema.safeParse(parseJson(raw));
    if (!parsed.success) {
      process.stderr.write(`fake-claude: ignoring unrecognised stdin line: ${raw}\n`);
      return;
    }
    const line = parsed.data;
    if (line.type === "control_request") {
      onControl({ requestId: line.request_id, subtype: line.request.subtype });
      return;
    }
    const text = messageText(line.message.content);
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(text);
    else waiter(text);
  });
  lines.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(undefined);
  });

  return {
    nextMessage(signal) {
      const ready = queued.shift();
      if (ready !== undefined || closed) return Promise.resolve(ready);
      if (signal.aborted) return Promise.reject(new Interrupted());
      return new Promise((resolve, reject) => {
        const waiter = (text: string | undefined): void => {
          signal.removeEventListener("abort", onAbort);
          resolve(text);
        };
        const onAbort = (): void => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Interrupted());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    takeQueued() {
      return queued.splice(0);
    },
  };
}

export async function readAll(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}
