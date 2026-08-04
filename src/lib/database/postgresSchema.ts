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
  "research_signals",
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
  "position_review_signals",
  "portfolio_arbitration_decisions",
  "outcome_learning_refresh_runs",
  "outcome_learning_records",
  "historical_outcome_aggregates",
  "execution_reviews",
  "confirmation_evidence",
  "buying_power_reservations",
  "order_intents",
  "orders",
  "positions",
  "broker_events",
  "lifecycle_fingerprints",
  "autonomous_trade_lifecycle_transitions",
  "reservation_terminal_transitions"
] as const;

export const POSTGRES_OPERATIONAL_INDEXES = [
  "accounts_status_idx",
  "account_snapshots_account_observed_idx",
  "account_snapshots_request_idx",
  "market_data_ingestion_runs_status_started_idx",
  "market_data_ingestion_runs_cycle_symbol_idx",
  "universe_symbols_enabled_idx",
  "market_bars_symbol_time_idx",
  "stock_snapshots_symbol_observed_idx",
  "option_contracts_underlying_expiration_idx",
  "option_snapshots_underlying_observed_idx",
  "option_snapshots_option_observed_idx",
  "feature_snapshots_symbol_observed_idx",
  "target_snapshots_profile_confidence_idx",
  "target_snapshots_family_as_of_idx",
  "options_strategy_snapshots_family_as_of_idx",
  "research_runs_one_active_workstream_idx",
  "research_runs_status_started_idx",
  "research_runs_request_idx",
  "research_evidence_run_observed_idx",
  "research_signals_symbol_as_of_idx",
  "research_signals_provider_signal_idx",
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
  "position_review_signals_open_observed_idx",
  "position_review_signals_position_history_idx",
  "portfolio_arbitration_account_cycle_idx",
  "portfolio_arbitration_proposal_idx",
  "portfolio_arbitration_context_idx",
  "candidates_outcome_learning_as_of_idx",
  "outcome_learning_refresh_runs_range_idx",
  "outcome_learning_records_environment_lane_idx",
  "outcome_learning_records_symbol_idx",
  "outcome_learning_records_proposed_idx",
  "outcome_learning_records_refresh_idx",
  "historical_outcome_aggregates_lookup_idx",
  "historical_outcome_aggregates_evidence_idx",
  "historical_outcome_aggregates_range_idx",
  "historical_outcome_aggregates_refresh_idx",
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
  "lifecycle_fingerprints_intent_idx",
  "order_intents_lifecycle_state_idx",
  "order_intents_autonomous_cycle_idx",
  "autonomous_trade_lifecycle_transitions_intent_idx"
] as const;

export const POSTGRES_RELEASE_3_COLUMNS = [
  "candidates.decision_id",
  "workstream_events.processing_started_at",
  "workstream_events.attempts",
  "reconciliation_discrepancies.id",
  "reconciliation_discrepancies.checkpoint_id",
  "option_contracts.contract_id",
  "option_contracts.status",
  "option_contracts.exercise_style",
  "option_contracts.open_interest",
  "option_contracts.open_interest_date",
  "option_contracts.close_price",
  "option_contracts.close_price_date",
  "option_contracts.evidence",
  "market_data_ingestion_runs.cycle_id",
  "market_data_ingestion_runs.workstream",
  "market_data_ingestion_runs.symbol",
  "market_data_ingestion_runs.provider_endpoint",
  "market_data_ingestion_runs.pages_retrieved",
  "market_data_ingestion_runs.newest_provider_timestamp",
  "market_data_ingestion_runs.oldest_provider_timestamp",
  "market_data_ingestion_runs.newest_provider_age_seconds",
  "market_data_ingestion_runs.records_accepted",
  "market_data_ingestion_runs.records_stale",
  "market_data_ingestion_runs.records_rejected",
  "market_data_ingestion_runs.freshness_threshold_seconds",
  "market_data_ingestion_runs.rejection_reason",
  "market_data_ingestion_runs.persistence_result",
  "target_snapshots.strategy_family",
  "target_snapshots.expression_id",
  "options_strategy_snapshots.strategy_family",
  "options_strategy_snapshots.expression_id",
  "order_intents.operation",
  "order_intents.strategy_classification",
  "order_intents.lifecycle_state",
  "order_intents.review_id",
  "order_intents.confirmation_id",
  "order_intents.parent_position_id",
  "order_intents.opening_intent_id",
  "order_intents.contract_id",
  "order_intents.authorization_snapshot_id",
  "order_intents.autonomous_cycle_id",
  "order_intents.workstream_execution_id",
  "order_intents.fence_token",
  "order_intents.symbol",
  "order_intents.quantity",
  "order_intents.limit_price",
  "order_intents.reservation_release_reason",
  "position_review_signals.action",
  "position_review_signals.executable",
  "position_review_signals.reasons",
  "position_review_signals.evidence",
  "position_review_signals.signal_fingerprint",
  "position_review_signals.last_observation_id",
  "position_review_signals.status",
  "position_review_signals.first_observed_at",
  "position_review_signals.last_observed_at",
  "position_review_signals.occurrences"
] as const;

