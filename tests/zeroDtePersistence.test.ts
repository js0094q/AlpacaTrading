import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import {
  runZeroDteMigrations,
  ZERO_DTE_HARDENING_MIGRATION_VERSION
} from "../src/lib/zeroDteSchema.js";
import {
  appendZeroDteCandidateObservation,
  insertZeroDtePlaybookEvaluation,
  listZeroDteQueue,
  readZeroDteSummary,
  upsertZeroDteCandidate
} from "../src/services/zeroDte/zeroDtePersistenceService.js";
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
  "uq_zero_dte_terminal_outcomes_candidate_only",
  "uq_zero_dte_terminal_outcomes_paper_trade",
  "uq_zero_dte_terminal_outcomes_shadow_trade",
  "idx_zero_dte_configuration_versions_created_at"
] as const;

const hardeningTriggerNames = [
  "trg_zero_dte_candidate_observations_engine_run_insert",
  "trg_zero_dte_candidate_observations_engine_run_update",
  "trg_zero_dte_playbook_evaluations_engine_run_insert",
  "trg_zero_dte_playbook_evaluations_engine_run_update",
  "trg_zero_dte_decisions_engine_run_insert",
  "trg_zero_dte_decisions_engine_run_update",
  "trg_zero_dte_position_marks_exactly_one_insert",
  "trg_zero_dte_position_marks_exactly_one_update",
  "trg_zero_dte_terminal_outcomes_integrity_insert",
  "trg_zero_dte_terminal_outcomes_integrity_update",
  "trg_zero_dte_terminal_outcomes_paper_candidate_insert",
  "trg_zero_dte_terminal_outcomes_paper_candidate_update",
  "trg_zero_dte_terminal_outcomes_shadow_candidate_insert",
  "trg_zero_dte_terminal_outcomes_shadow_candidate_update",
  "trg_zero_dte_terminal_outcomes_unique_candidate_insert",
  "trg_zero_dte_terminal_outcomes_unique_candidate_update",
  "trg_zero_dte_terminal_outcomes_unique_paper_insert",
  "trg_zero_dte_terminal_outcomes_unique_paper_update",
  "trg_zero_dte_terminal_outcomes_unique_shadow_insert",
  "trg_zero_dte_terminal_outcomes_unique_shadow_update"
] as const;

