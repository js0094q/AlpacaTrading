-- Durable autonomous lifecycle metadata. The migration runner owns the transaction.
ALTER TABLE order_intents
  ADD COLUMN IF NOT EXISTS operation text,
  ADD COLUMN IF NOT EXISTS strategy_classification text,
  ADD COLUMN IF NOT EXISTS lifecycle_state text,
  ADD COLUMN IF NOT EXISTS review_id text REFERENCES execution_reviews(id),
  ADD COLUMN IF NOT EXISTS confirmation_id text REFERENCES confirmation_evidence(id),
  ADD COLUMN IF NOT EXISTS parent_position_id text REFERENCES positions(id),
  ADD COLUMN IF NOT EXISTS opening_intent_id text REFERENCES order_intents(id),
  ADD COLUMN IF NOT EXISTS contract_id text,
  ADD COLUMN IF NOT EXISTS authorization_snapshot_id text,
  ADD COLUMN IF NOT EXISTS autonomous_cycle_id text,
  ADD COLUMN IF NOT EXISTS workstream_execution_id text,
  ADD COLUMN IF NOT EXISTS scheduler_fence_token bigint,
  ADD COLUMN IF NOT EXISTS reservation_release_reason text;

-- Only facts that are unambiguous in the release-5 schema are backfilled. Generic
-- sides and option direction remain NULL and blocked for explicit human review.
UPDATE order_intents oi
SET operation = CASE
      WHEN oi.side IN ('buy_to_open', 'sell_to_close') THEN oi.side
      WHEN oi.side = 'sell' AND oi.asset_class = 'option' AND (oi.request_payload->>'position_intent') IN ('sell_to_open', 'sell_to_close') THEN oi.request_payload->>'position_intent'
      ELSE NULL END,
    strategy_classification = CASE
      WHEN oi.asset_class = 'option' AND (oi.request_payload->>'option_type') IN ('call', 'put') THEN
        CASE WHEN (oi.request_payload->>'option_type') = 'call' THEN 'standard_call' ELSE 'standard_put' END
      WHEN oi.asset_class = 'equity' THEN
        CASE WHEN c.direction = 'short' THEN 'equity_short' WHEN c.direction = 'long' THEN 'equity_long' ELSE NULL END
      ELSE NULL END,
    lifecycle_state = CASE
      WHEN oi.status = 'created' THEN 'intent_created'
      WHEN oi.status IN ('ready_for_submission', 'submission_pending') THEN 'submission_attempt_persisted'
      WHEN oi.status = 'submitted' THEN 'submitted'
      WHEN oi.status = 'reconciled' THEN 'reconciled'
      WHEN oi.status = 'cancelled' THEN 'cancelled'
      WHEN oi.status = 'failed' THEN 'failed_terminal'
      ELSE 'blocked' END
FROM candidates c
WHERE c.id = oi.candidate_id;

UPDATE order_intents
SET lifecycle_state = CASE
      WHEN status = 'created' THEN 'intent_created'
      WHEN status IN ('ready_for_submission', 'submission_pending') THEN 'submission_attempt_persisted'
      WHEN status = 'submitted' THEN 'submitted'
      WHEN status = 'reconciled' THEN 'reconciled'
      WHEN status = 'cancelled' THEN 'cancelled'
      WHEN status = 'failed' THEN 'failed_terminal'
      ELSE 'blocked' END
WHERE lifecycle_state IS NULL;

ALTER TABLE order_intents
  ADD CONSTRAINT order_intents_operation_contract CHECK (operation IS NULL OR operation IN ('buy_to_open', 'sell_to_open', 'sell_to_close', 'buy_to_cover')),
  ADD CONSTRAINT order_intents_strategy_classification_contract CHECK (strategy_classification IS NULL OR strategy_classification IN ('equity_long', 'equity_short', 'standard_call', 'standard_put', 'zero_dte_call', 'zero_dte_put', 'leaps_call', 'leaps_put', 'hedge')),
  ADD CONSTRAINT order_intents_lifecycle_state_contract CHECK (lifecycle_state IN ('candidate_created', 'candidate_qualified', 'review_created', 'review_pending', 'review_approved', 'review_rejected', 'intent_created', 'submission_attempt_persisted', 'submitted', 'partially_filled', 'filled', 'exit_requested', 'exit_submission_attempt_persisted', 'exit_submitted', 'cancel_requested', 'cancel_submitted', 'cancelled', 'rejected', 'expired', 'reconciled', 'closed', 'blocked', 'ambiguous', 'failed_recoverable', 'failed_terminal')),
  ADD CONSTRAINT order_intents_lifecycle_required CHECK (lifecycle_state IS NOT NULL);

