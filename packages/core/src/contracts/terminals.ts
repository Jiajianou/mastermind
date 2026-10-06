import { z } from "zod";
import { taskIdSchema } from "./tasks.js";

export const terminalScrollbackLimit = 200_000;

export const terminalStatusSchema = z.enum(["running", "exited"]);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const terminalSchema = z.strictObject({
  id: z.string(),
  taskId: taskIdSchema,
  cwd: z.string(),
  status: terminalStatusSchema,
});
export type Terminal = z.infer<typeof terminalSchema>;

export const terminalViewSchema = z.strictObject({
  terminal: terminalSchema,
  output: z.string(),
  received: z.int().min(0),
});
export type TerminalView = z.infer<typeof terminalViewSchema>;

export const taskTerminalSchema = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true), view: terminalViewSchema.nullable() }),
  z.strictObject({ available: z.literal(false), message: z.string() }),
]);
export type TaskTerminal = z.infer<typeof taskTerminalSchema>;

export const terminalSizeSchema = z.strictObject({
  cols: z.int().min(2).max(1_000),
  rows: z.int().min(2).max(500),
});
export type TerminalSize = z.infer<typeof terminalSizeSchema>;

export const terminalInputSchema = z.strictObject({ data: z.string().min(1).max(65_536) });
export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const terminalParamsSchema = z.strictObject({ terminalId: z.uuid() });
export const taskTerminalParamsSchema = z.strictObject({ taskId: taskIdSchema });
