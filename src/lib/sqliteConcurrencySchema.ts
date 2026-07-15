import type { DatabaseSync } from "node:sqlite";

export const SQLITE_CONCURRENCY_MIGRATION_VERSION =
  "2026-07-15-steady-state-sqlite-concurrency";

export const runSqliteConcurrencyMigration = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_write_leases (
      lease_name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
};
