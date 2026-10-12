import type { DbContext } from "./rows.js";

const projectTables = [
  "task_deps",
  "events",
  "checks",
  "findings",
  "comments",
  "rounds",
  "rebases",
  "sessions",
  "tasks",
  "chat_messages",
  "conductor_sessions",
  "conversations",
  "proposals",
  "runtime_flags",
] as const;

export function createWipe({ database, transaction }: DbContext): () => void {
  const deletes = projectTables.map((table) => database.prepare(`DELETE FROM ${table}`));
  return () => {
    transaction(() => {
      for (const statement of deletes) statement.run();
    });
  };
}
