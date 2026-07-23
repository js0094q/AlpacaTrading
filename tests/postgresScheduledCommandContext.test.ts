import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  runPostgresScheduledCommand,
  type PostgresScheduledCommandDependencies
} from "../src/services/postgresScheduledCommandService.js";

const config: DatabaseConfig = {
  backend: "postgres",
  runtime: "test",
  purpose: "application",
  sslRequired: true,
  applicationName: "scheduled-command-context-test",
  maxConnections: 1,
  minConnections: 0,
  idleTimeoutMs: 1_000,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 1_000,
  lockTimeoutMs: 500,
  idleInTransactionTimeoutMs: 1_000,
  transactionTimeoutMs: 2_000,
  features: {
    postgresReads: true,
    postgresWrites: true,
    shadowComparison: false,
    controlPlaneAuthority: true,
    schedulerAuthority: true,
    executionStateShadow: false,
    executionStateAuthority: true,
    sqliteAuditMirror: false
  }
};

test("registered commands receive the leased PostgreSQL pool, config, fence, and signal", async () => {
  const pool = { end: async () => undefined } as unknown as Pool;
  const signal = new AbortController().signal;
  const fence = {
    jobName: "research",
    workstream: "research",
    ownerId: "owner",
    runId: "run",
    fencingToken: "41"
  };
  const dependencies: PostgresScheduledCommandDependencies = {
    loadConfig: () => config,
    createPool: () => pool,
    invocationId: () => "run",
    ownerId: () => "owner",
    runWithLease: async (input) => input.operation({ fence, signal }),
    reportShadowFailure: () => undefined
  };

  const received = await runPostgresScheduledCommand(
    {
      command: "research:daily",
      operation: async (context) => context
    },
    dependencies
  );

  assert.equal(received?.pool, pool);
  assert.equal(received?.config, config);
  assert.equal(received?.fence, fence);
  assert.equal(received?.signal, signal);
});

test("unregistered commands receive no PostgreSQL scheduler context", async () => {
  const received = await runPostgresScheduledCommand(
    { command: "not:registered", operation: async (context) => context },
    {
      loadConfig: () => config,
      createPool: () => { throw new Error("pool must not be created"); },
      invocationId: () => "unused",
      ownerId: () => "unused",
      runWithLease: async () => { throw new Error("lease must not run"); },
      reportShadowFailure: () => undefined
    }
  );
  assert.equal(received, undefined);
});