export const POSTGRES_RELEASE_3_CONSTRAINTS = [
  "scheduler_leases_timestamp_order",
  "workstream_events_attempts_nonnegative",
  "workstream_events_processing_timestamp_order",
  "workstream_events_processing_started_required",
  "workstream_events_processed_timestamp_order",
  "option_contracts_evidence_object",
  "target_snapshots_strategy_identity_nonempty",
  "options_strategy_snapshots_strategy_identity_nonempty",
  "portfolio_arbitration_lane_valid",
  "position_review_signals_action_valid",
  "position_review_signals_nonexecutable",
  "position_review_signals_reasons_valid",
  "position_review_signals_evidence_object",
  "position_review_signals_fingerprint_valid",
  "position_review_signals_observation_id_valid",
  "position_review_signals_status_valid",
  "position_review_signals_occurrences_positive",
  "position_review_signals_observed_order",
  "position_review_signals_status_timestamps_consistent",
  "position_review_signals_identity_unique"
] as const;

/** Migration-006 constraints are registered separately from the release-3 verifier. */
export const POSTGRES_AUTONOMOUS_LIFECYCLE_CONSTRAINTS = [
  "order_intents_operation_contract",
  "order_intents_strategy_classification_contract",
  "order_intents_lifecycle_state_contract",
  "order_intents_lifecycle_required",
  "lifecycle_transition_from_state_contract",
  "lifecycle_transition_to_state_contract",
  "lifecycle_transition_operation_contract",
  "reservation_terminal_state_contract",
  "reservation_release_reason_nonempty",
  "reservation_release_reason_contract"
] as const;

export const POSTGRES_AUTONOMOUS_LIFECYCLE_TRIGGERS = [
  "autonomous_lifecycle_transition_edge",
  "autonomous_lifecycle_transitions_append_only",
  "reservation_terminal_transitions_append_only"
] as const;

export const POSTGRES_RELEASE_3_NOT_NULL_COLUMNS = [
  "candidates.decision_id",
  "option_contracts.evidence",
  "order_intents.lifecycle_state",
  "position_review_signals.action",
  "position_review_signals.executable",
  "position_review_signals.reasons",
  "position_review_signals.evidence",
  "position_review_signals.signal_fingerprint",
  "position_review_signals.last_observation_id",
  "position_review_signals.status",
  "position_review_signals.first_observed_at",
  "position_review_signals.last_observed_at",
  "position_review_signals.occurrences"
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
  },
  option_contracts_evidence_object: {
    table: "option_contracts",
    fragments: ["jsonb_typeof(evidence) = 'object'::text"]
  },
  target_snapshots_strategy_identity_nonempty: {
    table: "target_snapshots",
    fragments: ["btrim(strategy_family) <> ''::text", "btrim(expression_id) <> ''::text"]
  },
  options_strategy_snapshots_strategy_identity_nonempty: {
    table: "options_strategy_snapshots",
    fragments: ["btrim(strategy_family) <> ''::text", "btrim(expression_id) <> ''::text"]
  },
  portfolio_arbitration_lane_valid: {
    table: "portfolio_arbitration_decisions",
    fragments: [
      "equity",
      "options_standard",
      "options_0dte",
      "options_leaps"
    ]
  },
  position_review_signals_action_valid: {
    table: "position_review_signals",
    fragments: ["review", "partial_exit_review"]
  },
  position_review_signals_nonexecutable: {
    table: "position_review_signals",
    fragments: ["not executable"]
  },
  position_review_signals_reasons_valid: {
    table: "position_review_signals",
    fragments: ["jsonb_typeof(reasons)", "jsonb_array_length(reasons) > 0"]
  },
  position_review_signals_evidence_object: {
    table: "position_review_signals",
    fragments: ["jsonb_typeof(evidence)", "object"]
  },
  position_review_signals_fingerprint_valid: {
    table: "position_review_signals",
    fragments: ["signal_fingerprint", "^[a-f0-9]{64}$"]
  },
  position_review_signals_observation_id_valid: {
    table: "position_review_signals",
    fragments: ["last_observation_id", "^[a-f0-9]{64}$"]
  },
  position_review_signals_status_valid: {
    table: "position_review_signals",
    fragments: ["open", "acknowledged", "resolved"]
  },
  position_review_signals_occurrences_positive: {
    table: "position_review_signals",
    fragments: ["occurrences > 0"]
  },
  position_review_signals_observed_order: {
    table: "position_review_signals",
    fragments: ["last_observed_at >= first_observed_at"]
  },
  position_review_signals_status_timestamps_consistent: {
    table: "position_review_signals",
    fragments: ["status", "acknowledged_at is null", "resolved_at is not null"]
  },
  position_review_signals_identity_unique: {
    table: "position_review_signals",
    fragments: ["unique", "position_id", "signal_fingerprint"]
  }
};

