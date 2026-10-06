import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fakeClaudeBinDir, fakeClaudePath } from "./fake-claude.js";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(command: string, path: string): string | undefined {
  return path
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, command))
    .find(isExecutable);
}

export default function setup(): void {
  process.env.PATH = [fakeClaudeBinDir, process.env.PATH ?? ""].join(delimiter);
  const resolved = resolveOnPath("claude", process.env.PATH);
  const expected = realpathSync(fakeClaudePath);
  if (resolved === undefined || realpathSync(resolved) !== expected) {
    throw new Error(
      `Refusing to run: \`claude\` resolves to ${resolved ?? "nothing"}, not fake-claude at ${expected}. ` +
        "Tests must never reach the real Claude CLI.",
    );
  }
}
