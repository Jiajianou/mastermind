export class CliError extends Error {
  override readonly name = "CliError";
}

export class FakeSetupError extends Error {
  override readonly name = "FakeSetupError";
}

export class FakeExit extends Error {
  override readonly name = "FakeExit";

  constructor(readonly exitCode: number) {
    super(`fake-claude exits with code ${String(exitCode)}`);
  }
}
