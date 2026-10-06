import type { StatusStore } from "@mastermind/core/status";
import { render, useInput } from "ink";
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
    const command = key.ctrl || key.meta ? undefined : commandKeys[input];
    if (command !== undefined) onCommand(command);
  });

  return <StatusView snapshot={snapshot} armed={armed} now={now} />;
}

export interface TerminalView {
  restore(): void;
}

export function renderStatusApp(
  props: StatusAppProps,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): TerminalView {
  const instance = render(<StatusApp {...props} />, {
    stdin,
    stdout,
    exitOnCtrlC: false,
    patchConsole: true,
  });
  return {
    restore() {
      instance.clear();
      instance.unmount();
      stdin.setRawMode(false);
    },
  };
}
