-- Durable autonomous lifecycle metadata. Migration runners execute this in one transaction.
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
  ADD COLUMN IF NOT EXISTS fence_token bigint,
  ADD COLUMN IF NOT EXISTS reservation_release_reason text,
  ADD COLUMN IF NOT EXISTS symbol text,
  ADD COLUMN IF NOT EXISTS quantity text,
  ADD COLUMN IF NOT EXISTS limit_price text;

-- Ambiguous historical values fail closed instead of being guessed. A submitted
-- intent is only marked discovered when a durable broker identifier exists.
UPDATE order_intents AS intent SET lifecycle_state = CASE
  WHEN intent.status = 'created' THEN 'review_created'
  WHEN intent.status = 'ready_for_submission' THEN 'ready_for_submission'
  WHEN intent.status = 'submission_pending' THEN 'submission_attempt_persisted'
  WHEN intent.status = 'ambiguous' THEN 'submission_ambiguous'
  WHEN intent.status = 'submitted' AND EXISTS (
    SELECT 1 FROM orders AS broker_order
    WHERE broker_order.order_intent_id = intent.id
      AND broker_order.broker_order_id IS NOT NULL
  ) THEN 'broker_order_discovered'
  WHEN intent.status = 'submitted' THEN 'submission_ambiguous'
  WHEN intent.status = 'reconciled' AND EXISTS (
    SELECT 1 FROM orders AS broker_order
    WHERE broker_order.order_intent_id = intent.id
      AND broker_order.status = 'filled'
  ) THEN 'filled'
  WHEN intent.status = 'reconciled' AND EXISTS (
    SELECT 1 FROM orders AS broker_order
    WHERE broker_order.order_intent_id = intent.id
      AND broker_order.status IN ('canceled', 'cancelled')
  ) THEN 'cancelled'
  WHEN intent.status = 'cancelled' THEN 'cancelled'
  WHEN intent.status = 'failed' THEN 'failed_terminal'
  ELSE 'failed_terminal' END
WHERE intent.lifecycle_state IS NULL;

UPDATE order_intents AS intent
SET operation = CASE
  WHEN intent.side = 'buy_to_open' THEN 'buy_to_open'
  WHEN intent.side = 'sell_to_close' THEN 'sell_to_close'
  WHEN review.review_type = 'entry' AND intent.side = 'sell' THEN 'sell_to_open'
  WHEN review.review_type = 'entry' AND intent.side = 'buy' THEN 'buy_to_open'
  WHEN review.review_type = 'exit' AND intent.side = 'sell' THEN 'sell_to_close'
  WHEN review.review_type = 'exit' AND intent.side = 'buy' THEN 'buy_to_cover'
  ELSE NULL END
FROM execution_reviews AS review
WHERE review.id = intent.execution_review_id
  AND intent.operation IS NULL;

UPDATE order_intents AS intent
SET strategy_classification = CASE
  WHEN candidate.direction = 'short' THEN 'equity_short'
  WHEN candidate.direction = 'long' THEN 'equity_long'
  ELSE NULL END
FROM candidates AS candidate
WHERE candidate.id = intent.candidate_id
  AND intent.asset_class = 'equity'
  AND intent.strategy_classification IS NULL;

UPDATE order_intents AS intent
SET contract_id = COALESCE(intent.contract_id, contract.contract_id, contract.option_symbol),
    strategy_classification = CASE
      WHEN contract.expiration_date = intent.created_at::date AND contract.type = 'call'
        THEN 'zero_dte_long_call'
      WHEN contract.expiration_date = intent.created_at::date AND contract.type = 'put'
        THEN 'zero_dte_long_put'
      WHEN contract.expiration_date >= intent.created_at::date + 365 AND contract.type = 'call'
        THEN 'leaps_long_call'
      WHEN contract.expiration_date >= intent.created_at::date + 365 AND contract.type = 'put'
        THEN 'leaps_long_put'
      WHEN contract.type = 'call' THEN 'standard_long_call'
      WHEN contract.type = 'put' THEN 'standard_long_put'
      ELSE NULL END
