import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export async function makeTempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mastermind-unit-")));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
}
