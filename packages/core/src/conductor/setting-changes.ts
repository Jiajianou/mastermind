import type { ConfigLayer } from "../contracts/index.js";
import { listWithin } from "./format.js";

type SettingValue = string | number | boolean | readonly string[];

function settingValue(value: SettingValue): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? "none" : value;
  return value.length === 0 ? "nothing" : value.join(", ");
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function settingChanges(change: object, prefix: string): string[] {
  return Object.entries(change).flatMap(([key, value]: [string, unknown]) => {
    const name = `${prefix}${key}`;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      isStringList(value)
    )
      return [`${name} to ${settingValue(value)}`];
    return typeof value === "object" && value !== null ? settingChanges(value, `${name}.`) : [];
  });
}

export const describeSettingChanges = (change: ConfigLayer): string =>
  listWithin(settingChanges(change, ""), 160);