const autonomousIndexDefinitions: Readonly<Record<string, { readonly table: string; readonly unique: boolean; readonly fragments: readonly string[] }>> = {
  order_intents_lifecycle_state_idx: { table: "order_intents", unique: false, fragments: ["(lifecycle_state, updated_at"] },
  order_intents_autonomous_cycle_idx: { table: "order_intents", unique: false, fragments: ["(autonomous_cycle_id, workstream_execution_id"] },
  autonomous_trade_lifecycle_transitions_intent_idx: { table: "autonomous_trade_lifecycle_transitions", unique: false, fragments: ["(order_intent_id, occurred_at"] }
};
const autonomousConstraintDefinitions: Readonly<Record<string, { readonly table: string; readonly fragments: readonly string[] }>> = {
  order_intents_operation_contract: { table: "order_intents", fragments: ["operation", "buy_to_open"] },
  order_intents_strategy_classification_contract: { table: "order_intents", fragments: ["strategy_classification", "standard_long_call"] },
  order_intents_lifecycle_state_contract: { table: "order_intents", fragments: ["lifecycle_state", "candidate_created"] },
  order_intents_lifecycle_required: { table: "order_intents", fragments: ["lifecycle_state IS NOT NULL"] },
  lifecycle_transition_from_state_contract: { table: "autonomous_trade_lifecycle_transitions", fragments: ["from_state", "candidate_created"] },
  lifecycle_transition_to_state_contract: { table: "autonomous_trade_lifecycle_transitions", fragments: ["to_state", "candidate_created"] },
  lifecycle_transition_operation_contract: { table: "autonomous_trade_lifecycle_transitions", fragments: ["operation", "buy_to_open"] },
  reservation_terminal_state_contract: { table: "reservation_terminal_transitions", fragments: ["terminal_state", "filled", "cancelled"] },
  reservation_release_reason_nonempty: { table: "reservation_terminal_transitions", fragments: ["release_reason", "btrim"] },
  reservation_release_reason_contract: {
    table: "reservation_terminal_transitions",
    fragments: ["release_reason", "broker_terminal_filled", "broker_absence_established"]
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
  },
  target_snapshots_family_as_of_idx: {
    table: "target_snapshots",
    unique: false,
    fragments: ["(strategy_family, as_of desc, symbol)"]
  },
  options_strategy_snapshots_family_as_of_idx: {
    table: "options_strategy_snapshots",
    unique: false,
    fragments: ["(strategy_family, as_of desc, symbol)"]
  },
  position_review_signals_open_observed_idx: {
    table: "position_review_signals",
    unique: false,
    fragments: ["(last_observed_at desc, position_id)"],
    predicateFragments: ["status = 'open'::text"]
  },
  position_review_signals_position_history_idx: {
    table: "position_review_signals",
    unique: false,
    fragments: ["(position_id, last_observed_at desc, id)"]
  }
};

const targetIdentityPrimaryKeyDefinitions = {
  target_snapshots: "primary key (symbol, as_of, risk_profile, strategy_family, expression_id)",
  options_strategy_snapshots: "primary key (symbol, as_of, risk_profile, strategy_family, expression_id)"
} as const;

