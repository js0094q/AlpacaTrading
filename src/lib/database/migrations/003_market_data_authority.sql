-- PostgreSQL authority for the autonomous worker market-data and research data plane.
-- The migration runner owns BEGIN, COMMIT, ROLLBACK, and migration recording.

CREATE TABLE market_data_ingestion_runs (
  id text PRIMARY KEY,
  ingestion_type text NOT NULL,
  status text NOT NULL,
  source text NOT NULL DEFAULT 'alpaca',
  requested_feed text,
  effective_feed text,
  requested_symbols jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  records_received integer NOT NULL DEFAULT 0,
  records_persisted integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  scheduler_job_name text,
  scheduler_fencing_token bigint,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_data_ingestion_runs_status_valid CHECK (
    status IN ('running', 'completed', 'failed')
  ),
  CONSTRAINT market_data_ingestion_runs_counts_nonnegative CHECK (
    records_received >= 0 AND records_persisted >= 0
  ),
  CONSTRAINT market_data_ingestion_runs_terminal_time CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT market_data_ingestion_runs_fence_positive CHECK (
    scheduler_fencing_token IS NULL OR scheduler_fencing_token > 0
  )
);

CREATE INDEX market_data_ingestion_runs_status_started_idx
  ON market_data_ingestion_runs (status, started_at DESC);

CREATE TABLE universe_symbols (
  symbol text PRIMARY KEY,
  asset_class text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT universe_symbols_symbol_nonempty CHECK (btrim(symbol) <> ''),
  CONSTRAINT universe_symbols_asset_class_valid CHECK (asset_class IN ('equity', 'option')),
  CONSTRAINT universe_symbols_source_nonempty CHECK (btrim(source) <> '')
);

CREATE INDEX universe_symbols_enabled_idx
  ON universe_symbols (enabled, symbol);

CREATE TABLE market_bars (
  symbol text NOT NULL REFERENCES universe_symbols(symbol),
  timeframe text NOT NULL,
  observed_at timestamptz NOT NULL,
  open numeric(28, 8) NOT NULL,
  high numeric(28, 8) NOT NULL,
  low numeric(28, 8) NOT NULL,
  close numeric(28, 8) NOT NULL,
  volume numeric(28, 0) NOT NULL,
  source text NOT NULL,
  request_id text,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, observed_at),
  CONSTRAINT market_bars_timeframe_nonempty CHECK (btrim(timeframe) <> ''),
  CONSTRAINT market_bars_prices_valid CHECK (
    open > 0 AND high > 0 AND low > 0 AND close > 0
    AND high >= low AND high >= open AND high >= close
    AND low <= open AND low <= close
  ),
  CONSTRAINT market_bars_volume_nonnegative CHECK (volume >= 0),
  CONSTRAINT market_bars_source_nonempty CHECK (btrim(source) <> '')
);

CREATE INDEX market_bars_symbol_time_idx
  ON market_bars (symbol, timeframe, observed_at DESC);

CREATE TABLE stock_snapshots (
  id text PRIMARY KEY,
  symbol text NOT NULL REFERENCES universe_symbols(symbol),
  observed_at timestamptz NOT NULL,
  source_timestamp timestamptz,
  requested_feed text NOT NULL,
  effective_feed text NOT NULL,
  source text NOT NULL,
  request_id text,
  evidence jsonb NOT NULL,
  evidence_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_snapshots_feed_nonempty CHECK (
    btrim(requested_feed) <> '' AND btrim(effective_feed) <> ''
  ),
  CONSTRAINT stock_snapshots_source_nonempty CHECK (btrim(source) <> ''),
  CONSTRAINT stock_snapshots_fingerprint_nonempty CHECK (btrim(evidence_fingerprint) <> ''),
  UNIQUE (symbol, requested_feed, source_timestamp, evidence_fingerprint)
);

CREATE INDEX stock_snapshots_symbol_observed_idx
  ON stock_snapshots (symbol, observed_at DESC);

CREATE TABLE option_contracts (
  option_symbol text PRIMARY KEY,
  underlying_symbol text NOT NULL REFERENCES universe_symbols(symbol),
  type text NOT NULL,
  expiration_date date NOT NULL,
  strike numeric(28, 8) NOT NULL,
  multiplier numeric(12, 4) NOT NULL,
  tradable boolean NOT NULL,
  source text NOT NULL,
  request_id text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT option_contracts_symbol_nonempty CHECK (btrim(option_symbol) <> ''),
  CONSTRAINT option_contracts_type_valid CHECK (type IN ('call', 'put')),
  CONSTRAINT option_contracts_values_positive CHECK (strike > 0 AND multiplier > 0),
  CONSTRAINT option_contracts_source_nonempty CHECK (btrim(source) <> '')
);

CREATE INDEX option_contracts_underlying_expiration_idx
  ON option_contracts (underlying_symbol, expiration_date, strike);

