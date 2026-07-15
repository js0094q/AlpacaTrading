-- Initial Neon PostgreSQL schema for authoritative operational state.
-- The migration runner owns BEGIN, COMMIT, ROLLBACK, and migration recording.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  broker text NOT NULL DEFAULT 'alpaca',
  broker_account_id text NOT NULL,
  environment text NOT NULL DEFAULT 'paper',
  status text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT accounts_broker_nonempty CHECK (btrim(broker) <> ''),
  CONSTRAINT accounts_broker_id_nonempty CHECK (btrim(broker_account_id) <> ''),
  CONSTRAINT accounts_paper_only CHECK (environment = 'paper'),
  CONSTRAINT accounts_status_nonempty CHECK (btrim(status) <> ''),
  CONSTRAINT accounts_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT accounts_version_positive CHECK (version > 0),
  CONSTRAINT accounts_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (broker, environment, broker_account_id)
);

CREATE INDEX accounts_status_idx
  ON accounts (status, updated_at DESC);

CREATE TABLE account_snapshots (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  observed_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'alpaca',
  request_id text,
  account_status text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  cash numeric(28, 8),
  portfolio_value numeric(28, 8),
  equity numeric(28, 8),
  last_equity numeric(28, 8),
  buying_power numeric(28, 8),
  regt_buying_power numeric(28, 8),
  daytrading_buying_power numeric(28, 8),
  non_marginable_buying_power numeric(28, 8),
  options_buying_power numeric(28, 8),
  options_approved_level integer,
  options_trading_level integer,
  pattern_day_trader boolean NOT NULL DEFAULT false,
  daytrade_count integer,
  trading_blocked boolean NOT NULL DEFAULT false,
  transfers_blocked boolean NOT NULL DEFAULT false,
  account_blocked boolean NOT NULL DEFAULT false,
  broker_created_at timestamptz,
  snapshot_fingerprint text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_snapshots_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT account_snapshots_source_nonempty CHECK (btrim(source) <> ''),
  CONSTRAINT account_snapshots_status_nonempty CHECK (btrim(account_status) <> ''),
  CONSTRAINT account_snapshots_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT account_snapshots_levels_nonnegative CHECK (
    (options_approved_level IS NULL OR options_approved_level >= 0)
    AND (options_trading_level IS NULL OR options_trading_level >= 0)
    AND (daytrade_count IS NULL OR daytrade_count >= 0)
  ),
  CONSTRAINT account_snapshots_fingerprint_nonempty
    CHECK (btrim(snapshot_fingerprint) <> ''),
  UNIQUE (account_id, snapshot_fingerprint)
);

CREATE INDEX account_snapshots_account_observed_idx
  ON account_snapshots (account_id, observed_at DESC);
CREATE INDEX account_snapshots_request_idx
  ON account_snapshots (request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE research_runs (
  id text PRIMARY KEY,
  workstream text NOT NULL DEFAULT 'research',
  run_key text NOT NULL,
  status text NOT NULL,
  risk_profile text NOT NULL,
  options_enabled boolean NOT NULL DEFAULT false,
  universe_size integer NOT NULL DEFAULT 0,
  targets_generated integer NOT NULL DEFAULT 0,
  candidates_selected integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL,
  summary jsonb,
  error_code text,
  error_message text,
  worker_identity text,
  scheduler_job_name text,
  scheduler_fencing_token bigint,
  request_id text,
  correlation_id text,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  recovered_at timestamptz,
  recovery_reason text,
  recovery_source text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_runs_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT research_runs_workstream_nonempty CHECK (btrim(workstream) <> ''),
  CONSTRAINT research_runs_key_nonempty CHECK (btrim(run_key) <> ''),
  CONSTRAINT research_runs_status_valid CHECK (
    status IN ('reserved', 'running', 'completed', 'failed', 'cancelled', 'recovered')
  ),
  CONSTRAINT research_runs_risk_profile_nonempty CHECK (btrim(risk_profile) <> ''),
  CONSTRAINT research_runs_counts_nonnegative CHECK (
    universe_size >= 0 AND targets_generated >= 0 AND candidates_selected >= 0
  ),
  CONSTRAINT research_runs_fencing_token_positive CHECK (
    scheduler_fencing_token IS NULL OR scheduler_fencing_token > 0
  ),
  CONSTRAINT research_runs_terminal_timestamp CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'recovered') AND completed_at IS NOT NULL)
    OR (status IN ('reserved', 'running') AND completed_at IS NULL)
  ),
  CONSTRAINT research_runs_timestamp_order CHECK (
    (heartbeat_at IS NULL OR heartbeat_at >= started_at)
    AND (completed_at IS NULL OR completed_at >= started_at)
    AND (recovered_at IS NULL OR recovered_at >= started_at)
  ),
  CONSTRAINT research_runs_version_positive CHECK (version > 0),
  CONSTRAINT research_runs_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (workstream, run_key)
);

CREATE UNIQUE INDEX research_runs_one_active_workstream_idx
  ON research_runs (workstream)
  WHERE status IN ('reserved', 'running');
CREATE INDEX research_runs_status_started_idx
  ON research_runs (status, started_at DESC);
