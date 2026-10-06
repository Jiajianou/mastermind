import { basename } from "node:path";
import { test as base } from "@playwright/test";
import { runCleanups } from "../../support/cleanup.js";
import type { CliProcess } from "../../support/cli.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import { startMastermind } from "../../support/mastermind.js";
import { createTempRepo } from "../../support/temp-repo.js";

export interface ServedMastermind {
  process: CliProcess;
  project: string;
  link: string;
  origin: string;
  token: string;
}

const printedLink = /Web app → ((http:\/\/127\.0\.0\.1:\d+)\/#t=([0-9a-f]{64}))/;

export const test = base.extend<{ mastermind: ServedMastermind }>({
  mastermind: async ({ page }, use) => {
    try {
      const repo = await createTempRepo({ files: { "README.md": "# Demo\n" } });
      await repo.git("switch", "--quiet", "--create", "dev");
      const env = await isolatedEnv();
      const { mastermind } = await startMastermind(repo, env.env);
      const [, link, origin, token] = printedLink.exec(mastermind.output.stdout) ?? [];
      if (link === undefined || origin === undefined || token === undefined)
        throw new Error(`no web app link in:\n${mastermind.output.stdout}`);
      await page.goto(link);
      await use({ process: mastermind, project: basename(repo.path), link, origin, token });
    } finally {
      await runCleanups();
    }
  },
});

export { expect } from "@playwright/test";
