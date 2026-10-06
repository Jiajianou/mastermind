import type { DatabaseSync } from "node:sqlite";

export type Transaction = <T>(work: () => T) => T;

export function createTransaction(database: DatabaseSync): Transaction {
  let depth = 0;

  return <T>(work: () => T): T => {
    const savepoint = depth === 0 ? null : `nested_${String(depth)}`;
    database.exec(savepoint === null ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = work();
      if (result instanceof Promise)
        throw new TypeError("a transaction's work must be synchronous");
      database.exec(savepoint === null ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      database.exec(
        savepoint === null ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
      );
      throw error;
    } finally {
      depth -= 1;
    }
  };
}
