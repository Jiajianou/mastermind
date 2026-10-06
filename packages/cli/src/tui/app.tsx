import type { StatusStore } from "@mastermind/core/status";
import { render, useInput } from "ink";
import type { Instance } from "ink";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CtrlCGuard } from "../ctrl-c.js";
import type { TerminalCommand } from "../terminal-commands.js";
import { StatusView } from "./status-view.js";

export interface StatusAppProps {
  store: StatusStore;
  guard: CtrlCGuard;
  onCommand: (command: TerminalCommand) => void;
}

const commandKeys: Readonly<Record<string, TerminalCommand>> = { o: "open", c: "copy", p: "pause" };

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

export function StatusApp({ store, guard, onCommand }: StatusAppProps) {
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  );
  const armed = useSyncExternalStore(
    useCallback((listener: () => void) => guard.subscribe(listener), [guard]),
    useCallback(() => guard.isArmed(), [guard]),
  );
  const now = useNow(1_000);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      guard.press();
      return;
    }
    if (key.return && snapshot.summary.authRequired) {
      onCommand("sign-in");
      return;
    }
    const command = key.ctrl || key.meta ? undefined : commandKeys[input];
    if (command !== undefined) onCommand(command);
  });

  return <StatusView snapshot={snapshot} armed={armed} now={now} />;
}

export interface TerminalView {
  restore(): void;
  handOff<T>(work: () => Promise<T>): Promise<T>;
}

export function renderStatusApp(
  props: StatusAppProps,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): TerminalView {
  const mount = () =>
    render(<StatusApp {...props} />, { stdin, stdout, exitOnCtrlC: false, patchConsole: true });
  let instance: Instance | null = mount();

  // Ctrl+C twice can restore the terminal while the login hand-off already holds it.
  function restore(): void {
    if (instance === null) return;
    instance.clear();
    instance.unmount();
    instance = null;
    stdin.setRawMode(false);
  }

  return {
    restore,

    // The login hand-off owns the terminal with inherited stdio, so Ink leaves raw mode and stops drawing until it
    // returns.
    async handOff(work) {
      restore();
      stdin.pause();
      try {
        return await work();
      } finally {
        instance = mount();
      }
    },
  };
}
