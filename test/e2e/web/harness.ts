import { basename } from "node:path";
import { test as base } from "@playwright/test";
import { runCleanups } from "../../support/cleanup.js";
import type { CliProcess } from "../../support/cli.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { Scenario } from "../../support/fake-claude.js";
import { startMastermind } from "../../support/mastermind.js";
import { createTempRepo } from "../../support/temp-repo.js";

export interface ServedMastermind {
  process: CliProcess;
  repoPath: string;
  git(...args: string[]): Promise<string>;
  project: string;
  link: string;
  origin: string;
  token: string;
}

const printedLink = /Web app → ((http:\/\/127\.0\.0\.1:\d+)\/#t=([0-9a-f]{64}))/;

export interface MastermindOptions {
  repoFiles: Record<string, string>;
  scenario: Scenario | null;
}

export const test = base.extend<MastermindOptions & { mastermind: ServedMastermind }>({
  repoFiles: [{ "README.md": "# Demo\n" }, { option: true }],
  scenario: [null, { option: true }],
  mastermind: async ({ page, repoFiles, scenario }, use, testInfo) => {
    try {
      const repo = await createTempRepo({ files: repoFiles });
      await repo.git("switch", "--quiet", "--create", "dev");
      const env = await isolatedEnv();
      if (scenario !== null) await env.writeScenario(scenario);
      const { mastermind } = await startMastermind(repo, env.env);
      const [, link, origin, token] = printedLink.exec(mastermind.output.stdout) ?? [];
      if (link === undefined || origin === undefined || token === undefined)
        throw new Error(`no web app link in:\n${mastermind.output.stdout}`);
      await page.goto(link);
      await use({
        process: mastermind,
        repoPath: repo.path,
        git: (...args) => repo.git(...args),
        project: basename(repo.path),
        link,
        origin,
        token,
      });
      if (testInfo.status !== testInfo.expectedStatus) {
        const { stdout, stderr } = mastermind.output;
        await testInfo.attach("mastermind output", { body: `${stdout}\n${stderr}` });
      }
    } finally {
      await runCleanups();
    }
  },
});

export { expect } from "@playwright/test";
