import { DatabaseSync, type DatabaseSync as DbHandle } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isVercelRuntime } from "./runtime.js";
import {
  runZeroDteMigrations,
  ZERO_DTE_HARDENING_MIGRATION_VERSION,
  ZERO_DTE_MIGRATION_VERSION
} from "./zeroDteSchema.js";
import {
  getPendingMigrationVersions,
  runMigrationGroup
} from "./sqliteMigrations.js";
import {
  runSqliteConcurrencyMigration,
  SQLITE_CONCURRENCY_MIGRATION_VERSION
} from "./sqliteConcurrencySchema.js";

export { SQLITE_CONCURRENCY_MIGRATION_VERSION } from "./sqliteConcurrencySchema.js";

export const LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL =
  "LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL";

export const UNIVERSE_LIFECYCLE_MIGRATION_VERSION =
  "2026-07-14-autonomous-universe-lifecycle";
export const PHASE_1B_MIGRATION_VERSION =
  "2026-07-13-market-observatory-phase-1b";
export const RUNTIME_SCHEMA_MIGRATION_VERSION =
  "2026-07-15-paper-runtime-contention-recovery";

export const REQUIRED_RUNTIME_MIGRATION_VERSIONS = [
  RUNTIME_SCHEMA_MIGRATION_VERSION,
  PHASE_1B_MIGRATION_VERSION,
  UNIVERSE_LIFECYCLE_MIGRATION_VERSION,
  ZERO_DTE_MIGRATION_VERSION,
  ZERO_DTE_HARDENING_MIGRATION_VERSION,
  SQLITE_CONCURRENCY_MIGRATION_VERSION
] as const;

export class DatabaseMigrationRequiredError extends Error {
  code = "DATABASE_MIGRATION_REQUIRED";
  pendingVersions: string[];

  constructor(pendingVersions: string[]) {
    super(
      `DATABASE_MIGRATION_REQUIRED: run db:migrate before runtime startup. Pending: ${pendingVersions.join(", ")}`
    );
    this.name = "DatabaseMigrationRequiredError";
    this.pendingVersions = pendingVersions;
  }
}

export class LocalSqliteUnavailableError extends Error {
  code = LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL;

  constructor(dbPath: string) {
    super(
      `Local SQLite persistence is unavailable for Vercel app bundle path: ${dbPath}`
    );
    this.name = "LocalSqliteUnavailableError";
  }
}

export const getResearchDbPath = () =>
  process.env.RESEARCH_DB_PATH ?? `${process.cwd()}/data/research.db`;

const isVercelBundlePath = (dbPath: string) =>
  resolve(dbPath).startsWith("/var/task/");