FROM option_contracts AS contract
WHERE contract.option_symbol = intent.symbol
  AND intent.asset_class = 'option'
  AND intent.strategy_classification IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_intents_operation_contract') THEN
    ALTER TABLE order_intents ADD CONSTRAINT order_intents_operation_contract CHECK (operation IS NULL OR operation IN ('buy_to_open','sell_to_open','sell_to_close','buy_to_cover'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_intents_strategy_classification_contract') THEN
    ALTER TABLE order_intents ADD CONSTRAINT order_intents_strategy_classification_contract CHECK (strategy_classification IS NULL OR strategy_classification IN ('equity_long','equity_short','standard_long_call','standard_long_put','zero_dte_long_call','zero_dte_long_put','leaps_long_call','leaps_long_put','hedge'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_intents_lifecycle_state_contract') THEN
    ALTER TABLE order_intents ADD CONSTRAINT order_intents_lifecycle_state_contract CHECK (lifecycle_state IN ('candidate_created','review_created','confirmed','ready_for_submission','submission_attempt_persisted','submission_ambiguous','broker_order_discovered','broker_order_accepted','partially_filled','filled','position_reconciled','exit_evaluated','exit_review_created','exit_confirmed','exit_ready_for_submission','exit_submission_attempt_persisted','exit_submission_ambiguous','exit_broker_order_discovered','exit_partially_filled','closed','cancel_requested','cancel_ambiguous','cancelled','rejected','expired','failed_terminal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_intents_lifecycle_required') THEN
    ALTER TABLE order_intents ADD CONSTRAINT order_intents_lifecycle_required CHECK (lifecycle_state IS NOT NULL);
  END IF;
END $$;

ALTER TABLE order_intents
  ALTER COLUMN lifecycle_state SET NOT NULL;

CREATE INDEX IF NOT EXISTS order_intents_lifecycle_state_idx ON order_intents (lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS order_intents_autonomous_cycle_idx ON order_intents (autonomous_cycle_id, workstream_execution_id, created_at DESC);
CREATE TABLE IF NOT EXISTS autonomous_trade_lifecycle_transitions (
  id text PRIMARY KEY, order_intent_id text NOT NULL REFERENCES order_intents(id), from_state text, to_state text NOT NULL,
  operation text, idempotency_key text NOT NULL, autonomous_cycle_id text, workstream_execution_id text,
  authorization_snapshot_id text, evidence jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_transition_from_state_contract CHECK (from_state IS NULL OR from_state IN ('candidate_created','review_created','confirmed','ready_for_submission','submission_attempt_persisted','submission_ambiguous','broker_order_discovered','broker_order_accepted','partially_filled','filled','position_reconciled','exit_evaluated','exit_review_created','exit_confirmed','exit_ready_for_submission','exit_submission_attempt_persisted','exit_submission_ambiguous','exit_broker_order_discovered','exit_partially_filled','closed','cancel_requested','cancel_ambiguous','cancelled','rejected','expired','failed_terminal')),
  CONSTRAINT lifecycle_transition_to_state_contract CHECK (to_state IN ('candidate_created','review_created','confirmed','ready_for_submission','submission_attempt_persisted','submission_ambiguous','broker_order_discovered','broker_order_accepted','partially_filled','filled','position_reconciled','exit_evaluated','exit_review_created','exit_confirmed','exit_ready_for_submission','exit_submission_attempt_persisted','exit_submission_ambiguous','exit_broker_order_discovered','exit_partially_filled','closed','cancel_requested','cancel_ambiguous','cancelled','rejected','expired','failed_terminal')),
  CONSTRAINT lifecycle_transition_operation_contract CHECK (operation IS NULL OR operation IN ('buy_to_open','sell_to_open','sell_to_close','buy_to_cover')),
  UNIQUE (order_intent_id, idempotency_key)
);
CREATE OR REPLACE FUNCTION enforce_autonomous_lifecycle_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.from_state IS NOT NULL AND NOT EXISTS (SELECT 1 FROM (VALUES
    ('candidate_created','review_created'),('review_created','confirmed'),('confirmed','ready_for_submission'),('ready_for_submission','submission_attempt_persisted'),('submission_attempt_persisted','submission_ambiguous'),('submission_attempt_persisted','broker_order_discovered'),('broker_order_discovered','broker_order_accepted'),('broker_order_accepted','partially_filled'),('broker_order_accepted','filled'),('partially_filled','filled'),('partially_filled','position_reconciled'),('filled','position_reconciled'),('position_reconciled','exit_evaluated'),('exit_evaluated','exit_review_created'),('exit_review_created','exit_confirmed'),('exit_confirmed','exit_ready_for_submission'),('exit_ready_for_submission','exit_submission_attempt_persisted'),('exit_submission_attempt_persisted','exit_submission_ambiguous'),('exit_submission_attempt_persisted','exit_broker_order_discovered'),('exit_broker_order_discovered','exit_partially_filled'),('exit_broker_order_discovered','closed'),('exit_partially_filled','closed'),('ready_for_submission','cancel_requested'),('broker_order_accepted','cancel_requested'),('cancel_requested','cancel_ambiguous'),('cancel_requested','cancelled'),('cancel_ambiguous','cancelled'),('cancel_ambiguous','expired')) AS edges(from_state,to_state) WHERE edges.from_state=NEW.from_state AND edges.to_state=NEW.to_state) THEN
    RAISE EXCEPTION 'INVALID_LIFECYCLE_TRANSITION:%->%', NEW.from_state, NEW.to_state USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS autonomous_lifecycle_transition_edge ON autonomous_trade_lifecycle_transitions;
CREATE TRIGGER autonomous_lifecycle_transition_edge BEFORE INSERT ON autonomous_trade_lifecycle_transitions FOR EACH ROW EXECUTE FUNCTION enforce_autonomous_lifecycle_transition();
-- append-only audit evidence; UPDATE and DELETE are rejected.
CREATE OR REPLACE FUNCTION reject_autonomous_lifecycle_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AUTONOMOUS_LIFECYCLE_APPEND_ONLY:%', TG_OP USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS autonomous_lifecycle_transitions_append_only ON autonomous_trade_lifecycle_transitions;
CREATE TRIGGER autonomous_lifecycle_transitions_append_only BEFORE UPDATE OR DELETE ON autonomous_trade_lifecycle_transitions FOR EACH ROW EXECUTE FUNCTION reject_autonomous_lifecycle_mutation();
CREATE INDEX IF NOT EXISTS autonomous_trade_lifecycle_transitions_intent_idx ON autonomous_trade_lifecycle_transitions (order_intent_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS reservation_terminal_transitions (
  id text PRIMARY KEY, reservation_id text NOT NULL REFERENCES buying_power_reservations(id), order_intent_id text REFERENCES order_intents(id),
  terminal_state text NOT NULL, release_reason text NOT NULL, idempotency_key text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_terminal_state_contract CHECK (terminal_state IN ('cancelled','rejected','expired','closed','failed_terminal')),
  CONSTRAINT reservation_release_reason_nonempty CHECK (btrim(release_reason) <> ''),
  CONSTRAINT reservation_release_reason_contract CHECK (release_reason IN (
    'broker_terminal_filled','broker_terminal_cancelled','broker_terminal_rejected',
    'broker_terminal_expired','position_closed','stale_intent_recovery',
    'broker_absence_established'
  )),
  UNIQUE (reservation_id), UNIQUE (reservation_id,idempotency_key)
);
DROP TRIGGER IF EXISTS reservation_terminal_transitions_append_only ON reservation_terminal_transitions;
CREATE TRIGGER reservation_terminal_transitions_append_only
  BEFORE UPDATE OR DELETE ON reservation_terminal_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_autonomous_lifecycle_mutation();
