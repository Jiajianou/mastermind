// Node 22 warns on stderr that node:sqlite is experimental. The entry imports the program, and with it node:sqlite,
// only after this listener is in place; a static import would load node:sqlite before any of our code ran.
const defaultListeners = process.listeners("warning");

const isSqliteWarning = (warning: Error) =>
  warning.name === "ExperimentalWarning" && warning.message.startsWith("SQLite ");

process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (isSqliteWarning(warning)) return;
  for (const listener of defaultListeners) listener(warning);
});
