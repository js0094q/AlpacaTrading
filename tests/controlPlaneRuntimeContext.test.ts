import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import { getDb } from "../src/lib/db.js";
import { insertPaperExecutionLedgerEntry } from "../src/services/paperExecutionLedgerService.js";
import {
  assertControlPlaneFenceActive,
  assertScheduledWriteFenceActive,
  currentControlPlaneRuntimeContext,
  withControlPlaneRuntimeContext
} from "../src/services/controlPlaneRuntimeContext.js";

const config = {
  backend: "postgres",
  runtime: "test",
  purpose: "application",
  sslRequired: true,
  applicationName: "control-plane-context-test",
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
    executionStateAuthority: false,
    sqliteAuditMirror: true
  }
} satisfies DatabaseConfig;

test("control-plane scheduler context is scoped to one async operation", async () => {
  const abort = new AbortController();
  assert.equal(currentControlPlaneRuntimeContext(), null);
  await withControlPlaneRuntimeContext(
    {
      config,
      pool: {} as Pool,
      fence: {
        jobName: "research",
        workstream: "research",
        ownerId: "worker-1",
        runId: "scheduler-run-1",
        fencingToken: "9"
      },
      signal: abort.signal,
      operationId: "operation-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      researchRunVersions: new Map()
    },
    async () => {
      assert.equal(currentControlPlaneRuntimeContext()?.fence.fencingToken, "9");
      assertControlPlaneFenceActive();
      await Promise.resolve();
      assert.equal(currentControlPlaneRuntimeContext()?.operationId, "operation-1");
    }
  );
  assert.equal(currentControlPlaneRuntimeContext(), null);
});

test("an aborted scheduler fence fails closed before another authoritative write", async () => {
  const abort = new AbortController();
  abort.abort(new Error("lost"));
  await assert.rejects(
    withControlPlaneRuntimeContext(
      {
        config,
        pool: {} as Pool,
        fence: {
          jobName: "research",
          workstream: "research",
          ownerId: "worker-1",
          runId: "scheduler-run-1",
          fencingToken: "9"
        },
        signal: abort.signal,
        operationId: "operation-1",
        requestId: null,
        correlationId: null,
        researchRunVersions: new Map()
      },
      async () => assertControlPlaneFenceActive()
    ),
    (error) =>
      error instanceof Error &&
      error.name === "ControlPlaneFenceLostError" &&
      error.message === "PostgreSQL scheduler fence is no longer active."
  );
});

test("scheduled write guards fail closed only after scheduler authority", async () => {
  assert.equal(assertScheduledWriteFenceActive(), null);
  const abort = new AbortController();
  abort.abort(new Error("lost"));
  const context = {
    config,
    pool: {} as Pool,
    fence: {
      jobName: "paper-execution",
      workstream: "paper_execution",
      ownerId: "worker-1",
      runId: "scheduler-run-1",
      fencingToken: "10"
    },
    signal: abort.signal,
    operationId: "operation-2",
    requestId: null,
    correlationId: null,
    researchRunVersions: new Map<string, number>()
  };

  await assert.rejects(
    withControlPlaneRuntimeContext(context, async () =>
      assertScheduledWriteFenceActive()
    ),
    (error) => error instanceof Error && error.name === "ControlPlaneFenceLostError"
  );

  await withControlPlaneRuntimeContext(
    {
      ...context,
      config: {
        ...config,
        features: { ...config.features, schedulerAuthority: false }
      }
    },
    async () => assert.equal(assertScheduledWriteFenceActive()?.signal.aborted, true)
  );
});

test("a stale scheduler owner cannot commit an execution-ledger write", async () => {
  const abort = new AbortController();
  abort.abort(new Error("lease-lost"));
  const dedupeKey = "stale-fence-execution-ledger";

  await assert.rejects(
    withControlPlaneRuntimeContext(
      {
        config,
        pool: {} as Pool,
        fence: {
          jobName: "paper-execution",
          workstream: "paper_execution",
          ownerId: "worker-stale",
          runId: "scheduler-run-stale",
          fencingToken: "11"
        },
        signal: abort.signal,
        operationId: "operation-stale",
        requestId: null,
        correlationId: null,
        researchRunVersions: new Map()
      },
      async () => {
        insertPaperExecutionLedgerEntry({
          mode: "test",
          assetClass: "equity",
          symbol: "SPY",
          dedupeKey,
          clientOrderId: dedupeKey,
          status: "built",
          payload: { test: true }
        });
      }
    ),
    (error) => error instanceof Error && error.name === "ControlPlaneFenceLostError"
  );

  const row = getDb().prepare(
    "SELECT id FROM paper_execution_ledger WHERE dedupe_key = ?"
  ).get(dedupeKey);
  assert.equal(row, undefined);
});
