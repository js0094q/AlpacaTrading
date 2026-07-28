-- Provider-neutral, read-only research evidence for Section 8.
-- The migration runner owns BEGIN, COMMIT, ROLLBACK, and migration recording.
CREATE TABLE research_signals (
  id text PRIMARY KEY,
  provider text NOT NULL,
  provider_signal_id text,
  symbol text NOT NULL REFERENCES universe_symbols(symbol),
  as_of timestamptz NOT NULL,
  horizon text NOT NULL,
  thesis_summary text,
  thesis_direction text,
  confidence numeric,
  catalysts jsonb NOT NULL DEFAULT '[]'::jsonb,
  catalyst_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  invalidation_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  contradiction_status text,
  contradiction_reason text,
  valuation_summary text,
  source_references jsonb NOT NULL,
  expires_or_review_at timestamptz,
  ingestion_timestamp timestamptz NOT NULL,
  content_hash text NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_signals_id_contract
    CHECK (id ~ '^research_signal_[a-f0-9]{64}$'),
  CONSTRAINT research_signals_provider_contract
    CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT research_signals_provider_signal_id_contract
    CHECK (
      provider_signal_id IS NULL
      OR length(provider_signal_id) BETWEEN 1 AND 200
    ),
  CONSTRAINT research_signals_symbol_contract
    CHECK (symbol ~ '^[A-Z][A-Z.]{0,14}$'),
  CONSTRAINT research_signals_horizon_contract
    CHECK (horizon IN ('intraday', 'short_term', 'medium_term', 'long_term')),
  CONSTRAINT research_signals_thesis_summary_contract
    CHECK (thesis_summary IS NULL OR length(thesis_summary) BETWEEN 1 AND 4000),
  CONSTRAINT research_signals_thesis_direction_contract
    CHECK (
      thesis_direction IS NULL
      OR thesis_direction IN ('bullish', 'bearish', 'neutral')
    ),
  CONSTRAINT research_signals_confidence_contract
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT research_signals_catalysts_contract
    CHECK (
      jsonb_typeof(catalysts) = 'array'
      AND jsonb_array_length(catalysts) BETWEEN 0 AND 20
    ),
  CONSTRAINT research_signals_catalyst_dates_contract
    CHECK (
      jsonb_typeof(catalyst_dates) = 'array'
      AND jsonb_array_length(catalyst_dates) BETWEEN 0 AND 20
    ),
  CONSTRAINT research_signals_risks_contract
    CHECK (
      jsonb_typeof(risks) = 'array'
      AND jsonb_array_length(risks) BETWEEN 0 AND 20
    ),
  CONSTRAINT research_signals_invalidation_conditions_contract
    CHECK (
      jsonb_typeof(invalidation_conditions) = 'array'
      AND jsonb_array_length(invalidation_conditions) BETWEEN 0 AND 20
    ),
  CONSTRAINT research_signals_contradiction_status_contract
    CHECK (
      contradiction_status IS NULL
      OR contradiction_status IN ('not_contradicted', 'contradicted')
    ),
  CONSTRAINT research_signals_contradiction_reason_contract
    CHECK (
      contradiction_reason IS NULL
      OR length(contradiction_reason) BETWEEN 1 AND 1000
    ),
  CONSTRAINT research_signals_valuation_summary_contract
    CHECK (
      valuation_summary IS NULL
      OR length(valuation_summary) BETWEEN 1 AND 4000
    ),
  CONSTRAINT research_signals_source_references_contract
    CHECK (
      jsonb_typeof(source_references) = 'array'
      AND jsonb_array_length(source_references) BETWEEN 1 AND 20
    ),
  CONSTRAINT research_signals_timestamp_contract
    CHECK (
      ingestion_timestamp >= as_of
      AND (
        expires_or_review_at IS NULL
        OR expires_or_review_at >= as_of
      )
    ),
  CONSTRAINT research_signals_content_hash_contract
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT research_signals_schema_version_contract
    CHECK (schema_version = 1),
  UNIQUE (provider, symbol, as_of, horizon, content_hash)
);

CREATE INDEX research_signals_symbol_as_of_idx
  ON research_signals (symbol, as_of DESC, ingestion_timestamp DESC);

CREATE UNIQUE INDEX research_signals_provider_signal_idx
  ON research_signals (provider, provider_signal_id)
  WHERE provider_signal_id IS NOT NULL;
