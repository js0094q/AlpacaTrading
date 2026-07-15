import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResult } from "pg";

import {
  POSTGRES_OPERATIONAL_INDEXES,
  POSTGRES_OPERATIONAL_TABLES,
  verifyPostgresSchema
} from "../src/lib/database/postgresSchema.js";

const poolWith = (options: { missingTable?: string; missingIndex?: string; sequence?: boolean } = {}) => ({
  query: async (text: string) => {
    if (text.includes("pg_catalog.pg_tables")) {
      return {
        rows: POSTGRES_OPERATIONAL_TABLES
          .filter((name) => name !== options.missingTable)
          .map((tablename) => ({ tablename }))
      } as unknown as QueryResult;
    }
    if (text.includes("pg_catalog.pg_indexes")) {
      return {
        rows: POSTGRES_OPERATIONAL_INDEXES
          .filter((name) => name !== options.missingIndex)
          .map((indexname) => ({ indexname }))
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
  assert.equal(result.presentTableCount, 22);
  assert.equal(result.presentIndexCount, POSTGRES_OPERATIONAL_INDEXES.length);
  assert.deepEqual(result.missingTables, []);
  assert.deepEqual(result.missingIndexes, []);
});

test("schema verification reports exact missing objects without connection details", async () => {
  const result = await verifyPostgresSchema(poolWith({
    missingTable: "scheduler_leases",
    missingIndex: "scheduler_leases_fencing_token_idx",
    sequence: false
  }));
  assert.equal(result.verificationPassed, false);
  assert.deepEqual(result.missingTables, ["scheduler_leases"]);
  assert.deepEqual(result.missingIndexes, ["scheduler_leases_fencing_token_idx"]);
  assert.equal(result.schedulerFencingSequencePresent, false);
});
