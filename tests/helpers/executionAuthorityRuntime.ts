import type { Pool } from "pg";

import type { DatabaseConfig } from "../../src/lib/database/config.js";
import { withControlPlaneRuntimeContext } from "../../src/services/controlPlaneRuntimeContext.js";

const config: DatabaseConfig = {
  backend: "postgres",
  runtime: "test",
  purpose: "application",
  sslRequired: true,
  applicationName: "execution-authority-test",
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
    shadowComparison: true,
    controlPlaneAuthority: true,
    schedulerAuthority: true,
    executionStateShadow: true,
    executionStateAuthority: true,
    sqliteAuditMirror: false
  }
};

export const withExecutionAuthority = <T>(operation: () => Promise<T>) =>
  withControlPlaneRuntimeContext(
    {
      config,
      pool: {} as Pool,
      fence: {
        jobName: "paper-execution",
        workstream: "paper_execution",
        ownerId: "execution-authority-test-worker",
        runId: "execution-authority-test-run",
        fencingToken: "1"
      },
      signal: new AbortController().signal,
      operationId: "execution-authority-test-operation",
      requestId: null,
      correlationId: null,
      researchRunVersions: new Map()
    },
    operation
  );
