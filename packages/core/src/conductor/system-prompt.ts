import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const conductorPromptFiles = ["conductor.md", "planner.md"];

export function conductorSystemPromptPath(stateDir: string): string {
  return join(stateDir, "run", "conductor.md");
}

// --append-system-prompt-file takes a single file, so the planning guide is joined to the chat prompt.
export async function writeConductorSystemPrompt(promptsDir: string, path: string): Promise<void> {
  const parts = await Promise.all(
    conductorPromptFiles.map((name) => readFile(join(promptsDir, name), "utf8")),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${parts.map((part) => part.trim()).join("\n\n")}\n`);
}
