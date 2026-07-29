-- Bounded, derived outcome-learning projection for Section 10.
-- Authoritative lifecycle and market tables remain read-only to the service.
-- The migration runner owns BEGIN, COMMIT, ROLLBACK, and migration recording.

CREATE TABLE outcome_learning_refresh_runs (
  id text PRIMARY KEY,
  environment text NOT NULL,
  date_range_start timestamptz NOT NULL,
  date_range_end timestamptz NOT NULL,
  requested_max_records integer NOT NULL,
  source_record_count integer NOT NULL DEFAULT 0,
  outcome_record_count integer NOT NULL DEFAULT 0,
  aggregate_record_count integer NOT NULL DEFAULT 0,
  source_truncated boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  scheduler_job_name text NOT NULL,
  scheduler_workstream text NOT NULL,
  scheduler_run_id text NOT NULL,
  scheduler_fencing_token bigint NOT NULL,
  source_fingerprint char(64) NOT NULL,
  result_fingerprint char(64),
  limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  schema_version integer NOT NULL,
  CONSTRAINT outcome_learning_refresh_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT outcome_learning_refresh_environment CHECK (
    environment IN ('paper', 'live', 'unknown')
  ),
  CONSTRAINT outcome_learning_refresh_range CHECK (
    date_range_end > date_range_start
    AND date_range_end <= date_range_start + interval '31 days'
  ),
  CONSTRAINT outcome_learning_refresh_bound CHECK (
    requested_max_records BETWEEN 1 AND 500
    AND source_record_count BETWEEN 0 AND requested_max_records
    AND outcome_record_count BETWEEN 0 AND requested_max_records
    AND aggregate_record_count >= 0
  ),
  CONSTRAINT outcome_learning_refresh_status CHECK (
    status IN ('running', 'completed', 'no_op', 'failed')
  ),
  CONSTRAINT outcome_learning_refresh_scheduler CHECK (
    btrim(scheduler_job_name) <> ''
    AND btrim(scheduler_workstream) <> ''
    AND btrim(scheduler_run_id) <> ''
    AND scheduler_fencing_token > 0
  ),
  CONSTRAINT outcome_learning_refresh_fingerprints CHECK (
    source_fingerprint ~ '^[a-f0-9]{64}$'
    AND (
      result_fingerprint IS NULL
      OR result_fingerprint ~ '^[a-f0-9]{64}$'
    )
  ),
  CONSTRAINT outcome_learning_refresh_limitations_array CHECK (
    jsonb_typeof(limitations) = 'array'
  ),
  CONSTRAINT outcome_learning_refresh_completion CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT outcome_learning_refresh_schema_version CHECK (schema_version > 0),
  UNIQUE (
    environment,
    date_range_start,
    date_range_end,
    requested_max_records,
    source_fingerprint,
    schema_version
  )
);