CREATE INDEX research_runs_request_idx
  ON research_runs (request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE candidates (
  id text PRIMARY KEY,
  research_run_id text NOT NULL REFERENCES research_runs(id),
  candidate_key text NOT NULL,
  symbol text NOT NULL,
  underlying_symbol text,
  option_symbol text,
  asset_class text NOT NULL,
  as_of timestamptz NOT NULL,
  rank integer NOT NULL,
  direction text NOT NULL,
  horizon text NOT NULL,
  risk_profile text NOT NULL,
  preferred_expression text NOT NULL,
  strategy_family text,
  score numeric(24, 10) NOT NULL,
  confidence numeric(12, 10) NOT NULL,
  expected_return numeric(24, 10),
  estimated_max_loss numeric(28, 8),
  estimated_max_profit numeric(28, 8),
  historical_win_rate numeric(12, 10),
  historical_avg_return numeric(24, 10),
  historical_max_drawdown numeric(24, 10),
  similar_setup_count integer,
  option_liquidity_score numeric(24, 10),
  volatility_score numeric(24, 10),
  signal_freshness_days integer,
  recent_learning_adjustment numeric(24, 10),
  directional_accuracy numeric(12, 10),
  option_outperformance_accuracy numeric(12, 10),
  strike numeric(28, 8),
  short_strike numeric(28, 8),
  decision text NOT NULL,
  lifecycle_status text NOT NULL,
  decision_reason text,
  rationale jsonb NOT NULL DEFAULT '[]'::jsonb,
  signal_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_quality_status text NOT NULL,
  relevant_backtest_run_id text,
  source_candidate_id text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidates_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT candidates_key_nonempty CHECK (btrim(candidate_key) <> ''),
  CONSTRAINT candidates_symbol_nonempty CHECK (btrim(symbol) <> ''),
  CONSTRAINT candidates_asset_class_valid CHECK (asset_class IN ('equity', 'option')),
  CONSTRAINT candidates_rank_positive CHECK (rank > 0),
  CONSTRAINT candidates_direction_valid CHECK (direction IN ('long', 'short', 'neutral')),
  CONSTRAINT candidates_horizon_nonempty CHECK (btrim(horizon) <> ''),
  CONSTRAINT candidates_risk_profile_nonempty CHECK (btrim(risk_profile) <> ''),
  CONSTRAINT candidates_expression_nonempty CHECK (btrim(preferred_expression) <> ''),
  CONSTRAINT candidates_confidence_range CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT candidates_optional_metrics_valid CHECK (
    (estimated_max_loss IS NULL OR estimated_max_loss >= 0)
    AND (estimated_max_profit IS NULL OR estimated_max_profit >= 0)
    AND (historical_win_rate IS NULL OR historical_win_rate BETWEEN 0 AND 1)
    AND (historical_max_drawdown IS NULL OR historical_max_drawdown >= 0)
    AND (similar_setup_count IS NULL OR similar_setup_count >= 0)
    AND (signal_freshness_days IS NULL OR signal_freshness_days >= 0)
    AND (directional_accuracy IS NULL OR directional_accuracy BETWEEN 0 AND 1)
    AND (option_outperformance_accuracy IS NULL OR option_outperformance_accuracy BETWEEN 0 AND 1)
    AND (strike IS NULL OR strike > 0)
    AND (short_strike IS NULL OR short_strike > 0)
  ),
  CONSTRAINT candidates_decision_valid CHECK (
    decision IN ('selected', 'rejected', 'skipped', 'blocked')
  ),
  CONSTRAINT candidates_lifecycle_status_nonempty CHECK (btrim(lifecycle_status) <> ''),
  CONSTRAINT candidates_data_quality_nonempty CHECK (btrim(data_quality_status) <> ''),
  CONSTRAINT candidates_version_positive CHECK (version > 0),
  CONSTRAINT candidates_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (research_run_id, candidate_key),
  UNIQUE (research_run_id, rank)
);

CREATE INDEX candidates_run_rank_idx
  ON candidates (research_run_id, rank);
CREATE INDEX candidates_symbol_status_idx
  ON candidates (symbol, lifecycle_status, as_of DESC);
CREATE INDEX candidates_active_idx
  ON candidates (research_run_id, updated_at DESC)
  WHERE lifecycle_status NOT IN ('closed', 'expired', 'rejected', 'skipped');

CREATE TABLE candidate_lifecycle_events (
  event_id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES candidates(id),
  sequence_number bigint NOT NULL,
  event_type text NOT NULL,
  prior_status text,
  status text NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  source_event_id text,
  occurred_at timestamptz NOT NULL,
  produced_at timestamptz NOT NULL,
  run_id text,
  request_id text,
  correlation_id text,
  scheduler_job_name text,
  scheduler_fencing_token bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidate_events_id_nonempty CHECK (btrim(event_id) <> ''),
  CONSTRAINT candidate_events_sequence_nonnegative CHECK (sequence_number >= 0),
  CONSTRAINT candidate_events_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT candidate_events_status_nonempty CHECK (btrim(status) <> ''),
  CONSTRAINT candidate_events_idempotency_nonempty CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT candidate_events_produced_after_occurred CHECK (produced_at >= occurred_at),
  CONSTRAINT candidate_events_fencing_token_positive CHECK (
    scheduler_fencing_token IS NULL OR scheduler_fencing_token > 0
  ),
  UNIQUE (candidate_id, sequence_number),
  UNIQUE (candidate_id, idempotency_key)
);

CREATE INDEX candidate_events_candidate_time_idx
  ON candidate_lifecycle_events (candidate_id, occurred_at, sequence_number);
CREATE INDEX candidate_events_source_idx
  ON candidate_lifecycle_events (source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE SEQUENCE scheduler_fencing_token_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE scheduler_leases (
  job_name text PRIMARY KEY,
  workstream text NOT NULL,
  owner_id text NOT NULL,
  run_id text NOT NULL,
  fencing_token bigint NOT NULL DEFAULT nextval('scheduler_fencing_token_seq'),
  status text NOT NULL,
  acquired_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduler_leases_job_nonempty CHECK (btrim(job_name) <> ''),
  CONSTRAINT scheduler_leases_workstream_nonempty CHECK (btrim(workstream) <> ''),
  CONSTRAINT scheduler_leases_owner_nonempty CHECK (btrim(owner_id) <> ''),
  CONSTRAINT scheduler_leases_run_nonempty CHECK (btrim(run_id) <> ''),
  CONSTRAINT scheduler_leases_token_positive CHECK (fencing_token > 0),
  CONSTRAINT scheduler_leases_status_valid CHECK (status IN ('held', 'released', 'expired')),
  CONSTRAINT scheduler_leases_timestamp_order CHECK (
    heartbeat_at >= acquired_at
    AND expires_at > acquired_at
    AND (released_at IS NULL OR released_at >= acquired_at)
  ),
  CONSTRAINT scheduler_leases_release_consistency CHECK (
    (status = 'held' AND released_at IS NULL)
    OR (status IN ('released', 'expired'))
  ),
  CONSTRAINT scheduler_leases_version_positive CHECK (version > 0),
  CONSTRAINT scheduler_leases_updated_after_created CHECK (updated_at >= created_at)
);

ALTER SEQUENCE scheduler_fencing_token_seq OWNED BY scheduler_leases.fencing_token;

CREATE UNIQUE INDEX scheduler_leases_fencing_token_idx
  ON scheduler_leases (fencing_token);
CREATE INDEX scheduler_leases_active_expiration_idx
  ON scheduler_leases (expires_at, job_name)
  WHERE status = 'held';
CREATE INDEX scheduler_leases_owner_idx
  ON scheduler_leases (owner_id, run_id)
  WHERE status = 'held';

CREATE TABLE reconciliation_checkpoints (
  id text PRIMARY KEY,
  workstream text NOT NULL,
  checkpoint_key text NOT NULL,
  source_name text NOT NULL,
  target_name text NOT NULL,
  status text NOT NULL,
  source_checksum text,
  source_row_count bigint,
  target_row_count bigint,
  discrepancy_count bigint NOT NULL DEFAULT 0,
  cursor_value jsonb,
  source_aggregates jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_aggregates jsonb NOT NULL DEFAULT '{}'::jsonb,
  discrepancy_report jsonb,
  last_event_occurred_at timestamptz,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_checkpoints_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT reconciliation_checkpoints_workstream_nonempty CHECK (btrim(workstream) <> ''),
  CONSTRAINT reconciliation_checkpoints_key_nonempty CHECK (btrim(checkpoint_key) <> ''),
  CONSTRAINT reconciliation_checkpoints_source_nonempty CHECK (btrim(source_name) <> ''),
  CONSTRAINT reconciliation_checkpoints_target_nonempty CHECK (btrim(target_name) <> ''),
  CONSTRAINT reconciliation_checkpoints_status_valid CHECK (
    status IN ('pending', 'running', 'passed', 'failed', 'blocked')
  ),
  CONSTRAINT reconciliation_checkpoints_counts_nonnegative CHECK (
    (source_row_count IS NULL OR source_row_count >= 0)
    AND (target_row_count IS NULL OR target_row_count >= 0)
    AND discrepancy_count >= 0
  ),
  CONSTRAINT reconciliation_checkpoints_terminal_timestamp CHECK (
    (status IN ('passed', 'failed', 'blocked') AND completed_at IS NOT NULL)
    OR (status IN ('pending', 'running') AND completed_at IS NULL)
  ),
  CONSTRAINT reconciliation_checkpoints_timestamp_order CHECK (
    completed_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT reconciliation_checkpoints_version_positive CHECK (version > 0),
  CONSTRAINT reconciliation_checkpoints_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (workstream, checkpoint_key)
);

CREATE INDEX reconciliation_checkpoints_status_idx
  ON reconciliation_checkpoints (status, updated_at DESC);
CREATE INDEX reconciliation_checkpoints_incomplete_idx
  ON reconciliation_checkpoints (workstream, updated_at DESC)
  WHERE status IN ('pending', 'running', 'failed', 'blocked');

CREATE TABLE idempotency_records (
  id text PRIMARY KEY,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL,
  resource_type text,
  resource_id text,
  response_fingerprint text,
  response_data jsonb,
  error_code text,
  owner_id text,
  run_id text,
  scheduler_fencing_token bigint,
  expires_at timestamptz,
  completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT idempotency_records_scope_nonempty CHECK (btrim(scope) <> ''),
  CONSTRAINT idempotency_records_key_nonempty CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT idempotency_records_request_fingerprint_nonempty
    CHECK (btrim(request_fingerprint) <> ''),
  CONSTRAINT idempotency_records_status_valid CHECK (
    status IN ('in_progress', 'completed', 'failed', 'expired')
  ),
  CONSTRAINT idempotency_records_fencing_token_positive CHECK (
    scheduler_fencing_token IS NULL OR scheduler_fencing_token > 0
  ),
  CONSTRAINT idempotency_records_completion_consistency CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR status <> 'completed'
  ),
  CONSTRAINT idempotency_records_expiration_order CHECK (
    expires_at IS NULL OR expires_at > created_at
  ),
  CONSTRAINT idempotency_records_version_positive CHECK (version > 0),
  CONSTRAINT idempotency_records_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (scope, idempotency_key)
);

CREATE INDEX idempotency_records_resource_idx
  ON idempotency_records (resource_type, resource_id)
  WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL;
CREATE INDEX idempotency_records_in_progress_idx
  ON idempotency_records (expires_at, scope)
  WHERE status = 'in_progress';

CREATE TABLE workstream_events (
  event_id text PRIMARY KEY,
  workstream text NOT NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  produced_at timestamptz NOT NULL,
  schema_version integer NOT NULL,
  run_id text,
  request_id text,
  correlation_id text,
  source_sequence bigint,
  predecessor_event_id text,
  payload jsonb NOT NULL,
  payload_fingerprint text NOT NULL,
  processing_status text NOT NULL DEFAULT 'received',
  projection_version bigint,
  processed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workstream_events_id_nonempty CHECK (btrim(event_id) <> ''),
  CONSTRAINT workstream_events_workstream_nonempty CHECK (btrim(workstream) <> ''),
  CONSTRAINT workstream_events_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT workstream_events_entity_type_nonempty CHECK (btrim(entity_type) <> ''),
  CONSTRAINT workstream_events_entity_id_nonempty CHECK (btrim(entity_id) <> ''),
  CONSTRAINT workstream_events_schema_version_positive CHECK (schema_version > 0),
  CONSTRAINT workstream_events_source_sequence_nonnegative CHECK (
    source_sequence IS NULL OR source_sequence >= 0
  ),
  CONSTRAINT workstream_events_payload_fingerprint_nonempty
    CHECK (btrim(payload_fingerprint) <> ''),
  CONSTRAINT workstream_events_processing_status_valid CHECK (
    processing_status IN ('received', 'processing', 'completed', 'deferred', 'failed', 'dead_letter')
  ),
  CONSTRAINT workstream_events_produced_after_occurred CHECK (produced_at >= occurred_at),
  CONSTRAINT workstream_events_processing_consistency CHECK (
    (processing_status = 'completed' AND processed_at IS NOT NULL)
    OR processing_status <> 'completed'
  ),
  CONSTRAINT workstream_events_projection_version_positive CHECK (
    projection_version IS NULL OR projection_version > 0
  ),
  CONSTRAINT workstream_events_version_positive CHECK (version > 0),
  CONSTRAINT workstream_events_updated_after_created CHECK (updated_at >= created_at)
);

CREATE INDEX workstream_events_pending_idx
  ON workstream_events (workstream, produced_at, event_id)
  WHERE processing_status IN ('received', 'deferred', 'failed');
CREATE INDEX workstream_events_entity_idx
  ON workstream_events (entity_type, entity_id, occurred_at, event_id);
CREATE INDEX workstream_events_correlation_idx
  ON workstream_events (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE UNIQUE INDEX workstream_events_source_sequence_idx
  ON workstream_events (workstream, source_sequence)
  WHERE source_sequence IS NOT NULL;

CREATE TABLE workstream_event_failures (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES workstream_events(event_id),
  attempt_number integer NOT NULL,
  error_classification text NOT NULL,
  error_code text,
  redacted_error_message text NOT NULL,
  retryable boolean NOT NULL,
  failed_at timestamptz NOT NULL,
  next_retry_at timestamptz,
  dead_lettered_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workstream_event_failures_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT workstream_event_failures_attempt_positive CHECK (attempt_number > 0),
  CONSTRAINT workstream_event_failures_classification_nonempty
    CHECK (btrim(error_classification) <> ''),
  CONSTRAINT workstream_event_failures_message_nonempty
    CHECK (btrim(redacted_error_message) <> ''),
  CONSTRAINT workstream_event_failures_retry_consistency CHECK (
    (retryable AND dead_lettered_at IS NULL)
    OR (NOT retryable)
  ),
  CONSTRAINT workstream_event_failures_timestamp_order CHECK (
    (next_retry_at IS NULL OR next_retry_at >= failed_at)
    AND (dead_lettered_at IS NULL OR dead_lettered_at >= failed_at)
  ),
  UNIQUE (event_id, attempt_number)
);

CREATE INDEX workstream_event_failures_retry_idx
  ON workstream_event_failures (next_retry_at, event_id)
  WHERE retryable AND dead_lettered_at IS NULL;
CREATE INDEX workstream_event_failures_dead_letter_idx
  ON workstream_event_failures (dead_lettered_at DESC)
  WHERE dead_lettered_at IS NOT NULL;

CREATE TABLE risk_limits (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  scope_type text NOT NULL,
  scope_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  currency text NOT NULL DEFAULT 'USD',
  cash_reserve_amount numeric(28, 8),
  cash_reserve_ratio numeric(12, 10),
  max_deployment_amount numeric(28, 8),
  max_deployment_ratio numeric(12, 10),
  max_gross_exposure numeric(28, 8),
  max_net_exposure numeric(28, 8),
  max_open_order_exposure numeric(28, 8),
  max_position_notional numeric(28, 8),
  max_symbol_notional numeric(28, 8),
  max_position_count integer,
  max_order_count integer,
  config_version text NOT NULL,
  config_fingerprint text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_limits_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT risk_limits_scope_type_valid CHECK (
    scope_type IN ('portfolio', 'strategy', 'symbol', 'position')
  ),
  CONSTRAINT risk_limits_scope_key_nonempty CHECK (btrim(scope_key) <> ''),
  CONSTRAINT risk_limits_status_valid CHECK (status IN ('active', 'superseded', 'disabled')),
  CONSTRAINT risk_limits_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT risk_limits_amounts_nonnegative CHECK (
    (cash_reserve_amount IS NULL OR cash_reserve_amount >= 0)
    AND (max_deployment_amount IS NULL OR max_deployment_amount >= 0)
    AND (max_gross_exposure IS NULL OR max_gross_exposure >= 0)
    AND (max_net_exposure IS NULL OR max_net_exposure >= 0)
    AND (max_open_order_exposure IS NULL OR max_open_order_exposure >= 0)
    AND (max_position_notional IS NULL OR max_position_notional >= 0)
    AND (max_symbol_notional IS NULL OR max_symbol_notional >= 0)
  ),
  CONSTRAINT risk_limits_ratios_valid CHECK (
    (cash_reserve_ratio IS NULL OR cash_reserve_ratio BETWEEN 0 AND 1)
    AND (max_deployment_ratio IS NULL OR max_deployment_ratio BETWEEN 0 AND 1)
  ),
  CONSTRAINT risk_limits_counts_positive CHECK (
    (max_position_count IS NULL OR max_position_count > 0)
    AND (max_order_count IS NULL OR max_order_count > 0)
  ),
  CONSTRAINT risk_limits_config_version_nonempty CHECK (btrim(config_version) <> ''),
  CONSTRAINT risk_limits_config_fingerprint_nonempty CHECK (btrim(config_fingerprint) <> ''),
  CONSTRAINT risk_limits_effective_order CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT risk_limits_version_positive CHECK (version > 0),
  CONSTRAINT risk_limits_updated_after_created CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX risk_limits_current_scope_idx
  ON risk_limits (account_id, scope_type, scope_key)
  WHERE status = 'active' AND effective_to IS NULL;
CREATE INDEX risk_limits_effective_idx
  ON risk_limits (account_id, effective_from DESC, effective_to);

CREATE TABLE strategy_allocations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  strategy_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  currency text NOT NULL DEFAULT 'USD',
  allocation_amount numeric(28, 8),
  allocation_ratio numeric(12, 10),
  reserved_amount numeric(28, 8) NOT NULL DEFAULT 0,
  deployed_amount numeric(28, 8) NOT NULL DEFAULT 0,
  config_version text NOT NULL,
  config_fingerprint text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_allocations_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT strategy_allocations_key_nonempty CHECK (btrim(strategy_key) <> ''),
  CONSTRAINT strategy_allocations_status_valid CHECK (
    status IN ('active', 'superseded', 'disabled')
  ),
  CONSTRAINT strategy_allocations_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT strategy_allocations_limit_present CHECK (
    allocation_amount IS NOT NULL OR allocation_ratio IS NOT NULL
  ),
  CONSTRAINT strategy_allocations_amounts_nonnegative CHECK (
    (allocation_amount IS NULL OR allocation_amount >= 0)
    AND reserved_amount >= 0
    AND deployed_amount >= 0
  ),
  CONSTRAINT strategy_allocations_ratio_valid CHECK (
    allocation_ratio IS NULL OR allocation_ratio BETWEEN 0 AND 1
  ),
  CONSTRAINT strategy_allocations_config_version_nonempty CHECK (btrim(config_version) <> ''),
  CONSTRAINT strategy_allocations_config_fingerprint_nonempty
    CHECK (btrim(config_fingerprint) <> ''),
  CONSTRAINT strategy_allocations_effective_order CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT strategy_allocations_version_positive CHECK (version > 0),
  CONSTRAINT strategy_allocations_updated_after_created CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX strategy_allocations_current_idx
  ON strategy_allocations (account_id, strategy_key)
  WHERE status = 'active' AND effective_to IS NULL;
CREATE INDEX strategy_allocations_account_status_idx
  ON strategy_allocations (account_id, status, updated_at DESC);

CREATE TABLE portfolio_exposure (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  account_snapshot_id text REFERENCES account_snapshots(id),
  scope_type text NOT NULL,
  scope_key text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  gross_exposure numeric(28, 8) NOT NULL,
  net_exposure numeric(28, 8) NOT NULL,
  long_exposure numeric(28, 8) NOT NULL,
  short_exposure numeric(28, 8) NOT NULL,
  open_order_exposure numeric(28, 8) NOT NULL DEFAULT 0,
  active_reservation_amount numeric(28, 8) NOT NULL DEFAULT 0,
  deployed_amount numeric(28, 8) NOT NULL DEFAULT 0,
  cash_reserve_amount numeric(28, 8) NOT NULL DEFAULT 0,
  available_buying_power numeric(28, 8),
  position_count integer NOT NULL DEFAULT 0,
  open_order_count integer NOT NULL DEFAULT 0,
  exposure_fingerprint text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portfolio_exposure_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT portfolio_exposure_scope_type_valid CHECK (
    scope_type IN ('portfolio', 'strategy', 'symbol')
  ),
  CONSTRAINT portfolio_exposure_scope_key_nonempty CHECK (btrim(scope_key) <> ''),
  CONSTRAINT portfolio_exposure_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT portfolio_exposure_amounts_valid CHECK (
    gross_exposure >= 0
    AND long_exposure >= 0
    AND short_exposure >= 0
    AND open_order_exposure >= 0
    AND active_reservation_amount >= 0
    AND deployed_amount >= 0
    AND cash_reserve_amount >= 0
  ),
  CONSTRAINT portfolio_exposure_counts_nonnegative CHECK (
    position_count >= 0 AND open_order_count >= 0
  ),
  CONSTRAINT portfolio_exposure_fingerprint_nonempty
    CHECK (btrim(exposure_fingerprint) <> ''),
  UNIQUE (account_id, exposure_fingerprint)
);

CREATE INDEX portfolio_exposure_account_observed_idx
  ON portfolio_exposure (account_id, observed_at DESC);
CREATE INDEX portfolio_exposure_scope_observed_idx
  ON portfolio_exposure (account_id, scope_type, scope_key, observed_at DESC);

CREATE TABLE execution_reviews (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  candidate_id text REFERENCES candidates(id),
  review_type text NOT NULL,
  environment text NOT NULL DEFAULT 'paper',
  paper_only boolean NOT NULL DEFAULT true,
  live_trading_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  client_order_id text,
  account_fingerprint text NOT NULL,
  source_recommendation_id text,
  source_snapshot_id text,
  source_regime_id text,
  configuration_fingerprint text NOT NULL,
  payload_fingerprint text NOT NULL,
  signature_algorithm text NOT NULL,
  signature text NOT NULL,
  order_intent jsonb NOT NULL,
  market_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  portfolio_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_id text,
  correlation_id text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_reviews_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT execution_reviews_type_valid CHECK (review_type IN ('entry', 'exit')),
  CONSTRAINT execution_reviews_paper_only CHECK (
    environment = 'paper' AND paper_only AND NOT live_trading_enabled
  ),
  CONSTRAINT execution_reviews_status_valid CHECK (
    status IN ('created', 'valid', 'blocked', 'expired', 'consumed', 'revoked')
  ),
  CONSTRAINT execution_reviews_account_fingerprint_nonempty
    CHECK (btrim(account_fingerprint) <> ''),
  CONSTRAINT execution_reviews_config_fingerprint_nonempty
    CHECK (btrim(configuration_fingerprint) <> ''),
  CONSTRAINT execution_reviews_payload_fingerprint_nonempty
    CHECK (btrim(payload_fingerprint) <> ''),
  CONSTRAINT execution_reviews_signature_nonempty CHECK (
    btrim(signature_algorithm) <> '' AND btrim(signature) <> ''
  ),
  CONSTRAINT execution_reviews_expiration_order CHECK (expires_at > created_at),
  CONSTRAINT execution_reviews_consumed_order CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT execution_reviews_version_positive CHECK (version > 0),
  CONSTRAINT execution_reviews_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (account_id, payload_fingerprint)
);

CREATE UNIQUE INDEX execution_reviews_client_order_idx
  ON execution_reviews (account_id, client_order_id)
  WHERE client_order_id IS NOT NULL;
CREATE INDEX execution_reviews_valid_expiration_idx
  ON execution_reviews (expires_at, account_id)
  WHERE status IN ('created', 'valid');
CREATE INDEX execution_reviews_candidate_idx
  ON execution_reviews (candidate_id, created_at DESC)
  WHERE candidate_id IS NOT NULL;

CREATE TABLE confirmation_evidence (
  id text PRIMARY KEY,
  execution_review_id text NOT NULL REFERENCES execution_reviews(id),
  account_id text NOT NULL REFERENCES accounts(id),
  candidate_id text REFERENCES candidates(id),
  evidence_type text NOT NULL,
  confirmation_method text NOT NULL,
  status text NOT NULL,
  paper_only boolean NOT NULL DEFAULT true,
  payload_fingerprint text NOT NULL,
  signature_algorithm text,
  signature text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT confirmation_evidence_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT confirmation_evidence_type_nonempty CHECK (btrim(evidence_type) <> ''),
  CONSTRAINT confirmation_evidence_method_nonempty CHECK (btrim(confirmation_method) <> ''),
  CONSTRAINT confirmation_evidence_status_valid CHECK (
    status IN ('valid', 'expired', 'consumed', 'revoked')
  ),
  CONSTRAINT confirmation_evidence_paper_only CHECK (paper_only),
  CONSTRAINT confirmation_evidence_fingerprint_nonempty
    CHECK (btrim(payload_fingerprint) <> ''),
  CONSTRAINT confirmation_evidence_signature_pair CHECK (
    (signature_algorithm IS NULL AND signature IS NULL)
    OR (signature_algorithm IS NOT NULL AND signature IS NOT NULL)
  ),
  CONSTRAINT confirmation_evidence_timestamp_order CHECK (
    expires_at > confirmed_at
    AND (consumed_at IS NULL OR consumed_at >= confirmed_at)
    AND (revoked_at IS NULL OR revoked_at >= confirmed_at)
  ),
  CONSTRAINT confirmation_evidence_version_positive CHECK (version > 0),
  CONSTRAINT confirmation_evidence_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (execution_review_id, payload_fingerprint)
);

CREATE INDEX confirmation_evidence_valid_expiration_idx
  ON confirmation_evidence (expires_at, account_id)
  WHERE status = 'valid';
CREATE INDEX confirmation_evidence_review_idx
  ON confirmation_evidence (execution_review_id, confirmed_at DESC);

CREATE TABLE buying_power_reservations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  candidate_id text REFERENCES candidates(id),
  strategy_key text NOT NULL,
  symbol text NOT NULL,
  asset_class text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  amount numeric(28, 8) NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  reservation_fingerprint text NOT NULL,
  account_snapshot_id text NOT NULL REFERENCES account_snapshots(id),
  scheduler_job_name text,
  scheduler_fencing_token bigint,
  expires_at timestamptz NOT NULL,
  committed_at timestamptz,
  released_at timestamptz,
  release_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buying_power_reservations_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT buying_power_reservations_strategy_nonempty CHECK (btrim(strategy_key) <> ''),
  CONSTRAINT buying_power_reservations_symbol_nonempty CHECK (btrim(symbol) <> ''),
  CONSTRAINT buying_power_reservations_asset_class_valid CHECK (
    asset_class IN ('equity', 'option')
  ),
  CONSTRAINT buying_power_reservations_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT buying_power_reservations_amount_positive CHECK (amount > 0),
  CONSTRAINT buying_power_reservations_status_valid CHECK (
    status IN ('active', 'committed', 'released', 'expired', 'cancelled')
  ),
  CONSTRAINT buying_power_reservations_idempotency_nonempty
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT buying_power_reservations_fingerprint_nonempty
    CHECK (btrim(reservation_fingerprint) <> ''),
  CONSTRAINT buying_power_reservations_fencing_token_positive CHECK (
    scheduler_fencing_token IS NULL OR scheduler_fencing_token > 0
  ),
  CONSTRAINT buying_power_reservations_expiration_order CHECK (expires_at > created_at),
  CONSTRAINT buying_power_reservations_timestamp_order CHECK (
    (committed_at IS NULL OR committed_at >= created_at)
    AND (released_at IS NULL OR released_at >= created_at)
  ),
  CONSTRAINT buying_power_reservations_status_consistency CHECK (
    (status = 'active' AND committed_at IS NULL AND released_at IS NULL)
    OR (status = 'committed' AND committed_at IS NOT NULL)
    OR (status IN ('released', 'expired', 'cancelled') AND released_at IS NOT NULL)
  ),
  CONSTRAINT buying_power_reservations_version_positive CHECK (version > 0),
  CONSTRAINT buying_power_reservations_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX buying_power_reservations_active_account_idx
  ON buying_power_reservations (account_id, expires_at, strategy_key)
  WHERE status = 'active';
CREATE INDEX buying_power_reservations_active_symbol_idx
  ON buying_power_reservations (account_id, symbol, expires_at)
  WHERE status = 'active';
CREATE INDEX buying_power_reservations_candidate_idx
  ON buying_power_reservations (candidate_id, created_at DESC)
  WHERE candidate_id IS NOT NULL;

CREATE TABLE order_intents (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  candidate_id text REFERENCES candidates(id),
  reservation_id text REFERENCES buying_power_reservations(id),
  execution_review_id text REFERENCES execution_reviews(id),
  confirmation_evidence_id text REFERENCES confirmation_evidence(id),
  environment text NOT NULL DEFAULT 'paper',
  client_order_id text NOT NULL,
  idempotency_key text NOT NULL,
  strategy_key text NOT NULL,
  symbol text NOT NULL,
  underlying_symbol text,
  asset_class text NOT NULL,
  side text NOT NULL,
  order_type text NOT NULL,
  time_in_force text NOT NULL,
  quantity numeric(28, 12),
  notional numeric(28, 8),
  limit_price numeric(28, 8),
  stop_price numeric(28, 8),
  estimated_premium numeric(28, 8),
  max_risk numeric(28, 8),
  status text NOT NULL,
  intent_fingerprint text NOT NULL,
  lifecycle_fingerprint text NOT NULL,
  request_payload jsonb NOT NULL,
  request_id text,
  correlation_id text,
  ready_at timestamptz,
  submitted_at timestamptz,
  terminal_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_intents_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT order_intents_paper_only CHECK (environment = 'paper'),
  CONSTRAINT order_intents_client_order_id_nonempty CHECK (btrim(client_order_id) <> ''),
  CONSTRAINT order_intents_idempotency_nonempty CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT order_intents_strategy_nonempty CHECK (btrim(strategy_key) <> ''),
  CONSTRAINT order_intents_symbol_nonempty CHECK (btrim(symbol) <> ''),
  CONSTRAINT order_intents_asset_class_valid CHECK (asset_class IN ('equity', 'option')),
  CONSTRAINT order_intents_side_valid CHECK (
    side IN ('buy', 'sell', 'buy_to_open', 'sell_to_close')
  ),
  CONSTRAINT order_intents_order_type_valid CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit')),
  CONSTRAINT order_intents_tif_valid CHECK (time_in_force IN ('day', 'gtc', 'opg', 'cls', 'ioc', 'fok')),
  CONSTRAINT order_intents_size_present CHECK (quantity IS NOT NULL OR notional IS NOT NULL),
  CONSTRAINT order_intents_financial_values_valid CHECK (
    (quantity IS NULL OR quantity > 0)
    AND (notional IS NULL OR notional > 0)
    AND (limit_price IS NULL OR limit_price > 0)
    AND (stop_price IS NULL OR stop_price > 0)
    AND (estimated_premium IS NULL OR estimated_premium >= 0)
    AND (max_risk IS NULL OR max_risk >= 0)
  ),
  CONSTRAINT order_intents_limit_price_required CHECK (
    order_type NOT IN ('limit', 'stop_limit') OR limit_price IS NOT NULL
  ),
  CONSTRAINT order_intents_stop_price_required CHECK (
    order_type NOT IN ('stop', 'stop_limit') OR stop_price IS NOT NULL
  ),
  CONSTRAINT order_intents_status_valid CHECK (
    status IN (
      'created', 'ready_for_submission', 'submission_pending', 'submitted',
      'ambiguous', 'reconciled', 'failed', 'cancelled'
    )
  ),
  CONSTRAINT order_intents_fingerprints_nonempty CHECK (
    btrim(intent_fingerprint) <> '' AND btrim(lifecycle_fingerprint) <> ''
  ),
  CONSTRAINT order_intents_timestamp_order CHECK (
    (ready_at IS NULL OR ready_at >= created_at)
    AND (submitted_at IS NULL OR submitted_at >= created_at)
    AND (terminal_at IS NULL OR terminal_at >= created_at)
  ),
  CONSTRAINT order_intents_version_positive CHECK (version > 0),
  CONSTRAINT order_intents_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (account_id, client_order_id),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (account_id, intent_fingerprint)
);

CREATE INDEX order_intents_pending_idx
  ON order_intents (account_id, created_at, id)
  WHERE status IN ('ready_for_submission', 'submission_pending', 'ambiguous');
CREATE INDEX order_intents_candidate_idx
  ON order_intents (candidate_id, created_at DESC)
  WHERE candidate_id IS NOT NULL;
CREATE INDEX order_intents_reservation_idx
  ON order_intents (reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE TABLE orders (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  order_intent_id text NOT NULL REFERENCES order_intents(id),
  broker text NOT NULL DEFAULT 'alpaca',
  broker_order_id text,
  client_order_id text NOT NULL,
  parent_order_id text REFERENCES orders(id),
  replacement_order_id text REFERENCES orders(id),
  environment text NOT NULL DEFAULT 'paper',
  symbol text NOT NULL,
  asset_class text NOT NULL,
  side text NOT NULL,
  order_type text NOT NULL,
  time_in_force text NOT NULL,
  status text NOT NULL,
  quantity numeric(28, 12),
  notional numeric(28, 8),
  limit_price numeric(28, 8),
  stop_price numeric(28, 8),
  filled_quantity numeric(28, 12) NOT NULL DEFAULT 0,
  filled_average_price numeric(28, 8),
  broker_request_id text,
  submitted_at timestamptz,
  accepted_at timestamptz,
  filled_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  last_broker_update_at timestamptz,
  raw_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT orders_broker_nonempty CHECK (btrim(broker) <> ''),
  CONSTRAINT orders_client_order_id_nonempty CHECK (btrim(client_order_id) <> ''),
  CONSTRAINT orders_paper_only CHECK (environment = 'paper'),
  CONSTRAINT orders_symbol_nonempty CHECK (btrim(symbol) <> ''),
  CONSTRAINT orders_asset_class_valid CHECK (asset_class IN ('equity', 'option')),
  CONSTRAINT orders_side_valid CHECK (side IN ('buy', 'sell', 'buy_to_open', 'sell_to_close')),
  CONSTRAINT orders_order_type_valid CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit')),
  CONSTRAINT orders_tif_valid CHECK (time_in_force IN ('day', 'gtc', 'opg', 'cls', 'ioc', 'fok')),
  CONSTRAINT orders_status_nonempty CHECK (btrim(status) <> ''),
  CONSTRAINT orders_size_present CHECK (quantity IS NOT NULL OR notional IS NOT NULL),
  CONSTRAINT orders_financial_values_valid CHECK (
    (quantity IS NULL OR quantity > 0)
    AND (notional IS NULL OR notional > 0)
    AND (limit_price IS NULL OR limit_price > 0)
    AND (stop_price IS NULL OR stop_price > 0)
    AND filled_quantity >= 0
    AND (filled_average_price IS NULL OR filled_average_price > 0)
  ),
  CONSTRAINT orders_fill_not_above_quantity CHECK (
    quantity IS NULL OR filled_quantity <= quantity
  ),
  CONSTRAINT orders_version_positive CHECK (version > 0),
  CONSTRAINT orders_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (account_id, client_order_id)
);

CREATE UNIQUE INDEX orders_broker_order_idx
  ON orders (broker, broker_order_id)
  WHERE broker_order_id IS NOT NULL;
CREATE INDEX orders_open_account_idx
  ON orders (account_id, submitted_at DESC, id)
  WHERE status IN ('new', 'accepted', 'pending_new', 'partially_filled', 'held', 'replaced');
CREATE INDEX orders_intent_idx
  ON orders (order_intent_id, created_at DESC);
CREATE INDEX orders_symbol_status_idx
  ON orders (account_id, symbol, status, created_at DESC);

CREATE TABLE positions (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  candidate_id text REFERENCES candidates(id),
  opening_order_id text REFERENCES orders(id),
  closing_order_id text REFERENCES orders(id),
  broker_position_key text NOT NULL,
  symbol text NOT NULL,
  underlying_symbol text,
  option_symbol text,
  asset_class text NOT NULL,
  side text NOT NULL,
  status text NOT NULL,
  quantity numeric(28, 12) NOT NULL,
  available_quantity numeric(28, 12),
  average_entry_price numeric(28, 8),
  current_price numeric(28, 8),
  market_value numeric(28, 8),
  cost_basis numeric(28, 8),
  unrealized_pnl numeric(28, 8),
  realized_pnl numeric(28, 8),
  source_account_snapshot_id text REFERENCES account_snapshots(id),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  last_reconciled_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT positions_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT positions_broker_key_nonempty CHECK (btrim(broker_position_key) <> ''),
  CONSTRAINT positions_symbol_nonempty CHECK (btrim(symbol) <> ''),
  CONSTRAINT positions_asset_class_valid CHECK (asset_class IN ('equity', 'option')),
  CONSTRAINT positions_side_valid CHECK (side IN ('long', 'short')),
  CONSTRAINT positions_status_valid CHECK (status IN ('open', 'closing', 'closed')),
  CONSTRAINT positions_quantity_nonnegative CHECK (
    quantity >= 0 AND (available_quantity IS NULL OR available_quantity >= 0)
  ),
  CONSTRAINT positions_prices_valid CHECK (
    (average_entry_price IS NULL OR average_entry_price > 0)
    AND (current_price IS NULL OR current_price >= 0)
  ),
  CONSTRAINT positions_close_consistency CHECK (
    (status = 'closed' AND closed_at IS NOT NULL)
    OR (status IN ('open', 'closing') AND closed_at IS NULL)
  ),
  CONSTRAINT positions_timestamp_order CHECK (
    (closed_at IS NULL OR closed_at >= opened_at)
    AND (last_reconciled_at IS NULL OR last_reconciled_at >= opened_at)
  ),
  CONSTRAINT positions_version_positive CHECK (version > 0),
  CONSTRAINT positions_updated_after_created CHECK (updated_at >= created_at),
  UNIQUE (account_id, broker_position_key)
);

CREATE INDEX positions_open_account_idx
  ON positions (account_id, symbol, opened_at DESC)
  WHERE status IN ('open', 'closing');
CREATE INDEX positions_candidate_idx
  ON positions (candidate_id, opened_at DESC)
  WHERE candidate_id IS NOT NULL;
CREATE INDEX positions_reconciliation_idx
  ON positions (account_id, last_reconciled_at)
  WHERE status IN ('open', 'closing');

CREATE TABLE broker_events (
  event_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  order_id text REFERENCES orders(id),
  order_intent_id text REFERENCES order_intents(id),
  broker text NOT NULL DEFAULT 'alpaca',
  broker_event_id text,
  broker_order_id text,
  client_order_id text,
  event_type text NOT NULL,
  event_status text NOT NULL,
  request_id text,
  http_status integer,
  error_classification text,
  retryable boolean,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_fingerprint text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_events_id_nonempty CHECK (btrim(event_id) <> ''),
  CONSTRAINT broker_events_broker_nonempty CHECK (btrim(broker) <> ''),
  CONSTRAINT broker_events_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT broker_events_status_nonempty CHECK (btrim(event_status) <> ''),
  CONSTRAINT broker_events_http_status_valid CHECK (
    http_status IS NULL OR http_status BETWEEN 100 AND 599
  ),
  CONSTRAINT broker_events_fingerprint_nonempty CHECK (btrim(response_fingerprint) <> ''),
  CONSTRAINT broker_events_received_after_occurred CHECK (received_at >= occurred_at)
);

CREATE UNIQUE INDEX broker_events_broker_event_idx
  ON broker_events (broker, broker_event_id)
  WHERE broker_event_id IS NOT NULL;
CREATE INDEX broker_events_order_time_idx
  ON broker_events (order_id, occurred_at, event_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX broker_events_intent_time_idx
  ON broker_events (order_intent_id, occurred_at, event_id)
  WHERE order_intent_id IS NOT NULL;
CREATE INDEX broker_events_ambiguous_idx
  ON broker_events (account_id, occurred_at DESC)
  WHERE error_classification = 'ambiguous_network_result';

CREATE TABLE lifecycle_fingerprints (
  id text PRIMARY KEY,
  account_id text REFERENCES accounts(id),
  candidate_id text REFERENCES candidates(id),
  order_intent_id text REFERENCES order_intents(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  lifecycle_stage text NOT NULL,
  fingerprint text NOT NULL,
  algorithm text NOT NULL DEFAULT 'sha256',
  payload_version integer NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  correlation_id text,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_fingerprints_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT lifecycle_fingerprints_entity_type_nonempty CHECK (btrim(entity_type) <> ''),
  CONSTRAINT lifecycle_fingerprints_entity_id_nonempty CHECK (btrim(entity_id) <> ''),
  CONSTRAINT lifecycle_fingerprints_stage_nonempty CHECK (btrim(lifecycle_stage) <> ''),
  CONSTRAINT lifecycle_fingerprints_value_nonempty CHECK (btrim(fingerprint) <> ''),
  CONSTRAINT lifecycle_fingerprints_algorithm_nonempty CHECK (btrim(algorithm) <> ''),
  CONSTRAINT lifecycle_fingerprints_payload_version_positive CHECK (payload_version > 0),
  UNIQUE (entity_type, entity_id, lifecycle_stage, fingerprint)
);

CREATE INDEX lifecycle_fingerprints_entity_time_idx
  ON lifecycle_fingerprints (entity_type, entity_id, captured_at DESC);
CREATE INDEX lifecycle_fingerprints_candidate_idx
  ON lifecycle_fingerprints (candidate_id, captured_at DESC)
  WHERE candidate_id IS NOT NULL;
CREATE INDEX lifecycle_fingerprints_intent_idx
  ON lifecycle_fingerprints (order_intent_id, captured_at DESC)
  WHERE order_intent_id IS NOT NULL;

-- Preserve creation-time provenance on mutable records. Updated timestamps stay
-- explicit so optimistic write paths can set and compare them transactionally.
CREATE FUNCTION operational_reject_created_at_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '22000',
      MESSAGE = 'created_at is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_created_at_immutable
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER account_snapshots_created_at_immutable
  BEFORE UPDATE ON account_snapshots
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER research_runs_created_at_immutable
  BEFORE UPDATE ON research_runs
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER candidates_created_at_immutable
  BEFORE UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER candidate_lifecycle_events_created_at_immutable
  BEFORE UPDATE ON candidate_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER scheduler_leases_created_at_immutable
  BEFORE UPDATE ON scheduler_leases
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER reconciliation_checkpoints_created_at_immutable
  BEFORE UPDATE ON reconciliation_checkpoints
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER idempotency_records_created_at_immutable
  BEFORE UPDATE ON idempotency_records
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER workstream_events_created_at_immutable
  BEFORE UPDATE ON workstream_events
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER workstream_event_failures_created_at_immutable
  BEFORE UPDATE ON workstream_event_failures
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER risk_limits_created_at_immutable
  BEFORE UPDATE ON risk_limits
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER strategy_allocations_created_at_immutable
  BEFORE UPDATE ON strategy_allocations
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER portfolio_exposure_created_at_immutable
  BEFORE UPDATE ON portfolio_exposure
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER execution_reviews_created_at_immutable
  BEFORE UPDATE ON execution_reviews
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER confirmation_evidence_created_at_immutable
  BEFORE UPDATE ON confirmation_evidence
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER buying_power_reservations_created_at_immutable
  BEFORE UPDATE ON buying_power_reservations
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER order_intents_created_at_immutable
  BEFORE UPDATE ON order_intents
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER orders_created_at_immutable
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER positions_created_at_immutable
  BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER broker_events_created_at_immutable
  BEFORE UPDATE ON broker_events
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
CREATE TRIGGER lifecycle_fingerprints_created_at_immutable
  BEFORE UPDATE ON lifecycle_fingerprints
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
