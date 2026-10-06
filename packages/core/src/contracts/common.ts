import { z } from "zod";

export const isoTimestampSchema = z.iso.datetime();
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;
