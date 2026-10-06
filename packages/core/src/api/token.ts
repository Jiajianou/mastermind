import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tokenPath } from "../lock.js";

export function createToken(): string {
  return randomBytes(32).toString("hex");
}

export function writeTokenFile(stateDir: string, token: string): void {
  const path = tokenPath(stateDir);
  const temp = `${path}.${randomUUID()}.tmp`;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
