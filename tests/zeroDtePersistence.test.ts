import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runZeroDteMigrations } from "../src/lib/zeroDteSchema.js";
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

const insertTerminalOutcome = (input: {
  outcomeId: string;
  candidateId: string | null;
  paperTradeId?: string | null;
  shadowTradeId?: string | null;
  outcomeType?: string;
  horizonMinutes?: number | null;
}) => {
  seedIntegrityFixtures()
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
      input.horizonMinutes ?? 5,
      "closed",
      "complete",
      "2026-07-13T19:02:00.000Z",
      "2026-07-13T19:02:00.000Z"
    );
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
