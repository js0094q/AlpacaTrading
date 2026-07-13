import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { configureSqliteTestDb } from "./helpers/sqliteTestDb.js";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-schema-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

const { closeDbForTests, getDb } = await import("../src/lib/db.js");

const levelTwoTables = [
  "zero_dte_engine_runs",
  "zero_dte_candidates",
  "zero_dte_candidate_observations",
  "zero_dte_playbook_evaluations",
  "zero_dte_decisions",
  "zero_dte_lifecycle_events",
  "zero_dte_paper_trades",
  "zero_dte_shadow_trades",
  "zero_dte_position_marks",
  "zero_dte_terminal_outcomes",
  "zero_dte_configuration_versions"
] as const;

const levelTwoIndexes = [
  "idx_zero_dte_engine_runs_trading_date",
  "idx_zero_dte_engine_runs_status",
  "idx_zero_dte_candidates_trading_date_state",
  "idx_zero_dte_candidates_option_symbol",
  "idx_zero_dte_candidate_observations_candidate_observed_at",
  "idx_zero_dte_playbook_evaluations_candidate_playbook",
  "idx_zero_dte_decisions_group_decided_at",
  "idx_zero_dte_lifecycle_events_candidate_occurred_at",
  "idx_zero_dte_paper_trades_open_status",
  "idx_zero_dte_shadow_trades_open_status",
  "idx_zero_dte_position_marks_trade_marked_at",
  "idx_zero_dte_terminal_outcomes_candidate_recorded_at",
  "idx_zero_dte_configuration_versions_created_at"
] as const;

const namesInSqliteMaster = (type: "table" | "index", names: readonly string[]) => {
  const placeholders = names.map(() => "?").join(", ");
  return getDb()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = ? AND name IN (${placeholders}) ORDER BY name`
    )
    .all(type, ...names) as Array<{ name: string }>;
};

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("initialization creates all Level 2 tables and indexes", () => {
  const db = configureSqliteTestDb(getDb());
  assert.equal(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'universe_symbols'").get() as { name: string })
      .name,
    "universe_symbols"
  );
  assert.deepEqual(
    namesInSqliteMaster("table", levelTwoTables).map((row) => row.name),
    [...levelTwoTables].sort()
  );
  assert.deepEqual(
    namesInSqliteMaster("index", levelTwoIndexes).map((row) => row.name),
    [...levelTwoIndexes].sort()
  );
  assert.equal(
    (db.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '2026-07-13-zero-dte-level-2'"
    ).get() as { count: number }).count,
    1
  );
});

test("initialization is idempotent and records one migration row", () => {
  const first = getDb();
  closeDbForTests();
  const second = getDb();

  assert.notEqual(first, second);
  assert.equal(
    (second.prepare(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '2026-07-13-zero-dte-level-2'"
    ).get() as { count: number }).count,
    1
  );
  assert.equal(
    (second.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(
      "zero_dte_candidates"
    ) as { count: number }).count,
    1
  );
});