export const verifyPostgresSchema = async (pool: Pool) => {
  const [tables, indexes, sequences, columns, constraints, primaryKeys, triggers] = await Promise.all([
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
      [[...POSTGRES_RELEASE_3_CONSTRAINTS, ...POSTGRES_AUTONOMOUS_LIFECYCLE_CONSTRAINTS]]
    ),
    pool.query<{ table_name: string; definition: string }>(
      `SELECT table_row.relname AS table_name,
              pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_catalog.pg_constraint AS constraint_row
       JOIN pg_catalog.pg_class AS table_row
         ON table_row.oid = constraint_row.conrelid
       WHERE constraint_row.connamespace = (
         SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = current_schema()
       )
         AND constraint_row.contype = 'p'
         AND table_row.relname = ANY($1::text[])`,
      [Object.keys(targetIdentityPrimaryKeyDefinitions)]
    ),
    pool.query<{
      trigger_name: string;
      table_name: string;
      enabled: string;
    }>(
      `SELECT trigger_row.tgname AS trigger_name,
              table_row.relname AS table_name,
              trigger_row.tgenabled AS enabled
       FROM pg_catalog.pg_trigger AS trigger_row
       JOIN pg_catalog.pg_class AS table_row
         ON table_row.oid = trigger_row.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = table_row.relnamespace
       WHERE namespace_row.nspname = current_schema()
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgname = ANY($1::text[])`,
      [[...POSTGRES_AUTONOMOUS_LIFECYCLE_TRIGGERS]]
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
  const allConstraints = [...POSTGRES_RELEASE_3_CONSTRAINTS, ...POSTGRES_AUTONOMOUS_LIFECYCLE_CONSTRAINTS] as const;
  const missingConstraints = allConstraints.filter(
    (name) => !constraintSet.has(name)
  );
  const triggerSet = new Set(triggers.rows.map((row) => row.trigger_name));
  const missingTriggers = POSTGRES_AUTONOMOUS_LIFECYCLE_TRIGGERS.filter(
    (name) => !triggerSet.has(name)
  );
  const invalidTriggers = POSTGRES_AUTONOMOUS_LIFECYCLE_TRIGGERS.filter((name) => {
    const row = triggers.rows.find((trigger) => trigger.trigger_name === name);
    if (!row) return false;
    const expectedTable = name === "reservation_terminal_transitions_append_only"
      ? "reservation_terminal_transitions"
      : "autonomous_trade_lifecycle_transitions";
    return row.table_name !== expectedTable || !["O", "A"].includes(row.enabled);
  });
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
    const expected = release3IndexDefinitions[name] ?? autonomousIndexDefinitions[name];
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
  const invalidAutonomousConstraints = POSTGRES_AUTONOMOUS_LIFECYCLE_CONSTRAINTS.filter((name) => {
    const row = constraints.rows.find((constraint) => constraint.conname === name);
    if (!row) return false;
    const expected = autonomousConstraintDefinitions[name];
    const definition = row.definition.toLowerCase().replace(/\s+/g, " ");
    return row.table_name !== expected.table || !row.convalidated || expected.fragments.some((fragment) => !definition.includes(fragment.toLowerCase()));
  });
  const missingAutonomousConstraints = POSTGRES_AUTONOMOUS_LIFECYCLE_CONSTRAINTS.filter((name) => !constraintSet.has(name));
  const primaryKeyTables = Object.keys(targetIdentityPrimaryKeyDefinitions) as Array<
    keyof typeof targetIdentityPrimaryKeyDefinitions
  >;
  const missingPrimaryKeys = primaryKeyTables.filter(
    (table) => !primaryKeys.rows.some((row) => row.table_name === table)
  );
  const invalidPrimaryKeys = primaryKeyTables.filter((table) => {
    const row = primaryKeys.rows.find((primaryKey) => primaryKey.table_name === table);
    if (!row) return false;
    return row.definition.toLowerCase().replace(/\s+/g, " ") !== targetIdentityPrimaryKeyDefinitions[table];
  });
  return {
    verificationPassed:
      missingTables.length === 0 &&
      missingIndexes.length === 0 &&
      sequencePresent &&
      missingColumns.length === 0 &&
      missingConstraints.length === 0 &&
      missingAutonomousConstraints.length === 0 &&
      missingTriggers.length === 0 &&
      invalidNotNullColumns.length === 0 &&
      invalidIndexes.length === 0 &&
      invalidConstraints.length === 0 &&
      invalidAutonomousConstraints.length === 0 &&
      missingPrimaryKeys.length === 0 &&
      invalidPrimaryKeys.length === 0 &&
      invalidTriggers.length === 0,
    expectedTableCount: POSTGRES_OPERATIONAL_TABLES.length,
    presentTableCount: POSTGRES_OPERATIONAL_TABLES.length - missingTables.length,
    expectedIndexCount: POSTGRES_OPERATIONAL_INDEXES.length,
    presentIndexCount: POSTGRES_OPERATIONAL_INDEXES.length - missingIndexes.length,
    schedulerFencingSequencePresent: sequencePresent,
    missingTables,
    missingIndexes,
    missingColumns,
    missingConstraints,
    missingAutonomousConstraints,
    missingTriggers,
    invalidNotNullColumns,
    invalidIndexes,
    invalidConstraints,
    invalidAutonomousConstraints,
    missingPrimaryKeys,
    invalidPrimaryKeys,
    invalidTriggers
  };
};