CREATE TABLE option_snapshots (
  option_symbol text NOT NULL REFERENCES option_contracts(option_symbol),
  underlying_symbol text NOT NULL REFERENCES universe_symbols(symbol),
  observed_at timestamptz NOT NULL,
  quote_timestamp timestamptz,
  trade_timestamp timestamptz,
  snapshot_timestamp timestamptz,
  bid numeric(28, 8),
  ask numeric(28, 8),
  midpoint numeric(28, 8),
  last numeric(28, 8),
  volume bigint,
  open_interest bigint,
  implied_volatility numeric(24, 12),
  delta numeric(24, 12),
  gamma numeric(24, 12),
  theta numeric(24, 12),
  vega numeric(24, 12),
  rho numeric(24, 12),
  source text NOT NULL,
  request_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (option_symbol, observed_at),
  CONSTRAINT option_snapshots_quotes_valid CHECK (
    (bid IS NULL OR bid >= 0) AND (ask IS NULL OR ask >= 0)
    AND (midpoint IS NULL OR midpoint >= 0) AND (last IS NULL OR last >= 0)
  ),
  CONSTRAINT option_snapshots_counts_nonnegative CHECK (
    (volume IS NULL OR volume >= 0) AND (open_interest IS NULL OR open_interest >= 0)
  ),
  CONSTRAINT option_snapshots_source_nonempty CHECK (btrim(source) <> ''),
  CONSTRAINT option_snapshots_fingerprint_nonempty CHECK (btrim(evidence_fingerprint) <> '')
);

CREATE INDEX option_snapshots_underlying_observed_idx
  ON option_snapshots (underlying_symbol, observed_at DESC);
CREATE INDEX option_snapshots_option_observed_idx
  ON option_snapshots (option_symbol, observed_at DESC);

CREATE TABLE feature_snapshots (
  symbol text NOT NULL REFERENCES universe_symbols(symbol),
  observed_at timestamptz NOT NULL,
  features jsonb NOT NULL,
  source_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, observed_at),
  CONSTRAINT feature_snapshots_fingerprint_nonempty CHECK (btrim(source_fingerprint) <> '')
);

CREATE INDEX feature_snapshots_symbol_observed_idx
  ON feature_snapshots (symbol, observed_at DESC);

CREATE TABLE target_snapshots (
  symbol text NOT NULL REFERENCES universe_symbols(symbol),
  as_of timestamptz NOT NULL,
  direction text NOT NULL,
  horizon text NOT NULL,
  entry_reference numeric(28, 8) NOT NULL,
  upside_target numeric(28, 8) NOT NULL,
  downside_risk numeric(28, 8) NOT NULL,
  stop_loss numeric(28, 8),
  take_profit numeric(28, 8),
  confidence numeric(12, 10) NOT NULL,
  expected_return numeric(24, 10),
  volatility_adjusted_score numeric(24, 10),
  risk_profile text NOT NULL,
  preferred_expression text NOT NULL,
  rationale jsonb NOT NULL,
  source_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, as_of, risk_profile),
  CONSTRAINT target_snapshots_direction_valid CHECK (direction IN ('long', 'short', 'neutral')),
  CONSTRAINT target_snapshots_confidence_valid CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT target_snapshots_fingerprint_nonempty CHECK (btrim(source_fingerprint) <> '')
);

CREATE INDEX target_snapshots_profile_confidence_idx
  ON target_snapshots (risk_profile, confidence DESC, as_of DESC);

CREATE TABLE options_strategy_snapshots (
  symbol text NOT NULL REFERENCES universe_symbols(symbol),
  as_of timestamptz NOT NULL,
  risk_profile text NOT NULL,
  direction text NOT NULL,
  preferred_expression text NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale jsonb NOT NULL DEFAULT '[]'::jsonb,
  options_candidate jsonb,
  source_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, as_of, risk_profile),
  CONSTRAINT options_strategy_snapshots_direction_valid CHECK (
    direction IN ('long', 'short', 'neutral')
  ),
  CONSTRAINT options_strategy_snapshots_fingerprint_nonempty CHECK (
    btrim(source_fingerprint) <> ''
  )
);

CREATE TABLE research_evidence (
  id text PRIMARY KEY,
  research_run_id text NOT NULL REFERENCES research_runs(id),
  evidence_type text NOT NULL,
  symbol text,
  observed_at timestamptz NOT NULL,
  source_table text NOT NULL,
  source_key text NOT NULL,
  source_fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_evidence_type_nonempty CHECK (btrim(evidence_type) <> ''),
  CONSTRAINT research_evidence_source_nonempty CHECK (
    btrim(source_table) <> '' AND btrim(source_key) <> ''
  ),
  CONSTRAINT research_evidence_fingerprint_nonempty CHECK (
    btrim(source_fingerprint) <> ''
  ),
  UNIQUE (research_run_id, evidence_type, source_key, source_fingerprint)
);

CREATE INDEX research_evidence_run_observed_idx
  ON research_evidence (research_run_id, observed_at DESC);
