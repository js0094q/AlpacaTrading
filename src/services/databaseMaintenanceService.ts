import { DatabaseSync, type DatabaseSync as DbHandle } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  configureDatabaseConnection,
  getResearchDbPath,
  initializeDatabaseHandle,
  PHASE_1B_MIGRATION_VERSION,
  REQUIRED_RUNTIME_MIGRATION_VERSIONS,
  UNIVERSE_LIFECYCLE_MIGRATION_VERSION
} from "../lib/db.js";
import { getPendingMigrationVersions } from "../lib/sqliteMigrations.js";

export { PHASE_1B_MIGRATION_VERSION } from "../lib/db.js";

const requiredTables = [
  "schema_migrations",
  "decision_snapshots",
  "decision_lifecycle_events",
  "paper_review_decisions",
  "paper_positions",
  "paper_position_observations",
  "paper_position_observation_links",
  "paper_position_outcomes",
  "paper_position_outcome_revisions",
  "universe_lifecycle_runs",
  "universe_lifecycle_events",
  "autonomous_recovery_runs",
  "autonomous_recovery_events",
  "research_runs"
] as const;

const requiredColumns: Record<string, string[]> = {
  paper_trade_candidates: ["decision_id", "decision_linkage_status"],
  paper_trade_plans: ["decision_id", "decision_linkage_status"],
  paper_trade_evaluations: ["decision_id", "decision_linkage_status"],
  paper_execution_ledger: [
    "decision_id",
    "position_lifecycle_id",
    "decision_linkage_status"
  ],
  paper_learning_records: [
    "decision_id",
    "entry_decision_id",
    "exit_decision_id",
    "position_lifecycle_id",
    "outcome_id",
    "effective_outcome_revision_id",
    "outcome_completeness_status",
    "decision_linkage_status"
  ],
  hedge_execution_reviews: [
    "decision_id",
    "decision_role",
    "position_lifecycle_id",
    "decision_linkage_status"
  ],
  hedge_learning_events: [
    "decision_id",
    "position_lifecycle_id",
    "decision_linkage_status"
  ],
  universe_symbols: [
    "lifecycle_state",
    "lifecycle_reason_code",
    "lifecycle_entered_at",
    "lifecycle_updated_at",
    "lifecycle_config_version"
  ],
  autonomous_recovery_runs: [
    "git_sha",
    "config_version",
    "config_hash",
    "recovered_research_runs"
  ],
  autonomous_recovery_events: [
    "recovery_run_id",
    "source_table",
    "source_id",
    "recovery_code",
    "evidence_json"
  ],
  research_runs: [
    "heartbeat_at",
    "worker_identity",
    "request_id",
    "correlation_id",
    "recovered_at",
    "recovery_reason",
    "recovery_source"
  ]
};

const requiredIndexes = [
  "idx_paper_trade_candidates_decision_id",
  "idx_paper_trade_plans_decision_id",
  "idx_paper_trade_evaluations_decision_id",
  "idx_paper_execution_decision_id",
  "idx_paper_execution_position_lifecycle",
  "idx_paper_learning_decision_id",
  "idx_paper_learning_entry_decision_id",
  "idx_paper_learning_position_lifecycle",
  "idx_paper_learning_outcome_id",
  "idx_decision_snapshots_symbol_created",
  "idx_paper_positions_symbol_status",
  "idx_paper_position_observations_symbol_time",
  "idx_universe_lifecycle_runs_completed",
  "idx_universe_lifecycle_events_symbol_occurred",
  "idx_universe_lifecycle_events_run",
  "idx_autonomous_recovery_runs_started_at",
  "idx_autonomous_recovery_events_run",
  "idx_autonomous_recovery_events_source"
] as const;

const objectExists = (db: DbHandle, type: "table" | "index", name: string) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name)
  );

export interface DatabaseSchemaVerification {
  databasePath: string;
  ok: boolean;
  integrity: string;
  migrationApplied: boolean;
  universeLifecycleMigrationApplied: boolean;
  requiredMigrationsApplied: boolean;
  pendingMigrations: string[];
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  pragmas: {
    integrityCheck: string;
    journalMode: string;
    busyTimeout: number;
    foreignKeys: number;
    synchronous: number;
  };
}

