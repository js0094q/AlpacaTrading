ALTER TABLE candidates
  ADD COLUMN decision_id text NOT NULL;

CREATE UNIQUE INDEX candidates_decision_id_idx
  ON candidates (decision_id);

ALTER TABLE scheduler_leases
  DROP CONSTRAINT scheduler_leases_timestamp_order,
  ADD CONSTRAINT scheduler_leases_timestamp_order CHECK (
    heartbeat_at >= acquired_at
    AND expires_at > heartbeat_at
    AND (released_at IS NULL OR released_at >= acquired_at)
  );

ALTER TABLE workstream_events
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT workstream_events_attempts_nonnegative CHECK (attempts >= 0),
  ADD CONSTRAINT workstream_events_processing_timestamp_order CHECK (
    processing_started_at IS NULL OR processing_started_at >= produced_at
  ),
  ADD CONSTRAINT workstream_events_processing_started_required CHECK (
    processing_status <> 'processing' OR processing_started_at IS NOT NULL
  ),
  ADD CONSTRAINT workstream_events_processed_timestamp_order CHECK (
    processed_at IS NULL
    OR processing_started_at IS NULL
    OR processed_at >= processing_started_at
  );

CREATE INDEX workstream_events_stale_processing_idx
  ON workstream_events (processing_started_at, workstream, event_id)
  WHERE processing_status = 'processing';

CREATE TABLE reconciliation_discrepancies (
  id text PRIMARY KEY,
  checkpoint_id text NOT NULL REFERENCES reconciliation_checkpoints(id),
  domain text NOT NULL,
  entity_id text,
  discrepancy_type text NOT NULL,
  expected jsonb,
  actual jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_discrepancies_id_nonempty
    CHECK (btrim(id) <> ''),
  CONSTRAINT reconciliation_discrepancies_domain_nonempty
    CHECK (btrim(domain) <> ''),
  CONSTRAINT reconciliation_discrepancies_type_nonempty
    CHECK (btrim(discrepancy_type) <> ''),
  CONSTRAINT reconciliation_discrepancies_entity_nonempty
    CHECK (entity_id IS NULL OR btrim(entity_id) <> ''),
  CONSTRAINT reconciliation_discrepancies_created_after_observed
    CHECK (created_at >= observed_at)
);

CREATE INDEX reconciliation_discrepancies_checkpoint_idx
  ON reconciliation_discrepancies (checkpoint_id, observed_at, id);

CREATE INDEX reconciliation_discrepancies_domain_idx
  ON reconciliation_discrepancies (domain, discrepancy_type, observed_at DESC);

CREATE TRIGGER reconciliation_discrepancies_created_at_immutable
  BEFORE UPDATE ON reconciliation_discrepancies
  FOR EACH ROW EXECUTE FUNCTION operational_reject_created_at_change();
