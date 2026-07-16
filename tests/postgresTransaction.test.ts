import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import { withPostgresTransaction } from "../src/lib/database/postgresTransaction.js";

const config: DatabaseConfig = {
  backend: "postgres",
  runtime: "test",
  purpose: "application",
  pooledUrl: "postgresql://synthetic:synthetic@host.invalid/db",
  pooledVariable: "DATABASE_URL",
  sslRequired: true,
  applicationName: "test",
  maxConnections: 1,
  minConnections: 0,
  idleTimeoutMs: 1_000,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 15_000,
  transactionTimeoutMs: 30_000,
  features: {
    postgresReads: false,
    postgresWrites: false,
    shadowComparison: false,
    controlPlaneAuthority: false,
    schedulerAuthority: false,
    executionStateShadow: false,
    executionStateAuthority: false,
    sqliteAuditMirror: false
  }
};

const fakePool = () => {
  const queries: string[] = [];
  let releases = 0;
  const client = {
    query: async (text: string) => {
      queries.push(text);
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    },
    release: () => {
      releases += 1;
    }
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client
  } as unknown as Pool;
  return { pool, client, queries, releases: () => releases };
};

test("uses one checked-out client from BEGIN through COMMIT and releases in finally", async () => {
  const fake = fakePool();
  const result = await withPostgresTransaction(
    fake.pool,
    config,
    async (client) => {
      assert.strictEqual(client, fake.client);
      await client.query("SELECT 1");
      return "committed";
    },
    { isolationLevel: "serializable" }
  );

  assert.equal(result, "committed");
  assert.equal(fake.queries[0], "BEGIN");
  assert.ok(fake.queries.includes("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE"));
  assert.ok(fake.queries.includes("SET LOCAL statement_timeout = '15000ms'"));
  assert.ok(fake.queries.includes("SET LOCAL lock_timeout = '5000ms'"));
  assert.ok(fake.queries.includes("SET LOCAL transaction_timeout = '30000ms'"));
  assert.ok(fake.queries.includes("SELECT 1"));
  assert.equal(fake.queries.at(-1), "COMMIT");
  assert.equal(fake.releases(), 1);
});

test("rolls back on the same client and preserves the causal error", async () => {
  const fake = fakePool();
  const causal = new Error("forced transaction failure");
  let thrown: unknown;

  try {
    await withPostgresTransaction(fake.pool, config, async () => {
      throw causal;
    });
  } catch (error) {
    thrown = error;
  }

  assert.strictEqual(thrown, causal);
  assert.equal(fake.queries.at(-1), "ROLLBACK");
  assert.equal(fake.queries.includes("COMMIT"), false);
  assert.equal(fake.releases(), 1);
});

test("surfaces rollback failure as cause without losing the original transaction error", async () => {
  const queries: string[] = [];
  const causal = new Error("operation failed");
  const rollback = new Error("rollback failed");
  let releases = 0;
  let releaseError: Error | boolean | undefined;
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text === "ROLLBACK") throw rollback;
      return { rows: [], rowCount: 0 };
    },
    release: (error?: Error | boolean) => {
      releases += 1;
      releaseError = error;
    }
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;

  await assert.rejects(
    () => withPostgresTransaction(pool, config, async () => Promise.reject(causal)),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === causal &&
      error.errors[1] === rollback
  );
  assert.equal(releases, 1);
  assert.ok(releaseError instanceof AggregateError);
});