CREATE INDEX IF NOT EXISTS order_intents_lifecycle_state_idx ON order_intents (lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS order_intents_autonomous_cycle_idx ON order_intents (autonomous_cycle_id, workstream_execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_intents_cycle_workstream_idx ON order_intents (autonomous_cycle_id, workstream_execution_id, created_at DESC);

-- Append-only transition evidence; retries use the idempotency uniqueness key.
CREATE TABLE IF NOT EXISTS autonomous_trade_lifecycle_transitions (
  id text PRIMARY KEY,
  order_intent_id text NOT NULL REFERENCES order_intents(id),
  from_state text,
  to_state text NOT NULL,
  operation text,
  idempotency_key text NOT NULL,
  autonomous_cycle_id text,
  workstream_execution_id text,
  authorization_snapshot_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_transition_from_state_contract CHECK (from_state IS NULL OR from_state IN ('candidate_created', 'candidate_qualified', 'review_created', 'review_pending', 'review_approved', 'review_rejected', 'intent_created', 'submission_attempt_persisted', 'submitted', 'partially_filled', 'filled', 'exit_requested', 'exit_submission_attempt_persisted', 'exit_submitted', 'cancel_requested', 'cancel_submitted', 'cancelled', 'rejected', 'expired', 'reconciled', 'closed', 'blocked', 'ambiguous', 'failed_recoverable', 'failed_terminal')),
  CONSTRAINT lifecycle_transition_to_state_contract CHECK (to_state IN ('candidate_created', 'candidate_qualified', 'review_created', 'review_pending', 'review_approved', 'review_rejected', 'intent_created', 'submission_attempt_persisted', 'submitted', 'partially_filled', 'filled', 'exit_requested', 'exit_submission_attempt_persisted', 'exit_submitted', 'cancel_requested', 'cancel_submitted', 'cancelled', 'rejected', 'expired', 'reconciled', 'closed', 'blocked', 'ambiguous', 'failed_recoverable', 'failed_terminal')),
  CONSTRAINT lifecycle_transition_operation_contract CHECK (operation IS NULL OR operation IN ('buy_to_open', 'sell_to_open', 'sell_to_close', 'buy_to_cover')),
  UNIQUE (order_intent_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION reject_autonomous_lifecycle_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AUTONOMOUS_LIFECYCLE_APPEND_ONLY:%', TG_OP USING ERRCODE = '55000';
END; $$;
DROP TRIGGER IF EXISTS autonomous_lifecycle_transitions_append_only ON autonomous_trade_lifecycle_transitions;
CREATE TRIGGER autonomous_lifecycle_transitions_append_only
  BEFORE UPDATE OR DELETE ON autonomous_trade_lifecycle_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_autonomous_lifecycle_mutation();

CREATE INDEX IF NOT EXISTS autonomous_trade_lifecycle_transitions_intent_idx ON autonomous_trade_lifecycle_transitions (order_intent_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS reservation_terminal_transitions (
  id text PRIMARY KEY,
  reservation_id text NOT NULL REFERENCES buying_power_reservations(id),
  order_intent_id text REFERENCES order_intents(id),
  terminal_state text NOT NULL,
  release_reason text NOT NULL,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_terminal_state_contract CHECK (terminal_state IN ('cancelled', 'rejected', 'expired', 'closed', 'failed_terminal')),
  CONSTRAINT reservation_release_reason_nonempty CHECK (btrim(release_reason) <> ''),
  UNIQUE (reservation_id), UNIQUE (reservation_id, idempotency_key)
);
