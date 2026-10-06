import type { DatabaseSync, SQLInputValue, StatementResultingChanges } from "node:sqlite";
import { z } from "zod";
import type { Clock } from "../clock.js";
import { InvalidRowError } from "./errors.js";
import type { Transaction } from "./transaction.js";

export interface DbContext {
  database: DatabaseSync;
  clock: Clock;
  transaction: Transaction;
}

export type Columns = Record<string, SQLInputValue | undefined>;

const jsonTextSchema = z.string().transform((text, context): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: "custom", message: "expected JSON text" });
    return z.NEVER;
  }
});

export function jsonColumn<Schema extends z.ZodType>(schema: Schema) {
  return jsonTextSchema.pipe(schema);
}

export const booleanColumn = z
  .union([z.literal(0), z.literal(1)])
  .transform((value) => value === 1);

export function toJsonText(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function toBooleanColumn(value: boolean | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

export function timestamp(clock: Clock): string {
  return clock.now().toISOString();
}

export function readRow<Schema extends z.ZodType>(
  table: string,
  schema: Schema,
  row: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(row);
  if (!parsed.success) throw new InvalidRowError(table, parsed.error.issues);
  return parsed.data;
}

export function readRows<Schema extends z.ZodType>(
  table: string,
  schema: Schema,
  rows: readonly unknown[],
): z.output<Schema>[] {
  return rows.map((row) => readRow(table, schema, row));
}

function definedColumns(columns: Columns): Record<string, SQLInputValue> {
  const defined: Record<string, SQLInputValue> = {};
  for (const [name, value] of Object.entries(columns)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}

export function insertRow(database: DatabaseSync, table: string, columns: Columns): number {
  const values = definedColumns(columns);
  const names = Object.keys(values);
  const sql = `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((name) => `:${name}`).join(", ")})`;
  return Number(database.prepare(sql).run(values).lastInsertRowid);
}

export function updateRow(
  database: DatabaseSync,
  table: string,
  id: string | number,
  columns: Columns,
): boolean {
  const values = definedColumns(columns);
  const names = Object.keys(values);
  if (names.length === 0) {
    return database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }
  const assignments = names.map((name) => `${name} = :${name}`).join(", ");
  const sql = `UPDATE ${table} SET ${assignments} WHERE id = :id`;
  return changedRows(database.prepare(sql).run({ ...values, id })) > 0;
}

export function changedRows(result: StatementResultingChanges): number {
  return Number(result.changes);
}
