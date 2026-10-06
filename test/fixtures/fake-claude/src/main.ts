import { parseRawArgs, toPrintArgs } from "./args.js";
import type { RawArgs } from "./args.js";
import { authLogin, authLogout, authStatus } from "./auth.js";
import type { CommandResult } from "./auth.js";
import { readConfig } from "./config.js";
import type { FakeConfig } from "./config.js";
import { CliError, FakeExit, FakeSetupError } from "./errors.js";
import { loggedEnv, openLog } from "./log.js";
import { flushAndExit } from "./output.js";
import { runPrint } from "./print.js";
import { processGroupOf } from "./processes.js";
import { openState } from "./state.js";
import type { FakeState } from "./state.js";

function print(result: CommandResult): number {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

function runAuth(raw: RawArgs, config: FakeConfig, state: FakeState): number {
  const subcommand = raw.positionals[1];
  switch (subcommand) {
    case "status":
      return print(authStatus(state, process.env, raw.switches.has("--json")));
    case "login":
      return print(authLogin(state, config.loginAccount, config.loginFails));
    case "logout":
      return print(authLogout(state));
    default:
      throw new CliError(`error: unknown command 'auth ${subcommand ?? ""}'`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const config = readConfig(process.env);
  const log = openLog(config.logPath);
  const raw = parseRawArgs(argv);
  log.append({
    kind: "invocation",
    ppid: process.ppid,
    pgid: processGroupOf(process.pid),
    cwd: process.cwd(),
    argv: [...argv],
    unknownFlags: raw.unknownFlags,
    env: loggedEnv(process.env),
  });
  const state = openState(config.stateDir, config.initialAccount);

  if (raw.switches.has("--version")) {
    process.stdout.write(`${config.version} (Claude Code)\n`);
    return 0;
  }
  if (raw.positionals[0] === "auth") return runAuth(raw, config, state);
  if (raw.switches.has("--print")) return runPrint(toPrintArgs(argv, raw), config, state, log);
  throw new FakeSetupError("only --version, auth and -p are implemented");
}

function exitCodeFor(error: unknown): number {
  if (error instanceof FakeExit) return error.exitCode;
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (error instanceof FakeSetupError) {
    process.stderr.write(`fake-claude: ${error.message}\n`);
    return 2;
  }
  process.stderr.write(
    `fake-claude: unexpected failure: ${error instanceof Error ? (error.stack ?? "") : String(error)}\n`,
  );
  return 70;
}

process.stdout.on("error", () => {
  process.exit(1);
});

try {
  await flushAndExit(await main(process.argv.slice(2)));
} catch (error) {
  await flushAndExit(exitCodeFor(error));
}
