import { DatabaseSync } from "node:sqlite";

export const createControlPlaneSnapshotFixture = (path: string) => {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE research_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT,
      completed_at TEXT,
      status TEXT NOT NULL,
      risk_profile TEXT NOT NULL,
      options_enabled INTEGER NOT NULL,
      universe_size INTEGER NOT NULL,
      targets_generated INTEGER NOT NULL,
      candidates_selected INTEGER NOT NULL,
      error_message TEXT,
      config_json TEXT NOT NULL,
      summary_json TEXT,
      worker_identity TEXT,
      request_id TEXT,
      correlation_id TEXT,
      recovered_at TEXT,
      recovery_reason TEXT,
      recovery_source TEXT
    );
    CREATE TABLE paper_trade_candidates (
      id TEXT PRIMARY KEY,
      decision_id TEXT,
      decision_linkage_status TEXT NOT NULL DEFAULT 'EXACT',
      research_run_id TEXT NOT NULL REFERENCES research_runs(id),
      symbol TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rank INTEGER NOT NULL,
      direction TEXT NOT NULL,
      horizon TEXT NOT NULL,
      risk_profile TEXT NOT NULL,
      preferred_expression TEXT NOT NULL,
      score REAL NOT NULL,
      confidence REAL NOT NULL,
      expected_return REAL,
      estimated_max_loss REAL,
      estimated_max_profit REAL,
      rationale TEXT NOT NULL,
      relevant_backtest_run_id TEXT,
      historical_win_rate REAL,
      historical_avg_return REAL,
      historical_max_drawdown REAL,
      similar_setup_count INTEGER,
      option_liquidity_score REAL,
      volatility_score REAL,
      signal_freshness_days INTEGER,
      recent_learning_adjustment REAL,
      directional_accuracy REAL,
      option_outperformance_accuracy REAL,
      option_symbol TEXT,
      strike REAL,
      short_strike REAL,
      decision TEXT NOT NULL,
      decision_reason TEXT,
      strategy_family TEXT,
      signal_inputs_json TEXT NOT NULL,
      data_quality_status TEXT NOT NULL
    );
    CREATE TABLE runtime_write_leases (
      lease_name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE decision_snapshots (
      decision_id TEXT PRIMARY KEY,
      origin_type TEXT NOT NULL DEFAULT 'paper_trade_candidate',
      decision_role TEXT NOT NULL DEFAULT 'entry',
      candidate_id TEXT,
      position_lifecycle_id TEXT,
      request_id TEXT,
      correlation_id TEXT
    );
    CREATE TABLE decision_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL REFERENCES decision_snapshots(decision_id),
      status TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
  `);
  const insertRun = database.prepare(`
    INSERT INTO research_runs(
      id, started_at, heartbeat_at, completed_at, status, risk_profile,
      options_enabled, universe_size, targets_generated, candidates_selected,
      error_message, config_json, summary_json, worker_identity, request_id,
      correlation_id, recovered_at, recovery_reason, recovery_source
    ) VALUES (?, ?, NULL, ?, 'completed', 'moderate', 1, 51, 4, 1,
              NULL, '{}', NULL, ?, ?, ?, NULL, NULL, NULL)
  `);
  const insertCandidate = database.prepare(`
    INSERT INTO paper_trade_candidates(
      id, decision_id, research_run_id, symbol, as_of, rank, direction, horizon,
      risk_profile, preferred_expression, score, confidence, expected_return,
      estimated_max_loss, estimated_max_profit, rationale,
      relevant_backtest_run_id, historical_win_rate, historical_avg_return,
      historical_max_drawdown, similar_setup_count, option_liquidity_score,
      volatility_score, signal_freshness_days, recent_learning_adjustment,
      directional_accuracy, option_outperformance_accuracy, option_symbol,
      strike, short_strike, decision, decision_reason, strategy_family,
      signal_inputs_json, data_quality_status
    ) VALUES (?, ?, ?, ?, ?, 1, 'long', 'swing', 'moderate', 'equity',
              0.8, 0.75, NULL, NULL, NULL, '[]', NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL,
              'selected', NULL, 'momentum', '{}', 'COMPLETE')
  `);
  for (const suffix of ["1", "2"]) {
    const startedAt = `2026-07-15T12:0${suffix}:00.000Z`;
    const completedAt = `2026-07-15T12:1${suffix}:00.000Z`;
    insertRun.run(
      `run-${suffix}`,
      startedAt,
      completedAt,
      `worker-${suffix}`,
      `request-${suffix}`,
      `correlation-${suffix}`
    );
    insertCandidate.run(
      `candidate-${suffix}`,
      `decision-${suffix}`,
      `run-${suffix}`,
      suffix === "1" ? "SPY" : "QQQ",
      completedAt
    );
  }
  database.exec(`
    INSERT INTO decision_snapshots(decision_id, candidate_id, position_lifecycle_id)
    VALUES
      ('decision-1', 'candidate-1', NULL),
      ('decision-2', 'candidate-2', NULL),
      ('decision-release-4', NULL, 'position-release-4');
    INSERT INTO decision_lifecycle_events(
      event_id, decision_id, status, reason_codes_json, occurred_at,
      source_type, source_id, evidence_json
    ) VALUES
      ('event-1b', 'decision-1', 'REVIEWED', '["REVIEW_APPROVED"]',
       '2026-07-15T12:12:00+00:00', 'review', 'review-1', '{"approved":true}'),
      ('event-1a', 'decision-1', 'SELECTED', '[]',
       '2026-07-15T12:11:00+00:00', 'candidate', 'candidate-1', '{}'),
      ('event-2a', 'decision-2', 'SELECTED', '[]',
       '2026-07-15T12:13:00+00:00', 'candidate', 'candidate-2', '{}'),
      ('event-release-4', 'decision-release-4', 'OPEN', '[]',
       '2026-07-15T12:14:00+00:00', 'position', 'position-release-4', '{}');
  `);
  database.close();
};
