export type StartupFailure =
  | "unsupported-platform"
  | "not-a-repo"
  | "already-running"
  | "claude-unavailable"
  | "account-refused"
  | "sign-in-failed"
  | "config-invalid"
  | "quit";

export class StartupError extends Error {
  override readonly name = "StartupError";

  constructor(
    readonly failure: StartupFailure,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
  }
}
