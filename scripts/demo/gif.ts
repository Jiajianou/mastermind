import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Frame {
  file: string;
  seconds: number;
}

export interface EncodedGif {
  bytes: number;
  fps: number;
  width: number;
  seconds: number;
}

export const gifBudgetBytes = 5 * 1024 * 1024;

const finalFrameSeconds = 2.5;

const settings = [
  { fps: 10, width: 1000 },
  { fps: 8, width: 900 },
  { fps: 6, width: 800 },
  { fps: 5, width: 720 },
];

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function writeConcatList(frames: readonly Frame[], dir: string): Promise<string> {
  const last = frames.at(-1);
  if (last === undefined) throw new Error("No frames were captured.");
  const lines = frames.flatMap((frame, index) => {
    const next = frames[index + 1];
    const duration =
      next === undefined ? finalFrameSeconds : Math.max(next.seconds - frame.seconds, 0.01);
    return [`file '${frame.file}'`, `duration ${duration.toFixed(3)}`];
  });
  // ffmpeg's concat demuxer ignores the last duration unless the final file is listed once more.
  lines.push(`file '${last.file}'`);
  const listPath = join(dir, "frames.txt");
  await writeFile(listPath, `${lines.join("\n")}\n`);
  return listPath;
}

async function encode(listPath: string, output: string, fps: number, width: number): Promise<void> {
  const filter = [
    `fps=${String(fps)}`,
    `scale=${String(width)}:-1:flags=lanczos`,
    "split[a][b]",
    "[a]palettegen=max_colors=128:stats_mode=diff[p]",
    "[b][p]paletteuse=dither=none:diff_mode=rectangle",
  ].join(",");
  const args = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath];
  await execFileAsync("ffmpeg", [...args, "-vf", filter, output]).catch((error: unknown) => {
    throw new Error(`ffmpeg could not encode ${output}`, { cause: error });
  });
}

export async function encodeGif(
  frames: readonly Frame[],
  workDir: string,
  output: string,
): Promise<EncodedGif> {
  const listPath = await writeConcatList(frames, workDir);
  const seconds = (frames.at(-1)?.seconds ?? 0) + finalFrameSeconds;
  for (const { fps, width } of settings) {
    await encode(listPath, output, fps, width);
    const { size } = await stat(output);
    if (size <= gifBudgetBytes) return { bytes: size, fps, width, seconds };
    console.log(
      `  ${String(fps)} fps at ${String(width)}px is ${formatBytes(size)}; trying smaller`,
    );
  }
  throw new Error(`Every setting is over ${formatBytes(gifBudgetBytes)}. Shorten the tour.`);
}
