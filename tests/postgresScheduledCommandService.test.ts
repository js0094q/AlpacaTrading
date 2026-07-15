import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  runPostgresScheduledCommand,
  type PostgresScheduledCommandDependencies
} from "../src/services/postgresScheduledCommandService.js";

const configFor = (features: Partial<DatabaseConfig["features"]>): DatabaseConfig => ({
  backend: features.controlPlaneAuthority ? "postgres" : "sqlite",
  runtime: "test",
  purpose: "application",
  sslRequired: true,
  applicationName: "scheduled-command-test",
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
    controlPlaneAuthority: false,
    executionStateAuthority: false,
    sqliteAuditMirror: false,
    ...features
  }
});

const dependencies = (
  config: DatabaseConfig,
  calls: string[]
): PostgresScheduledCommandDependencies => ({
  loadConfig: () => config,
  createPool: () => ({ end: async () => calls.push("pool:end") } as unknown as Pool),
  invocationId: () => "scheduler-invocation-1",
  ownerId: () => "owner-1",
  runWithLease: async (input) => {
    calls.push(`lease:${input.job.workstream}`);
    return input.operation({
      fence: {
        jobName: input.job.jobName,
        workstream: input.job.workstream,
        ownerId: input.ownerId,
        runId: input.runId,
        fencingToken: "17"
      },
      signal: new AbortController().signal
    });
  },
  reportShadowFailure: (code) => calls.push(`shadow:${code}`)
});

test("unregistered commands do not create a PostgreSQL pool", async () => {
  const calls: string[] = [];
  const result = await runPostgresScheduledCommand(
    { command: "paper:runtime", operation: async () => "local" },
    dependencies(configFor({ controlPlaneAuthority: true }), calls)
  );
  assert.equal(result, "local");
  assert.deepEqual(calls, []);
});

test("research authority executes inside a fenced runtime context", async () => {
  const calls: string[] = [];
  const result = await runPostgresScheduledCommand(
    {
      command: "research",
      action: "daily",
      operation: async () => {
        calls.push("operation");
        return "completed";
      }
    },
    dependencies(
      configFor({ controlPlaneAuthority: true, sqliteAuditMirror: true }),
      calls
    )
  );
  assert.equal(result, "completed");
  assert.deepEqual(calls, ["lease:research", "operation", "pool:end"]);
});

test("only fence-aware research uses PostgreSQL scheduler authority in Release 3", async () => {
  const calls: string[] = [];
  const config = configFor({
    controlPlaneAuthority: true,
    executionStateAuthority: true,
    sqliteAuditMirror: true
  });
  for (const command of [
    "observatory:collect",
    "data:ingest",
    "paper:exit:execute",
    "zero-dte:engine"
  ]) {
    await runPostgresScheduledCommand(
      { command, operation: async () => calls.push(`operation:${command}`) },
      dependencies(config, calls)
    );
  }
  assert.deepEqual(calls, [
    "operation:observatory:collect",
    "operation:data:ingest",
    "operation:paper:exit:execute",
    "operation:zero-dte:engine"
  ]);
});

test("shadow lease failure is reported but cannot block the SQLite-authoritative operation", async () => {
  const calls: string[] = [];
  const deps = dependencies(configFor({ shadowComparison: true }), calls);
  deps.runWithLease = async () => {
    calls.push("lease:attempt");
    throw new Error("synthetic shadow lease failure");
  };
  const result = await runPostgresScheduledCommand(
    { command: "research:daily", operation: async () => "sqlite-result" },
    deps
  );
  assert.equal(result, "sqlite-result");
  assert.deepEqual(calls, [
    "lease:attempt",
    "shadow:POSTGRES_SCHEDULER_SHADOW_FAILED",
    "pool:end"
  ]);
});

test("shadow release failure does not rerun an operation that already completed", async () => {
  const calls: string[] = [];
  const deps = dependencies(configFor({ shadowComparison: true }), calls);
  deps.runWithLease = async (input) => {
    calls.push("lease:attempt");
    await input.operation({
      fence: {
        jobName: input.job.jobName,
        workstream: input.job.workstream,
        ownerId: input.ownerId,
        runId: input.runId,
        fencingToken: "17"
      },
      signal: new AbortController().signal
    });
    throw new Error("synthetic shadow release failure");
  };
  const result = await runPostgresScheduledCommand(
    {
      command: "research:daily",
      operation: async () => {
        calls.push("operation");
        return "sqlite-result";
      }
    },
    deps
  );
  assert.equal(result, "sqlite-result");
  assert.deepEqual(calls, [
    "lease:attempt",
    "operation",
    "shadow:POSTGRES_SCHEDULER_SHADOW_FAILED",
    "pool:end"
  ]);
});

test("shadow mode never retries an operation that started and failed", async () => {
  const calls: string[] = [];
  const deps = dependencies(configFor({ shadowComparison: true }), calls);
  const domainError = new Error("synthetic domain failure");
  await assert.rejects(
    runPostgresScheduledCommand(
      {
        command: "research:daily",
        operation: async () => {
          calls.push("operation");
          throw domainError;
        }
      },
      deps
    ),
    (error) => error === domainError
  );
  assert.deepEqual(calls, ["lease:research", "operation", "pool:end"]);
});
