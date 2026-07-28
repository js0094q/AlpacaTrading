import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResult } from "pg";

import {
  POSTGRES_OPERATIONAL_INDEXES,
  POSTGRES_OPERATIONAL_TABLES,
  POSTGRES_AUTONOMOUS_LIFECYCLE_CONSTRAINTS,
  POSTGRES_AUTONOMOUS_LIFECYCLE_TRIGGERS,
  POSTGRES_RELEASE_3_COLUMNS,
  POSTGRES_RELEASE_3_CONSTRAINTS,
  POSTGRES_RELEASE_3_NOT_NULL_COLUMNS,
  verifyPostgresSchema
} from "../src/lib/database/postgresSchema.js";

const poolWith = (options: {
  missingTable?: string;
  missingIndex?: string;
  missingColumn?: string;
  missingConstraint?: string;
  missingTrigger?: string;
  invalidConstraint?: string;
  invalidIndex?: string;
  nullableColumn?: string;
  sequence?: boolean;
} = {}) => ({
  query: async (text: string) => {
    if (text.includes("pg_catalog.pg_tables")) {
      return {
        rows: POSTGRES_OPERATIONAL_TABLES
          .filter((name) => name !== options.missingTable)
          .map((tablename) => ({ tablename }))
      } as unknown as QueryResult;
    }
    if (text.includes("pg_catalog.pg_index")) {
      const indexMetadata: Record<string, {
        tableName: string;
        indexdef: string;
        unique?: boolean;
        predicate?: string | null;
      }> = {
        candidates_decision_id_idx: {
          tableName: "candidates",
          indexdef: "CREATE UNIQUE INDEX candidates_decision_id_idx ON candidates (decision_id)",
          unique: true
        },
        workstream_events_stale_processing_idx: {
          tableName: "workstream_events",
          indexdef: "CREATE INDEX workstream_events_stale_processing_idx ON workstream_events (processing_started_at, workstream, event_id)",
          predicate: "processing_status = 'processing'::text"
        },
        reconciliation_discrepancies_checkpoint_idx: {
          tableName: "reconciliation_discrepancies",
          indexdef: "CREATE INDEX reconciliation_discrepancies_checkpoint_idx ON reconciliation_discrepancies (checkpoint_id, observed_at, id)"
        },
        reconciliation_discrepancies_domain_idx: {
          tableName: "reconciliation_discrepancies",
          indexdef: "CREATE INDEX reconciliation_discrepancies_domain_idx ON reconciliation_discrepancies (domain, discrepancy_type, observed_at DESC)"
        },
        order_intents_lifecycle_state_idx: {
          tableName: "order_intents",
          indexdef: "CREATE INDEX order_intents_lifecycle_state_idx ON order_intents (lifecycle_state, updated_at DESC)"
        },
        order_intents_autonomous_cycle_idx: {
          tableName: "order_intents",
          indexdef: "CREATE INDEX order_intents_autonomous_cycle_idx ON order_intents (autonomous_cycle_id, workstream_execution_id, created_at DESC)"
        },
        autonomous_trade_lifecycle_transitions_intent_idx: {
          tableName: "autonomous_trade_lifecycle_transitions",
          indexdef: "CREATE INDEX autonomous_trade_lifecycle_transitions_intent_idx ON autonomous_trade_lifecycle_transitions (order_intent_id, occurred_at DESC)"
        }
      };
      return {
        rows: POSTGRES_OPERATIONAL_INDEXES
          .filter((name) => name !== options.missingIndex)
          .map((indexname) => {
            const metadata = indexMetadata[indexname] ?? {
              tableName: "synthetic_table",
              indexdef: `CREATE INDEX ${indexname} ON synthetic_table (synthetic_column)`
            };
            return {
              indexname,
              table_name: metadata.tableName,
              indexdef: options.invalidIndex === indexname
                ? `CREATE INDEX ${indexname} ON wrong_table (wrong_column)`
                : metadata.indexdef,
              is_unique: metadata.unique ?? false,
              is_valid: options.invalidIndex !== indexname,
              is_ready: true,
              predicate: metadata.predicate ?? null
            };
          })
      } as unknown as QueryResult;
    }
    if (text.includes("information_schema.columns")) {
      return {
        rows: POSTGRES_RELEASE_3_COLUMNS
          .filter((name) => name !== options.missingColumn)
          .map((name) => {
            const [table_name, column_name] = name.split(".");
            return {
              table_name,
              column_name,
              is_nullable: options.nullableColumn === name ? "YES" : "NO"
            };
          })
      } as unknown as QueryResult;
    }
    if (text.includes("pg_catalog.pg_constraint")) {
      return {
        rows: [...POSTGRES_RELEASE_3_CONSTRAINTS, ...POSTGRES_AUTONOMOUS_LIFECYCLE_CONSTRAINTS]
          .filter((conname) => conname !== options.missingConstraint)
          .map((conname) => ({
            conname,
            table_name: conname === "scheduler_leases_timestamp_order"
              ? "scheduler_leases"
              : conname === "option_contracts_evidence_object"
                ? "option_contracts"
                : conname.startsWith("order_intents_")
                  ? "order_intents"
                  : conname.startsWith("lifecycle_transition_")
                    ? "autonomous_trade_lifecycle_transitions"
                    : conname.startsWith("reservation_")
                      ? "reservation_terminal_transitions"
                      : "workstream_events",
            convalidated: options.invalidConstraint === conname ? false : true,
            definition: conname === "scheduler_leases_timestamp_order"
              ? "CHECK ((heartbeat_at >= acquired_at) AND (expires_at > heartbeat_at) AND ((released_at IS NULL) OR (released_at >= acquired_at)))"
              : conname === "workstream_events_attempts_nonnegative"
                ? "CHECK (attempts >= 0)"
              : conname === "workstream_events_processing_timestamp_order"
                ? "CHECK ((processing_started_at IS NULL) OR (processing_started_at >= produced_at))"
                : conname === "workstream_events_processing_started_required"
                  ? "CHECK ((processing_status <> 'processing'::text) OR (processing_started_at IS NOT NULL))"
                : conname === "option_contracts_evidence_object"
                  ? "CHECK (jsonb_typeof(evidence) = 'object'::text)"
                  : conname === "order_intents_operation_contract"
                    ? "CHECK ((operation IS NULL) OR (operation = ANY (ARRAY['buy_to_open'::text])))"
                  : conname === "order_intents_strategy_classification_contract"
                    ? "CHECK ((strategy_classification IS NULL) OR (strategy_classification = ANY (ARRAY['standard_long_call'::text])))"
                  : conname === "order_intents_lifecycle_state_contract"
                    ? "CHECK (lifecycle_state = ANY (ARRAY['candidate_created'::text]))"
                  : conname === "order_intents_lifecycle_required"
                    ? "CHECK (lifecycle_state IS NOT NULL)"
                  : conname === "lifecycle_transition_from_state_contract"
                    ? "CHECK ((from_state IS NULL) OR (from_state = ANY (ARRAY['candidate_created'::text])))"
                  : conname === "lifecycle_transition_to_state_contract"
                    ? "CHECK (to_state = ANY (ARRAY['candidate_created'::text]))"
                  : conname === "lifecycle_transition_operation_contract"
                    ? "CHECK ((operation IS NULL) OR (operation = ANY (ARRAY['buy_to_open'::text])))"
                  : conname === "reservation_terminal_state_contract"
                    ? "CHECK (terminal_state = ANY (ARRAY['filled'::text, 'cancelled'::text]))"
                  : conname === "reservation_release_reason_nonempty"
                    ? "CHECK (btrim(release_reason) <> ''::text)"
                  : conname === "reservation_release_reason_contract"
                    ? "CHECK (release_reason = ANY (ARRAY['broker_terminal_filled'::text, 'broker_absence_established'::text]))"
                : "CHECK ((processed_at IS NULL) OR (processing_started_at IS NULL) OR (processed_at >= processing_started_at))"
          }))
      } as unknown as QueryResult;
    }
    if (text.includes("pg_catalog.pg_trigger")) {
      return {
        rows: POSTGRES_AUTONOMOUS_LIFECYCLE_TRIGGERS
          .filter((trigger_name) => trigger_name !== options.missingTrigger)
          .map((trigger_name) => ({
            trigger_name,
            table_name: trigger_name === "reservation_terminal_transitions_append_only"
              ? "reservation_terminal_transitions"
              : "autonomous_trade_lifecycle_transitions",
            enabled: "O"
          }))
      } as unknown as QueryResult;
    }
    return {
      rows: options.sequence === false ? [] : [{ sequencename: "scheduler_fencing_token_seq" }]
    } as unknown as QueryResult;
  }
}) as unknown as Pool;

