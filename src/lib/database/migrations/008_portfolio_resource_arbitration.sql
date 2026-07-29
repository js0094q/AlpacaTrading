-- Deterministic, paper-only portfolio allocation audit for Section 9.
-- The migration runner owns BEGIN, COMMIT, ROLLBACK, and migration recording.
CREATE TABLE portfolio_arbitration_decisions (
  id text PRIMARY KEY,
  arbitration_id text NOT NULL,
  cycle_id text NOT NULL,
  proposal_id text NOT NULL REFERENCES candidates(id),
  account_id text NOT NULL REFERENCES accounts(id),
  account_snapshot_id text NOT NULL REFERENCES account_snapshots(id),
  context_id text NOT NULL,
  lane text NOT NULL,
  decision_rank integer NOT NULL,
  action text NOT NULL,
  environment text NOT NULL DEFAULT 'paper',
  live_trading_enabled boolean NOT NULL DEFAULT false,
  original_quantity numeric(28, 12),
  approved_quantity numeric(28, 12),
  original_notional numeric(28, 8),
  approved_notional numeric(28, 8),
  original_resource_requirement numeric(28, 8),
  approved_resource_requirement numeric(28, 8),
  score numeric,
  confidence numeric,
  strategy_priority integer NOT NULL,
  deterministic_tiebreak text NOT NULL,
  conflict_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason_codes jsonb NOT NULL,
  related_proposal_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_position_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_open_order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared_context_version text NOT NULL,
  account_snapshot_as_of timestamptz NOT NULL,
  position_snapshot_as_of timestamptz NOT NULL,
  open_order_snapshot_as_of timestamptz NOT NULL,
  scheduler_job_name text NOT NULL,
  scheduler_workstream text NOT NULL,
  scheduler_run_id text NOT NULL,
  scheduler_fencing_token bigint NOT NULL,
  decision_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT portfolio_arbitration_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT portfolio_arbitration_identity_nonempty CHECK (
    btrim(arbitration_id) <> ''
    AND btrim(cycle_id) <> ''
    AND btrim(proposal_id) <> ''
    AND btrim(context_id) <> ''
  ),
  CONSTRAINT portfolio_arbitration_lane_valid CHECK (
    lane IN ('equity', 'options_0dte', 'options_leaps')
  ),
  CONSTRAINT portfolio_arbitration_rank_positive CHECK (decision_rank > 0),
  CONSTRAINT portfolio_arbitration_action_valid CHECK (
    action IN ('approve', 'resize', 'skip')
  ),
  CONSTRAINT portfolio_arbitration_paper_only CHECK (
    environment = 'paper' AND NOT live_trading_enabled
  ),
  CONSTRAINT portfolio_arbitration_sizes_nonnegative CHECK (
    (original_quantity IS NULL OR original_quantity > 0)
    AND (approved_quantity IS NULL OR approved_quantity > 0)
    AND (original_notional IS NULL OR original_notional > 0)
    AND (approved_notional IS NULL OR approved_notional > 0)
    AND (
      original_resource_requirement IS NULL
      OR original_resource_requirement > 0
    )
    AND (
      approved_resource_requirement IS NULL
      OR approved_resource_requirement > 0
    )
  ),
  CONSTRAINT portfolio_arbitration_action_size_consistent CHECK (
    (
      action = 'skip'
      AND approved_quantity IS NULL
      AND approved_notional IS NULL
      AND approved_resource_requirement IS NULL
    )
    OR (
      action IN ('approve', 'resize')
      AND approved_resource_requirement IS NOT NULL
    )
  ),
  CONSTRAINT portfolio_arbitration_json_arrays CHECK (
    jsonb_typeof(conflict_types) = 'array'
    AND jsonb_typeof(reason_codes) = 'array'
    AND jsonb_array_length(reason_codes) > 0
    AND jsonb_typeof(related_proposal_ids) = 'array'
    AND jsonb_typeof(related_position_ids) = 'array'
    AND jsonb_typeof(related_open_order_ids) = 'array'
  ),
  CONSTRAINT portfolio_arbitration_context_nonempty CHECK (
    btrim(shared_context_version) <> ''
    AND btrim(deterministic_tiebreak) <> ''
  ),
  CONSTRAINT portfolio_arbitration_scheduler_nonempty CHECK (
    btrim(scheduler_job_name) <> ''
    AND btrim(scheduler_workstream) <> ''
    AND btrim(scheduler_run_id) <> ''
    AND scheduler_fencing_token > 0
  ),
  CONSTRAINT portfolio_arbitration_fingerprint_valid CHECK (
    decision_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  UNIQUE (arbitration_id, proposal_id),
  UNIQUE (cycle_id, proposal_id)
);

CREATE INDEX portfolio_arbitration_account_cycle_idx
  ON portfolio_arbitration_decisions (account_id, cycle_id, decision_rank);
CREATE INDEX portfolio_arbitration_proposal_idx
  ON portfolio_arbitration_decisions (proposal_id, created_at DESC);
CREATE INDEX portfolio_arbitration_context_idx
  ON portfolio_arbitration_decisions (
    account_id,
    account_snapshot_id,
    shared_context_version
  );

CREATE OR REPLACE FUNCTION reject_portfolio_arbitration_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PORTFOLIO_ARBITRATION_APPEND_ONLY:%', TG_OP
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER portfolio_arbitration_decisions_append_only
  BEFORE UPDATE OR DELETE ON portfolio_arbitration_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_portfolio_arbitration_mutation();
