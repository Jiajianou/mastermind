import { join } from "node:path";
import { checkClaude, createClaudeCli, describeClaudeCheck } from "@mastermind/core/claude";
import { createProcessRegistry } from "@mastermind/core/procs";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../support/isolated-env.js";

describe("checkClaude", () => {
  it.each([
    { version: "2.1.283", status: "ok", level: "ok" },
    { version: "2.3.0", status: "ok", level: "warning" },
    { version: "2.0.77", status: "too-old", level: "error" },
    { version: "unknown build", status: "unreadable", level: "error" },
  ])("reports claude $version as $status ($level)", async ({ version, status, level }) => {
    const env = await isolatedEnv({ version });
    const cli = createClaudeCli({ registry: createProcessRegistry(), env: env.env });

    const check = await checkClaude(cli);

    expect(check).toMatchObject({ status, path: join(env.binDir, "claude") });
    expect(describeClaudeCheck(check).level).toBe(level);
  });

  it("reports claude as missing when it is not on PATH", async () => {
    const env = await isolatedEnv();
    const cli = createClaudeCli({
      registry: createProcessRegistry(),
      env: { ...env.env, PATH: "/usr/bin:/bin" },
    });

    const check = await checkClaude(cli);

    expect(check).toEqual({ status: "missing" });
    expect(describeClaudeCheck(check)).toMatchObject({
      level: "error",
      message: /not on your PATH/,
    });
  });
});
