import { terminalScrollbackLimit } from "@mastermind/core/contracts";
import type { Terminal, TerminalView } from "@mastermind/core/contracts";
import type { TerminalState } from "./state.js";

interface Output {
  terminalId: string;
  offset: number;
  data: string;
}

const fresh = (id: string, received = 0): TerminalState => ({
  id,
  status: "running",
  output: "",
  received,
});

// Offsets let a chunk that the loaded scrollback already holds, or that arrives twice, be applied exactly once.
export function appendOutput(
  known: TerminalState | undefined,
  { terminalId, offset, data }: Output,
): TerminalState {
  const terminal = known?.id === terminalId ? known : fresh(terminalId, offset);
  const end = offset + data.length;
  if (end <= terminal.received) return terminal;
  const unseen = data.slice(Math.max(0, terminal.received - offset));
  const output = `${terminal.output}${unseen}`.slice(-terminalScrollbackLimit);
  return { ...terminal, output, received: end };
}

export function withStatus(known: TerminalState | undefined, terminal: Terminal): TerminalState {
  const current = known?.id === terminal.id ? known : fresh(terminal.id);
  return current.status === terminal.status ? current : { ...current, status: terminal.status };
}

// A terminal never comes back from exited, so whichever of the read and the stream saw the exit wins.
export function withView(known: TerminalState | undefined, view: TerminalView): TerminalState {
  const { terminal, output, received } = view;
  const same = known?.id === terminal.id ? known : undefined;
  const status = same?.status === "exited" ? "exited" : terminal.status;
  if (same === undefined || same.received < received)
    return { id: terminal.id, status, output, received };
  return same.status === status ? same : { ...same, status };
}
