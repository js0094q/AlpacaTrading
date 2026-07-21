import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResult } from "pg";

import {
  POSTGRES_OPERATIONAL_INDEXES,
  POSTGRES_OPERATIONAL_TABLES,
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
        rows: POSTGRES_RELEASE_3_CONSTRAINTS
          .filter((conname) => conname !== options.missingConstraint)
          .map((conname) => ({
            conname,
            table_name: conname === "scheduler_leases_timestamp_order"
              ? "scheduler_leases"
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
                : "CHECK ((processed_at IS NULL) OR (processing_started_at IS NULL) OR (processed_at >= processing_started_at))"
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
  assert.ok(POSTGRES_OPERATIONAL_TABLES.includes("reconciliation_discrepancies"));
  assert.ok(POSTGRES_OPERATIONAL_INDEXES.includes("candidates_decision_id_idx"));
  assert.ok(
    POSTGRES_OPERATIONAL_INDEXES.includes("reconciliation_discrepancies_checkpoint_idx")
  );
  assert.equal(result.presentIndexCount, POSTGRES_OPERATIONAL_INDEXES.length);
  assert.deepEqual(result.missingTables, []);
  assert.deepEqual(result.missingIndexes, []);
  assert.deepEqual(result.missingColumns, []);
  assert.deepEqual(result.missingConstraints, []);
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
  assert.deepEqual(result.invalidNotNullColumns, ["candidates.decision_id"]);
  assert.deepEqual(result.invalidIndexes, ["candidates_decision_id_idx"]);
  assert.deepEqual(result.invalidConstraints, ["scheduler_leases_timestamp_order"]);
  assert.equal(result.schedulerFencingSequencePresent, false);
});
