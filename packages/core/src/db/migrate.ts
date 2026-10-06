import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SchemaVersionError } from "./errors.js";
import { readRow } from "./rows.js";
import type { Transaction } from "./transaction.js";

const versionRowSchema = z.object({ version: z.int().min(0) });

export function migrate(
  database: DatabaseSync,
  transaction: Transaction,
  migrations: readonly string[],
): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  transaction(() => {
    const current = readVersion(database);
    if (current > migrations.length) throw new SchemaVersionError(current, migrations.length);
    if (current === migrations.length) return;
    for (const sql of migrations.slice(current)) database.exec(sql);
    writeVersion(database, migrations.length);
  });
}

function readVersion(database: DatabaseSync): number {
  const row = database.prepare("SELECT version FROM schema_version").get();
  return row === undefined ? 0 : readRow("schema_version", versionRowSchema, row).version;
}

function writeVersion(database: DatabaseSync, version: number): void {
  database.exec("DELETE FROM schema_version");
  database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
}
