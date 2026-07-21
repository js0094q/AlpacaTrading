import type { Pool } from "pg";

export const POSTGRES_OPERATIONAL_TABLES = [
  "schema_migrations",
  "accounts",
  "account_snapshots",
  "market_data_ingestion_runs",
  "universe_symbols",
  "market_bars",
  "stock_snapshots",
  "option_contracts",
  "option_snapshots",
  "feature_snapshots",
  "target_snapshots",
  "options_strategy_snapshots",
  "research_runs",
  "research_evidence",
  "candidates",
  "candidate_lifecycle_events",
  "scheduler_leases",
  "reconciliation_checkpoints",
  "reconciliation_discrepancies",
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
  "market_data_ingestion_runs_status_started_idx",
  "universe_symbols_enabled_idx",
  "market_bars_symbol_time_idx",
  "stock_snapshots_symbol_observed_idx",
  "option_contracts_underlying_expiration_idx",
  "option_snapshots_underlying_observed_idx",
  "option_snapshots_option_observed_idx",
  "feature_snapshots_symbol_observed_idx",
  "target_snapshots_profile_confidence_idx",
  "research_runs_one_active_workstream_idx",
  "research_runs_status_started_idx",
  "research_runs_request_idx",
  "research_evidence_run_observed_idx",
  "candidates_run_rank_idx",
  "candidates_symbol_status_idx",
  "candidates_active_idx",
  "candidates_decision_id_idx",
  "candidate_events_candidate_time_idx",
  "candidate_events_source_idx",
  "scheduler_leases_fencing_token_idx",
  "scheduler_leases_active_expiration_idx",
  "scheduler_leases_owner_idx",
  "reconciliation_checkpoints_status_idx",
  "reconciliation_checkpoints_incomplete_idx",
  "reconciliation_discrepancies_checkpoint_idx",
  "reconciliation_discrepancies_domain_idx",
  "idempotency_records_resource_idx",
  "idempotency_records_in_progress_idx",
  "workstream_events_pending_idx",
  "workstream_events_entity_idx",
  "workstream_events_correlation_idx",
  "workstream_events_source_sequence_idx",
  "workstream_events_stale_processing_idx",
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

export const POSTGRES_RELEASE_3_COLUMNS = [
  "candidates.decision_id",
  "workstream_events.processing_started_at",
  "workstream_events.attempts",
  "reconciliation_discrepancies.id",
  "reconciliation_discrepancies.checkpoint_id"
] as const;

export const POSTGRES_RELEASE_3_CONSTRAINTS = [
  "scheduler_leases_timestamp_order",
  "workstream_events_attempts_nonnegative",
  "workstream_events_processing_timestamp_order",
  "workstream_events_processing_started_required",
  "workstream_events_processed_timestamp_order"
] as const;

export const POSTGRES_RELEASE_3_NOT_NULL_COLUMNS = [
  "candidates.decision_id"
] as const;

const release3ConstraintDefinitions: Readonly<
  Record<(typeof POSTGRES_RELEASE_3_CONSTRAINTS)[number], {
    readonly table: string;
    readonly fragments: readonly string[];
  }>
> = {
  scheduler_leases_timestamp_order: {
    table: "scheduler_leases",
    fragments: [
      "heartbeat_at >= acquired_at",
      "expires_at > heartbeat_at",
      "released_at is null",
      "released_at >= acquired_at"
    ]
  },
  workstream_events_attempts_nonnegative: {
    table: "workstream_events",
    fragments: ["attempts >= 0"]
  },
  workstream_events_processing_timestamp_order: {
    table: "workstream_events",
    fragments: ["processing_started_at is null", "processing_started_at >= produced_at"]
  },
  workstream_events_processing_started_required: {
    table: "workstream_events",
    fragments: ["processing_status <> 'processing'::text", "processing_started_at is not null"]
  },
  workstream_events_processed_timestamp_order: {
    table: "workstream_events",
    fragments: ["processed_at is null", "processed_at >= processing_started_at"]
  }
};

const release3IndexDefinitions: Readonly<Record<string, {
  readonly table: string;
  readonly unique: boolean;
  readonly fragments: readonly string[];
  readonly predicateFragments?: readonly string[];
}>> = {
  candidates_decision_id_idx: {
    table: "candidates",
    unique: true,
    fragments: ["(decision_id)"]
  },
  workstream_events_stale_processing_idx: {
    table: "workstream_events",
    unique: false,
    fragments: ["(processing_started_at, workstream, event_id)"],
    predicateFragments: ["processing_status = 'processing'::text"]
  },
  reconciliation_discrepancies_checkpoint_idx: {
    table: "reconciliation_discrepancies",
    unique: false,
    fragments: ["(checkpoint_id, observed_at, id)"]
  },
  reconciliation_discrepancies_domain_idx: {
    table: "reconciliation_discrepancies",
    unique: false,
    fragments: ["(domain, discrepancy_type, observed_at desc)"]
  }
};

export const verifyPostgresSchema = async (pool: Pool) => {
  const [tables, indexes, sequences, columns, constraints] = await Promise.all([
    pool.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_catalog.pg_tables
       WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
      [[...POSTGRES_OPERATIONAL_TABLES]]
    ),
    pool.query<{
      indexname: string;
      table_name: string;
      indexdef: string;
      is_unique: boolean;
      is_valid: boolean;
      is_ready: boolean;
      predicate: string | null;
    }>(
      `SELECT index_row.relname AS indexname, table_row.relname AS table_name,
              pg_get_indexdef(index_row.oid) AS indexdef,
              index_meta.indisunique AS is_unique,
              index_meta.indisvalid AS is_valid,
              index_meta.indisready AS is_ready,
              pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
       FROM pg_catalog.pg_index AS index_meta
       JOIN pg_catalog.pg_class AS index_row ON index_row.oid = index_meta.indexrelid
       JOIN pg_catalog.pg_class AS table_row ON table_row.oid = index_meta.indrelid
       JOIN pg_catalog.pg_namespace AS namespace_row ON namespace_row.oid = index_row.relnamespace
       WHERE namespace_row.nspname = current_schema()
         AND index_row.relname = ANY($1::text[])`,
      [[...POSTGRES_OPERATIONAL_INDEXES]]
    ),
    pool.query<{ sequencename: string }>(
      `SELECT sequencename
       FROM pg_catalog.pg_sequences
       WHERE schemaname = current_schema() AND sequencename = 'scheduler_fencing_token_seq'`
    ),
    pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (table_name || '.' || column_name) = ANY($1::text[])`,
      [[...POSTGRES_RELEASE_3_COLUMNS]]
    ),
    pool.query<{
      conname: string;
      table_name: string;
      convalidated: boolean;
      definition: string;
    }>(
      `SELECT constraint_row.conname, table_row.relname AS table_name,
              constraint_row.convalidated,
              pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_catalog.pg_constraint AS constraint_row
       JOIN pg_catalog.pg_class AS table_row
         ON table_row.oid = constraint_row.conrelid
       WHERE constraint_row.connamespace = (
         SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema()
       )
         AND constraint_row.conname = ANY($1::text[])`,
      [[...POSTGRES_RELEASE_3_CONSTRAINTS]]
    )
  ]);
  const tableSet = new Set(tables.rows.map((row) => row.tablename));
  const indexSet = new Set(indexes.rows.map((row) => row.indexname));
  const missingTables = POSTGRES_OPERATIONAL_TABLES.filter((name) => !tableSet.has(name));
  const missingIndexes = POSTGRES_OPERATIONAL_INDEXES.filter((name) => !indexSet.has(name));
  const sequencePresent = sequences.rows.some(
    (row) => row.sequencename === "scheduler_fencing_token_seq"
  );
  const columnSet = new Set(
    columns.rows.map((row) => `${row.table_name}.${row.column_name}`)
  );
  const constraintSet = new Set(constraints.rows.map((row) => row.conname));
  const missingColumns = POSTGRES_RELEASE_3_COLUMNS.filter(
    (name) => !columnSet.has(name)
  );
  const missingConstraints = POSTGRES_RELEASE_3_CONSTRAINTS.filter(
    (name) => !constraintSet.has(name)
  );
  const invalidNotNullColumns = POSTGRES_RELEASE_3_NOT_NULL_COLUMNS.filter((name) => {
    const row = columns.rows.find(
      (column) => `${column.table_name}.${column.column_name}` === name
    );
    return row?.is_nullable !== "NO";
  });
  const invalidIndexes = POSTGRES_OPERATIONAL_INDEXES.filter((name) => {
    const row = indexes.rows.find((index) => index.indexname === name);
    if (!row) return false;
    if (!row.is_valid || !row.is_ready) return true;
    const expected = release3IndexDefinitions[name];
    if (!expected) return false;
    const indexDefinition = row.indexdef.toLowerCase().replace(/\s+/g, " ");
    const predicate = row.predicate?.toLowerCase().replace(/\s+/g, " ") ?? null;
    return (
      row.table_name !== expected.table ||
      row.is_unique !== expected.unique ||
      expected.fragments.some((fragment) => !indexDefinition.includes(fragment)) ||
      (expected.predicateFragments === undefined
        ? predicate !== null
        : predicate === null ||
          expected.predicateFragments.some((fragment) => !predicate.includes(fragment)))
    );
  });
  const invalidConstraints = POSTGRES_RELEASE_3_CONSTRAINTS.filter((name) => {
    const row = constraints.rows.find((constraint) => constraint.conname === name);
    if (!row) return false;
    const expected = release3ConstraintDefinitions[name];
    const definition = row.definition.toLowerCase().replace(/\s+/g, " ");
    return (
      row.table_name !== expected.table ||
      row.convalidated !== true ||
      expected.fragments.some((fragment) => !definition.includes(fragment))
    );
  });
  return {
    verificationPassed:
      missingTables.length === 0 &&
      missingIndexes.length === 0 &&
      sequencePresent &&
      missingColumns.length === 0 &&
      missingConstraints.length === 0 &&
      invalidNotNullColumns.length === 0 &&
      invalidIndexes.length === 0 &&
      invalidConstraints.length === 0,
    expectedTableCount: POSTGRES_OPERATIONAL_TABLES.length,
    presentTableCount: POSTGRES_OPERATIONAL_TABLES.length - missingTables.length,
    expectedIndexCount: POSTGRES_OPERATIONAL_INDEXES.length,
    presentIndexCount: POSTGRES_OPERATIONAL_INDEXES.length - missingIndexes.length,
    schedulerFencingSequencePresent: sequencePresent,
    missingTables,
    missingIndexes,
    missingColumns,
    missingConstraints,
    invalidNotNullColumns,
    invalidIndexes,
    invalidConstraints
  };
};
