import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import { Document, isMap, parseDocument } from "yaml";
import { configLayerSchema, configSchema } from "../contracts/config.js";
import type { Config, ConfigLayer } from "../contracts/config.js";
import { defaultConfig } from "./defaults.js";
import { ConfigError, issuesFromZod } from "./errors.js";
import { readOptionalFile, writeFileAtomically } from "./files.js";
import { projectPaths } from "./paths.js";
import type { ConfigContext } from "./paths.js";

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYaml(text: string, fileLabel: string): Document {
  const document = parseDocument(text);
  const [syntaxError] = document.errors;
  if (syntaxError !== undefined) {
    throw new ConfigError(fileLabel, [{ key: null, message: syntaxError.message }]);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new ConfigError(fileLabel, [{ key: null, message: "expected a mapping of config keys" }]);
  }
  return document;
}

function validateLayer(input: unknown, fileLabel: string): ConfigLayer {
  const result = configLayerSchema.safeParse(input ?? {});
  if (!result.success) throw new ConfigError(fileLabel, issuesFromZod(result.error));
  return result.data;
}

async function readLayerFile(
  path: string,
  fileLabel: string,
): Promise<{ document: Document; layer: ConfigLayer }> {
  const document = parseYaml((await readOptionalFile(path)) ?? "", fileLabel);
  return { document, layer: validateLayer(document.toJS(), fileLabel) };
}

function mergeRecords(base: PlainRecord, override: PlainRecord): PlainRecord {
  const merged: PlainRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] =
      isPlainRecord(current) && isPlainRecord(value) ? mergeRecords(current, value) : value;
  }
  return merged;
}

function leafEntries(record: PlainRecord, prefix: readonly string[] = []): [string[], unknown][] {
  return Object.entries(record).flatMap(([key, value]): [string[], unknown][] =>
    isPlainRecord(value) ? leafEntries(value, [...prefix, key]) : [[[...prefix, key], value]],
  );
}

function labels({ repoRoot }: ConfigContext) {
  const paths = projectPaths(repoRoot);
  return {
    paths,
    shared: relative(repoRoot, paths.sharedConfig),
    local: relative(repoRoot, paths.localConfig),
  };
}

export async function readSharedLayer(context: ConfigContext): Promise<ConfigLayer> {
  const { paths, shared } = labels(context);
  return (await readLayerFile(paths.sharedConfig, shared)).layer;
}

export async function loadConfig(context: ConfigContext): Promise<Config> {
  const { paths, shared, local } = labels(context);
  const layers = [
    (await readLayerFile(paths.sharedConfig, shared)).layer,
    (await readLayerFile(paths.localConfig, local)).layer,
  ];
  const merged = layers.reduce<PlainRecord>(mergeRecords, defaultConfig(context));
  const result = configSchema.safeParse(merged);
  if (!result.success) throw new ConfigError("merged config", issuesFromZod(result.error));
  return result.data;
}

const pendingWrites = new Map<string, Promise<void>>();

// Settings and the Conductor can change config at the same time; each edit must
// read the file only after the previous one is written, or one change is lost.
function afterPendingWrites<T>(path: string, write: () => Promise<T>): Promise<T> {
  const result = (pendingWrites.get(path) ?? Promise.resolve()).then(write);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(path, settled);
  void settled.then(() => {
    if (pendingWrites.get(path) === settled) pendingWrites.delete(path);
  });
  return result;
}

export async function setConfig(context: ConfigContext, overrides: unknown): Promise<Config> {
  const { paths, local } = labels(context);
  const validOverrides = validateLayer(overrides, "config change");
  await afterPendingWrites(paths.localConfig, async () => {
    const { document } = await readLayerFile(paths.localConfig, local);
    document.contents ??= document.createNode({});
    for (const [path, value] of leafEntries(validOverrides)) {
      document.setIn(path, document.createNode(value));
    }
    validateLayer(document.toJS(), local);
    await mkdir(paths.stateDir, { recursive: true });
    await writeFileAtomically(paths.localConfig, document.toString());
  });
  return loadConfig(context);
}
