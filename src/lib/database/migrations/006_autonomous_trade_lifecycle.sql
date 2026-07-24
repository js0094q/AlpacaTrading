-- Durable autonomous trade lifecycle metadata. The migration runner owns the transaction.
ALTER TABLE order_intents
  ADD COLUMN IF NOT EXISTS operation text,
  ADD COLUMN IF NOT EXISTS strategy_classification text,
  ADD COLUMN IF NOT EXISTS lifecycle_state text,
  ADD COLUMN IF NOT EXISTS cycle_id text,
  ADD COLUMN IF NOT EXISTS workstream text,
  ADD COLUMN IF NOT EXISTS snapshot_id text,
  ADD COLUMN IF NOT EXISTS parent_intent_id text REFERENCES order_intents(id),
  ADD COLUMN IF NOT EXISTS opening_intent_id text REFERENCES order_intents(id),
  ADD COLUMN IF NOT EXISTS broker_order_id text,
  ADD COLUMN IF NOT EXISTS reservation_release_reason text;

UPDATE order_intents
SET operation = COALESCE(operation, CASE
      WHEN side = 'sell_to_close' THEN 'sell_to_close'
      WHEN side = 'buy_to_open' THEN 'buy_to_open'
      WHEN side = 'sell' THEN 'sell_to_open'
      ELSE 'buy_to_open' END),
    strategy_classification = COALESCE(strategy_classification, CASE WHEN asset_class = 'option' THEN 'standard' ELSE 'equity' END),
    lifecycle_state = COALESCE(lifecycle_state, CASE
      WHEN status = 'created' THEN 'intent_created'
      WHEN status IN ('ready_for_submission', 'submission_pending') THEN 'submission_attempt_persisted'
      WHEN status = 'submitted' THEN 'submitted'
      WHEN status = 'reconciled' THEN 'reconciled'
      WHEN status IN ('cancelled', 'failed') THEN 'cancelled'
      ELSE 'intent_created' END);

ALTER TABLE order_intents
  ALTER COLUMN operation SET DEFAULT 'buy_to_open',
  ALTER COLUMN strategy_classification SET DEFAULT 'equity',
  ALTER COLUMN lifecycle_state SET DEFAULT 'intent_created';

CREATE INDEX IF NOT EXISTS order_intents_lifecycle_state_idx
  ON order_intents (lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS order_intents_cycle_workstream_idx
  ON order_intents (cycle_id, workstream, created_at DESC);

-- Append-only transition evidence; callers use the idempotency key for retries.
CREATE TABLE IF NOT EXISTS autonomous_trade_lifecycle_transitions (
  id text PRIMARY KEY,
  order_intent_id text NOT NULL REFERENCES order_intents(id),
  from_state text,
  to_state text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  cycle_id text,
  workstream text,
  snapshot_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_intent_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS autonomous_trade_lifecycle_transitions_intent_idx
  ON autonomous_trade_lifecycle_transitions (order_intent_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS reservation_terminal_transitions (
  id text PRIMARY KEY,
  reservation_id text NOT NULL REFERENCES buying_power_reservations(id),
  order_intent_id text REFERENCES order_intents(id),
  terminal_state text NOT NULL,
  release_reason text NOT NULL,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id)
);