CREATE TABLE outcome_learning_records (
  outcome_id text PRIMARY KEY,
  refresh_run_id text NOT NULL REFERENCES outcome_learning_refresh_runs(id),
  environment text NOT NULL,
  cycle_id text,
  scheduler_run_id text,
  lane text NOT NULL,
  candidate_id text NOT NULL REFERENCES candidates(id),
  proposal_id text NOT NULL REFERENCES candidates(id),
  arbitration_decision_id text REFERENCES portfolio_arbitration_decisions(id),
  review_id text REFERENCES execution_reviews(id),
  intent_id text REFERENCES order_intents(id),
  order_record_id text REFERENCES orders(id),
  client_order_id text,
  alpaca_order_id text,
  position_id text REFERENCES positions(id),
  exit_review_id text REFERENCES execution_reviews(id),
  exit_intent_id text REFERENCES order_intents(id),
  exit_order_id text REFERENCES orders(id),
  reconciliation_identity text,
  symbol text NOT NULL,
  underlying_symbol text NOT NULL,
  option_contract_id text,
  time_horizon text,
  broker_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  fill_activity_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  research_signal_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  research_horizons jsonb NOT NULL DEFAULT '[]'::jsonb,
  catalyst_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  market_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  entry_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  arbitration_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  exit_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal_score numeric,
  proposal_confidence numeric,
  score_bucket text,
  confidence_bucket text,
  spread_bucket text,
  liquidity_bucket text,
  arbitration_action text,
  proposed_at timestamptz,
  reviewed_at timestamptz,
  intent_created_at timestamptz,
  submitted_at timestamptz,
  first_fill_at timestamptz,
  full_fill_at timestamptz,
  closed_at timestamptz,
  submitted_status text,
  final_order_status text,
  fill_status text NOT NULL,
  requested_quantity numeric(28, 12),
  filled_quantity numeric(28, 12),
  average_fill_price numeric(28, 12),
  reference_bid numeric(28, 12),
  reference_ask numeric(28, 12),
  reference_midpoint numeric(28, 12),
  reference_last numeric(28, 12),
  reference_timestamp timestamptz,
  reference_received_at timestamptz,
  reference_persisted_at timestamptz,
  reference_source text,
  reference_feed text,
  reference_lookup_method text,
  reference_lookup_distance_ms bigint,
  reference_tolerance_ms bigint,
  reference_freshness_status text,
  fill_vs_bid numeric(28, 12),
  fill_vs_ask numeric(28, 12),
  fill_vs_midpoint numeric(28, 12),
  fill_vs_last numeric(28, 12),
  spread_at_reference_value numeric(28, 12),
  spread_at_reference_bps numeric(28, 8),
  slippage_value numeric(28, 12),
  slippage_bps numeric(28, 8),
  slippage_basis text,
  time_intent_to_submission_ms bigint,
  time_proposal_to_submission_ms bigint,
  time_to_first_fill_ms bigint,
  time_to_full_fill_ms bigint,
  time_first_fill_to_close_ms bigint,
  realized_pnl numeric(28, 12),
  realized_return numeric(28, 12),
  unrealized_return_checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  maximum_favorable_excursion numeric(28, 12),
  maximum_adverse_excursion numeric(28, 12),
  excursion_source text,
  excursion_start timestamptz,
  excursion_end timestamptz,
  holding_period_ms bigint,
  join_status text NOT NULL,
  join_methods jsonb NOT NULL DEFAULT '{}'::jsonb,
  partial_join_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_join_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ambiguous_join_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  unsupported_join_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  metric_limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  paper_limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_watermark timestamptz NOT NULL,
  calculated_at timestamptz NOT NULL,
  schema_version integer NOT NULL,
  content_hash char(64) NOT NULL,
  CONSTRAINT outcome_learning_record_id_nonempty CHECK (btrim(outcome_id) <> ''),
  CONSTRAINT outcome_learning_record_environment CHECK (
    environment IN ('paper', 'live', 'unknown')
  ),
  CONSTRAINT outcome_learning_record_lane CHECK (
    lane IN ('equity', 'options_0dte', 'options_leaps', 'unknown')
  ),
  CONSTRAINT outcome_learning_record_identity CHECK (
    btrim(candidate_id) <> ''
    AND btrim(proposal_id) <> ''
    AND candidate_id = proposal_id
    AND btrim(symbol) <> ''
    AND btrim(underlying_symbol) <> ''
  ),
  CONSTRAINT outcome_learning_record_join_status CHECK (
    join_status IN ('exact', 'partial', 'missing', 'ambiguous', 'unsupported')
  ),
  CONSTRAINT outcome_learning_record_arrays CHECK (
    jsonb_typeof(broker_event_ids) = 'array'
    AND jsonb_typeof(fill_activity_ids) = 'array'
    AND jsonb_typeof(research_signal_ids) = 'array'
    AND jsonb_typeof(research_horizons) = 'array'
    AND jsonb_typeof(catalyst_ids) = 'array'
    AND jsonb_typeof(market_evidence_ids) = 'array'
    AND jsonb_typeof(entry_reason_codes) = 'array'
    AND jsonb_typeof(arbitration_reason_codes) = 'array'
    AND jsonb_typeof(exit_reason_codes) = 'array'
    AND jsonb_typeof(unrealized_return_checkpoints) = 'array'
    AND jsonb_typeof(missing_join_reasons) = 'array'
    AND jsonb_typeof(ambiguous_join_reasons) = 'array'
    AND jsonb_typeof(metric_limitations) = 'array'
    AND jsonb_typeof(paper_limitations) = 'array'
    AND jsonb_typeof(join_methods) = 'object'
    AND jsonb_typeof(partial_join_reasons) = 'array'
    AND jsonb_typeof(unsupported_join_reasons) = 'array'
  ),
  CONSTRAINT outcome_learning_record_numeric_bounds CHECK (
    (proposal_confidence IS NULL OR proposal_confidence BETWEEN 0 AND 1)
    AND (requested_quantity IS NULL OR requested_quantity > 0)
    AND (filled_quantity IS NULL OR filled_quantity >= 0)
    AND (average_fill_price IS NULL OR average_fill_price >= 0)
    AND (reference_lookup_distance_ms IS NULL OR reference_lookup_distance_ms >= 0)
    AND (reference_tolerance_ms IS NULL OR reference_tolerance_ms BETWEEN 0 AND 900000)
    AND (spread_at_reference_value IS NULL OR spread_at_reference_value >= 0)
    AND (spread_at_reference_bps IS NULL OR spread_at_reference_bps >= 0)
    AND (time_intent_to_submission_ms IS NULL OR time_intent_to_submission_ms >= 0)
    AND (time_proposal_to_submission_ms IS NULL OR time_proposal_to_submission_ms >= 0)
    AND (time_to_first_fill_ms IS NULL OR time_to_first_fill_ms >= 0)
    AND (time_to_full_fill_ms IS NULL OR time_to_full_fill_ms >= 0)
    AND (time_first_fill_to_close_ms IS NULL OR time_first_fill_to_close_ms >= 0)
    AND (holding_period_ms IS NULL OR holding_period_ms >= 0)
  ),
  CONSTRAINT outcome_learning_record_reference_method CHECK (
    reference_lookup_method IS NULL
    OR reference_lookup_method IN (
      'exact_evidence',
      'nearest_prior_quote',
      'nearest_prior_trade',
      'unavailable'
    )
  ),
  CONSTRAINT outcome_learning_record_fill_status CHECK (
    fill_status IN (
      'not_submitted',
      'unfilled',
      'terminal_unfilled',
      'partially_filled',
      'fully_filled'
    )
  ),
  CONSTRAINT outcome_learning_record_schema_version CHECK (schema_version > 0),
  CONSTRAINT outcome_learning_record_content_hash CHECK (
    content_hash ~ '^[a-f0-9]{64}$'
  ),
  UNIQUE (environment, candidate_id, schema_version)
);