const namesInSqliteMasterFor = (
  db: DatabaseSync,
  type: "table" | "index" | "trigger",
  names: readonly string[]
) => {
  const placeholders = names.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = ? AND name IN (${placeholders}) ORDER BY name`
    )
    .all(type, ...names) as Array<{ name: string }>;
};

const createBaseVersionCompatibleDb = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, applied_at)
      VALUES ('2026-07-13-zero-dte-level-2', '2026-07-13T18:00:00.000Z');

    CREATE TABLE zero_dte_configuration_versions (
      configuration_version_id TEXT PRIMARY KEY,
      strategy_version TEXT NOT NULL,
      configuration_hash TEXT NOT NULL UNIQUE,
      configuration_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE zero_dte_engine_runs (
      run_id TEXT PRIMARY KEY,
      trading_date TEXT NOT NULL,
      mode TEXT NOT NULL,
      account_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      configuration_version_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(configuration_version_id)
        REFERENCES zero_dte_configuration_versions(configuration_version_id)
    );

    CREATE TABLE zero_dte_candidates (
      candidate_id TEXT PRIMARY KEY,
      trading_date TEXT NOT NULL,
      underlying_symbol TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      playbook TEXT NOT NULL,
      direction TEXT NOT NULL,
      expiration_date TEXT NOT NULL,
      strike REAL NOT NULL,
      state TEXT NOT NULL,
      score REAL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      state_changed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE zero_dte_candidate_observations (
      observation_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      engine_run_id TEXT,
      observed_at TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
      FOREIGN KEY(engine_run_id) REFERENCES zero_dte_engine_runs(run_id)
    );

    CREATE TABLE zero_dte_playbook_evaluations (
      evaluation_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      engine_run_id TEXT,
      playbook TEXT NOT NULL,
      score REAL NOT NULL,
      confidence REAL NOT NULL,
      direction TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(candidate_id, engine_run_id, playbook),
      FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
      FOREIGN KEY(engine_run_id) REFERENCES zero_dte_engine_runs(run_id)
    );

    CREATE TABLE zero_dte_decisions (
      decision_id TEXT PRIMARY KEY,
      decision_group_id TEXT NOT NULL,
      engine_run_id TEXT,
      candidate_id TEXT NOT NULL,
      trading_date TEXT NOT NULL,
      action TEXT NOT NULL,
      account_mode TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      configuration_version_id TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(engine_run_id) REFERENCES zero_dte_engine_runs(run_id),
      FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
      FOREIGN KEY(configuration_version_id)
        REFERENCES zero_dte_configuration_versions(configuration_version_id)
    );

    CREATE TABLE zero_dte_paper_trades (
      paper_trade_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      trading_date TEXT NOT NULL,
      underlying_symbol TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      playbook TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(decision_id) REFERENCES zero_dte_decisions(decision_id),
      FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id)
    );

    CREATE TABLE zero_dte_shadow_trades (
      shadow_trade_id TEXT PRIMARY KEY,
      decision_group_id TEXT NOT NULL,
      decision_id TEXT,
      candidate_id TEXT NOT NULL,
      trading_date TEXT NOT NULL,
      underlying_symbol TEXT NOT NULL,
      option_symbol TEXT NOT NULL,
      playbook TEXT NOT NULL,
      direction TEXT NOT NULL,
      alternative_type TEXT NOT NULL,
      status TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(decision_id) REFERENCES zero_dte_decisions(decision_id),
      FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id)
    );

    CREATE TABLE zero_dte_position_marks (
      mark_id TEXT PRIMARY KEY,
      paper_trade_id TEXT,
      shadow_trade_id TEXT,
      marked_at TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(paper_trade_id) REFERENCES zero_dte_paper_trades(paper_trade_id),
      FOREIGN KEY(shadow_trade_id) REFERENCES zero_dte_shadow_trades(shadow_trade_id),
      CHECK (paper_trade_id IS NOT NULL OR shadow_trade_id IS NOT NULL)
    );

    CREATE TABLE zero_dte_terminal_outcomes (
      outcome_id TEXT PRIMARY KEY,
      candidate_id TEXT,
      paper_trade_id TEXT,
      shadow_trade_id TEXT,
      decision_id TEXT,
      trading_date TEXT NOT NULL,
      outcome_type TEXT NOT NULL,
      horizon_minutes INTEGER,
      terminal_state TEXT NOT NULL,
      completeness_status TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
      FOREIGN KEY(paper_trade_id) REFERENCES zero_dte_paper_trades(paper_trade_id),
      FOREIGN KEY(shadow_trade_id) REFERENCES zero_dte_shadow_trades(shadow_trade_id),
      FOREIGN KEY(decision_id) REFERENCES zero_dte_decisions(decision_id)
    );
  `);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
};

