import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  assertControlPlaneFenceActive,
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
