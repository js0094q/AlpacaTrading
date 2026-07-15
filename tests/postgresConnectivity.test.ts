import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  PostgresConnectivityError,
  checkPostgresConnectivity
} from "../src/lib/database/postgresConnectivity.js";

const config: DatabaseConfig = {
  backend: "postgres",
  runtime: "test",
  purpose: "application",
  pooledUrl: "postgresql://synthetic:synthetic-password@host.invalid/db",
  pooledVariable: "DATABASE_URL",
  sslRequired: true,
  applicationName: "connectivity-test",
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
    executionStateAuthority: false,
    sqliteAuditMirror: false
  }
};

test("connectivity diagnostics expose capability and variable name but no endpoint value", async () => {
  let ended = 0;
  const client = {
    query: async () => ({
      rows: [{
        server_version_num: "170004",
        transaction_timeout: "0"
      }],
      rowCount: 1
    } as unknown as QueryResult),
    connection: { stream: { encrypted: true } },
    release: () => undefined
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
    end: async () => {
      ended += 1;
    }
  } as unknown as Pool;

  const result = await checkPostgresConnectivity(config, {
    mode: "pooled",
    createPool: () => pool,
    now: (() => {
      let current = 100;
      return () => current += 7;
    })()
  });

  assert.deepEqual(result, {
    connectionTest: "passed",
    mode: "pooled",
    variable: "DATABASE_URL",
    ssl: "enabled",
    serverMajorVersion: 17,
    transactionTimeoutSupported: true,
    latencyMs: 7
  });
  assert.equal(ended, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-password|host\.invalid/);
});

test("connectivity failures are sanitized before crossing the command boundary", async () => {
  const client = {
    query: async () => {
      throw Object.assign(
        new Error("failed postgresql://synthetic:synthetic-password@host.invalid/db"),
        { code: "ECONNRESET" }
      );
    },
    connection: { stream: { encrypted: true } },
    release: () => undefined
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
    end: async () => undefined
  } as unknown as Pool;

  await assert.rejects(
    () => checkPostgresConnectivity(config, { mode: "pooled", createPool: () => pool }),
    (error) => {
      assert.ok(error instanceof PostgresConnectivityError);
      assert.equal(error.code, "ECONNRESET");
      assert.doesNotMatch(error.message, /synthetic-password|host\.invalid/);
      return true;
    }
  );
});

test("connectivity fails when the required transaction timeout is unsupported", async () => {
  const client = {
    query: async () => ({
      rows: [{ server_version_num: "160010", transaction_timeout: null }],
      rowCount: 1
    } as unknown as QueryResult),
    connection: { stream: { encrypted: true } },
    release: () => undefined
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
    end: async () => undefined
  } as unknown as Pool;

  await assert.rejects(
    () => checkPostgresConnectivity(config, { mode: "pooled", createPool: () => pool }),
    /POSTGRES_TRANSACTION_TIMEOUT_UNSUPPORTED/
  );
});
