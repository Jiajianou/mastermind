import { z } from "zod";
import { runtimeFlagsSchema } from "../contracts/index.js";
import type { RuntimeFlags } from "../contracts/index.js";
import { jsonColumn, readRow, readRows } from "./rows.js";
import type { DbContext } from "./rows.js";

export interface FlagRepository {
  get(): RuntimeFlags;
  set(flags: Partial<RuntimeFlags>): RuntimeFlags;
}

const defaultRuntimeFlags: RuntimeFlags = {
  paused: false,
  authRequired: false,
  backoffResumeAt: null,
};

const flagKeySchema = runtimeFlagsSchema.keyof();

const flagRowSchema = z.object({
  key: flagKeySchema,
  value: jsonColumn(z.unknown()),
});

const flagChangeSchema = runtimeFlagsSchema.partial().strict();

export function createFlagRepository({ database, transaction }: DbContext): FlagRepository {
  const selectFlags = database.prepare("SELECT key, value FROM runtime_flags");
  const upsertFlag = database.prepare(
    "INSERT INTO runtime_flags (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );

  function get(): RuntimeFlags {
    const rows = readRows("runtime_flags", flagRowSchema, selectFlags.all());
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return readRow("runtime_flags", runtimeFlagsSchema, { ...defaultRuntimeFlags, ...stored });
  }

  return {
    get,

    set(flags) {
      const change = flagChangeSchema.parse(flags);
      transaction(() => {
        for (const key of flagKeySchema.options) {
          const value = change[key];
          if (value !== undefined) upsertFlag.run(key, JSON.stringify(value));
        }
      });
      return get();
    },
  };
}
