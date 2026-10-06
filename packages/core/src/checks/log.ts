import { open } from "node:fs/promises";

export const checkLogMaxBytes = 1024 * 1024;

export interface LogTail {
  text: string;
  truncated: boolean;
}

export interface TailLimits {
  maxBytes: number;
  maxLines?: number;
}

export async function readLogTail(path: string, limits: TailLimits): Promise<LogTail> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, limits.maxBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    let lines = buffer.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    let truncated = length < size;
    // A tail that starts mid-file starts mid-line too, so its first, partial line is dropped.
    if (truncated) lines = lines.slice(1);
    if (limits.maxLines !== undefined && lines.length > limits.maxLines) {
      lines = lines.slice(-limits.maxLines);
      truncated = true;
    }
    return { text: lines.join("\n"), truncated };
  } finally {
    await file.close();
  }
}
