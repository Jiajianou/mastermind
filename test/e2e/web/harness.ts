import { basename } from "node:path";
import { test as base } from "@playwright/test";
import type { APIResponse } from "@playwright/test";
import type { z } from "zod";
import { runCleanups } from "../../support/cleanup.js";
import type { CliProcess } from "../../support/cli.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { Scenario } from "../../support/fake-claude.js";
import type { NotifierCall } from "../../support/fake-notifier.js";
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
  readApi<Schema extends z.ZodType>(path: string, schema: Schema): Promise<z.output<Schema>>;
  postApi(path: string, data: unknown): Promise<APIResponse>;
  nativeNotifications(): Promise<NotifierCall[]>;
}

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
      const { mastermind, webApp } = await startMastermind(repo, env.env);
      const { link, origin, token } = webApp;
      await page.goto(link);
      const authorized = { headers: { authorization: `Bearer ${token}` } };
      await use({
        process: mastermind,
        repoPath: repo.path,
        git: (...args) => repo.git(...args),
        project: basename(repo.path),
        link,
        origin,
        token,
        readApi: async (path, schema) => {
          const response = await page.request.get(`${origin}${path}`, authorized);
          return schema.parse(await response.json());
        },
        postApi: (path, data) => page.request.post(`${origin}${path}`, { ...authorized, data }),
        nativeNotifications: () => env.notifications(),
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