const seedBaseVersionFixtures = (db: DatabaseSync) => {
  const timestamp = "2026-07-13T19:00:00.000Z";

  db.prepare(
    `INSERT INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash, configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("config-1", "zero-dte-level-2-v1", "hash-1", "{}", timestamp);

  db.prepare(
    `INSERT INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "run-1",
    "2026-07-13",
    "test",
    "paper",
    "completed",
    "zero-dte-level-2-v1",
    "config-1",
    timestamp,
    timestamp
  );

  for (const candidateId of ["candidate-1", "candidate-2"]) {
    db.prepare(
      `INSERT INTO zero_dte_candidates
        (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
         direction, expiration_date, strike, state, first_seen_at, last_seen_at,
         state_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      candidateId,
      "2026-07-13",
      "SPY",
      `${candidateId}-option`,
      "trend_continuation",
      "bullish",
      "2026-07-13",
      500,
      "eligible",
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp
    );
  }

  db.prepare(
    `INSERT INTO zero_dte_decisions
      (decision_id, decision_group_id, engine_run_id, candidate_id, trading_date,
       action, account_mode, strategy_version, configuration_version_id,
       decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "decision-1",
    "group-1",
    "run-1",
    "candidate-1",
    "2026-07-13",
    "select",
    "paper",
    "zero-dte-level-2-v1",
    "config-1",
    timestamp,
    timestamp
  );

  db.prepare(
    `INSERT INTO zero_dte_paper_trades
      (paper_trade_id, decision_id, candidate_id, trading_date, underlying_symbol,
       option_symbol, playbook, direction, status, quantity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "paper-1",
    "decision-1",
    "candidate-1",
    "2026-07-13",
    "SPY",
    "candidate-1-option",
    "trend_continuation",
    "bullish",
    "open",
    1,
    timestamp,
    timestamp
  );

  db.prepare(
    `INSERT INTO zero_dte_shadow_trades
      (shadow_trade_id, decision_group_id, decision_id, candidate_id, trading_date,
       underlying_symbol, option_symbol, playbook, direction, alternative_type,
       status, quantity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "shadow-1",
    "group-1",
    "decision-1",
    "candidate-1",
    "2026-07-13",
    "SPY",
    "candidate-1-option",
    "trend_continuation",
    "bullish",
    "runner_up",
    "open",
    1,
    timestamp,
    timestamp
  );

  // These rows were legal under the base migration and must remain readable after hardening.
  db.prepare(
    `INSERT INTO zero_dte_candidate_observations
      (observation_id, candidate_id, engine_run_id, observed_at, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "legacy-null-engine-run",
    "candidate-1",
    null,
    timestamp,
    "eligible",
    timestamp
  );

  db.prepare(
    `INSERT INTO zero_dte_terminal_outcomes
      (outcome_id, candidate_id, paper_trade_id, trading_date, outcome_type,
       horizon_minutes, terminal_state, completeness_status, evaluated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "legacy-mismatched-candidate",
    "candidate-2",
    "paper-1",
    "2026-07-13",
    "legacy_mismatch",
    5,
    "closed",
    "complete",
    timestamp,
    timestamp
  );
};

const namesInSqliteMaster = (type: "table" | "index", names: readonly string[]) => {
  const placeholders = names.map(() => "?").join(", ");
  return getDb()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = ? AND name IN (${placeholders}) ORDER BY name`
    )
    .all(type, ...names) as Array<{ name: string }>;
};

const seedIntegrityFixtures = () => {
  const db = getDb();
  const timestamp = "2026-07-13T19:00:00.000Z";

  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash, configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("config-1", "zero-dte-level-2-v1", "hash-1", "{}", timestamp);

  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "run-1",
    "2026-07-13",
    "test",
    "paper",
    "completed",
    "zero-dte-level-2-v1",
    "config-1",
    timestamp,
    timestamp
  );

  for (const candidateId of ["candidate-1", "candidate-2"]) {
    db.prepare(
      `INSERT OR IGNORE INTO zero_dte_candidates
        (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
         direction, expiration_date, strike, state, first_seen_at, last_seen_at,
         state_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      candidateId,
      "2026-07-13",
      "SPY",
      `${candidateId}-option`,
      "trend_continuation",
      "bullish",
      "2026-07-13",
      500,
      "eligible",
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp
    );
  }

  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_decisions
      (decision_id, decision_group_id, engine_run_id, candidate_id, trading_date,
       action, account_mode, strategy_version, configuration_version_id,
       decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "decision-1",
    "group-1",
    "run-1",
    "candidate-1",
    "2026-07-13",
    "select",
    "paper",
    "zero-dte-level-2-v1",
    "config-1",
    timestamp,
    timestamp
  );

  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_paper_trades
      (paper_trade_id, decision_id, candidate_id, trading_date, underlying_symbol,
       option_symbol, playbook, direction, status, quantity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "paper-1",
    "decision-1",
    "candidate-1",
    "2026-07-13",
    "SPY",
    "candidate-1-option",
    "trend_continuation",
    "bullish",
    "open",
    1,
    timestamp,
    timestamp
  );

  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_shadow_trades
      (shadow_trade_id, decision_group_id, decision_id, candidate_id, trading_date,
       underlying_symbol, option_symbol, playbook, direction, alternative_type,
       status, quantity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "shadow-1",
    "group-1",
    "decision-1",
    "candidate-1",
    "2026-07-13",
    "SPY",
    "candidate-1-option",
    "trend_continuation",
    "bullish",
    "runner_up",
    "open",
    1,
    timestamp,
    timestamp
  );

  return db;
};

const insertPositionMark = (
  markId: string,
  paperTradeId: string | null,
  shadowTradeId: string | null
) => {
  seedIntegrityFixtures()
    .prepare(
      `INSERT INTO zero_dte_position_marks
        (mark_id, paper_trade_id, shadow_trade_id, marked_at, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      markId,
      paperTradeId,
      shadowTradeId,
      "2026-07-13T19:01:00.000Z",
      "test",
      "2026-07-13T19:01:00.000Z"
    );
};

type TerminalOutcomeInput = {
  outcomeId: string;
  candidateId: string | null;
  paperTradeId?: string | null;
  shadowTradeId?: string | null;
  outcomeType?: string;
  horizonMinutes?: number | null;
};

const insertTerminalOutcomeInto = (db: DatabaseSync, input: TerminalOutcomeInput) => {
  db
    .prepare(
      `INSERT INTO zero_dte_terminal_outcomes
        (outcome_id, candidate_id, paper_trade_id, shadow_trade_id,
         trading_date, outcome_type, horizon_minutes, terminal_state,
         completeness_status, evaluated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.outcomeId,
      input.candidateId,
      input.paperTradeId ?? null,
      input.shadowTradeId ?? null,
      "2026-07-13",
      input.outcomeType ?? "terminal",
      input.horizonMinutes === undefined ? 5 : input.horizonMinutes,
      "closed",
      "complete",
      "2026-07-13T19:02:00.000Z",
      "2026-07-13T19:02:00.000Z"
    );
};

const insertTerminalOutcome = (input: TerminalOutcomeInput) => {
  insertTerminalOutcomeInto(getDb(), input);
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
  runZeroDteMigrations(first);
  closeDbForTests();
  const second = getDb();
  runZeroDteMigrations(second);

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

test("base-version databases receive non-destructive hardening exactly once", () => {
  const db = createBaseVersionCompatibleDb();
  seedBaseVersionFixtures(db);

  runZeroDteMigrations(db);

  assert.deepEqual(
    namesInSqliteMasterFor(db, "trigger", hardeningTriggerNames).map((row) => row.name),
    [...hardeningTriggerNames].sort()
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?"
        )
        .get(ZERO_DTE_HARDENING_MIGRATION_VERSION) as { count: number }
    ).count,
    1
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM zero_dte_candidate_observations WHERE observation_id = ?"
        )
        .get("legacy-null-engine-run") as { count: number }
    ).count,
    1
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM zero_dte_terminal_outcomes WHERE outcome_id = ?"
        )
        .get("legacy-mismatched-candidate") as { count: number }
    ).count,
    1
  );

  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO zero_dte_candidate_observations
          (observation_id, candidate_id, engine_run_id, observed_at, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "upgraded-observation-without-run",
        "candidate-1",
        null,
        "2026-07-13T19:03:00.000Z",
        "eligible",
        "2026-07-13T19:03:00.000Z"
      )
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO zero_dte_position_marks
          (mark_id, paper_trade_id, shadow_trade_id, marked_at, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "upgraded-mark-both",
        "paper-1",
        "shadow-1",
        "2026-07-13T19:03:00.000Z",
        "test",
        "2026-07-13T19:03:00.000Z"
      )
  );
  assert.throws(() =>
    insertTerminalOutcomeInto(db, {
      outcomeId: "upgraded-mismatched-paper-outcome",
      candidateId: "candidate-2",
      paperTradeId: "paper-1",
      outcomeType: "upgraded_mismatch",
      horizonMinutes: 5
    })
  );
  assert.throws(() =>
    insertTerminalOutcomeInto(db, {
      outcomeId: "upgraded-legacy-trade-duplicate",
      candidateId: "candidate-1",
      paperTradeId: "paper-1",
      outcomeType: "legacy_mismatch",
      horizonMinutes: 5
    })
  );
  assert.throws(() =>
    insertTerminalOutcomeInto(db, {
      outcomeId: "upgraded-orphan-outcome",
      candidateId: null,
      outcomeType: "upgraded_orphan",
      horizonMinutes: 5
    })
  );

  insertTerminalOutcomeInto(db, {
    outcomeId: "upgraded-candidate-only-1",
    candidateId: "candidate-1",
    outcomeType: "upgraded_candidate_only",
    horizonMinutes: 30
  });
  assert.throws(() =>
    insertTerminalOutcomeInto(db, {
      outcomeId: "upgraded-candidate-only-duplicate",
      candidateId: "candidate-1",
      outcomeType: "upgraded_candidate_only",
      horizonMinutes: 30
    })
  );

  runZeroDteMigrations(db);
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?"
        )
        .get(ZERO_DTE_HARDENING_MIGRATION_VERSION) as { count: number }
    ).count,
    1
  );
  db.close();
});

