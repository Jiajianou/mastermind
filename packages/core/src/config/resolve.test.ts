import { describe, expect, it } from "vitest";
import { parseDuration } from "../contracts/config.js";
import { defaultConfig } from "./defaults.js";
import { resolveConfig } from "./resolve.js";

const context = { repoRoot: "/code/myos", homeDir: "/home/owner" };

describe("resolveConfig", () => {
  it.each([
    { maxWorkers: "auto", plan: "pro", expected: 1 },
    { maxWorkers: "auto", plan: "max", expected: 2 },
    { maxWorkers: 4, plan: "pro", expected: 4 },
  ] as const)(
    "resolves maxWorkers $maxWorkers on $plan to $expected",
    ({ maxWorkers, plan, expected }) => {
      const resolved = resolveConfig(
        { ...defaultConfig(context), maxWorkers },
        { ...context, plan },
      );

      expect(resolved.maxWorkers).toBe(expected);
    },
  );

  it("defaults worktreeDir to a central folder named after the repo and a hash of its path", () => {
    const first = defaultConfig(context).worktreeDir;
    const sameName = defaultConfig({ ...context, repoRoot: "/elsewhere/myos" }).worktreeDir;

    expect(first).toMatch(/^\/home\/owner\/\.mastermind\/worktrees\/myos-[0-9a-f]{6}$/);
    expect(sameName).toMatch(/\/myos-[0-9a-f]{6}$/);
    expect(sameName).not.toBe(first);
  });

  it("parses durations and expands home-relative paths", () => {
    const config = {
      ...defaultConfig(context),
      worktreeDir: "~/trees",
      stuckCheck: { after: "1h30m", every: "20m" },
      sandbox: {
        enabled: true,
        allowedDomains: [],
        allowWrite: ["~/.npm", "/opt/cache", "build/tmp"],
      },
    };

    const resolved = resolveConfig(config, { ...context, plan: "max" });

    expect(resolved.worktreeDir).toBe("/home/owner/trees");
    expect(resolved.stuckCheck).toEqual({ afterMs: 5_400_000, everyMs: 1_200_000 });
    expect(resolved.sandbox.allowWrite).toEqual([
      "/home/owner/.npm",
      "/opt/cache",
      "/code/myos/build/tmp",
    ]);
  });
});

describe("parseDuration", () => {
  it.each([
    ["60m", 3_600_000],
    ["90s", 90_000],
    ["1h30m", 5_400_000],
    ["2d", 172_800_000],
    ["250ms", 250],
    ["0m", null],
    ["60", null],
    ["10 m", null],
    ["soon", null],
    ["", null],
  ])("parses %j as %j", (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });
});
