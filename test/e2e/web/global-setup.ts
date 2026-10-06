import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtCliPath } from "../../support/cli.js";
import requireFakeClaude from "../../support/global-setup.js";

const builtWebApp = fileURLToPath(
  new URL("../../../packages/cli/dist/web/index.html", import.meta.url),
);

export default function setup(): void {
  requireFakeClaude();
  for (const path of [builtCliPath, builtWebApp]) {
    if (!existsSync(path))
      throw new Error(
        `The web tests run the built binary, but ${path} is missing. Run pnpm build first.`,
      );
  }
}