test("material observations, playbook evaluations, and decisions require an engine run", () => {
  const db = seedIntegrityFixtures();

  for (const table of [
    "zero_dte_candidate_observations",
    "zero_dte_playbook_evaluations",
    "zero_dte_decisions"
  ]) {
    const column = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .find((entry) => (entry as { name: string }).name === "engine_run_id") as
      | { notnull: number }
      | undefined;
    assert.equal(column?.notnull, 1, `${table}.engine_run_id must be NOT NULL`);
  }

  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO zero_dte_candidate_observations
          (observation_id, candidate_id, engine_run_id, observed_at, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "observation-without-run",
        "candidate-1",
        null,
        "2026-07-13T19:03:00.000Z",
        "eligible",
        "2026-07-13T19:03:00.000Z"
      )
  );

  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO zero_dte_playbook_evaluations
          (evaluation_id, candidate_id, engine_run_id, playbook, score, confidence,
           direction, evaluated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "evaluation-without-run",
        "candidate-1",
        null,
        "trend_continuation",
        80,
        0.8,
        "bullish",
        "2026-07-13T19:03:00.000Z",
        "2026-07-13T19:03:00.000Z"
      )
  );

  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO zero_dte_decisions
          (decision_id, decision_group_id, engine_run_id, candidate_id,
           trading_date, action, account_mode, strategy_version,
           configuration_version_id, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "decision-without-run",
        "group-without-run",
        null,
        "candidate-1",
        "2026-07-13",
        "skip",
        "paper",
        "zero-dte-level-2-v1",
        "config-1",
        "2026-07-13T19:03:00.000Z",
        "2026-07-13T19:03:00.000Z"
      )
  );
});

