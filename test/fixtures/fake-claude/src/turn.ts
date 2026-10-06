import { effectiveAccount } from "./auth.js";
import { FakeExit, FakeSetupError } from "./errors.js";
import { emitAuthFailure } from "./failures.js";
import { Interrupted } from "./interrupt.js";
import { initLine, interruptedLine, resultLine } from "./lines.js";
import { selectTurn } from "./scenario.js";
import type { Scenario } from "./scenario.js";
import { receiveMessage, runSteps } from "./steps.js";
import type { TurnProgress, TurnRuntime } from "./steps.js";

export interface TurnOutcome {
  isError: boolean;
}

export async function runTurn(
  runtime: TurnRuntime,
  scenario: Scenario,
  prompt: string,
): Promise<TurnOutcome> {
  const { context, output, resultIndex } = runtime;
  const startedAt = Date.now();
  const elapsed = (): number => Math.max(Date.now() - startedAt, 1);

  output.line(initLine(context));
  receiveMessage(runtime, prompt);

  if (effectiveAccount(runtime.state.account(), process.env) === "signed-out") {
    emitAuthFailure(output, context, "not-logged-in", resultIndex);
    throw new FakeExit(1);
  }

  const turn = selectTurn(scenario, { prompt, role: runtime.args.role, argv: runtime.args.argv });
  if (turn === undefined)
    throw new FakeSetupError(`no scenario turn matches the prompt ${JSON.stringify(prompt)}`);

  const progress: TurnProgress = {
    numTurns: 1,
    rateLimitReported: false,
    lastText: "",
    structuredOutput: undefined,
  };
  try {
    await runSteps(runtime, turn.steps, progress);
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    output.line(interruptedLine(context));
    const interrupted = resultLine(
      context,
      { kind: "interrupted", numTurns: progress.numTurns },
      resultIndex,
      elapsed(),
    );
    output.result(interrupted, "");
    return { isError: true };
  }

  const success = resultLine(
    context,
    {
      kind: "success",
      text: progress.lastText,
      numTurns: progress.numTurns,
      structuredOutput: progress.structuredOutput,
    },
    resultIndex,
    elapsed(),
  );
  output.result(success, progress.lastText);
  return { isError: false };
}
