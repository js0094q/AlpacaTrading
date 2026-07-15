import type { DatabaseSync as DbHandle } from "node:sqlite";

const MIGRATION_TABLE = "schema_migrations";

const migrationTableExists = (db: DbHandle): boolean =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MIGRATION_TABLE)
  );

export const getAppliedMigrationVersions = (db: DbHandle): Set<string> => {
  if (!migrationTableExists(db)) {
    return new Set();
  }
  const rows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: string }>;
  return new Set(rows.map((row) => row.version));
};

export const getPendingMigrationVersions = (
  db: DbHandle,
  versions: readonly string[]
): string[] => {
  const applied = getAppliedMigrationVersions(db);
  return versions.filter((version) => !applied.has(version));
};

export interface MigrationGroupResult {
  applied: boolean;
  appliedVersions: string[];
}

export const runMigrationGroup = (
  db: DbHandle,
  versions: readonly string[],
  apply: () => void
): MigrationGroupResult => {
  const pendingBeforeLock = getPendingMigrationVersions(db, versions);
  if (pendingBeforeLock.length === 0) {
    return { applied: false, appliedVersions: [] };
  }

  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const pendingUnderLock = getPendingMigrationVersions(db, versions);
    if (pendingUnderLock.length === 0) {
      db.exec("COMMIT;");
      transactionStarted = false;
      return { applied: false, appliedVersions: [] };
    }

    apply();
    const appliedAt = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
    );
    for (const version of pendingUnderLock) {
      insert.run(version, appliedAt);
    }
    db.exec("COMMIT;");
    transactionStarted = false;
    return { applied: true, appliedVersions: pendingUnderLock };
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the original migration failure.
      }
    }
    throw error;
  }
};