test("lifecycle events remain valid when reconciliation has no engine run", () => {
  const db = seedIntegrityFixtures();

  db.prepare(
    `INSERT INTO zero_dte_lifecycle_events
      (event_id, event_type, candidate_id, account_mode, strategy_version,
       configuration_version_id, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "lifecycle-outside-run",
    "position_marked",
    "candidate-1",
    "paper",
    "zero-dte-level-2-v1",
    "config-1",
    "2026-07-13T19:04:00.000Z",
    "2026-07-13T19:04:00.000Z"
  );
});

test("position marks require exactly one paper or shadow trade", () => {
  seedIntegrityFixtures();

  assert.throws(() => insertPositionMark("mark-neither", null, null));
  assert.throws(() => insertPositionMark("mark-both", "paper-1", "shadow-1"));

  insertPositionMark("mark-paper", "paper-1", null);
  insertPositionMark("mark-shadow", null, "shadow-1");
});

test("terminal outcomes require a candidate linkage", () => {
  assert.throws(() =>
    insertTerminalOutcome({
      outcomeId: "outcome-without-candidate",
      candidateId: null
    })
  );
});

test("terminal outcomes allow a candidate-only missed opportunity or one linked trade", () => {
  insertTerminalOutcome({
    outcomeId: "candidate-only-outcome",
    candidateId: "candidate-1"
  });
  insertTerminalOutcome({
    outcomeId: "paper-outcome",
    candidateId: "candidate-1",
    paperTradeId: "paper-1",
    outcomeType: "paper_terminal",
    horizonMinutes: 15
  });
  insertTerminalOutcome({
    outcomeId: "shadow-outcome",
    candidateId: "candidate-1",
    shadowTradeId: "shadow-1",
    outcomeType: "shadow_terminal",
    horizonMinutes: 15
  });
});

test("terminal outcomes reject rows linked to both paper and shadow trades", () => {
  assert.throws(() =>
    insertTerminalOutcome({
      outcomeId: "outcome-with-both-trades",
      candidateId: "candidate-1",
      paperTradeId: "paper-1",
      shadowTradeId: "shadow-1"
    })
  );
});

test("terminal outcome uniqueness handles nullable trade IDs", () => {
  insertTerminalOutcome({
    outcomeId: "candidate-only-unique-1",
    candidateId: "candidate-1",
    outcomeType: "unique_candidate_only",
    horizonMinutes: 30
  });
  assert.throws(() =>
    insertTerminalOutcome({
      outcomeId: "candidate-only-unique-duplicate",
      candidateId: "candidate-1",
      outcomeType: "unique_candidate_only",
      horizonMinutes: 30
    })
  );
  insertTerminalOutcome({
    outcomeId: "candidate-only-unique-other-candidate",
    candidateId: "candidate-2",
    outcomeType: "unique_candidate_only",
    horizonMinutes: 30
  });

  insertTerminalOutcome({
    outcomeId: "paper-unique-1",
    candidateId: "candidate-1",
    paperTradeId: "paper-1",
    outcomeType: "unique_paper",
    horizonMinutes: 60
  });
  assert.throws(() =>
    insertTerminalOutcome({
      outcomeId: "paper-unique-duplicate",
      candidateId: "candidate-1",
      paperTradeId: "paper-1",
      outcomeType: "unique_paper",
      horizonMinutes: 60
    })
  );

  insertTerminalOutcome({
    outcomeId: "shadow-unique-1",
    candidateId: "candidate-1",
    shadowTradeId: "shadow-1",
    outcomeType: "unique_shadow",
    horizonMinutes: 60
  });
  assert.throws(() =>
    insertTerminalOutcome({
      outcomeId: "shadow-unique-duplicate",
      candidateId: "candidate-1",
      shadowTradeId: "shadow-1",
      outcomeType: "unique_shadow",
      horizonMinutes: 60
    })
  );
});

const taskFiveConfigId = "task5-config-1";
const taskFiveRunIds = ["task5-run-1", "task5-run-2"] as const;
const taskFiveTimestamp = "2026-07-13T19:10:00.000Z";

const seedTaskFiveRunFixtures = () => {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    taskFiveConfigId,
    "zero-dte-level-2-v1",
    "task5-config-hash",
    JSON.stringify({ source: "test" }),
    taskFiveTimestamp
  );

  for (const runId of taskFiveRunIds) {
    db.prepare(
      `INSERT OR IGNORE INTO zero_dte_engine_runs
        (run_id, trading_date, mode, account_mode, status, strategy_version,
         configuration_version_id, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      "2026-07-13",
      "test",
      "paper",
      "running",
      "zero-dte-level-2-v1",
      taskFiveConfigId,
      taskFiveTimestamp,
      taskFiveTimestamp
    );
  }
};

const taskFiveLifecycleContext = {
  engineRunId: taskFiveRunIds[0],
  accountMode: "paper" as const,
  strategyVersion: "zero-dte-level-2-v1",
  configurationVersionId: taskFiveConfigId,
  marketTimestamp: taskFiveTimestamp,
  occurredAt: taskFiveTimestamp
};

const taskFiveCandidateInput = (overrides: Record<string, unknown> = {}) => ({
  tradingDate: "2026-07-13",
  underlyingSymbol: "SPY",
  optionSymbol: "SPY260713C00500000",
  playbook: "trend_continuation" as const,
  direction: "bullish" as const,
  expirationDate: "2026-07-13",
  strike: 500,
  state: "watching" as const,
  score: 42,
  playbookScore: 40,
  signalStrengthAdjustment: 2,
  liquidityAdjustment: 1,
  regimeAdjustment: 0,
  executionQualityAdjustment: 1,
  riskPenalty: 0,
  staleDataPenalty: 0,
  confidence: 70,
  signalSlope: 3,
  shortWindowSlope: 3,
  mediumWindowSlope: 2,
  liquidityScore: 80,
  freshnessScore: 95,
  setupAgeSeconds: 60,
  quoteBid: 1.2,
  quoteAsk: 1.4,
  quoteMidpoint: 1.3,
  premium: 1.3,
  spreadPct: 15.38,
  volume: 500,
  openInterest: 900,
  impliedVolatility: 0.32,
  delta: 0.51,
  gamma: 0.08,
  theta: -0.2,
  vega: 0.1,
  marketTimestamp: taskFiveTimestamp,
  lastSeenAt: taskFiveTimestamp,
  stateChangedAt: taskFiveTimestamp,
  stateReasonCode: "INITIAL_OBSERVATION",
  stateReason: { source: "test" },
  blockerCodes: [],
  lifecycleContext: taskFiveLifecycleContext,
  ...overrides
});

test("candidate upsert uses the identity unique key and records state transitions", () => {
  seedTaskFiveRunFixtures();
  const first = upsertZeroDteCandidate(taskFiveCandidateInput());
  const second = upsertZeroDteCandidate(taskFiveCandidateInput({
    state: "strengthening" as const,
    score: 65,
    stateReasonCode: "SCORE_MOVED_ABOVE_CONFIRMATION",
    lastSeenAt: "2026-07-13T19:11:00.000Z",
    stateChangedAt: "2026-07-13T19:11:00.000Z",
    lifecycleContext: {
      ...taskFiveLifecycleContext,
      occurredAt: "2026-07-13T19:11:00.000Z"
    }
  }));

  assert.equal(first.candidateId, second.candidateId);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_candidates WHERE candidate_id = ?").get(first.candidateId) as { count: number }).count,
    1
  );
  assert.equal(second.state, "strengthening");
  assert.equal(second.score, 65);
  assert.deepEqual(
    (getDb().prepare(
      `SELECT event_type, reason_code
       FROM zero_dte_lifecycle_events
       WHERE candidate_id = ?
       ORDER BY occurred_at ASC`
    ).all(first.candidateId) as Array<{ event_type: string; reason_code: string | null }>).map(
      (row) => ({ event_type: row.event_type, reason_code: row.reason_code })
    ),
    [
      { event_type: "candidate_discovered", reason_code: "INITIAL_OBSERVATION" },
      { event_type: "candidate_strengthened", reason_code: "SCORE_MOVED_ABOVE_CONFIRMATION" }
    ]
  );
});

