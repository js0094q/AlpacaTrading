import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import type {
  SchedulerLeaseMutationResult,
  SchedulerLeaseRecord
} from "../src/repositories/contracts/schedulerLeaseRepository.js";
import {
  POSTGRES_SCHEDULER_JOBS,
  PostgresSchedulerExecutionError,
  runWithPostgresSchedulerLease,
  type PostgresSchedulerLeaseStore
} from "../src/services/postgresSchedulerExecutionService.js";

const config = (controlPlaneAuthority = true): DatabaseConfig => ({
  backend: "postgres",
  runtime: "test",
  purpose: "application",
  pooledUrl: "postgresql://synthetic:synthetic@host.invalid/db",
  pooledVariable: "DATABASE_URL",
  sslRequired: true,
  applicationName: "scheduler-execution-test",
  maxConnections: 3,
  minConnections: 0,
  idleTimeoutMs: 1_000,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 15_000,
  transactionTimeoutMs: 30_000,
  features: {
    postgresReads: true,
    postgresWrites: true,
    shadowComparison: false,
    controlPlaneAuthority,
    schedulerAuthority: controlPlaneAuthority,
    executionStateShadow: false,
    executionStateAuthority: false,
    sqliteAuditMirror: false
  }
});

const createTransactionPool = () => {
  const events: string[] = [];
  const active = new Set<number>();
  const clientIds = new WeakMap<PoolClient, number>();
  let nextClientId = 0;

  const pool = {
    connect: async () => {
      const id = ++nextClientId;
      const client = {
        query: async (text: string) => {
          if (text === "BEGIN") {
            assert.equal(active.has(id), false);
            active.add(id);
            events.push(`BEGIN:${id}`);
          } else if (text === "COMMIT" || text === "ROLLBACK") {
            assert.equal(active.has(id), true);
            events.push(`${text}:${id}`);
            active.delete(id);
          } else {
            assert.equal(active.has(id), true);
            events.push(`QUERY:${id}`);
          }
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        },
        release: () => events.push(`RELEASE:${id}`)
      } as unknown as PoolClient;
      clientIds.set(client, id);
      events.push(`CONNECT:${id}`);
      return client;
    }
  } as unknown as Pool;

  return { pool, events, active, clientIds };
};

const lease = (): SchedulerLeaseRecord => ({
  jobName: "research",
  workstream: "research",
  ownerId: "worker-a",
  runId: "run-a",
  fencingToken: "9007199254740993",
  acquiredAt: "2026-07-15T20:00:00.000Z",
  heartbeatAt: "2026-07-15T20:00:00.000Z",
  expiresAt: "2026-07-15T20:01:00.000Z",
  releasedAt: null,
  releaseReason: null,
  status: "held",
  version: 1
});

