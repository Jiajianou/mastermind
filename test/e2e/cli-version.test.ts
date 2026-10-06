import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import cliPackage from "../../packages/cli/package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const binary = fileURLToPath(
  new URL(`../../packages/cli/${cliPackage.bin.mastermind}`, import.meta.url),
);

it("prints the package version for --version", async () => {
  const { stdout } = await execFileAsync(binary, ["--version"]);

  expect(stdout.trim()).toBe(cliPackage.version);
});