test("reappearing candidates reuse one row and append an explicit reappearance event", () => {
  seedTaskFiveRunFixtures();
  const first = upsertZeroDteCandidate(taskFiveCandidateInput({
    optionSymbol: "SPY260713C00503000",
    state: "weakening" as const,
    stateReasonCode: "WEAKENING_SIGNAL"
  }));
  const reappeared = upsertZeroDteCandidate(taskFiveCandidateInput({
    optionSymbol: "SPY260713C00503000",
    state: "watching" as const,
    score: 72,
    reappeared: true,
    stateReasonCode: "SIGNAL_REAPPEARED",
    lastSeenAt: "2026-07-13T19:12:00.000Z",
    stateChangedAt: "2026-07-13T19:12:00.000Z",
    lifecycleContext: {
      ...taskFiveLifecycleContext,
      occurredAt: "2026-07-13T19:12:00.000Z"
    }
  }));

  assert.equal(first.candidateId, reappeared.candidateId);
  assert.equal(reappeared.reappearanceCount, 1);
  assert.deepEqual(
    (getDb().prepare(
      `SELECT event_type, reason_code
       FROM zero_dte_lifecycle_events
       WHERE candidate_id = ?
       ORDER BY occurred_at ASC`
    ).all(first.candidateId) as Array<{ event_type: string; reason_code: string | null }>).map(
      (row) => ({ event_type: row.event_type, reason_code: row.reason_code })
    ),
    [
      { event_type: "candidate_discovered", reason_code: "WEAKENING_SIGNAL" },
      { event_type: "candidate_reappeared", reason_code: "SIGNAL_REAPPEARED" },
      { event_type: "candidate_observed", reason_code: "SIGNAL_REAPPEARED" }
    ]
  );
});