test("schema verification requires every operational table, index, and fencing sequence", async () => {
  const result = await verifyPostgresSchema(poolWith());
  assert.equal(result.verificationPassed, true);
  assert.equal(result.presentTableCount, POSTGRES_OPERATIONAL_TABLES.length);
  assert.ok(POSTGRES_OPERATIONAL_TABLES.includes("market_bars"));
  assert.ok(POSTGRES_OPERATIONAL_TABLES.includes("research_evidence"));
  assert.ok(POSTGRES_OPERATIONAL_TABLES.includes("research_signals"));
  assert.ok(POSTGRES_OPERATIONAL_TABLES.includes("reconciliation_discrepancies"));
  assert.ok(POSTGRES_OPERATIONAL_INDEXES.includes("candidates_decision_id_idx"));
  assert.ok(
    POSTGRES_OPERATIONAL_INDEXES.includes("reconciliation_discrepancies_checkpoint_idx")
  );
  assert.ok(
    POSTGRES_OPERATIONAL_INDEXES.includes("research_signals_symbol_as_of_idx")
  );
  for (const column of [
    "option_contracts.contract_id",
    "option_contracts.status",
    "option_contracts.exercise_style",
    "option_contracts.open_interest",
    "option_contracts.open_interest_date",
    "option_contracts.close_price",
    "option_contracts.close_price_date",
    "option_contracts.evidence"
  ]) {
    assert.ok(POSTGRES_RELEASE_3_COLUMNS.includes(column as never), column);
  }
  assert.equal(result.presentIndexCount, POSTGRES_OPERATIONAL_INDEXES.length);
  assert.deepEqual(result.missingTables, []);
  assert.deepEqual(result.missingIndexes, []);
  assert.deepEqual(result.missingColumns, []);
  assert.deepEqual(result.missingConstraints, []);
  assert.deepEqual(result.missingTriggers, []);
  assert.deepEqual(result.invalidNotNullColumns, []);
  assert.deepEqual(result.invalidIndexes, []);
  assert.deepEqual(result.invalidConstraints, []);
});

