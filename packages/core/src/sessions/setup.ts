import { runShellCheck } from "../checks/runner.js";
import type { CheckContext } from "../checks/runner.js";
import type { Check } from "../contracts/index.js";

export interface SetupCheckRequest extends CheckContext {
  taskId: string;
  round: number;
  command: string;
  cwd: string;
}

export function runSetupCheck(request: SetupCheckRequest): Promise<Check> {
  return runShellCheck(request, { ...request, kind: "setup" });
}
