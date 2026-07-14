import type { DatabaseSync } from "node:sqlite";

export const ZERO_DTE_MIGRATION_VERSION = "2026-07-13-zero-dte-level-2";
export const ZERO_DTE_HARDENING_MIGRATION_VERSION =
  "2026-07-13-zero-dte-level-2-hardening";

const zeroDteSchema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zero_dte_configuration_versions (
  configuration_version_id TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  configuration_hash TEXT NOT NULL UNIQUE,
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_configuration_versions_created_at
  ON zero_dte_configuration_versions(created_at);

CREATE TABLE IF NOT EXISTS zero_dte_engine_runs (
  run_id TEXT PRIMARY KEY,
  trading_date TEXT NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL,
  account_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  configuration_version_id TEXT NOT NULL,
  market_timestamp TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  candidates_discovered INTEGER NOT NULL DEFAULT 0,
  candidates_evaluated INTEGER NOT NULL DEFAULT 0,
  candidates_eligible INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  executed_count INTEGER NOT NULL DEFAULT 0,
  shadow_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_summary_json TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(configuration_version_id)
    REFERENCES zero_dte_configuration_versions(configuration_version_id)
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_engine_runs_trading_date
  ON zero_dte_engine_runs(trading_date, started_at);

CREATE INDEX IF NOT EXISTS idx_zero_dte_engine_runs_status
  ON zero_dte_engine_runs(status, started_at);

CREATE TABLE IF NOT EXISTS zero_dte_candidates (
  candidate_id TEXT PRIMARY KEY,
  trading_date TEXT NOT NULL,
  underlying_symbol TEXT NOT NULL,
  option_symbol TEXT NOT NULL,
  playbook TEXT NOT NULL,
  direction TEXT NOT NULL,
  expiration_date TEXT NOT NULL,
  strike REAL NOT NULL,
  state TEXT NOT NULL,
  rank INTEGER,
  score REAL,
  playbook_score REAL,
  signal_strength_adjustment REAL,
  liquidity_adjustment REAL,
  regime_adjustment REAL,
  execution_quality_adjustment REAL,
  risk_penalty REAL,
  stale_data_penalty REAL,
  confidence REAL,
  signal_slope REAL,
  short_window_slope REAL,
  medium_window_slope REAL,
  liquidity_score REAL,
  freshness_score REAL,
  setup_age_seconds INTEGER,
  quote_bid REAL,
  quote_ask REAL,
  quote_midpoint REAL,
  premium REAL,
  spread_pct REAL,
  volume INTEGER,
  open_interest INTEGER,
  implied_volatility REAL,
  delta REAL,
  gamma REAL,
  theta REAL,
  vega REAL,
  market_timestamp TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  state_reason_code TEXT,
  state_reason_json TEXT,
  reappearance_count INTEGER NOT NULL DEFAULT 0,
  blocker_codes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (
    trading_date,
    underlying_symbol,
    option_symbol,
    playbook,
    direction,
    expiration_date,
    strike
  )
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_candidates_trading_date_state
  ON zero_dte_candidates(trading_date, state, score DESC);

CREATE INDEX IF NOT EXISTS idx_zero_dte_candidates_option_symbol
  ON zero_dte_candidates(option_symbol, trading_date);

CREATE TABLE IF NOT EXISTS zero_dte_candidate_observations (
  observation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  engine_run_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  market_timestamp TEXT,
  state TEXT NOT NULL,
  total_score REAL,
  playbook_score REAL,
  confidence REAL,
  signal_slope REAL,
  short_window_slope REAL,
  medium_window_slope REAL,
  liquidity_score REAL,
  freshness_score REAL,
  quote_bid REAL,
  quote_ask REAL,
  quote_midpoint REAL,
  premium REAL,
  spread_pct REAL,
  volume INTEGER,
  open_interest INTEGER,
  implied_volatility REAL,
  delta REAL,
  gamma REAL,
  theta REAL,
  vega REAL,
  peak_score REAL,
  drawdown_score REAL,
  setup_age_seconds INTEGER,
  data_quality_flags_json TEXT NOT NULL DEFAULT '[]',
  supporting_signals_json TEXT NOT NULL DEFAULT '[]',
  opposing_signals_json TEXT NOT NULL DEFAULT '[]',
  blocker_codes_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
  FOREIGN KEY(engine_run_id) REFERENCES zero_dte_engine_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_candidate_observations_candidate_observed_at
  ON zero_dte_candidate_observations(candidate_id, observed_at);

CREATE TABLE IF NOT EXISTS zero_dte_playbook_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  engine_run_id TEXT NOT NULL,
  playbook TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  direction TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0,
  supporting_signals_json TEXT NOT NULL DEFAULT '[]',
  opposing_signals_json TEXT NOT NULL DEFAULT '[]',
  blocker_codes_json TEXT NOT NULL DEFAULT '[]',
  missing_inputs_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  evaluated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(candidate_id, engine_run_id, playbook),
  FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
  FOREIGN KEY(engine_run_id) REFERENCES zero_dte_engine_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_playbook_evaluations_candidate_playbook
  ON zero_dte_playbook_evaluations(candidate_id, playbook, evaluated_at);

CREATE TABLE IF NOT EXISTS zero_dte_decisions (
  decision_id TEXT PRIMARY KEY,
  decision_group_id TEXT NOT NULL,
  engine_run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  action TEXT NOT NULL,
  account_mode TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  configuration_version_id TEXT NOT NULL,
  market_timestamp TEXT,
  decided_at TEXT NOT NULL,
  score REAL,
  score_threshold REAL,
  applied_thresholds_json TEXT NOT NULL DEFAULT '{}',
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  client_order_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(engine_run_id) REFERENCES zero_dte_engine_runs(run_id),
  FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
  FOREIGN KEY(configuration_version_id)
    REFERENCES zero_dte_configuration_versions(configuration_version_id)
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_decisions_group_decided_at
  ON zero_dte_decisions(decision_group_id, decided_at);

CREATE TABLE IF NOT EXISTS zero_dte_paper_trades (
  paper_trade_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  underlying_symbol TEXT NOT NULL,
  option_symbol TEXT NOT NULL,
  playbook TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  client_order_id TEXT,
  broker_order_id TEXT,
  source_ledger_id INTEGER,
  quantity INTEGER NOT NULL,
  entry_premium REAL,
  exit_premium REAL,
  fees REAL NOT NULL DEFAULT 0,
  slippage REAL NOT NULL DEFAULT 0,
  mfe REAL,
  mae REAL,
  realized_pnl REAL,
  return_pct REAL,
  terminal_state TEXT,
  entry_quote_json TEXT,
  exit_quote_json TEXT,
  exit_reason_code TEXT,
  requested_at TEXT,
  submitted_at TEXT,
  filled_at TEXT,
  exit_requested_at TEXT,
  exited_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(decision_id) REFERENCES zero_dte_decisions(decision_id),
  FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_paper_trades_open_status
  ON zero_dte_paper_trades(status, trading_date)
  WHERE status IN ('intended', 'submitted', 'partially_filled', 'open');

CREATE TABLE IF NOT EXISTS zero_dte_shadow_trades (
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
  entry_premium REAL,
  exit_premium REAL,
  fees REAL NOT NULL DEFAULT 0,
  slippage REAL NOT NULL DEFAULT 0,
  mfe REAL,
  mae REAL,
  realized_pnl REAL,
  return_pct REAL,
  terminal_state TEXT,
  fill_assumptions_json TEXT NOT NULL DEFAULT '{}',
  entry_quote_json TEXT,
  exit_quote_json TEXT,
  exit_reason_code TEXT,
  opened_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(decision_id) REFERENCES zero_dte_decisions(decision_id),
  FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_shadow_trades_open_status
  ON zero_dte_shadow_trades(status, trading_date)
  WHERE status IN ('intended', 'open');

CREATE TABLE IF NOT EXISTS zero_dte_position_marks (
  mark_id TEXT PRIMARY KEY,
  paper_trade_id TEXT,
  shadow_trade_id TEXT,
  marked_at TEXT NOT NULL,
  market_timestamp TEXT,
  mark_price REAL,
  bid REAL,
  ask REAL,
  midpoint REAL,
  quote_quality TEXT,
  quantity INTEGER,
  unrealized_pnl REAL,
  return_pct REAL,
  mfe REAL,
  mae REAL,
  source TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(paper_trade_id) REFERENCES zero_dte_paper_trades(paper_trade_id),
  FOREIGN KEY(shadow_trade_id) REFERENCES zero_dte_shadow_trades(shadow_trade_id),
  CHECK ((paper_trade_id IS NOT NULL) <> (shadow_trade_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_position_marks_trade_marked_at
  ON zero_dte_position_marks(marked_at, paper_trade_id, shadow_trade_id);

CREATE TABLE IF NOT EXISTS zero_dte_terminal_outcomes (
  outcome_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  paper_trade_id TEXT,
  shadow_trade_id TEXT,
  decision_id TEXT,
  trading_date TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  horizon_minutes INTEGER,
  terminal_state TEXT NOT NULL,
  terminal_price REAL,
  mfe REAL,
  mae REAL,
  realized_pnl REAL,
  return_pct REAL,
  holding_minutes INTEGER,
  exit_reason_code TEXT,
  completeness_status TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
  FOREIGN KEY(paper_trade_id) REFERENCES zero_dte_paper_trades(paper_trade_id),
  FOREIGN KEY(shadow_trade_id) REFERENCES zero_dte_shadow_trades(shadow_trade_id),
  FOREIGN KEY(decision_id) REFERENCES zero_dte_decisions(decision_id),
  CHECK (
    (paper_trade_id IS NULL AND shadow_trade_id IS NULL)
    OR (paper_trade_id IS NOT NULL AND shadow_trade_id IS NULL)
    OR (paper_trade_id IS NULL AND shadow_trade_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_terminal_outcomes_candidate_recorded_at
  ON zero_dte_terminal_outcomes(candidate_id, evaluated_at);

CREATE TABLE IF NOT EXISTS zero_dte_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  reason_code TEXT,
  engine_run_id TEXT,
  candidate_id TEXT,
  decision_id TEXT,
  decision_group_id TEXT,
  paper_trade_id TEXT,
  shadow_trade_id TEXT,
  account_mode TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  configuration_version_id TEXT NOT NULL,
  market_timestamp TEXT,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(engine_run_id) REFERENCES zero_dte_engine_runs(run_id),
  FOREIGN KEY(candidate_id) REFERENCES zero_dte_candidates(candidate_id),
  FOREIGN KEY(decision_id) REFERENCES zero_dte_decisions(decision_id),
  FOREIGN KEY(paper_trade_id) REFERENCES zero_dte_paper_trades(paper_trade_id),
  FOREIGN KEY(shadow_trade_id) REFERENCES zero_dte_shadow_trades(shadow_trade_id),
  FOREIGN KEY(configuration_version_id)
    REFERENCES zero_dte_configuration_versions(configuration_version_id)
);

CREATE INDEX IF NOT EXISTS idx_zero_dte_lifecycle_events_candidate_occurred_at
  ON zero_dte_lifecycle_events(candidate_id, occurred_at);
`;

const zeroDteUniqueIndexes = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_zero_dte_terminal_outcomes_candidate_only
  ON zero_dte_terminal_outcomes(
    candidate_id,
    outcome_type,
    COALESCE(horizon_minutes, -1)
  )
  WHERE paper_trade_id IS NULL AND shadow_trade_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_zero_dte_terminal_outcomes_paper_trade
  ON zero_dte_terminal_outcomes(
    paper_trade_id,
    outcome_type,
    COALESCE(horizon_minutes, -1)
  )
  WHERE paper_trade_id IS NOT NULL AND shadow_trade_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_zero_dte_terminal_outcomes_shadow_trade
  ON zero_dte_terminal_outcomes(
    shadow_trade_id,
    outcome_type,
    COALESCE(horizon_minutes, -1)
  )
  WHERE paper_trade_id IS NULL AND shadow_trade_id IS NOT NULL;
`;

const zeroDteHardeningSchema = `
CREATE TRIGGER IF NOT EXISTS trg_zero_dte_candidate_observations_engine_run_insert
BEFORE INSERT ON zero_dte_candidate_observations
WHEN NEW.engine_run_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_candidate_observations.engine_run_id is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_candidate_observations_engine_run_update
BEFORE UPDATE ON zero_dte_candidate_observations
WHEN NEW.engine_run_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_candidate_observations.engine_run_id is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_playbook_evaluations_engine_run_insert
BEFORE INSERT ON zero_dte_playbook_evaluations
WHEN NEW.engine_run_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_playbook_evaluations.engine_run_id is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_playbook_evaluations_engine_run_update
BEFORE UPDATE ON zero_dte_playbook_evaluations
WHEN NEW.engine_run_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_playbook_evaluations.engine_run_id is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_decisions_engine_run_insert
BEFORE INSERT ON zero_dte_decisions
WHEN NEW.engine_run_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_decisions.engine_run_id is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_decisions_engine_run_update
BEFORE UPDATE ON zero_dte_decisions
WHEN NEW.engine_run_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_decisions.engine_run_id is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_position_marks_exactly_one_insert
BEFORE INSERT ON zero_dte_position_marks
WHEN (NEW.paper_trade_id IS NOT NULL) = (NEW.shadow_trade_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_position_marks requires exactly one trade domain');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_position_marks_exactly_one_update
BEFORE UPDATE ON zero_dte_position_marks
WHEN (NEW.paper_trade_id IS NOT NULL) = (NEW.shadow_trade_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_position_marks requires exactly one trade domain');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_integrity_insert
BEFORE INSERT ON zero_dte_terminal_outcomes
WHEN NEW.candidate_id IS NULL
  OR (NEW.paper_trade_id IS NOT NULL AND NEW.shadow_trade_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_terminal_outcomes requires a candidate and at most one trade');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_integrity_update
BEFORE UPDATE ON zero_dte_terminal_outcomes
WHEN NEW.candidate_id IS NULL
  OR (NEW.paper_trade_id IS NOT NULL AND NEW.shadow_trade_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_terminal_outcomes requires a candidate and at most one trade');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_paper_candidate_insert
BEFORE INSERT ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM zero_dte_paper_trades
    WHERE paper_trade_id = NEW.paper_trade_id
      AND candidate_id = NEW.candidate_id
  )
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_terminal_outcomes paper trade candidate mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_paper_candidate_update
BEFORE UPDATE ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM zero_dte_paper_trades
    WHERE paper_trade_id = NEW.paper_trade_id
      AND candidate_id = NEW.candidate_id
  )
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_terminal_outcomes paper trade candidate mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_shadow_candidate_insert
BEFORE INSERT ON zero_dte_terminal_outcomes
WHEN NEW.shadow_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM zero_dte_shadow_trades
    WHERE shadow_trade_id = NEW.shadow_trade_id
      AND candidate_id = NEW.candidate_id
  )
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_terminal_outcomes shadow trade candidate mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_shadow_candidate_update
BEFORE UPDATE ON zero_dte_terminal_outcomes
WHEN NEW.shadow_trade_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM zero_dte_shadow_trades
    WHERE shadow_trade_id = NEW.shadow_trade_id
      AND candidate_id = NEW.candidate_id
  )
BEGIN
  SELECT RAISE(ABORT, 'zero_dte_terminal_outcomes shadow trade candidate mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_unique_candidate_insert
BEFORE INSERT ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NULL
  AND NEW.shadow_trade_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM zero_dte_terminal_outcomes AS existing
    WHERE existing.candidate_id = NEW.candidate_id
      AND existing.paper_trade_id IS NULL
      AND existing.shadow_trade_id IS NULL
      AND existing.outcome_type = NEW.outcome_type
      AND COALESCE(existing.horizon_minutes, -1) = COALESCE(NEW.horizon_minutes, -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate zero_dte candidate terminal outcome');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_unique_candidate_update
BEFORE UPDATE ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NULL
  AND NEW.shadow_trade_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM zero_dte_terminal_outcomes AS existing
    WHERE existing.outcome_id <> NEW.outcome_id
      AND existing.candidate_id = NEW.candidate_id
      AND existing.paper_trade_id IS NULL
      AND existing.shadow_trade_id IS NULL
      AND existing.outcome_type = NEW.outcome_type
      AND COALESCE(existing.horizon_minutes, -1) = COALESCE(NEW.horizon_minutes, -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate zero_dte candidate terminal outcome');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_unique_paper_insert
BEFORE INSERT ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NOT NULL
  AND NEW.shadow_trade_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM zero_dte_terminal_outcomes AS existing
    WHERE existing.paper_trade_id = NEW.paper_trade_id
      AND existing.shadow_trade_id IS NULL
      AND existing.outcome_type = NEW.outcome_type
      AND COALESCE(existing.horizon_minutes, -1) = COALESCE(NEW.horizon_minutes, -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate zero_dte paper terminal outcome');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_unique_paper_update
BEFORE UPDATE ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NOT NULL
  AND NEW.shadow_trade_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM zero_dte_terminal_outcomes AS existing
    WHERE existing.outcome_id <> NEW.outcome_id
      AND existing.paper_trade_id = NEW.paper_trade_id
      AND existing.shadow_trade_id IS NULL
      AND existing.outcome_type = NEW.outcome_type
      AND COALESCE(existing.horizon_minutes, -1) = COALESCE(NEW.horizon_minutes, -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate zero_dte paper terminal outcome');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_unique_shadow_insert
BEFORE INSERT ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NULL
  AND NEW.shadow_trade_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM zero_dte_terminal_outcomes AS existing
    WHERE existing.paper_trade_id IS NULL
      AND existing.shadow_trade_id = NEW.shadow_trade_id
      AND existing.outcome_type = NEW.outcome_type
      AND COALESCE(existing.horizon_minutes, -1) = COALESCE(NEW.horizon_minutes, -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate zero_dte shadow terminal outcome');
END;

CREATE TRIGGER IF NOT EXISTS trg_zero_dte_terminal_outcomes_unique_shadow_update
BEFORE UPDATE ON zero_dte_terminal_outcomes
WHEN NEW.paper_trade_id IS NULL
  AND NEW.shadow_trade_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM zero_dte_terminal_outcomes AS existing
    WHERE existing.outcome_id <> NEW.outcome_id
      AND existing.paper_trade_id IS NULL
      AND existing.shadow_trade_id = NEW.shadow_trade_id
      AND existing.outcome_type = NEW.outcome_type
      AND COALESCE(existing.horizon_minutes, -1) = COALESCE(NEW.horizon_minutes, -1)
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate zero_dte shadow terminal outcome');
END;
`;

export const runZeroDteMigrations = (db: DatabaseSync): void => {
  db.exec("PRAGMA foreign_keys = ON;");
  const hasExistingZeroDteSchema = Boolean(
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'zero_dte_engine_runs'"
      )
      .get()
  );
  try {
    db.exec("BEGIN IMMEDIATE;");
    db.exec(zeroDteSchema);
    try {
      db.exec(zeroDteUniqueIndexes);
    } catch (error) {
      if (!hasExistingZeroDteSchema) {
        throw error;
      }
      // Keep existing rows intact. The hardening triggers below still enforce
      // uniqueness for future writes if a legacy database contains duplicates.
    }
    db.exec(zeroDteHardeningSchema);
    const appliedAt = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)"
    ).run(ZERO_DTE_MIGRATION_VERSION, appliedAt);
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)"
    ).run(ZERO_DTE_HARDENING_MIGRATION_VERSION, appliedAt);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original migration failure if rollback is unavailable.
    }
    throw error;
  }
};