test("observations append and evaluations remain unique per candidate run playbook", () => {
  seedTaskFiveRunFixtures();
  const candidate = upsertZeroDteCandidate(taskFiveCandidateInput({
    optionSymbol: "SPY260713C00501000"
  }));

  for (const [index, runId] of taskFiveRunIds.entries()) {
    appendZeroDteCandidateObservation({
      observationId: `task5-observation-${index + 1}`,
      candidateId: candidate.candidateId,
      engineRunId: runId,
      observedAt: `2026-07-13T19:${10 + index}:00.000Z`,
      state: index === 0 ? "watching" : "strengthening",
      totalScore: 42 + index,
      playbookScore: 40 + index,
      confidence: 70,
      signalSlope: 3,
      shortWindowSlope: 3,
      mediumWindowSlope: 2,
      liquidityScore: 80,
      freshnessScore: 95,
      quoteBid: 1.2,
      quoteAsk: 1.4,
      quoteMidpoint: 1.3,
      premium: 1.3,
      spreadPct: 15.38,
      volume: 500,
      openInterest: 900,
      dataQualityFlags: [],
      supportingSignals: [{ code: "VWAP_RECLAIM" }],
      opposingSignals: [],
      blockerCodes: [],
      evidence: { note: "paper-only test" }
    });

    for (const playbook of [
      "trend_continuation",
      "reversal",
      "breakout",
      "gamma_proxy",
      "volatility_expansion"
    ] as const) {
      insertZeroDtePlaybookEvaluation({
        evaluationId: `task5-evaluation-${index + 1}-${playbook}`,
        candidateId: candidate.candidateId,
        engineRunId: runId,
        playbook,
        score: 50 + index,
        confidence: 70,
        direction: "bullish",
        eligible: true,
        supportingSignals: [{ code: "TEST_SIGNAL" }],
        opposingSignals: [],
        blockerCodes: [],
        missingInputs: [],
        evidence: { playbook },
        evaluatedAt: `2026-07-13T19:${10 + index}:00.000Z`
      });
    }
  }

  insertZeroDtePlaybookEvaluation({
    evaluationId: "task5-evaluation-duplicate",
    candidateId: candidate.candidateId,
    engineRunId: taskFiveRunIds[0],
    playbook: "trend_continuation",
    score: 99,
    confidence: 99,
    direction: "bearish",
    eligible: false,
    supportingSignals: [],
    opposingSignals: [],
    blockerCodes: ["DUPLICATE_TEST"],
    missingInputs: [],
    evidence: {},
    evaluatedAt: taskFiveTimestamp
  });

  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_candidate_observations WHERE candidate_id = ?").get(candidate.candidateId) as { count: number }).count,
    2
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_playbook_evaluations WHERE candidate_id = ?").get(candidate.candidateId) as { count: number }).count,
    10
  );
  assert.equal(
    (getDb().prepare(
      `SELECT score, direction
       FROM zero_dte_playbook_evaluations
       WHERE candidate_id = ? AND engine_run_id = ? AND playbook = ?`
    ).get(candidate.candidateId, taskFiveRunIds[0], "trend_continuation") as { score: number; direction: string }).score,
    50
  );
});