test("schema verification reports exact missing objects without connection details", async () => {
  const result = await verifyPostgresSchema(poolWith({
    missingTable: "scheduler_leases",
    missingIndex: "scheduler_leases_fencing_token_idx",
    missingColumn: "candidates.decision_id",
    missingConstraint: "workstream_events_attempts_nonnegative",
    missingTrigger: "autonomous_lifecycle_transition_edge",
    invalidConstraint: "scheduler_leases_timestamp_order",
    invalidIndex: "candidates_decision_id_idx",
    nullableColumn: POSTGRES_RELEASE_3_NOT_NULL_COLUMNS[0],
    sequence: false
  }));
  assert.equal(result.verificationPassed, false);
  assert.deepEqual(result.missingTables, ["scheduler_leases"]);
  assert.deepEqual(result.missingIndexes, ["scheduler_leases_fencing_token_idx"]);
  assert.deepEqual(result.missingColumns, ["candidates.decision_id"]);
  assert.deepEqual(result.missingConstraints, ["workstream_events_attempts_nonnegative"]);
  assert.deepEqual(result.missingTriggers, ["autonomous_lifecycle_transition_edge"]);
  assert.deepEqual(result.invalidNotNullColumns, ["candidates.decision_id"]);
  assert.deepEqual(result.invalidIndexes, ["candidates_decision_id_idx"]);
  assert.deepEqual(result.invalidConstraints, ["scheduler_leases_timestamp_order"]);
  assert.equal(result.schedulerFencingSequencePresent, false);
});
