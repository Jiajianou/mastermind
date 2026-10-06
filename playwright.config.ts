import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e/web",
  testMatch: "**/*.spec.ts",
  forbidOnly: process.env.CI !== undefined,
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