test("queue and summary reads expose typed components and sanitize evidence", () => {
  seedTaskFiveRunFixtures();
  const candidate = upsertZeroDteCandidate(taskFiveCandidateInput({
    tradingDate: "2026-07-14",
    optionSymbol: "SPY260713C00502000",
    state: "eligible" as const,
    score: 88,
    blockerCodes: ["NONE"],
    stateReason: {
      note: "Authorization: Bearer task-secret-value",
      apiKey: "should-not-persist"
    }
  }));

  const queue = listZeroDteQueue({ tradingDate: "2026-07-14", limit: 10 });
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.candidateId, candidate.candidateId);
  assert.equal(queue[0]?.eligible, true);
  assert.equal(queue[0]?.componentScores.playbook, 40);
  assert.equal(queue[0]?.quote.bid, 1.2);
  assert.deepEqual(queue[0]?.blockers, ["NONE"]);

  const rawEvidence = getDb().prepare(
    "SELECT state_reason_json FROM zero_dte_candidates WHERE candidate_id = ?"
  ).get(candidate.candidateId) as { state_reason_json: string };
  assert.doesNotMatch(rawEvidence.state_reason_json, /task-secret-value|should-not-persist/);
  assert.match(rawEvidence.state_reason_json, /REDACTED|note/);

  const summary = readZeroDteSummary({ tradingDate: "2026-07-14", limit: 10 });
  assert.equal(summary.paperOnly, true);
  assert.equal(summary.queue.length, 1);
  assert.equal(summary.counts.candidates, 1);
  assert.equal(summary.counts.byState.eligible, 1);
  assert.equal(summary.lifecycle.counts.candidate_discovered, 1);
});
