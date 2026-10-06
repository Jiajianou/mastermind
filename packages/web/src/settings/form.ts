import { configLayerSchema } from "@mastermind/core/contracts";
import type { Config, ConfigLayer, WorkerPermissions } from "@mastermind/core/contracts";

export interface SettingsValues {
  conductorModel: string;
  workerModel: string;
  fixerModel: string;
  reviewerModel: string;
  judgeModel: string;
  reviewerEnabled: boolean;
  maxWorkers: string;
  workerPermissions: WorkerPermissions;
  workerAllowedTools: string;
  sandboxEnabled: boolean;
  allowedDomains: string;
  setupCommand: string;
  buildCommand: string;
  testCommand: string;
  requireReviewFor: string;
  desktopNotifications: boolean;
}

export type SettingsChange =
  { ok: true; change: ConfigLayer; empty: boolean } | { ok: false; message: string };

const lines = (items: readonly string[]): string => items.join("\n");

const listItems = (text: string): string[] =>
  text
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");

export function settingsValues(config: Config): SettingsValues {
  return {
    conductorModel: config.models.conductor,
    workerModel: config.models.worker,
    fixerModel: config.models.fixer,
    reviewerModel: config.models.reviewer,
    judgeModel: config.models.judge,
    reviewerEnabled: config.reviewer.enabled,
    maxWorkers: String(config.maxWorkers),
    workerPermissions: config.workerPermissions,
    workerAllowedTools: lines(config.workerAllowedTools),
    sandboxEnabled: config.sandbox.enabled,
    allowedDomains: lines(config.sandbox.allowedDomains),
    setupCommand: config.commands.setup,
    buildCommand: config.commands.build,
    testCommand: config.commands.test,
    requireReviewFor: lines(config.requireReviewFor),
    desktopNotifications: config.notifications.desktop,
  };
}

function settingsLayer(values: SettingsValues) {
  return {
    models: {
      conductor: values.conductorModel,
      worker: values.workerModel,
      fixer: values.fixerModel,
      reviewer: values.reviewerModel,
      judge: values.judgeModel,
    },
    reviewer: { enabled: values.reviewerEnabled },
    maxWorkers: values.maxWorkers === "auto" ? "auto" : Number(values.maxWorkers),
    workerPermissions: values.workerPermissions,
    workerAllowedTools: listItems(values.workerAllowedTools),
    sandbox: { enabled: values.sandboxEnabled, allowedDomains: listItems(values.allowedDomains) },
    commands: {
      setup: values.setupCommand.trim(),
      build: values.buildCommand.trim(),
      test: values.testCommand.trim(),
    },
    requireReviewFor: listItems(values.requireReviewFor),
    notifications: { desktop: values.desktopNotifications },
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function changedLeaves(before: unknown, after: unknown): unknown {
  if (!isRecord(before) || !isRecord(after))
    return JSON.stringify(before) === JSON.stringify(after) ? undefined : after;
  const changed = Object.entries(after).flatMap(([key, value]) => {
    const leaf = changedLeaves(before[key], value);
    return leaf === undefined ? [] : [[key, leaf] as const];
  });
  return changed.length === 0 ? undefined : Object.fromEntries(changed);
}

// The change holds only what the owner edited since the form opened, so a setting changed meanwhile from the
// chat is never written back with the value the form started from.
export function settingsChange(initial: SettingsValues, edited: SettingsValues): SettingsChange {
  const change = changedLeaves(settingsLayer(initial), settingsLayer(edited)) ?? {};
  const parsed = configLayerSchema.safeParse(change);
  if (!parsed.success)
    return {
      ok: false,
      message: parsed.error.issues
        .map(({ path, message }) => `${path.join(".")}: ${message}`)
        .join("; "),
    };
  return { ok: true, change: parsed.data, empty: Object.keys(parsed.data).length === 0 };
}
