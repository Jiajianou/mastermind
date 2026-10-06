import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function locateOnPath(command: string, pathVariable: string): string | null {
  for (const dir of pathVariable.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
