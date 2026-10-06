import type { TerminalSize } from "@mastermind/core/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useEffectEvent, useRef } from "react";
import type { TerminalState } from "../store/state.js";

export interface XtermViewProps {
  terminal: TerminalState | undefined;
  label: string;
  onInput: (data: string) => void;
  onResize: (size: TerminalSize) => void;
}

interface Screen {
  xterm: Terminal;
  shownId: string | null;
  shownReceived: number;
}

function themeToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function show(screen: Screen, terminal: TerminalState): void {
  const unshown = terminal.received - screen.shownReceived;
  if (screen.shownId !== terminal.id || unshown < 0 || unshown > terminal.output.length) {
    screen.xterm.reset();
    screen.xterm.write(terminal.output);
  } else if (unshown > 0) {
    screen.xterm.write(terminal.output.slice(-unshown));
  }
  screen.shownId = terminal.id;
  screen.shownReceived = terminal.received;
}

export function XtermView({ terminal, label, onInput, onResize }: XtermViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const screen = useRef<Screen | null>(null);
  const input = useEffectEvent(onInput);
  const resize = useEffectEvent(onResize);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const xterm = new Terminal({
      fontFamily: themeToken("--font-mono"),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5_000,
      theme: {
        background: themeToken("--color-page"),
        foreground: themeToken("--color-text"),
        cursor: themeToken("--color-frost"),
        selectionBackground: themeToken("--color-control-border"),
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element);
    const subscriptions = [
      xterm.onData((data) => {
        input(data);
      }),
      xterm.onResize(({ cols, rows }) => {
        resize({ cols, rows });
      }),
    ];
    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(element);
    fit.fit();
    resize({ cols: xterm.cols, rows: xterm.rows });
    screen.current = { xterm, shownId: null, shownReceived: 0 };
    return () => {
      observer.disconnect();
      for (const subscription of subscriptions) subscription.dispose();
      xterm.dispose();
      screen.current = null;
    };
  }, []);

  useEffect(() => {
    const current = screen.current;
    if (current === null) return;
    current.xterm.options.disableStdin = terminal?.status !== "running";
    if (terminal !== undefined) show(current, terminal);
  }, [terminal]);

  return <div ref={container} className="xterm-view" role="region" aria-label={label} />;
}
