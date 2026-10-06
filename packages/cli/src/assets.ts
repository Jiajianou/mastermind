import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The build copies prompts/ and the web app next to the bundle (tsup.config.ts), so an installed binary needs
// nothing else from the repo. Run from source, the repo's own folders are used.
function assetDir(bundled: string, inRepo: string): string {
  const copy = fileURLToPath(new URL(bundled, import.meta.url));
  return existsSync(copy) ? copy : fileURLToPath(new URL(inRepo, import.meta.url));
}

export const promptsDir = assetDir("./prompts/", "../../../prompts/");
export const webRoot = assetDir("./web/", "../../web/dist/");
