CREATE TABLE position_review_signals (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  position_id text NOT NULL REFERENCES positions(id),
  candidate_id text REFERENCES candidates(id),
  option_symbol text NOT NULL,
  lane text NOT NULL DEFAULT 'options_leaps',
  action text NOT NULL,
  executable boolean NOT NULL DEFAULT false,
  suggested_quantity numeric,
  reasons jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  signal_fingerprint char(64) NOT NULL,
  last_observation_id char(64) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  occurrences bigint NOT NULL DEFAULT 1,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_review_signals_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT position_review_signals_symbol_nonempty CHECK (btrim(option_symbol) <> ''),
  CONSTRAINT position_review_signals_lane_valid CHECK (lane = 'options_leaps'),
  CONSTRAINT position_review_signals_action_valid CHECK (
    action IN ('review', 'partial_exit_review')
  ),
  CONSTRAINT position_review_signals_nonexecutable CHECK (NOT executable),
  CONSTRAINT position_review_signals_quantity_valid CHECK (
    suggested_quantity IS NULL OR suggested_quantity > 0
  ),
  CONSTRAINT position_review_signals_reasons_valid CHECK (
    jsonb_typeof(reasons) = 'array'
    AND jsonb_array_length(reasons) > 0
  ),
  CONSTRAINT position_review_signals_evidence_object CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT position_review_signals_fingerprint_valid CHECK (
    signal_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT position_review_signals_observation_id_valid CHECK (
    last_observation_id ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT position_review_signals_status_valid CHECK (
    status IN ('open', 'acknowledged', 'resolved')
  ),
  CONSTRAINT position_review_signals_occurrences_positive CHECK (occurrences > 0),
  CONSTRAINT position_review_signals_observed_order CHECK (
    last_observed_at >= first_observed_at
  ),
  CONSTRAINT position_review_signals_acknowledged_order CHECK (
    acknowledged_at IS NULL OR acknowledged_at >= first_observed_at
  ),
  CONSTRAINT position_review_signals_resolved_order CHECK (
    resolved_at IS NULL OR resolved_at >= first_observed_at
  ),
  CONSTRAINT position_review_signals_updated_order CHECK (updated_at >= created_at),
  CONSTRAINT position_review_signals_status_timestamps_consistent CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND resolved_at IS NULL)
    OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT position_review_signals_identity_unique
    UNIQUE (position_id, signal_fingerprint)
);

CREATE INDEX position_review_signals_open_observed_idx
  ON position_review_signals (last_observed_at DESC, position_id)
  WHERE status = 'open';

CREATE INDEX position_review_signals_position_history_idx
  ON position_review_signals (position_id, last_observed_at DESC, id);