const tableSchema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS universe_symbols (
  symbol TEXT PRIMARY KEY,
  asset_class TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  tradable INTEGER NOT NULL DEFAULT 1,
  asset_id TEXT,
  asset_status TEXT,
  exchange TEXT,
  fractionable INTEGER,
  shortable INTEGER,
  marginable INTEGER,
  options_enabled INTEGER,
  asset_attributes_json TEXT,
  asset_validated_at TEXT,
  asset_request_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'research_eligible',
  lifecycle_reason_code TEXT NOT NULL DEFAULT 'LEGACY_SEED',
  lifecycle_entered_at TEXT,
  lifecycle_updated_at TEXT,
  lifecycle_config_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_bars (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(symbol, timeframe, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_market_bars_symbol_timeframe_timestamp
  ON market_bars(symbol, timeframe, timestamp);

CREATE TABLE IF NOT EXISTS stock_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingestion_run_id INTEGER,
  symbol TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_timestamp TEXT,
  requested_feed TEXT NOT NULL,
  effective_feed TEXT NOT NULL,
  currency TEXT,
  latest_trade_price REAL,
  latest_trade_size REAL,
  latest_trade_exchange TEXT,
  latest_trade_conditions_json TEXT NOT NULL,
  trade_timestamp TEXT,
  bid_price REAL,
  ask_price REAL,
  bid_size REAL,
  ask_size REAL,
  bid_exchange TEXT,
  ask_exchange TEXT,
  quote_conditions_json TEXT NOT NULL,
  quote_timestamp TEXT,
  midpoint REAL,
  spread REAL,
  spread_pct REAL,
  minute_timestamp TEXT,
  minute_open REAL,
  minute_high REAL,
  minute_low REAL,
  minute_close REAL,
  minute_volume REAL,
  minute_trade_count REAL,
  minute_vwap REAL,
  daily_timestamp TEXT,
  daily_open REAL,
  daily_high REAL,
  daily_low REAL,
  daily_close REAL,
  daily_volume REAL,
  daily_trade_count REAL,
  daily_vwap REAL,
  previous_daily_timestamp TEXT,
  previous_daily_open REAL,
  previous_daily_high REAL,
  previous_daily_low REAL,
  previous_daily_close REAL,
  previous_daily_volume REAL,
  previous_daily_trade_count REAL,
  previous_daily_vwap REAL,
  daily_return REAL,
  gap_from_previous_close REAL,
  return_from_open REAL,
  distance_from_vwap REAL,
  intraday_range REAL,
  relative_current_day_volume REAL,
  freshness_status TEXT NOT NULL,
  data_quality_status TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT,
  error_summary TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_snapshots_dedupe
  ON stock_snapshots(symbol, requested_feed, source_timestamp);

CREATE INDEX IF NOT EXISTS idx_stock_snapshots_symbol_observed
  ON stock_snapshots(symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_snapshots_freshness
  ON stock_snapshots(freshness_status);

CREATE INDEX IF NOT EXISTS idx_stock_snapshots_source_timestamp
  ON stock_snapshots(source_timestamp);

CREATE INDEX IF NOT EXISTS idx_stock_snapshots_ingestion_run
  ON stock_snapshots(ingestion_run_id);

CREATE TABLE IF NOT EXISTS option_contracts (
  underlying_symbol TEXT NOT NULL,
  option_symbol TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  expiration_date TEXT NOT NULL,
  strike REAL NOT NULL,
  multiplier REAL NOT NULL,
  tradable INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_option_contracts_underlying
  ON option_contracts(underlying_symbol);

CREATE TABLE IF NOT EXISTS option_snapshots (
  option_symbol TEXT NOT NULL,
  underlying_symbol TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  bid REAL,
  ask REAL,
  midpoint REAL,
  last REAL,
  quote_status TEXT,
  executable INTEGER NOT NULL DEFAULT 0,
  executable_price REAL,
  executable_price_source TEXT,
  rejection_reason TEXT,
  quote_timestamp TEXT,
  bid_size REAL,
  ask_size REAL,
  trade_size REAL,
  trade_timestamp TEXT,
  volume INTEGER,
  open_interest INTEGER,
  implied_volatility REAL,
  delta REAL,
  gamma REAL,
  theta REAL,
  vega REAL,
  rho REAL,
  snapshot_timestamp TEXT,
  normalization_path TEXT,
  source TEXT NOT NULL,
  UNIQUE(option_symbol, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_option_snapshots_underlying_timestamp
  ON option_snapshots(underlying_symbol, timestamp);

CREATE TABLE IF NOT EXISTS feature_snapshots (
  symbol TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  features TEXT NOT NULL,
  PRIMARY KEY(symbol, timestamp)
);

CREATE TABLE IF NOT EXISTS target_snapshots (
  symbol TEXT NOT NULL,
  as_of TEXT NOT NULL,
  direction TEXT NOT NULL,
  horizon TEXT NOT NULL,
  entry_reference REAL NOT NULL,
  upside_target REAL NOT NULL,
  downside_risk REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  confidence REAL NOT NULL,
  expected_return REAL,
  volatility_adjusted_score REAL,
  risk_profile TEXT NOT NULL,
  preferred_expression TEXT NOT NULL,
  rationale TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS options_strategy_snapshots (
  symbol TEXT NOT NULL,
  as_of TEXT NOT NULL,
  direction TEXT NOT NULL,
  preferred_expression TEXT NOT NULL,
  alternatives TEXT NOT NULL,
  rationale TEXT NOT NULL,
  options_candidate TEXT
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL,
  symbols TEXT NOT NULL,
  timeframe TEXT,
  start_date TEXT,
  end_date TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  rows_ingested INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  requested_symbols INTEGER NOT NULL DEFAULT 0,
  successful_symbols INTEGER NOT NULL DEFAULT 0,
  failed_symbols INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  metrics_json TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  run_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  pnl REAL NOT NULL,
  return_pct REAL NOT NULL,
  exit_reason TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES backtest_runs(id)
);

CREATE TABLE IF NOT EXISTS backtest_options_trades (
  run_id TEXT NOT NULL,
  underlying_symbol TEXT NOT NULL,
  option_symbol TEXT,
  strategy TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  expiration_date TEXT,
  strike REAL,
  short_strike REAL,
  entry_premium REAL,
  exit_premium REAL,
  contracts REAL NOT NULL,
  estimated_max_loss REAL,
  estimated_max_profit REAL,
  pnl REAL NOT NULL,
  return_pct REAL NOT NULL,
  exit_reason TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES backtest_runs(id)
);

CREATE TABLE IF NOT EXISTS learning_runs (
  id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL,
  trained_at TEXT NOT NULL,
  horizon TEXT NOT NULL,
  universe_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  feature_importance_json TEXT,
  strategy_performance_json TEXT,
  notes_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_runs (
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

CREATE TABLE IF NOT EXISTS paper_trade_candidates (
  id TEXT PRIMARY KEY,
  research_run_id TEXT NOT NULL,
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
  decision TEXT NOT NULL DEFAULT 'selected',
  decision_reason TEXT,
  strategy_family TEXT,
  signal_inputs_json TEXT NOT NULL DEFAULT '{}',
  data_quality_status TEXT NOT NULL DEFAULT 'UNOBSERVED',
  FOREIGN KEY(research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_trade_plans (
  id TEXT PRIMARY KEY,
  research_run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  direction TEXT NOT NULL,
  expression TEXT NOT NULL,
  entry_reference REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  expiration_date TEXT,
  option_symbol TEXT,
  strike REAL,
  short_strike REAL,
  estimated_entry_cost REAL,
  estimated_max_loss REAL,
  estimated_max_profit REAL,
  thesis TEXT NOT NULL,
  invalidation TEXT NOT NULL,
  learning_objective TEXT NOT NULL,
  last_evaluated_at TEXT,
  last_outcome TEXT,
  last_return_pct REAL,
  FOREIGN KEY(candidate_id) REFERENCES paper_trade_candidates(id) ON DELETE CASCADE,
  FOREIGN KEY(research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_trade_evaluations (
  id TEXT PRIMARY KEY,
  research_run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  horizon TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  mark_price REAL,
  estimated_exit_value REAL,
  unrealized_pnl REAL,
  realized_pnl REAL,
  return_pct REAL,
  outcome TEXT NOT NULL,
  notes TEXT NOT NULL,
  FOREIGN KEY(plan_id) REFERENCES paper_trade_plans(id) ON DELETE CASCADE,
  FOREIGN KEY(candidate_id) REFERENCES paper_trade_candidates(id) ON DELETE CASCADE,
  FOREIGN KEY(research_run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_recommendation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  group_by TEXT NOT NULL,
  group_key TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  evaluated_count INTEGER NOT NULL,
  unevaluated_count INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  avg_return_pct REAL NOT NULL,
  median_return_pct REAL NOT NULL,
  best_return_pct REAL NOT NULL,
  worst_return_pct REAL NOT NULL,
  avg_rank REAL NOT NULL,
  recommendation_flag TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_recommendation_snapshots_created_at
  ON paper_recommendation_snapshots(created_at);

CREATE INDEX IF NOT EXISTS idx_paper_recommendation_snapshots_run
  ON paper_recommendation_snapshots(snapshot_run_id);

CREATE INDEX IF NOT EXISTS idx_paper_recommendation_snapshots_group
  ON paper_recommendation_snapshots(group_by, group_key);

CREATE TABLE IF NOT EXISTS paper_execution_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  underlying_symbol TEXT,
  strategy TEXT,
  side TEXT,
  order_type TEXT,
  time_in_force TEXT,
  qty TEXT,
  notional TEXT,
  limit_price TEXT,
  estimated_premium REAL,
  max_risk REAL,
  dedupe_key TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  alpaca_order_id TEXT,
  alpaca_status TEXT,
  request_id TEXT,
  source_plan_id TEXT,
  source_candidate_id TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  blocked_reason TEXT,
  error_message TEXT,
  payload_json TEXT NOT NULL,
  raw_payload_json TEXT,
  raw_response_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_execution_ledger_created_at
  ON paper_execution_ledger(created_at);

CREATE INDEX IF NOT EXISTS idx_paper_execution_ledger_symbol
  ON paper_execution_ledger(symbol, asset_class);

CREATE INDEX IF NOT EXISTS idx_paper_execution_ledger_dedupe_key
  ON paper_execution_ledger(dedupe_key);

CREATE TABLE IF NOT EXISTS paper_reconciliation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_qty TEXT,
  recent_buy_fill_order_ids_json TEXT NOT NULL,
  sell_fills_found INTEGER NOT NULL DEFAULT 0,
  non_fill_adjustment_activities_found INTEGER NOT NULL DEFAULT 0,
  account_cash TEXT,
  account_equity TEXT,
  account_position_market_value TEXT,
  sum_positions_market_value REAL NOT NULL DEFAULT 0,
  alpaca_request_ids_json TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_reconciliation_events_symbol_created_at
  ON paper_reconciliation_events(symbol, created_at);

CREATE TABLE IF NOT EXISTS paper_learning_records (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  strategy_family TEXT NOT NULL,
  symbol TEXT NOT NULL,
  underlying_symbol TEXT,
  option_symbol TEXT,
  decision TEXT NOT NULL,
  skip_reason TEXT,
  block_reason TEXT,
  hypothesis TEXT NOT NULL,
  signal_inputs_json TEXT NOT NULL,
  option_metadata_json TEXT,
  quote_snapshot_json TEXT,
  paper_fill_model_json TEXT,
  live_like_fill_model_json TEXT,
  risk_model_json TEXT,
  outcome_json TEXT,
  evaluation_reason TEXT,
  learning_status TEXT NOT NULL,
  promotion_eligible INTEGER NOT NULL DEFAULT 0,
  promotion_block_reason TEXT,
  source_research_run_id TEXT,
  source_candidate_id TEXT,
  source_plan_timestamp TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_learning_records_created_at
  ON paper_learning_records(created_at);

CREATE INDEX IF NOT EXISTS idx_paper_learning_records_strategy_status
  ON paper_learning_records(strategy_family, learning_status);

CREATE INDEX IF NOT EXISTS idx_paper_learning_records_option_symbol
  ON paper_learning_records(option_symbol);

CREATE TABLE IF NOT EXISTS paper_learning_governance_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  scanned_records INTEGER NOT NULL DEFAULT 0,
  valid_outcomes INTEGER NOT NULL DEFAULT 0,
  decisions_written INTEGER NOT NULL DEFAULT 0,
  git_sha TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  summary_json TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS paper_learning_governance_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('strategy_family', 'symbol')),
  scope_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('observe', 'prioritized', 'suspended')),
  priority_multiplier REAL NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  superseded_at TEXT,
  git_sha TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES paper_learning_governance_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_paper_learning_governance_runs_started_at
  ON paper_learning_governance_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_learning_governance_decisions_scope
  ON paper_learning_governance_decisions(scope_type, scope_key, effective_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_learning_governance_decisions_current
  ON paper_learning_governance_decisions(scope_type, scope_key)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS autonomous_recovery_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  recovered_universe_lifecycle_runs INTEGER NOT NULL DEFAULT 0,
  recovered_learning_governance_runs INTEGER NOT NULL DEFAULT 0,
  recovered_paper_operations INTEGER NOT NULL DEFAULT 0,
  recovered_research_runs INTEGER NOT NULL DEFAULT 0,
  git_sha TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_autonomous_recovery_runs_started_at
  ON autonomous_recovery_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS autonomous_recovery_events (
  id TEXT PRIMARY KEY,
  recovery_run_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  recovery_code TEXT NOT NULL,
  recovered_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  git_sha TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  FOREIGN KEY(recovery_run_id) REFERENCES autonomous_recovery_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_autonomous_recovery_events_run
  ON autonomous_recovery_events(recovery_run_id, recovered_at DESC);

CREATE INDEX IF NOT EXISTS idx_autonomous_recovery_events_source
  ON autonomous_recovery_events(source_table, source_id, recovered_at DESC);

CREATE TABLE IF NOT EXISTS paper_operation_log (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  request_id TEXT,
  correlation_id TEXT,
  command TEXT,
  summary_json TEXT,
  warnings_json TEXT,
  blockers_json TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_operation_log_started_at
  ON paper_operation_log(started_at);

CREATE TABLE IF NOT EXISTS paper_review_artifacts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source_action TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_signature TEXT NOT NULL,
  payload_count INTEGER NOT NULL,
  artifact_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_review_artifacts_created_at
  ON paper_review_artifacts(created_at);

CREATE TABLE IF NOT EXISTS hedge_execution_reviews (
  review_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  review_type TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  account_hash TEXT NOT NULL,
  source_recommendation_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,
  review_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hedge_execution_reviews_expires_at
  ON hedge_execution_reviews(expires_at);

CREATE TABLE IF NOT EXISTS hedge_learning_events (
  event_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hedge_learning_events_review_id
  ON hedge_learning_events(review_id, created_at);

CREATE TABLE IF NOT EXISTS portfolio_high_water_marks (
  environment TEXT PRIMARY KEY,
  equity REAL NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_beta_cache (
  symbol TEXT NOT NULL,
  benchmark TEXT NOT NULL,
  lookback_days INTEGER NOT NULL,
  observation_interval TEXT NOT NULL,
  minimum_observations INTEGER NOT NULL,
  calculation_version TEXT NOT NULL,
  latest_market_data_date TEXT NOT NULL,
  beta REAL,
  observations INTEGER NOT NULL,
  data_start_date TEXT,
  data_end_date TEXT,
  status TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (
    symbol,
    benchmark,
    lookback_days,
    observation_interval,
    minimum_observations,
    calculation_version,
    latest_market_data_date
  )
);

CREATE INDEX IF NOT EXISTS idx_portfolio_beta_cache_expires_at
  ON portfolio_beta_cache(expires_at);
`;

const phase1BSchema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_snapshots (
  decision_id TEXT PRIMARY KEY,
  origin_type TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  decision_role TEXT NOT NULL,
  candidate_id TEXT,
  position_lifecycle_id TEXT,
  created_at TEXT NOT NULL,
  strategy_family TEXT,
  symbol TEXT,
  underlying_symbol TEXT,
  option_symbol TEXT,
  research_run_id TEXT,
  candidate_rank INTEGER,
  candidate_status TEXT,
  decision_status TEXT NOT NULL,
  score REAL,
  confidence REAL,
  reason_codes_json TEXT NOT NULL,
  rationale TEXT,
  signal_inputs_json TEXT NOT NULL,
  market_state_json TEXT,
  instrument_state_json TEXT,
  portfolio_state_json TEXT,
  risk_state_json TEXT,
  data_quality_status TEXT NOT NULL,
  source_timestamps_json TEXT NOT NULL,
  environment TEXT NOT NULL,
  git_sha TEXT,
  config_allowlist_version TEXT NOT NULL,
  strategy_config_hash TEXT,
  risk_config_hash TEXT,
  broker_request_id TEXT,
  market_data_request_id TEXT,
  feed TEXT,
  UNIQUE(origin_type, origin_id, decision_role)
);

CREATE INDEX IF NOT EXISTS idx_decision_snapshots_candidate
  ON decision_snapshots(candidate_id);
CREATE INDEX IF NOT EXISTS idx_decision_snapshots_position
  ON decision_snapshots(position_lifecycle_id);
CREATE INDEX IF NOT EXISTS idx_decision_snapshots_symbol_created
  ON decision_snapshots(symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_snapshots_research
  ON decision_snapshots(research_run_id);

CREATE TABLE IF NOT EXISTS decision_lifecycle_events (
  event_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  UNIQUE(decision_id, status, source_type, source_id),
  FOREIGN KEY(decision_id) REFERENCES decision_snapshots(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_decision_lifecycle_events_decision
  ON decision_lifecycle_events(decision_id, occurred_at);

CREATE TABLE IF NOT EXISTS paper_review_decisions (
  artifact_id TEXT NOT NULL,
  section TEXT NOT NULL,
  payload_index INTEGER NOT NULL,
  decision_id TEXT NOT NULL,
  decision_role TEXT NOT NULL,
  PRIMARY KEY(artifact_id, section, payload_index, decision_id),
  FOREIGN KEY(artifact_id) REFERENCES paper_review_artifacts(id),
  FOREIGN KEY(decision_id) REFERENCES decision_snapshots(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_review_decisions_decision
  ON paper_review_decisions(decision_id);

CREATE TABLE IF NOT EXISTS paper_positions (
  position_lifecycle_id TEXT PRIMARY KEY,
  entry_decision_id TEXT NOT NULL,
  terminal_exit_decision_id TEXT,
  symbol TEXT NOT NULL,
  option_symbol TEXT,
  asset_class TEXT NOT NULL,
  side TEXT NOT NULL,
  broker_entry_order_id TEXT,
  entry_client_order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  entry_quantity REAL,
  entry_price REAL,
  linkage_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(entry_client_order_id),
  FOREIGN KEY(entry_decision_id) REFERENCES decision_snapshots(decision_id),
  FOREIGN KEY(terminal_exit_decision_id) REFERENCES decision_snapshots(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_symbol_status
  ON paper_positions(symbol, status);
CREATE INDEX IF NOT EXISTS idx_paper_positions_entry_decision
  ON paper_positions(entry_decision_id);
CREATE INDEX IF NOT EXISTS idx_paper_positions_broker_order
  ON paper_positions(broker_entry_order_id);

CREATE TABLE IF NOT EXISTS paper_position_observations (
  observation_id TEXT PRIMARY KEY,
  broker_symbol_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  option_symbol TEXT,
  observed_at TEXT NOT NULL,
  source_timestamp TEXT,
  broker_request_id TEXT,
  market_data_request_id TEXT,
  feed TEXT,
  underlying_price REAL,
  bid REAL,
  ask REAL,
  midpoint REAL,
  mark REAL,
  quantity REAL,
  average_entry_price REAL,
  market_value REAL,
  unrealized_pnl REAL,
  unrealized_return REAL,
  realized_pnl REAL,
  delta REAL,
  gamma REAL,
  theta REAL,
  vega REAL,
  rho REAL,
  implied_volatility REAL,
  quote_freshness TEXT,
  data_quality_status TEXT NOT NULL,
  portfolio_state_json TEXT,
  risk_state_json TEXT,
  evidence_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_position_observations_symbol_time
  ON paper_position_observations(symbol, observed_at);

CREATE TABLE IF NOT EXISTS paper_position_observation_links (
  observation_id TEXT NOT NULL,
  position_lifecycle_id TEXT NOT NULL,
  decision_id TEXT,
  linkage_status TEXT NOT NULL,
  PRIMARY KEY(observation_id, position_lifecycle_id),
  FOREIGN KEY(observation_id) REFERENCES paper_position_observations(observation_id),
  FOREIGN KEY(position_lifecycle_id) REFERENCES paper_positions(position_lifecycle_id),
  FOREIGN KEY(decision_id) REFERENCES decision_snapshots(decision_id)
);

CREATE INDEX IF NOT EXISTS idx_position_observation_links_lifecycle
  ON paper_position_observation_links(position_lifecycle_id, observation_id);

CREATE TABLE IF NOT EXISTS paper_position_outcomes (
  outcome_id TEXT PRIMARY KEY,
  position_lifecycle_id TEXT NOT NULL UNIQUE,
  entry_decision_id TEXT NOT NULL,
  exit_decision_id TEXT,
  terminal_status TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  realized_pnl REAL,
  realized_return_pct REAL,
  unrealized_return_pct REAL,
  option_position_return_pct REAL,
  underlying_return_pct REAL,
  holding_duration_ms INTEGER,
  mfe_pct REAL,
  mae_pct REAL,
  time_to_mfe_ms INTEGER,
  time_to_mae_ms INTEGER,
  time_to_first_profit_ms INTEGER,
  maximum_runup_pct REAL,
  maximum_drawdown_pct REAL,
  exit_reason_code TEXT,
  data_quality_status TEXT NOT NULL,
  completeness_status TEXT NOT NULL,
  evaluation_reason TEXT,
  calculation_basis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(position_lifecycle_id) REFERENCES paper_positions(position_lifecycle_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_position_outcomes_entry_decision
  ON paper_position_outcomes(entry_decision_id);

CREATE TABLE IF NOT EXISTS paper_position_outcome_revisions (
  revision_id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  supersedes_revision_id TEXT,
  correction_reason TEXT NOT NULL,
  corrected_fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(outcome_id, revision_number),
  FOREIGN KEY(outcome_id) REFERENCES paper_position_outcomes(outcome_id),
  FOREIGN KEY(supersedes_revision_id) REFERENCES paper_position_outcome_revisions(revision_id)
);
`;

let database: DbHandle | null = null;

const addColumnIfMissing = (db: DbHandle, table: string, column: string, ddl: string) => {
  const existing = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (existing.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
};

const tableExists = (db: DbHandle, table: string) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  );

const addPhase1BColumn = (
  db: DbHandle,
  table: string,
  column: string,
  ddl: string
) => {
  if (tableExists(db, table)) {
    addColumnIfMissing(db, table, column, ddl);
  }
};

const exactCandidateBackfill = (
  db: DbHandle,
  table: string,
  candidateColumn: string
) => {
  if (!tableExists(db, table) || !tableExists(db, "paper_trade_candidates")) {
    return;
  }
  db.exec(`
    UPDATE ${table}
    SET decision_id = (
          SELECT c.decision_id
          FROM paper_trade_candidates c
          WHERE c.id = ${table}.${candidateColumn}
        ),
        decision_linkage_status = 'EXACT_LEGACY_REUSE'
    WHERE decision_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM paper_trade_candidates c
        WHERE c.id = ${table}.${candidateColumn}
          AND c.decision_id IS NOT NULL
      );
  `);
};

export const runPhase1BMigrations = (db: DbHandle) => {
  runMigrationGroup(
    db,
    [PHASE_1B_MIGRATION_VERSION, UNIVERSE_LIFECYCLE_MIGRATION_VERSION],
    () => {
      db.exec(phase1BSchema);

    addPhase1BColumn(db, "paper_trade_candidates", "decision_id", "decision_id TEXT");
    addPhase1BColumn(
      db,
      "paper_trade_candidates",
      "decision_linkage_status",
      "decision_linkage_status TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED'"
    );
    addPhase1BColumn(db, "paper_trade_plans", "decision_id", "decision_id TEXT");
    addPhase1BColumn(
      db,
      "paper_trade_plans",
      "decision_linkage_status",
      "decision_linkage_status TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED'"
    );
    addPhase1BColumn(db, "paper_trade_evaluations", "decision_id", "decision_id TEXT");
    addPhase1BColumn(
      db,
      "paper_trade_evaluations",
      "decision_linkage_status",
      "decision_linkage_status TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED'"
    );
    addPhase1BColumn(db, "paper_execution_ledger", "decision_id", "decision_id TEXT");
    addPhase1BColumn(db, "paper_execution_ledger", "position_lifecycle_id", "position_lifecycle_id TEXT");
    addPhase1BColumn(
      db,
      "paper_execution_ledger",
      "decision_linkage_status",
      "decision_linkage_status TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED'"
    );
    addPhase1BColumn(db, "paper_learning_records", "decision_id", "decision_id TEXT");
    addPhase1BColumn(db, "paper_learning_records", "entry_decision_id", "entry_decision_id TEXT");
    addPhase1BColumn(db, "paper_learning_records", "exit_decision_id", "exit_decision_id TEXT");
    addPhase1BColumn(db, "paper_learning_records", "position_lifecycle_id", "position_lifecycle_id TEXT");
    addPhase1BColumn(db, "paper_learning_records", "outcome_id", "outcome_id TEXT");
    addPhase1BColumn(
      db,
      "paper_learning_records",
      "effective_outcome_revision_id",
      "effective_outcome_revision_id TEXT"
    );
    addPhase1BColumn(
      db,
      "paper_learning_records",
      "outcome_completeness_status",
      "outcome_completeness_status TEXT"
    );
    addPhase1BColumn(
      db,
      "paper_learning_records",
      "decision_linkage_status",
      "decision_linkage_status TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED'"
    );
    addPhase1BColumn(db, "hedge_execution_reviews", "decision_id", "decision_id TEXT");
    addPhase1BColumn(db, "hedge_execution_reviews", "decision_role", "decision_role TEXT");
    addPhase1BColumn(db, "hedge_execution_reviews", "position_lifecycle_id", "position_lifecycle_id TEXT");
    addPhase1BColumn(
      db,
      "hedge_execution_reviews",
      "decision_linkage_status",
      "decision_linkage_status TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED'"
    );
    addPhase1BColumn(db, "hedge_learning_events", "decision_id", "decision_id TEXT");
    addPhase1BColumn(db, "hedge_learning_events", "position_lifecycle_id", "position_lifecycle_id TEXT");
    addPhase1BColumn(
      db,
      "hedge_learning_events",
      "decision_linkage_status",
      "decision_linkage_status TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED'"
    );

    if (tableExists(db, "paper_trade_candidates")) {
      db.exec(`
        UPDATE paper_trade_candidates
        SET decision_id = id,
            decision_linkage_status = 'EXACT_LEGACY_REUSE'
        WHERE decision_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_trade_candidates_decision_id
          ON paper_trade_candidates(decision_id)
          WHERE decision_id IS NOT NULL;
      `);
    }
    exactCandidateBackfill(db, "paper_trade_plans", "candidate_id");
    exactCandidateBackfill(db, "paper_trade_evaluations", "candidate_id");
    exactCandidateBackfill(db, "paper_execution_ledger", "source_candidate_id");
    exactCandidateBackfill(db, "paper_learning_records", "source_candidate_id");

    const indexStatements = [
      ["paper_trade_plans", "CREATE INDEX IF NOT EXISTS idx_paper_trade_plans_decision_id ON paper_trade_plans(decision_id)"],
      ["paper_trade_evaluations", "CREATE INDEX IF NOT EXISTS idx_paper_trade_evaluations_decision_id ON paper_trade_evaluations(decision_id)"],
      ["paper_execution_ledger", "CREATE INDEX IF NOT EXISTS idx_paper_execution_decision_id ON paper_execution_ledger(decision_id)"],
      ["paper_execution_ledger", "CREATE INDEX IF NOT EXISTS idx_paper_execution_position_lifecycle ON paper_execution_ledger(position_lifecycle_id)"],
      ["paper_learning_records", "CREATE INDEX IF NOT EXISTS idx_paper_learning_decision_id ON paper_learning_records(decision_id)"],
      ["paper_learning_records", "CREATE INDEX IF NOT EXISTS idx_paper_learning_entry_decision_id ON paper_learning_records(entry_decision_id)"],
      ["paper_learning_records", "CREATE INDEX IF NOT EXISTS idx_paper_learning_position_lifecycle ON paper_learning_records(position_lifecycle_id)"],
      ["paper_learning_records", "CREATE INDEX IF NOT EXISTS idx_paper_learning_outcome_id ON paper_learning_records(outcome_id)"],
      ["hedge_execution_reviews", "CREATE INDEX IF NOT EXISTS idx_hedge_execution_reviews_decision_id ON hedge_execution_reviews(decision_id)"],
      ["hedge_learning_events", "CREATE INDEX IF NOT EXISTS idx_hedge_learning_events_decision_id ON hedge_learning_events(decision_id)"]
    ] as const;
    for (const [table, sql] of indexStatements) {
      if (tableExists(db, table)) {
        db.exec(sql);
      }
    }

    }
  );
};

const universeLifecycleSchema = `
CREATE TABLE IF NOT EXISTS universe_lifecycle_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  discovery_cursor_start TEXT,
  discovery_cursor_end TEXT,
  assets_scanned INTEGER NOT NULL DEFAULT 0,
  assets_discovered INTEGER NOT NULL DEFAULT 0,
  symbols_assessed INTEGER NOT NULL DEFAULT 0,
  transitions_applied INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  git_sha TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_universe_lifecycle_runs_completed
  ON universe_lifecycle_runs(completed_at);

CREATE TABLE IF NOT EXISTS universe_lifecycle_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  git_sha TEXT NOT NULL,
  config_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES universe_lifecycle_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_universe_lifecycle_events_symbol_occurred
  ON universe_lifecycle_events(symbol, occurred_at);
CREATE INDEX IF NOT EXISTS idx_universe_lifecycle_events_run
  ON universe_lifecycle_events(run_id);
`;

const runMigrations = (db: DbHandle) => {
  addColumnIfMissing(db, "universe_symbols", "asset_id", "asset_id TEXT");
  addColumnIfMissing(db, "universe_symbols", "asset_status", "asset_status TEXT");
  addColumnIfMissing(db, "universe_symbols", "exchange", "exchange TEXT");
  addColumnIfMissing(db, "universe_symbols", "fractionable", "fractionable INTEGER");
  addColumnIfMissing(db, "universe_symbols", "shortable", "shortable INTEGER");
  addColumnIfMissing(db, "universe_symbols", "marginable", "marginable INTEGER");
  addColumnIfMissing(db, "universe_symbols", "options_enabled", "options_enabled INTEGER");
  addColumnIfMissing(db, "universe_symbols", "asset_attributes_json", "asset_attributes_json TEXT");
  addColumnIfMissing(db, "universe_symbols", "asset_validated_at", "asset_validated_at TEXT");
  addColumnIfMissing(db, "universe_symbols", "asset_request_id", "asset_request_id TEXT");
  addColumnIfMissing(
    db,
    "universe_symbols",
    "lifecycle_state",
    "lifecycle_state TEXT NOT NULL DEFAULT 'research_eligible'"
  );
  addColumnIfMissing(
    db,
    "universe_symbols",
    "lifecycle_reason_code",
    "lifecycle_reason_code TEXT NOT NULL DEFAULT 'LEGACY_SEED'"
  );
  addColumnIfMissing(
    db,
    "universe_symbols",
    "lifecycle_entered_at",
    "lifecycle_entered_at TEXT"
  );
  addColumnIfMissing(
    db,
    "universe_symbols",
    "lifecycle_updated_at",
    "lifecycle_updated_at TEXT"
  );
  addColumnIfMissing(
    db,
    "universe_symbols",
    "lifecycle_config_version",
    "lifecycle_config_version TEXT"
  );
  db.exec(universeLifecycleSchema);
  addColumnIfMissing(db, "ingestion_runs", "requested_symbols", "requested_symbols INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "ingestion_runs", "successful_symbols", "successful_symbols INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "ingestion_runs", "failed_symbols", "failed_symbols INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "ingestion_runs", "error_summary", "error_summary TEXT");
  addColumnIfMissing(db, "paper_trade_candidates", "decision", "decision TEXT NOT NULL DEFAULT 'selected'");
  addColumnIfMissing(db, "paper_trade_candidates", "decision_reason", "decision_reason TEXT");
  addColumnIfMissing(db, "paper_trade_candidates", "strategy_family", "strategy_family TEXT");
  addColumnIfMissing(db, "paper_trade_candidates", "signal_inputs_json", "signal_inputs_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "paper_trade_candidates", "data_quality_status", "data_quality_status TEXT NOT NULL DEFAULT 'UNOBSERVED'");
  addColumnIfMissing(db, "option_snapshots", "quote_status", "quote_status TEXT");
  addColumnIfMissing(db, "option_snapshots", "executable", "executable INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "option_snapshots", "executable_price", "executable_price REAL");
  addColumnIfMissing(db, "option_snapshots", "executable_price_source", "executable_price_source TEXT");
  addColumnIfMissing(db, "option_snapshots", "rejection_reason", "rejection_reason TEXT");
  addColumnIfMissing(db, "option_snapshots", "quote_timestamp", "quote_timestamp TEXT");
  addColumnIfMissing(db, "option_snapshots", "bid_size", "bid_size REAL");
  addColumnIfMissing(db, "option_snapshots", "ask_size", "ask_size REAL");
  addColumnIfMissing(db, "option_snapshots", "trade_size", "trade_size REAL");
  addColumnIfMissing(db, "option_snapshots", "trade_timestamp", "trade_timestamp TEXT");
  addColumnIfMissing(db, "option_snapshots", "snapshot_timestamp", "snapshot_timestamp TEXT");
  addColumnIfMissing(db, "option_snapshots", "normalization_path", "normalization_path TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "side", "side TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "order_type", "order_type TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "time_in_force", "time_in_force TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "qty", "qty TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "notional", "notional TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "limit_price", "limit_price TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "estimated_premium", "estimated_premium REAL");
  addColumnIfMissing(db, "paper_execution_ledger", "max_risk", "max_risk REAL");
  addColumnIfMissing(db, "paper_execution_ledger", "alpaca_status", "alpaca_status TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "source_plan_id", "source_plan_id TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "source_candidate_id", "source_candidate_id TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "blocked_reason", "blocked_reason TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "error_message", "error_message TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "raw_payload_json", "raw_payload_json TEXT");
  addColumnIfMissing(db, "paper_execution_ledger", "raw_response_json", "raw_response_json TEXT");
  addColumnIfMissing(db, "paper_learning_records", "updated_at", "updated_at TEXT");
  addColumnIfMissing(db, "paper_learning_records", "outcome_json", "outcome_json TEXT");
  addColumnIfMissing(db, "paper_learning_records", "evaluation_reason", "evaluation_reason TEXT");
  addColumnIfMissing(db, "paper_learning_records", "source_research_run_id", "source_research_run_id TEXT");
  addColumnIfMissing(db, "paper_learning_records", "source_candidate_id", "source_candidate_id TEXT");
  addColumnIfMissing(db, "paper_learning_records", "source_plan_timestamp", "source_plan_timestamp TEXT");
  addColumnIfMissing(db, "research_runs", "heartbeat_at", "heartbeat_at TEXT");
  addColumnIfMissing(db, "research_runs", "worker_identity", "worker_identity TEXT");
  addColumnIfMissing(db, "research_runs", "request_id", "request_id TEXT");
  addColumnIfMissing(db, "research_runs", "correlation_id", "correlation_id TEXT");
  addColumnIfMissing(db, "research_runs", "recovered_at", "recovered_at TEXT");
  addColumnIfMissing(db, "research_runs", "recovery_reason", "recovery_reason TEXT");
  addColumnIfMissing(db, "research_runs", "recovery_source", "recovery_source TEXT");
  addColumnIfMissing(
    db,
    "autonomous_recovery_runs",
    "recovered_research_runs",
    "recovered_research_runs INTEGER NOT NULL DEFAULT 0"
  );
};

const parseBusyTimeoutMs = (): number => {
  const parsed = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || "5000", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 5000;
  }
  return Math.min(parsed, 30_000);
};

export const configureDatabaseConnection = (db: DbHandle): void => {
  db.exec(`PRAGMA busy_timeout = ${parseBusyTimeoutMs()};`);
  db.exec("PRAGMA foreign_keys = ON;");
};

export const initializeDatabaseHandle = (db: DbHandle): DbHandle => {
  configureDatabaseConnection(db);
  runMigrationGroup(db, [RUNTIME_SCHEMA_MIGRATION_VERSION], () => {
    db.exec(tableSchema);
    runMigrations(db);
  });
  runPhase1BMigrations(db);
  runZeroDteMigrations(db);
  runMigrationGroup(db, [SQLITE_CONCURRENCY_MIGRATION_VERSION], () => {
    runSqliteConcurrencyMigration(db);
  });
  return db;
};

const hasApplicationSchema = (db: DbHandle): boolean =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
      )
      .get()
  );

export const initializeRuntimeDatabaseHandle = (db: DbHandle): DbHandle => {
  configureDatabaseConnection(db);
  if (!hasApplicationSchema(db)) {
    return initializeDatabaseHandle(db);
  }

  const pendingVersions = getPendingMigrationVersions(
    db,
    REQUIRED_RUNTIME_MIGRATION_VERSIONS
  );
  if (pendingVersions.length > 0) {
    throw new DatabaseMigrationRequiredError(pendingVersions);
  }
  return db;
};

const initialize = (): DbHandle => {
  if (database) {
    return database;
  }

  const dbPath = getResearchDbPath();
  if (isVercelRuntime() && isVercelBundlePath(dbPath)) {
    throw new LocalSqliteUnavailableError(dbPath);
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const opened = new DatabaseSync(dbPath);
  try {
    database = initializeRuntimeDatabaseHandle(opened);
    return database;
  } catch (error) {
    opened.close();
    throw error;
  }
};

export const getDb = (): DbHandle => initialize();

export const closeDbForTests = () => {
  if (database) {
    database.close();
    database = null;
  }
};

export const queryAll = <T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = []
): T[] => {
  return getDb()
    .prepare(sql)
    .all(...params) as unknown as T[];
};

export const queryOne = <T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = []
): T | null => {
  const row = getDb()
    .prepare(sql)
    .get(...params) as unknown as T | undefined;
  return row ?? null;
};
