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
    schedulerAuthority: false,
    executionStateShadow: false,
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
      configFor({
        controlPlaneAuthority: true,
        schedulerAuthority: true,
        sqliteAuditMirror: true
      }),
      calls
    )
  );
  assert.equal(result, "completed");
  assert.deepEqual(calls, ["lease:research", "operation", "pool:end"]);
});

test("long paper review workstreams receive a bounded lease window", async () => {
  const calls: string[] = [];
  let leaseDurationMs: number | undefined;
  let heartbeatIntervalMs: number | undefined;
  const deps = dependencies(
    configFor({ controlPlaneAuthority: true, schedulerAuthority: true }),
    calls
  );
  deps.runWithLease = async (input) => {
    leaseDurationMs = input.leaseDurationMs;
    heartbeatIntervalMs = input.heartbeatIntervalMs;
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
  };

  await runPostgresScheduledCommand(
    { command: "paper:ops:review", operation: async () => "completed" },
    deps
  );

  assert.equal(leaseDurationMs, 5 * 60_000);
  assert.equal(heartbeatIntervalMs, 15_000);
});

test("every registered mutating workstream uses PostgreSQL scheduler authority", async () => {
  const config = configFor({
    controlPlaneAuthority: true,
    schedulerAuthority: true,
    executionStateAuthority: true,
    sqliteAuditMirror: true
  });
  const workstreams = [
    ["research:daily", "research"],
    ["zero-dte:engine", "zero_dte"],
    ["observatory:collect", "observatory"],
    ["zero-dte:reconcile", "reconciliation"],
    ["paper:exit:review", "exit_review"],
    ["paper:exit:execute", "paper_exit"],
    ["paper:execute:reviewed", "paper_execution"],
    ["paper:ops:morning", "allocation"],
    ["data:ingest", "market_data_refresh"],
    ["universe:lifecycle", "universe_lifecycle"],
    ["system:recover", "autonomous_recovery"]
  ] as const;

  for (const [command, workstream] of workstreams) {
    const calls: string[] = [];
    await runPostgresScheduledCommand(
      { command, operation: async () => calls.push(`operation:${command}`) },
      dependencies(config, calls)
    );
    assert.deepEqual(calls, [
      `lease:${workstream}`,
      `operation:${command}`,
      "pool:end"
    ]);
  }
});

test("control-plane authority does not implicitly grant scheduler authority", async () => {
  const calls: string[] = [];
  const result = await runPostgresScheduledCommand(
    { command: "research:daily", operation: async () => "control-plane-only" },
    dependencies(
      configFor({ controlPlaneAuthority: true, sqliteAuditMirror: true }),
      calls
    )
  );
  assert.equal(result, "control-plane-only");
  assert.deepEqual(calls, []);
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
