import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeTempDir, runCleanups } from "../../test/support/cleanup.js";
import requireFakeClaude from "../../test/support/global-setup.js";
import { isolatedEnv } from "../../test/support/isolated-env.js";
import { startMastermind } from "../../test/support/mastermind.js";
import { createTempRepo } from "../../test/support/temp-repo.js";
import { encodeGif, formatBytes } from "./gif.js";
import { embedDemo } from "./readme.js";
import { demoProject, demoRepoFiles, demoScenario } from "./scenario.js";
import { recordTour } from "./tour.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const gifPath = "assets/demo.gif";

async function requireFfmpeg(): Promise<void> {
  await promisify(execFile)("ffmpeg", ["-version"]).catch((error: unknown) => {
    throw new Error("ffmpeg is needed to encode the GIF (brew install ffmpeg).", { cause: error });
  });
}

async function build(): Promise<void> {
  const child = spawn("pnpm", ["build"], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  if (code !== 0) throw new Error(`pnpm build exited with ${String(code)}`);
}

async function record(): Promise<void> {
  requireFakeClaude();
  await requireFfmpeg();
  console.log("Building mastermind");
  await build();

  console.log(`Starting mastermind on a demo repo, ${demoProject}, with fake-claude`);
  const repo = await createTempRepo({ name: demoProject, files: demoRepoFiles });
  await repo.git("switch", "--quiet", "--create", "dev");
  const env = await isolatedEnv();
  await env.writeScenario(demoScenario);
  const { webApp } = await startMastermind(repo, env.env);

  console.log("Recording the tour");
  const workDir = await makeTempDir("demo");
  const frames = await recordTour(webApp.link, workDir);

  console.log(`Encoding ${String(frames.length)} frames`);
  const encoded = join(workDir, "demo.gif");
  const gif = await encodeGif(frames, workDir, encoded);
  const target = join(repoRoot, gifPath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(encoded, target);
  await embedDemo(join(repoRoot, "README.md"), gifPath);
  console.log(
    `Wrote ${gifPath}: ${formatBytes(gif.bytes)}, ${gif.seconds.toFixed(1)} s, ${String(gif.width)}px at ${String(gif.fps)} fps`,
  );
}

process.once("SIGINT", () => {
  runCleanups()
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => process.exit(130));
});

try {
  await record();
} finally {
  await runCleanups();
}
