import type { Pool } from "pg";

export const POSTGRES_OPERATIONAL_TABLES = [
  "schema_migrations",
  "accounts",
  "account_snapshots",
  "research_runs",
  "candidates",
  "candidate_lifecycle_events",
  "scheduler_leases",
  "reconciliation_checkpoints",
  "idempotency_records",
  "workstream_events",
  "workstream_event_failures",
  "risk_limits",
  "strategy_allocations",
  "portfolio_exposure",
  "execution_reviews",
  "confirmation_evidence",
  "buying_power_reservations",
  "order_intents",
  "orders",
  "positions",
  "broker_events",
  "lifecycle_fingerprints"
] as const;

export const POSTGRES_OPERATIONAL_INDEXES = [
  "accounts_status_idx",
  "account_snapshots_account_observed_idx",
  "account_snapshots_request_idx",
  "research_runs_one_active_workstream_idx",
  "research_runs_status_started_idx",
  "research_runs_request_idx",
  "candidates_run_rank_idx",
  "candidates_symbol_status_idx",
  "candidates_active_idx",
  "candidate_events_candidate_time_idx",
  "candidate_events_source_idx",
  "scheduler_leases_fencing_token_idx",
  "scheduler_leases_active_expiration_idx",
  "scheduler_leases_owner_idx",
  "reconciliation_checkpoints_status_idx",
  "reconciliation_checkpoints_incomplete_idx",
  "idempotency_records_resource_idx",
  "idempotency_records_in_progress_idx",
  "workstream_events_pending_idx",
  "workstream_events_entity_idx",
  "workstream_events_correlation_idx",
  "workstream_events_source_sequence_idx",
  "workstream_event_failures_retry_idx",
  "workstream_event_failures_dead_letter_idx",
  "risk_limits_current_scope_idx",
  "risk_limits_effective_idx",
  "strategy_allocations_current_idx",
  "strategy_allocations_account_status_idx",
  "portfolio_exposure_account_observed_idx",
  "portfolio_exposure_scope_observed_idx",
  "execution_reviews_client_order_idx",
  "execution_reviews_valid_expiration_idx",
  "execution_reviews_candidate_idx",
  "confirmation_evidence_valid_expiration_idx",
  "confirmation_evidence_review_idx",
  "buying_power_reservations_active_account_idx",
  "buying_power_reservations_active_symbol_idx",
  "buying_power_reservations_candidate_idx",
  "order_intents_pending_idx",
  "order_intents_candidate_idx",
  "order_intents_reservation_idx",
  "orders_broker_order_idx",
  "orders_open_account_idx",
  "orders_intent_idx",
  "orders_symbol_status_idx",
  "positions_open_account_idx",
  "positions_candidate_idx",
  "positions_reconciliation_idx",
  "broker_events_broker_event_idx",
  "broker_events_order_time_idx",
  "broker_events_intent_time_idx",
  "broker_events_ambiguous_idx",
  "lifecycle_fingerprints_entity_time_idx",
  "lifecycle_fingerprints_candidate_idx",
  "lifecycle_fingerprints_intent_idx"
] as const;

export const verifyPostgresSchema = async (pool: Pool) => {
  const [tables, indexes, sequences] = await Promise.all([
    pool.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_catalog.pg_tables
       WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
      [[...POSTGRES_OPERATIONAL_TABLES]]
    ),
    pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_catalog.pg_indexes
       WHERE schemaname = current_schema() AND indexname = ANY($1::text[])`,
      [[...POSTGRES_OPERATIONAL_INDEXES]]
    ),
    pool.query<{ sequencename: string }>(
      `SELECT sequencename
       FROM pg_catalog.pg_sequences
       WHERE schemaname = current_schema() AND sequencename = 'scheduler_fencing_token_seq'`
    )
  ]);
  const tableSet = new Set(tables.rows.map((row) => row.tablename));
  const indexSet = new Set(indexes.rows.map((row) => row.indexname));
  const missingTables = POSTGRES_OPERATIONAL_TABLES.filter((name) => !tableSet.has(name));
  const missingIndexes = POSTGRES_OPERATIONAL_INDEXES.filter((name) => !indexSet.has(name));
  const sequencePresent = sequences.rows.some(
    (row) => row.sequencename === "scheduler_fencing_token_seq"
  );
  return {
    verificationPassed:
      missingTables.length === 0 && missingIndexes.length === 0 && sequencePresent,
    expectedTableCount: POSTGRES_OPERATIONAL_TABLES.length,
    presentTableCount: POSTGRES_OPERATIONAL_TABLES.length - missingTables.length,
    expectedIndexCount: POSTGRES_OPERATIONAL_INDEXES.length,
    presentIndexCount: POSTGRES_OPERATIONAL_INDEXES.length - missingIndexes.length,
    schedulerFencingSequencePresent: sequencePresent,
    missingTables,
    missingIndexes
  };
};