const abortableWaitAfterFirstTick = () => {
  let calls = 0;
  return async (_milliseconds: number, signal: AbortSignal) => {
    calls += 1;
    if (calls === 1) return;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
};

test("exports bounded scheduler mappings for the restored autonomous workstreams", () => {
  assert.deepEqual(Object.keys(POSTGRES_SCHEDULER_JOBS), [
    "research",
    "zeroDte",
    "observatory",
    "reconciliation",
    "exitReview",
    "paperExit",
    "paperExecution",
    "allocation",
    "marketDataRefresh",
    "universeLifecycle",
    "autonomousRecovery",
    "optionDiscovery",
    "hedgeReview",
    "hedgeExit",
    "learning",
    "autonomousWorkerState"
  ]);
  assert.deepEqual(POSTGRES_SCHEDULER_JOBS.marketDataRefresh, {
    jobName: "market-data-refresh",
    workstream: "market_data_refresh"
  });
  assert.deepEqual(
    Object.values(POSTGRES_SCHEDULER_JOBS).map((job) => job.workstream),
    [
      "research",
      "zero_dte",
      "observatory",
      "reconciliation",
      "exit_review",
      "paper_exit",
      "paper_execution",
      "allocation",
      "market_data_refresh",
      "universe_lifecycle",
      "autonomous_recovery",
      "option_discovery",
      "hedge_review",
      "hedge_exit",
      "learning",
      "autonomous_worker_state"
    ]
  );
});

test("uses separate checked-out transactions for acquire, heartbeat, and release", async () => {
  const fake = createTransactionPool();
  const currentLease = lease();
  let heartbeatFinished!: () => void;
  const heartbeatObserved = new Promise<void>((resolve) => {
    heartbeatFinished = resolve;
  });
  const repository: PostgresSchedulerLeaseStore = {
    async acquire(_input, context) {
      fake.events.push(`ACQUIRE:${fake.clientIds.get(context.transaction)}`);
      return { status: "acquired", lease: currentLease };
    },
    async heartbeat(_input, context) {
      fake.events.push(`HEARTBEAT:${fake.clientIds.get(context.transaction)}`);
      heartbeatFinished();
      return {
        status: "updated",
        lease: { ...currentLease, version: 2 }
      };
    },
    async release(input, context) {
      fake.events.push(`RELEASE_LEASE:${fake.clientIds.get(context.transaction)}`);
      assert.equal(input.releaseReason, "completed");
      return {
        status: "updated",
        lease: { ...currentLease, status: "released", version: 3 }
      };
    }
  };

  const value = await runWithPostgresSchedulerLease(
    {
      pool: fake.pool,
      config: config(),
      job: POSTGRES_SCHEDULER_JOBS.research,
      ownerId: "worker-a",
      runId: "run-a",
      operationId: "research-run-a",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
      operation: async ({ fence, signal }) => {
        fake.events.push("OPERATION_START");
        assert.equal(fake.active.size, 0);
        assert.equal(fence.fencingToken, "9007199254740993");
        assert.equal(signal.aborted, false);
        await heartbeatObserved;
        fake.events.push("OPERATION_END");
        return "complete";
      }
    },
    {
      repository,
      now: () => new Date("2026-07-15T20:00:00.000Z"),
      wait: abortableWaitAfterFirstTick()
    }
  );

  assert.equal(value, "complete");
  assert.equal(fake.events.filter((event) => event.startsWith("CONNECT:")).length, 3);
  assert.ok(fake.events.indexOf("COMMIT:1") < fake.events.indexOf("OPERATION_START"));
  assert.ok(fake.events.indexOf("OPERATION_END") < fake.events.indexOf("BEGIN:3"));
  assert.deepEqual(
    fake.events.filter((event) => /^(ACQUIRE|HEARTBEAT|RELEASE_LEASE):/.test(event)),
    ["ACQUIRE:1", "HEARTBEAT:2", "RELEASE_LEASE:3"]
  );
  assert.equal(fake.active.size, 0);
});

test("aborts the operation and fails closed when a heartbeat loses the fence", async () => {
  const fake = createTransactionPool();
  const currentLease = lease();
  let releaseCalls = 0;
  const rejected: SchedulerLeaseMutationResult = {
    status: "fence_rejected",
    currentFencingToken: "9007199254740994"
  };
  const repository: PostgresSchedulerLeaseStore = {
    async acquire() {
      return { status: "acquired", lease: currentLease };
    },
    async heartbeat() {
      return rejected;
    },
    async release() {
      releaseCalls += 1;
      return rejected;
    }
  };

  await assert.rejects(
    () =>
      runWithPostgresSchedulerLease(
        {
          pool: fake.pool,
          config: config(),
          job: POSTGRES_SCHEDULER_JOBS.research,
          ownerId: "worker-a",
          runId: "run-a",
          operationId: "research-run-a",
          leaseDurationMs: 60_000,
          heartbeatIntervalMs: 10_000,
          operation: ({ signal }) =>
            new Promise((_resolve, rejectOperation) => {
              signal.addEventListener(
                "abort",
                () => rejectOperation(signal.reason),
                { once: true }
              );
            })
        },
        {
          repository,
          now: () => new Date("2026-07-15T20:00:00.000Z"),
          wait: abortableWaitAfterFirstTick()
        }
      ),
    (error) =>
      error instanceof PostgresSchedulerExecutionError &&
      error.code === "SCHEDULER_FENCE_LOST"
  );
  assert.equal(releaseCalls, 1);
  assert.equal(fake.active.size, 0);
});

test("rejects execution when control-plane authority is not enabled", async () => {
  const fake = createTransactionPool();
  let operationCalled = false;

  await assert.rejects(
    () =>
      runWithPostgresSchedulerLease({
        pool: fake.pool,
        config: config(false),
        job: POSTGRES_SCHEDULER_JOBS.research,
        ownerId: "worker-a",
        runId: "run-a",
        operationId: "research-run-a",
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 10_000,
        operation: async () => {
          operationCalled = true;
        }
      }),
    (error) =>
      error instanceof PostgresSchedulerExecutionError &&
      error.code === "POSTGRES_CONTROL_PLANE_AUTHORITY_REQUIRED"
  );
  assert.equal(operationCalled, false);
  assert.equal(fake.events.length, 0);
});

test("does not run a competing job and rejects a stale release", async () => {
  const heldLease = lease();
  const heldPool = createTransactionPool();
  let operationCalled = false;
  const heldRepository: PostgresSchedulerLeaseStore = {
    async acquire() {
      return { status: "held", lease: heldLease };
    },
    async heartbeat() {
      throw new Error("heartbeat must not run");
    },
    async release() {
      throw new Error("release must not run");
    }
  };

  await assert.rejects(
    () =>
      runWithPostgresSchedulerLease(
        {
          pool: heldPool.pool,
          config: config(),
          job: POSTGRES_SCHEDULER_JOBS.research,
          ownerId: "worker-b",
          runId: "run-b",
          operationId: "research-run-b",
          leaseDurationMs: 60_000,
          heartbeatIntervalMs: 10_000,
          operation: async () => {
            operationCalled = true;
          }
        },
        { repository: heldRepository }
      ),
    (error) =>
      error instanceof PostgresSchedulerExecutionError &&
      error.code === "SCHEDULER_LEASE_HELD"
  );
  assert.equal(operationCalled, false);

  const releasePool = createTransactionPool();
  const releaseRepository: PostgresSchedulerLeaseStore = {
    async acquire() {
      return { status: "acquired", lease: heldLease };
    },
    async heartbeat() {
      return { status: "updated", lease: heldLease };
    },
    async release() {
      return {
        status: "fence_rejected",
        currentFencingToken: "9007199254740994"
      };
    }
  };
  await assert.rejects(
    () =>
      runWithPostgresSchedulerLease(
        {
          pool: releasePool.pool,
          config: config(),
          job: POSTGRES_SCHEDULER_JOBS.research,
          ownerId: "worker-a",
          runId: "run-a",
          operationId: "research-run-a",
          leaseDurationMs: 60_000,
          heartbeatIntervalMs: 10_000,
          operation: async () => "complete"
        },
        { repository: releaseRepository }
      ),
    (error) =>
      error instanceof PostgresSchedulerExecutionError &&
      error.code === "SCHEDULER_RELEASE_REJECTED"
  );
});
