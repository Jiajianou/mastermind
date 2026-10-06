import { randomUUID } from "node:crypto";
import type { IPty, IPtyForkOptions } from "node-pty";
import { ActionError } from "./actions/index.js";
import { terminalScrollbackLimit } from "./contracts/index.js";
import type {
  Task,
  TaskTerminal,
  Terminal,
  TerminalSize,
  TerminalView,
} from "./contracts/index.js";
import type { Db } from "./db/index.js";
import { cleanEnv } from "./env.js";
import type { Environment } from "./env.js";
import type { EventBus } from "./events.js";
import { ProcessKillError, killTreesSync } from "./procs.js";
import type { ProcessRegistry } from "./procs.js";

export type SpawnPty = (file: string, args: string[], options: IPtyForkOptions) => IPty;
export type LoadPty = () => Promise<{ spawn: SpawnPty }>;

export interface TerminalsOptions {
  db: Db;
  bus: EventBus;
  registry: ProcessRegistry;
  env: Environment;
  loadPty?: LoadPty;
}

export interface Terminals {
  read(taskId: string): Promise<TaskTerminal>;
  open(taskId: string, size: TerminalSize): Promise<TerminalView>;
  write(terminalId: string, data: string): Terminal;
  resize(terminalId: string, size: TerminalSize): Terminal;
  stop(terminalId: string): Promise<Terminal>;
  killAllSync(): void;
  dispose(): void;
}

interface OpenTerminal {
  terminal: Terminal;
  pty: IPty;
  output: string;
  received: number;
  exited: Promise<void>;
}

type PtyLoad = { kind: "loaded"; spawn: SpawnPty } | { kind: "failed"; message: string };

const loadNodePty: LoadPty = () => import("node-pty");

const conflict = (message: string) => ActionError.fromMessage("conflict", message);

const hasWorkspace = (task: Task): task is Task & { worktree: string } =>
  task.worktree !== null && task.status !== "done";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const viewOf = ({ terminal, output, received }: OpenTerminal): TerminalView => ({
  terminal,
  output,
  received,
});

// node-pty runs the shell as a session leader, so its pid is also its process group.
const groupOf = (pty: IPty) => ({ pid: pty.pid, pgid: pty.pid });

export function createTerminals({
  db,
  bus,
  registry,
  env,
  loadPty = loadNodePty,
}: TerminalsOptions): Terminals {
  const terminals = new Map<string, OpenTerminal>();
  let loading: Promise<PtyLoad> | null = null;

  const load = (): Promise<PtyLoad> => {
    loading ??= loadPty().then(
      ({ spawn }): PtyLoad => ({ kind: "loaded", spawn }),
      (error: unknown): PtyLoad => ({
        kind: "failed",
        message: `Try it yourself needs node-pty, which could not be loaded: ${describe(error)}`,
      }),
    );
    return loading;
  };

  const requireTask = (taskId: string): Task => {
    const task = db.tasks.get(taskId);
    if (task === null) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
    return task;
  };

  const forTask = (taskId: string): OpenTerminal | undefined =>
    [...terminals.values()].find(({ terminal }) => terminal.taskId === taskId);

  const requireRunning = (terminalId: string): OpenTerminal => {
    const open = terminals.get(terminalId);
    if (open === undefined) throw ActionError.fromMessage("not_found", `no terminal ${terminalId}`);
    if (open.terminal.status !== "running") throw conflict(`terminal ${terminalId} has ended`);
    return open;
  };

  const killTree = (open: OpenTerminal): void => {
    const failures = killTreesSync([groupOf(open.pty)]);
    open.pty.kill("SIGKILL");
    if (failures.length > 0) throw new ProcessKillError(failures);
  };

  function start(spawn: SpawnPty, task: Task & { worktree: string }, size: TerminalSize) {
    const childEnv = cleanEnv(env);
    const shell = childEnv.SHELL ?? "/bin/sh";
    let pty: IPty;
    try {
      pty = spawn(shell, [], {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        cwd: task.worktree,
        env: childEnv,
      });
    } catch (error) {
      throw conflict(`could not start ${shell} in ${task.worktree}: ${describe(error)}`);
    }
    const untrack = registry.track({ kind: "terminal", ...groupOf(pty) });
    const terminal: Terminal = {
      id: randomUUID(),
      taskId: task.id,
      cwd: task.worktree,
      status: "running",
    };
    let markExited = (): void => undefined;
    const open: OpenTerminal = {
      terminal,
      pty,
      output: "",
      received: 0,
      exited: new Promise((resolve) => {
        markExited = resolve;
      }),
    };
    const previous = forTask(task.id);
    if (previous !== undefined) terminals.delete(previous.terminal.id);
    terminals.set(terminal.id, open);

    pty.onData((data) => {
      const offset = open.received;
      open.received += data.length;
      open.output = `${open.output}${data}`.slice(-terminalScrollbackLimit);
      bus.emit({ type: "terminal.output", taskId: task.id, terminalId: terminal.id, offset, data });
    });
    pty.onExit(() => {
      untrack();
      open.terminal = { ...open.terminal, status: "exited" };
      bus.emit({ type: "terminal.updated", taskId: task.id, terminal: open.terminal });
      markExited();
    });
    bus.emit({ type: "terminal.updated", taskId: task.id, terminal });
    return open;
  }

  // A terminal must not outlive its task's clone: the clone is deleted once the task is on main or discarded.
  const unsubscribe = bus.subscribe((event) => {
    if (event.type !== "task.updated" || hasWorkspace(event.task)) return;
    const open = forTask(event.taskId);
    if (open?.terminal.status === "running") killTree(open);
  });

  return {
    async read(taskId) {
      const pty = await load();
      requireTask(taskId);
      if (pty.kind === "failed") return { available: false, message: pty.message };
      const open = forTask(taskId);
      return { available: true, view: open === undefined ? null : viewOf(open) };
    },

    async open(taskId, size) {
      const pty = await load();
      const task = requireTask(taskId);
      if (!hasWorkspace(task)) throw conflict(`${taskId} has no workspace to try`);
      if (pty.kind === "failed") throw conflict(pty.message);
      const running = forTask(taskId);
      if (running?.terminal.status === "running") return viewOf(running);
      return viewOf(start(pty.spawn, task, size));
    },

    write(terminalId, data) {
      const open = requireRunning(terminalId);
      open.pty.write(data);
      return open.terminal;
    },

    resize(terminalId, { cols, rows }) {
      const open = requireRunning(terminalId);
      open.pty.resize(cols, rows);
      return open.terminal;
    },

    async stop(terminalId) {
      const open = terminals.get(terminalId);
      if (open === undefined)
        throw ActionError.fromMessage("not_found", `no terminal ${terminalId}`);
      if (open.terminal.status === "running") killTree(open);
      await open.exited;
      return open.terminal;
    },

    killAllSync() {
      for (const { pty, terminal } of terminals.values())
        if (terminal.status === "running") pty.kill("SIGKILL");
    },

    dispose: unsubscribe,
  };
}
