import { execFileSync, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const processKindSchema = z.enum([
  "session",
  "check",
  "rebase",
  "conductor",
  "terminal",
  "utility",
]);
export type ProcessKind = z.infer<typeof processKindSchema>;

export type ExitResult =
  { kind: "exited"; code: number } | { kind: "signaled"; signal: NodeJS.Signals };

export interface ProcessGroup {
  pid: number;
  pgid: number;
}

export interface TrackedGroup extends ProcessGroup {
  kind: ProcessKind;
}

export interface LiveProcess extends ProcessGroup {
  command: string;
}

export type LineHandler = (line: string) => void;

export type BytesHandler = (chunk: Buffer) => void;

export type PipedIo = {
  stdin: "pipe" | "ignore";
  onStderrLine?: LineHandler;
} & (
  | { onStdoutLine?: LineHandler; onStdoutBytes?: never }
  | { onStdoutBytes: BytesHandler; onStdoutLine?: never }
);

export interface SpawnRequest {
  kind: ProcessKind;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  io: PipedIo | "inherit";
}

export interface ChildHandle extends TrackedGroup {
  stdin: Writable | null;
  exited: Promise<ExitResult>;
}

export interface CompletedRun {
  exit: ExitResult;
  stdout: string;
  stderr: string;
}

export interface KillFailure {
  target: number | "process-table";
  error: unknown;
}

export interface KillReport {
  counts: Record<ProcessKind, number>;
  failures: KillFailure[];
}

export interface ProcessRegistry {
  spawn(request: SpawnRequest): Promise<ChildHandle>;
  track(group: TrackedGroup): () => void;
  tracked(): TrackedGroup[];
  killAllSync(): KillReport;
}

export class SpawnError extends Error {
  override readonly name = "SpawnError";

  constructor(
    readonly command: string,
    cause: unknown,
  ) {
    super(`could not start ${command}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

export class ProcessKillError extends AggregateError {
  override readonly name = "ProcessKillError";

  constructor(readonly failures: readonly KillFailure[]) {
    super(
      failures.map(({ error }) => error),
      `could not signal ${failures.map(({ target }) => String(target)).join(", ")}`,
    );
  }
}

export function createProcessRegistry(): ProcessRegistry {
  const groups = new Map<number, TrackedGroup>();

  const track = (group: TrackedGroup): (() => void) => {
    groups.set(group.pid, group);
    return () => {
      if (groups.get(group.pid) === group) groups.delete(group.pid);
    };
  };

  return {
    async spawn(request) {
      const piped = request.io === "inherit" ? null : request.io;
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        stdio:
          piped === null
            ? "inherit"
            : [
                piped.stdin,
                piped.onStdoutLine === undefined && piped.onStdoutBytes === undefined
                  ? "ignore"
                  : "pipe",
                piped.onStderrLine === undefined ? "ignore" : "pipe",
              ],
      });
      const started = new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error) => {
          reject(new SpawnError(request.command, error));
        });
      });
      const pid = child.pid;
      const untrack = pid === undefined ? null : track({ kind: request.kind, pid, pgid: pid });
      if (piped?.onStdoutLine !== undefined && child.stdout !== null)
        readLines(child.stdout, piped.onStdoutLine);
      const onStdoutBytes = piped?.onStdoutBytes;
      if (onStdoutBytes !== undefined && child.stdout !== null)
        child.stdout.on("data", (chunk: Buffer) => {
          onStdoutBytes(chunk);
        });
      if (piped?.onStderrLine !== undefined && child.stderr !== null)
        readLines(child.stderr, piped.onStderrLine);
      const exited = new Promise<ExitResult>((resolve) => {
        child.once("close", (code, signal) => {
          untrack?.();
          resolve(
            signal === null ? { kind: "exited", code: code ?? 0 } : { kind: "signaled", signal },
          );
        });
      });

      await started;
      if (pid === undefined)
        throw new SpawnError(request.command, new Error("no pid was assigned"));
      return { kind: request.kind, pid, pgid: pid, stdin: child.stdin, exited };
    },

    track,

    tracked: () => [...groups.values()],

    killAllSync() {
      const targets = [...groups.values()];
      groups.clear();
      const counts: Record<ProcessKind, number> = {
        session: 0,
        check: 0,
        rebase: 0,
        conductor: 0,
        terminal: 0,
        utility: 0,
      };
      for (const group of targets) counts[group.kind] += 1;
      return { counts, failures: killTreesSync(targets) };
    },
  };
}

export async function collectOutput(
  registry: ProcessRegistry,
  request: Omit<SpawnRequest, "io">,
): Promise<CompletedRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = await registry.spawn({
    ...request,
    io: {
      stdin: "ignore",
      onStdoutLine: (line) => stdout.push(line),
      onStderrLine: (line) => stderr.push(line),
    },
  });
  return { exit: await child.exited, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

export async function stopGroup(
  child: ChildHandle,
  options: { graceMs?: number } = {},
): Promise<ExitResult> {
  const sigtermFailure = signal(-child.pgid, "SIGTERM");
  if (sigtermFailure !== null) throw new ProcessKillError([sigtermFailure]);
  const grace = new AbortController();
  const exitedInTime = await Promise.race([
    child.exited,
    delay(options.graceMs ?? 10_000, null, { signal: grace.signal }),
  ]);
  grace.abort();
  if (exitedInTime !== null) return exitedInTime;
  const failures = killTreesSync([child]);
  if (failures.length > 0) throw new ProcessKillError(failures);
  return child.exited;
}

export function readLiveProcess(pid: number): LiveProcess | null {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-ww", "-o", "pgid=,stat=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) return null;
    throw error;
  }
  const match = /^\s*(\d+)\s+(\S+)\s(.*)$/.exec(output.trim());
  if (match === null) return null;
  const [, pgid, stat, command] = match;
  if (stat?.startsWith("Z") === true) return null;
  return { pid, pgid: Number(pgid), command: command ?? "" };
}

function readLines(stream: Readable, onLine: LineHandler): void {
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    if (partial !== "") onLine(partial);
  });
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  zombie: boolean;
}

function readProcessTable(): ProcessRow[] {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) return [];
    const [, pid, ppid, pgid, stat] = match;
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        zombie: stat?.startsWith("Z") === true,
      },
    ];
  });
}

const hasLiveMember = (table: readonly ProcessRow[], pgid: number): boolean =>
  table.some((row) => row.pgid === pgid && !row.zombie);

interface Tree {
  pids: Set<number>;
  pgids: Set<number>;
}

function growTree(table: readonly ProcessRow[], tree: Tree, ownGroup: number): ProcessRow[] {
  const members = new Map<number, ProcessRow>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (row.pid === process.pid || members.has(row.pid)) continue;
      if (tree.pids.has(row.pid) || tree.pids.has(row.ppid) || tree.pgids.has(row.pgid)) {
        members.set(row.pid, row);
        tree.pids.add(row.pid);
        if (row.pgid !== ownGroup) tree.pgids.add(row.pgid);
        grew = true;
      }
    }
  }
  return [...members.values()];
}

// Claude Code runs each Bash tool command in a process group of its own, so killing a session's group alone
// would orphan `make` and everything under it. One `ps` snapshot finds every descendant group; the second pass
// catches anything forked while the first pass was killing. If `ps` itself fails, the tracked groups are still
// killed directly so the Ctrl+C path always finishes.
export function killTreesSync(roots: readonly ProcessGroup[]): KillFailure[] {
  const failures = new Map<KillFailure["target"], KillFailure>();
  const record = (failure: KillFailure | null) => {
    if (failure !== null) failures.set(failure.target, failure);
  };
  const snapshot = (): ProcessRow[] | null => {
    try {
      return readProcessTable();
    } catch (error) {
      record({ target: "process-table", error });
      return null;
    }
  };

  const firstTable = snapshot();
  if (firstTable === null) {
    for (const root of roots) record(signal(-root.pgid, "SIGKILL"));
    return [...failures.values()];
  }
  const ownGroup = firstTable.find((row) => row.pid === process.pid)?.pgid ?? process.pid;
  const tree: Tree = {
    pids: new Set(roots.map((root) => root.pid)),
    pgids: new Set(roots.map((root) => root.pgid).filter((pgid) => pgid !== ownGroup)),
  };
  for (const pass of ["first", "second"] as const) {
    const table = pass === "first" ? firstTable : snapshot();
    if (table === null) break;
    const members = growTree(table, tree, ownGroup);
    const liveGroups = [...tree.pgids].filter((pgid) => hasLiveMember(table, pgid));
    const targets = new Set(liveGroups.map((pgid) => -pgid));
    for (const row of members) if (row.pgid === ownGroup && !row.zombie) targets.add(row.pid);
    for (const target of targets) record(signal(target, "SIGKILL"));
  }
  return [...failures.values()];
}

function signal(target: number, name: NodeJS.Signals): KillFailure | null {
  try {
    process.kill(target, name);
    return null;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return null;
    // macOS refuses to signal a group whose only members are zombies waiting to be reaped.
    if (errorCode(error) === "EPERM" && target < 0 && onlyZombiesLeft(-target)) return null;
    return { target, error };
  }
}

function onlyZombiesLeft(pgid: number): boolean {
  try {
    return !hasLiveMember(readProcessTable(), pgid);
  } catch {
    return false;
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
