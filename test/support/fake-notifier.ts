import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface NotifierCall {
  command: string;
  args: string[];
}

export interface FakeNotifier {
  calls(): Promise<NotifierCall[]>;
}

const nativeNotifierCommands = ["osascript", "notify-send"] as const;

// Stands in for the OS notifiers on PATH, so a test can see what would have been shown and nothing ever is.
export async function installFakeNotifier(
  binDir: string,
  { failWith }: { failWith?: string } = {},
): Promise<FakeNotifier> {
  const logPath = join(binDir, "notifications.log");
  const script = [
    "#!/bin/sh",
    `printf '%s\\t' "$(basename "$0")" "$@" >> '${logPath}'`,
    `printf '\\n' >> '${logPath}'`,
    ...(failWith === undefined ? [] : [`echo '${failWith}' >&2`, "exit 1"]),
    "",
  ].join("\n");
  for (const command of nativeNotifierCommands)
    await writeFile(join(binDir, command), script, { mode: 0o755 });

  return {
    async calls() {
      if (!existsSync(logPath)) return [];
      const lines = (await readFile(logPath, "utf8")).split("\n").filter((line) => line !== "");
      return lines.map((line) => {
        const [command = "", ...args] = line.split("\t").slice(0, -1);
        return { command, args };
      });
    },
  };
}
