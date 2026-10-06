import type { StatusStore } from "@mastermind/core/status";
import type { CtrlCGuard } from "./ctrl-c.js";
import { armedWarning, linkPlaceholder } from "./messages.js";
import type { TerminalView } from "./tui/app.js";
import { accountText, eventLineText, headerTitle, liveCounts } from "./tui/format.js";

export function startPlainLog(
  store: StatusStore,
  guard: CtrlCGuard,
  write: (line: string) => void,
): TerminalView {
  const { header } = store.getSnapshot();
  write(`${headerTitle(header)} · ${accountText(header)}`);
  write(header.link === null ? linkPlaceholder : `Web app → ${header.link}`);

  let printedUpTo = 0;
  const printNewLines = (): void => {
    for (const line of store.getSnapshot().events) {
      if (line.id <= printedUpTo) continue;
      write(eventLineText(line));
      printedUpTo = line.id;
    }
  };
  printNewLines();
  const unsubscribeStore = store.subscribe(printNewLines);
  const unsubscribeGuard = guard.subscribe(() => {
    if (guard.isArmed()) write(armedWarning(liveCounts(store.getSnapshot())));
  });

  return {
    restore() {
      unsubscribeStore();
      unsubscribeGuard();
    },
  };
}
