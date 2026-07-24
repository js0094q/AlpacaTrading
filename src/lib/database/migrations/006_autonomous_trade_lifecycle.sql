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

-- Ambiguous historical values fail closed instead of being guessed.
UPDATE order_intents SET lifecycle_state = CASE
  WHEN status = 'created' THEN 'candidate_created'
  WHEN status IN ('ready_for_submission', 'submission_pending') THEN 'ready_for_submission'
  WHEN status = 'submitted' THEN 'broker_order_accepted'
  WHEN status = 'reconciled' THEN 'position_reconciled'
  WHEN status = 'cancelled' THEN 'cancelled'
  WHEN status = 'failed' THEN 'failed_terminal'
  ELSE 'failed_terminal' END
WHERE lifecycle_state IS NULL;
UPDATE order_intents SET operation = CASE
  WHEN side IN ('buy_to_open', 'sell_to_open', 'sell_to_close', 'buy_to_cover') THEN side
  ELSE NULL END
WHERE operation IS NULL;
UPDATE order_intents SET strategy_classification = CASE
  WHEN asset_class = 'equity' AND request_payload->>'position_intent' = 'short' THEN 'equity_short'
  WHEN asset_class = 'equity' THEN 'equity_long'
  WHEN asset_class = 'option' AND request_payload->>'option_type' = 'call' THEN 'standard_long_call'
  WHEN asset_class = 'option' AND request_payload->>'option_type' = 'put' THEN 'standard_long_put'
  ELSE NULL END
WHERE strategy_classification IS NULL;

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
  CONSTRAINT reservation_release_reason_nonempty CHECK (btrim(release_reason) <> ''), UNIQUE (reservation_id), UNIQUE (reservation_id,idempotency_key)
);