CREATE TABLE historical_outcome_aggregates (
  id text PRIMARY KEY,
  refresh_run_id text NOT NULL REFERENCES outcome_learning_refresh_runs(id),
  environment text NOT NULL,
  lane text NOT NULL,
  dimension text NOT NULL,
  grouping_key text NOT NULL,
  date_range_start timestamptz NOT NULL,
  date_range_end timestamptz NOT NULL,
  source_truncated boolean NOT NULL DEFAULT false,
  sample_count integer NOT NULL,
  proposed_count integer NOT NULL DEFAULT 0,
  approved_count integer NOT NULL DEFAULT 0,
  resized_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  submitted_count integer NOT NULL DEFAULT 0,
  filled_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  canceled_count integer NOT NULL DEFAULT 0,
  closed_count integer NOT NULL DEFAULT 0,
  average_time_to_first_fill_ms numeric,
  average_slippage_bps numeric,
  median_slippage_bps numeric,
  realized_return_average numeric,
  realized_return_median numeric,
  win_rate numeric,
  maximum_favorable_excursion_average numeric,
  maximum_adverse_excursion_average numeric,
  missing_join_count integer NOT NULL DEFAULT 0,
  ambiguous_join_count integer NOT NULL DEFAULT 0,
  unsupported_metric_count integer NOT NULL DEFAULT 0,
  usable_as_evidence boolean NOT NULL DEFAULT false,
  paper_limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  bucket_definitions jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_watermark timestamptz NOT NULL,
  calculated_at timestamptz NOT NULL,
  schema_version integer NOT NULL,
  content_hash char(64) NOT NULL,
  CONSTRAINT historical_outcome_aggregate_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT historical_outcome_aggregate_environment CHECK (
    environment IN ('paper', 'live', 'unknown')
  ),
  CONSTRAINT historical_outcome_aggregate_lane CHECK (
    lane IN ('equity', 'options_0dte', 'options_leaps', 'unknown')
  ),
  CONSTRAINT historical_outcome_aggregate_grouping CHECK (
    btrim(dimension) <> '' AND btrim(grouping_key) <> ''
  ),
  CONSTRAINT historical_outcome_aggregate_range CHECK (
    date_range_end > date_range_start
    AND date_range_end <= date_range_start + interval '31 days'
  ),
  CONSTRAINT historical_outcome_aggregate_counts CHECK (
    sample_count > 0
    AND proposed_count BETWEEN 0 AND sample_count
    AND approved_count BETWEEN 0 AND sample_count
    AND resized_count BETWEEN 0 AND sample_count
    AND skipped_count BETWEEN 0 AND sample_count
    AND submitted_count BETWEEN 0 AND sample_count
    AND filled_count BETWEEN 0 AND sample_count
    AND rejected_count BETWEEN 0 AND sample_count
    AND canceled_count BETWEEN 0 AND sample_count
    AND closed_count BETWEEN 0 AND sample_count
    AND missing_join_count BETWEEN 0 AND sample_count
    AND ambiguous_join_count BETWEEN 0 AND sample_count
    AND unsupported_metric_count >= 0
  ),
  CONSTRAINT historical_outcome_aggregate_win_rate CHECK (
    win_rate IS NULL OR win_rate BETWEEN 0 AND 1
  ),
  CONSTRAINT historical_outcome_aggregate_json CHECK (
    jsonb_typeof(paper_limitations) = 'array'
    AND jsonb_typeof(bucket_definitions) = 'object'
  ),
  CONSTRAINT historical_outcome_aggregate_schema_version CHECK (
    schema_version > 0
  ),
  CONSTRAINT historical_outcome_aggregate_content_hash CHECK (
    content_hash ~ '^[a-f0-9]{64}$'
  ),
  UNIQUE (
    environment,
    lane,
    dimension,
    grouping_key,
    date_range_start,
    date_range_end,
    schema_version
  )
);

