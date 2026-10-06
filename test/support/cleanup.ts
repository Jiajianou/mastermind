import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cleanup = () => void | Promise<void>;

const pending: Cleanup[] = [];

export function onCleanup(cleanup: Cleanup): void {
  pending.push(cleanup);
}

export async function runCleanups(): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of pending.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `mastermind-${prefix}-`)));
  onCleanup(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
