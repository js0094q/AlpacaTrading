import { DatabaseSync, type DatabaseSync as DbHandle } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isVercelRuntime } from "./runtime.js";
import { runZeroDteMigrations } from "./zeroDteSchema.js";

export const LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL =
  "LOCAL_SQLITE_UNAVAILABLE_ON_VERCEL";

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
  notes TEXT
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
  completed_at TEXT,
  status TEXT NOT NULL,
  risk_profile TEXT NOT NULL,
  options_enabled INTEGER NOT NULL,
  universe_size INTEGER NOT NULL,
  targets_generated INTEGER NOT NULL,
  candidates_selected INTEGER NOT NULL,
  error_message TEXT,
  config_json TEXT NOT NULL,
  summary_json TEXT
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

const runMigrations = (db: DbHandle) => {
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
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(tableSchema);
  runMigrations(db);
  runZeroDteMigrations(db);
  database = db;
  return db;
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
