import { DatabaseSync, type DatabaseSync as DbHandle } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getResearchDbPath,
  initializeDatabaseHandle
} from "../lib/db.js";

export const PHASE_1B_MIGRATION_VERSION =
  "2026-07-13-market-observatory-phase-1b";

const requiredTables = [
  "schema_migrations",
  "decision_snapshots",
  "decision_lifecycle_events",
  "paper_review_decisions",
  "paper_positions",
  "paper_position_observations",
  "paper_position_observation_links",
  "paper_position_outcomes",
  "paper_position_outcome_revisions"
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
    "position_lifecycle_id",
    "outcome_id",
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
  ]
};

const requiredIndexes = [
  "idx_paper_trade_candidates_decision_id",
  "idx_paper_trade_plans_decision_id",
  "idx_paper_trade_evaluations_decision_id",
  "idx_paper_execution_decision_id",
  "idx_paper_execution_position_lifecycle",
  "idx_paper_learning_decision_id",
  "idx_paper_learning_position_lifecycle",
  "idx_decision_snapshots_symbol_created",
  "idx_paper_positions_symbol_status",
  "idx_paper_position_observations_symbol_time"
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
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
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
  const integrityRow = input.db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check: string }
    | undefined;
  const migrationApplied = objectExists(input.db, "table", "schema_migrations")
    ? Boolean(
        input.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
          .get(PHASE_1B_MIGRATION_VERSION)
      )
    : false;
  const integrity = integrityRow?.integrity_check ?? "unavailable";
  return {
    databasePath: input.databasePath,
    ok:
      integrity === "ok" &&
      migrationApplied &&
      missingTables.length === 0 &&
      missingColumns.length === 0 &&
      missingIndexes.length === 0,
    integrity,
    migrationApplied,
    missingTables: [...missingTables],
    missingColumns,
    missingIndexes: [...missingIndexes]
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
    return verifyDatabaseSchema({ db, databasePath: resolvedPath });
  } finally {
    db.close();
  }
};
