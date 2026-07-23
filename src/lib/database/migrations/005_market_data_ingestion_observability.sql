-- Structured audit evidence for each provider ingestion attempt.
-- The migration runner owns BEGIN, COMMIT, ROLLBACK, and migration recording.

ALTER TABLE market_data_ingestion_runs
  ADD COLUMN IF NOT EXISTS cycle_id text,
  ADD COLUMN IF NOT EXISTS workstream text,
  ADD COLUMN IF NOT EXISTS symbol text,
  ADD COLUMN IF NOT EXISTS provider_endpoint text,
  ADD COLUMN IF NOT EXISTS pages_retrieved integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS newest_provider_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS oldest_provider_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS newest_provider_age_seconds numeric(20, 3),
  ADD COLUMN IF NOT EXISTS records_accepted integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_stale integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS records_rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS freshness_threshold_seconds integer,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS persistence_result text;

ALTER TABLE market_data_ingestion_runs
  DROP CONSTRAINT IF EXISTS market_data_ingestion_runs_counts_nonnegative;

ALTER TABLE market_data_ingestion_runs
  ADD CONSTRAINT market_data_ingestion_runs_counts_nonnegative CHECK (
    records_received >= 0
    AND records_persisted >= 0
    AND pages_retrieved >= 0
    AND records_accepted >= 0
    AND records_stale >= 0
    AND records_rejected >= 0
    AND (freshness_threshold_seconds IS NULL OR freshness_threshold_seconds > 0)
  );

CREATE INDEX market_data_ingestion_runs_cycle_symbol_idx
  ON market_data_ingestion_runs (cycle_id, workstream, symbol, started_at DESC);
