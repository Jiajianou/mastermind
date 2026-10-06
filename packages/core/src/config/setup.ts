import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { commandKindSchema } from "../contracts/config.js";
import type { ConfigLayer, ProjectDetection } from "../contracts/config.js";
import { detectedCommandsConfig, detectProject } from "./detect.js";
import { readOptionalFile } from "./files.js";
import { readSharedLayer, setConfig } from "./layers.js";
import { projectPaths } from "./paths.js";
import type { ConfigContext } from "./paths.js";
import { sandboxPreset } from "./presets.js";
import type { HostPlatform } from "./presets.js";

const gitExcludePatterns = ["/.mastermind/", "/.mastermind-result.md"] as const;

export class GitDirError extends Error {
  override readonly name = "GitDirError";
}

async function gitCommonDir(repoRoot: string): Promise<string> {
  const dotGit = join(repoRoot, ".git");
  if ((await stat(dotGit)).isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1];
  if (pointer === undefined)
    throw new GitDirError(`${dotGit} is neither a directory nor a "gitdir:" pointer`);
  const gitDir = resolve(repoRoot, pointer.trim());
  const commonDir = await readOptionalFile(join(gitDir, "commondir"));
  return commonDir === null ? gitDir : resolve(gitDir, commonDir.trim());
}

async function ensureExcluded(excludeFile: string, patterns: readonly string[]): Promise<void> {
  const current = (await readOptionalFile(excludeFile)) ?? "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = patterns.filter((pattern) => !present.has(pattern));
  if (missing.length === 0) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(excludeFile), { recursive: true });
  await writeFile(excludeFile, `${current}${separator}${missing.join("\n")}\n`);
}

function firstRunOverrides(
  detection: ProjectDetection,
  shared: ConfigLayer,
  platform: HostPlatform,
): ConfigLayer {
  const detected = detectedCommandsConfig(detection);
  const commands: NonNullable<ConfigLayer["commands"]> = {};
  for (const kind of commandKindSchema.options) {
    const command = detected[kind];
    if (command !== undefined && shared.commands?.[kind] === undefined) commands[kind] = command;
  }
  const preset = sandboxPreset(detection.toolchains, platform);
  const sandbox: NonNullable<ConfigLayer["sandbox"]> = {};
  if (preset.allowedDomains.length > 0 && shared.sandbox?.allowedDomains === undefined) {
    sandbox.allowedDomains = preset.allowedDomains;
  }
  if (preset.allowWrite.length > 0 && shared.sandbox?.allowWrite === undefined) {
    sandbox.allowWrite = preset.allowWrite;
  }
  return { commands, sandbox };
}

export interface ProjectSetupContext extends ConfigContext {
  platform: HostPlatform;
}

export type ProjectSetupResult =
  { firstRun: true; detection: ProjectDetection } | { firstRun: false };

export async function prepareProject(context: ProjectSetupContext): Promise<ProjectSetupResult> {
  const paths = projectPaths(context.repoRoot);
  await mkdir(paths.stateDir, { recursive: true });
  await ensureExcluded(
    join(await gitCommonDir(context.repoRoot), "info", "exclude"),
    gitExcludePatterns,
  );
  if ((await readOptionalFile(paths.localConfig)) !== null) return { firstRun: false };
  const detection = await detectProject(context.repoRoot);
  await setConfig(
    context,
    firstRunOverrides(detection, await readSharedLayer(context), context.platform),
  );
  return { firstRun: true, detection };
}