CREATE INDEX candidates_outcome_learning_as_of_idx
  ON candidates (as_of, id);
CREATE INDEX outcome_learning_refresh_runs_range_idx
  ON outcome_learning_refresh_runs (
    environment,
    date_range_start,
    date_range_end,
    created_at DESC
  );
CREATE INDEX outcome_learning_records_environment_lane_idx
  ON outcome_learning_records (
    environment,
    lane,
    calculated_at DESC,
    candidate_id
  );
CREATE INDEX outcome_learning_records_symbol_idx
  ON outcome_learning_records (
    environment,
    symbol,
    calculated_at DESC,
    candidate_id
  );
CREATE INDEX outcome_learning_records_proposed_idx
  ON outcome_learning_records (
    environment,
    proposed_at DESC,
    outcome_id
  );
CREATE INDEX outcome_learning_records_refresh_idx
  ON outcome_learning_records (refresh_run_id, candidate_id);
CREATE INDEX historical_outcome_aggregates_lookup_idx
  ON historical_outcome_aggregates (
    environment,
    lane,
    dimension,
    grouping_key,
    calculated_at DESC
  );
CREATE INDEX historical_outcome_aggregates_evidence_idx
  ON historical_outcome_aggregates (
    environment,
    schema_version,
    calculated_at DESC,
    date_range_start,
    date_range_end,
    dimension,
    lane
  )
  WHERE usable_as_evidence AND NOT source_truncated;
CREATE INDEX historical_outcome_aggregates_range_idx
  ON historical_outcome_aggregates (
    environment,
    date_range_start,
    date_range_end,
    lane,
    dimension,
    grouping_key
  );
CREATE INDEX historical_outcome_aggregates_refresh_idx
  ON historical_outcome_aggregates (refresh_run_id, dimension, grouping_key);
