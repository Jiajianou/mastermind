import { defineConfig } from "vitest/config";
import type { TestProjectInlineConfiguration } from "vitest/config";

const liveProjects: TestProjectInlineConfiguration[] =
  process.env.MASTERMIND_LIVE === "1"
    ? [{ test: { name: "live", environment: "node", include: ["test/live/**/*.test.ts"] } }]
    : [];

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}"],
    },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/{core,cli}/src/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: "./packages/web/vite.config.ts",
        test: {
          name: "web",
          environment: "jsdom",
          include: ["packages/web/src/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["test/e2e/**/*.test.ts"],
        },
      },
      ...liveProjects,
    ],
  },
});