export const verifyDatabaseSchema = (input: {
  db: DbHandle;
  databasePath: string;
}): DatabaseSchemaVerification => {
  const missingTables = requiredTables.filter(
    (table) => !objectExists(input.db, "table", table)
  );
  const missingColumns: string[] = [];
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!objectExists(input.db, "table", table)) {
      missingColumns.push(...columns.map((column) => `${table}.${column}`));
      continue;
    }
    const existing = new Set(
      (input.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    missingColumns.push(
      ...columns
        .filter((column) => !existing.has(column))
        .map((column) => `${table}.${column}`)
    );
  }
  const missingIndexes = requiredIndexes.filter(
    (index) => !objectExists(input.db, "index", index)
  );
  const pendingMigrations = getPendingMigrationVersions(
    input.db,
    REQUIRED_RUNTIME_MIGRATION_VERSIONS
  );
  const integrityRow = input.db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check: string }
    | undefined;
  const journalModeRow = input.db.prepare("PRAGMA journal_mode").get() as
    | { journal_mode: string }
    | undefined;
  const busyTimeoutRow = input.db.prepare("PRAGMA busy_timeout").get() as
    | { timeout: number }
    | undefined;
  const foreignKeysRow = input.db.prepare("PRAGMA foreign_keys").get() as
    | { foreign_keys: number }
    | undefined;
  const synchronousRow = input.db.prepare("PRAGMA synchronous").get() as
    | { synchronous: number }
    | undefined;
  const foreignKeyViolations = input.db
    .prepare("PRAGMA foreign_key_check")
    .all() as Array<Record<string, unknown>>;
  const migrationApplied = objectExists(input.db, "table", "schema_migrations")
    ? Boolean(
        input.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
          .get(PHASE_1B_MIGRATION_VERSION)
      )
    : false;
  const universeLifecycleMigrationApplied = objectExists(
    input.db,
    "table",
    "schema_migrations"
  )
    ? Boolean(
        input.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
          .get(UNIVERSE_LIFECYCLE_MIGRATION_VERSION)
      )
    : false;
  const integrity = integrityRow?.integrity_check ?? "unavailable";
  return {
    databasePath: input.databasePath,
    ok:
      integrity === "ok" &&
      migrationApplied &&
      universeLifecycleMigrationApplied &&
      pendingMigrations.length === 0 &&
      missingTables.length === 0 &&
      missingColumns.length === 0 &&
      missingIndexes.length === 0 &&
      foreignKeyViolations.length === 0,
    integrity,
    migrationApplied,
    universeLifecycleMigrationApplied,
    requiredMigrationsApplied: pendingMigrations.length === 0,
    pendingMigrations,
    missingTables: [...missingTables],
    missingColumns,
    missingIndexes: [...missingIndexes],
    foreignKeyViolations,
    pragmas: {
      integrityCheck: integrity,
      journalMode: journalModeRow?.journal_mode ?? "unavailable",
      busyTimeout: busyTimeoutRow?.timeout ?? 0,
      foreignKeys: foreignKeysRow?.foreign_keys ?? 0,
      synchronous: synchronousRow?.synchronous ?? 0
    }
  };
};

export const migrateDatabaseFile = (
  databasePath = getResearchDbPath()
): DatabaseSchemaVerification => {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = initializeDatabaseHandle(new DatabaseSync(resolvedPath));
  try {
    return verifyDatabaseSchema({ db, databasePath: resolvedPath });
  } finally {
    db.close();
  }
};

export const verifyDatabaseFile = (
  databasePath = getResearchDbPath()
): DatabaseSchemaVerification => {
  const resolvedPath = resolve(databasePath);
  const db = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    configureDatabaseConnection(db);
    return verifyDatabaseSchema({ db, databasePath: resolvedPath });
  } finally {
    db.close();
  }
};
