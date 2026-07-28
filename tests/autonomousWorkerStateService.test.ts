import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  AUTONOMOUS_WORKER_STATE_MAX_PAYLOAD_BYTES,
  AutonomousWorkerPersistenceError,
  autonomousWorkerPersistenceClassification,
  decodeAutonomousWorkerStatePayload,
  persistAutonomousWorkerState,
  persistAutonomousWorkerStateWithClient,
  runAutonomousWorkerPersistence
} from "../src/services/autonomousWorkerStateService.js";

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("worker-state payload decoding is bounded and requires an object", () => {
  assert.deepEqual(decodeAutonomousWorkerStatePayload(encoded({ code: "OK", count: 2 })), {
    code: "OK",
    count: 2
  });
  assert.deepEqual(
    decodeAutonomousWorkerStatePayload(encoded({ text: "x".repeat(48_000) })),
    { text: "x".repeat(48_000) }
  );
  assert.throws(
    () => decodeAutonomousWorkerStatePayload(encoded(["not", "an", "object"])),
    /AUTONOMOUS_WORKER_STATE_PAYLOAD_INVALID/
  );
  assert.throws(
    () =>
      decodeAutonomousWorkerStatePayload(encoded({
        text: "x".repeat(AUTONOMOUS_WORKER_STATE_MAX_PAYLOAD_BYTES + 1)
      })),
    /AUTONOMOUS_WORKER_STATE_PAYLOAD_TOO_LARGE/
  );
});

test("worker lifecycle checkpoints are recoverable while preflight diagnostics are supplemental", () => {
  assert.equal(
    autonomousWorkerPersistenceClassification("workstream_completed"),
    "AUTHORITATIVE_RECOVERABLE"
  );
  assert.equal(
    autonomousWorkerPersistenceClassification("cycle_completed"),
    "AUTHORITATIVE_RECOVERABLE"
  );
  assert.equal(
    autonomousWorkerPersistenceClassification("preflight_failed"),
    "OBSERVABILITY_SUPPLEMENTAL"
  );
});

const codedFailure = (code: string) => Object.assign(new Error(code), { code });

test("retryable PostgreSQL persistence is bounded and reports one successful retry", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await runAutonomousWorkerPersistence(
    {
      operationName: "persist_autonomous_worker_state:workstream_completed",
      persistenceClassification: "AUTHORITATIVE_RECOVERABLE",
      cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
      workstreamName: "research:daily",
      lifecycleState: "workstream_completed",
      schedulerFenceStatus: "held",
      operation: async () => {
        attempts += 1;
        if (attempts === 1) throw codedFailure("08006");
        return { inserted: 1 };
      }
    },
    {
      maximumAttempts: 3,
      baseDelayMs: 20,
      maximumDelayMs: 25,
      random: () => 1,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      now: () => new Date("2026-07-28T15:00:00.000Z")
    }
  );

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [20]);
  assert.deepEqual(result.value, { inserted: 1 });
  assert.equal(result.evidence.retryAttempt, 1);
  assert.equal(result.evidence.maximumAttempts, 3);
  assert.equal(result.evidence.postgresErrorCode, "08006");
  assert.equal(result.evidence.retryable, true);
  assert.equal(result.evidence.finalDisposition, "PERSISTED_AFTER_RETRY");
  assert.equal(result.evidence.transactionStatus, "committed");
});

test("serialization and deadlock failures retry only idempotent persistence", async () => {
  for (const errorCode of ["40001", "40P01"]) {
    let attempts = 0;
    const result = await runAutonomousWorkerPersistence(
      {
        operationName: "persist_autonomous_worker_state:cycle_completed",
        persistenceClassification: "AUTHORITATIVE_RECOVERABLE",
        cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
        workstreamName: "autonomous_worker",
        lifecycleState: "cycle_completed",
        schedulerFenceStatus: "held",
        operation: async () => {
          attempts += 1;
          if (attempts === 1) throw codedFailure(errorCode);
          return "persisted";
        }
      },
      {
        wait: async () => undefined,
        random: () => 0,
        now: () => new Date("2026-07-28T15:00:00.000Z")
      }
    );

    assert.equal(attempts, 2, errorCode);
    assert.equal(result.value, "persisted", errorCode);
    assert.equal(result.evidence.postgresErrorCode, errorCode, errorCode);
    assert.equal(result.evidence.finalDisposition, "PERSISTED_AFTER_RETRY", errorCode);
  }
});

test("nonretryable schema failures and scheduler-fence loss are not retried", async () => {
  for (const testCase of [
    { errorCode: "42P01", disposition: "NONRETRYABLE_PERSISTENCE_FAILURE" },
    { errorCode: "22P02", disposition: "NONRETRYABLE_PERSISTENCE_FAILURE" },
    {
      errorCode: "08006 database_url=must-not-escape",
      disposition: "NONRETRYABLE_PERSISTENCE_FAILURE"
    },
    { errorCode: "SCHEDULER_FENCE_LOST", disposition: "SCHEDULER_FENCE_LOST" }
  ] as const) {
    let attempts = 0;
    const waits: number[] = [];
    await assert.rejects(
      runAutonomousWorkerPersistence(
        {
          operationName: "persist_autonomous_worker_state:workstream_completed",
          persistenceClassification: "AUTHORITATIVE_RECOVERABLE",
          cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
          workstreamName: "research:daily",
          lifecycleState: "workstream_completed",
          schedulerFenceStatus: "held",
          operation: async () => {
            attempts += 1;
            throw codedFailure(testCase.errorCode);
          }
        },
        {
          wait: async (milliseconds) => {
            waits.push(milliseconds);
          },
          now: () => new Date("2026-07-28T15:00:00.000Z")
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof AutonomousWorkerPersistenceError);
        assert.equal(error.evidence.retryable, false);
        assert.equal(error.evidence.finalDisposition, testCase.disposition);
        if (testCase.errorCode.includes(" ")) {
          assert.equal(error.evidence.errorCode, null);
          assert.equal(error.evidence.postgresErrorCode, null);
        }
        assert.equal(
          error.evidence.schedulerFenceStatus,
          testCase.errorCode === "SCHEDULER_FENCE_LOST" ? "lost" : "held"
        );
        return true;
      }
    );
    assert.equal(attempts, 1, testCase.errorCode);
    assert.deepEqual(waits, [], testCase.errorCode);
  }
});

test("retry exhaustion is bounded and retains the final PostgreSQL code", async () => {
  let attempts = 0;
  const waits: number[] = [];
  await assert.rejects(
    runAutonomousWorkerPersistence(
      {
        operationName: "persist_autonomous_worker_state:cycle_completed",
        persistenceClassification: "AUTHORITATIVE_RECOVERABLE",
        cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
        workstreamName: "autonomous_worker",
        lifecycleState: "cycle_completed",
        schedulerFenceStatus: "held",
        operation: async () => {
          attempts += 1;
          throw codedFailure("53300");
        }
      },
      {
        maximumAttempts: 3,
        baseDelayMs: 10,
        maximumDelayMs: 15,
        random: () => 1,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
        now: () => new Date("2026-07-28T15:00:00.000Z")
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof AutonomousWorkerPersistenceError);
      assert.equal(error.evidence.retryAttempt, 2);
      assert.equal(error.evidence.maximumAttempts, 3);
      assert.equal(error.evidence.postgresErrorCode, "53300");
      assert.equal(error.evidence.retryable, true);
      assert.equal(error.evidence.finalDisposition, "CYCLE_FAILED_WORKER_CONTINUED");
      return true;
    }
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 15]);
});

test("each retry rolls back and releases its transaction before backoff", async () => {
  const events: string[] = [];
  let activeTransactions = 0;
  let connectCount = 0;
  let releaseCount = 0;
  const clients = [1, 2].map((attempt) => ({
    query: async (sql: string) => {
      if (sql === "BEGIN") {
        activeTransactions += 1;
        events.push(`begin:${attempt}`);
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (sql === "ROLLBACK") {
        activeTransactions -= 1;
        events.push(`rollback:${attempt}`);
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (sql === "COMMIT") {
        activeTransactions -= 1;
        events.push(`commit:${attempt}`);
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (sql.includes("FROM scheduler_leases")) {
        return { rows: [{ held: 1 }], rowCount: 1 } as unknown as QueryResult;
      }
      if (sql.includes("WHERE event_id = $1")) {
        if (attempt === 1) throw codedFailure("08006");
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (
        sql.includes("FROM workstream_events started") ||
        sql.includes("SELECT event_type")
      ) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    },
    release: () => {
      releaseCount += 1;
      events.push(`release:${attempt}`);
    }
  })) as unknown as PoolClient[];
  const pool = {
    connect: async () => clients[connectCount++]!
  } as unknown as Pool;
  const config = {
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 2_000,
    idleInTransactionTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000
  } as DatabaseConfig;
  const waits: number[] = [];

  const result = await persistAutonomousWorkerState(
    pool,
    config,
    {
      cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
      eventType: "cycle_started",
      payload: { workerPid: 12 },
      occurredAt: "2026-07-28T15:00:00.000Z"
    },
    {
      jobName: "autonomous-worker-state",
      workstream: "autonomous_worker_state",
      ownerId: "worker-state-owner",
      runId: "worker-state-run",
      fencingToken: "42"
    },
    {
      maximumAttempts: 2,
      baseDelayMs: 10,
      maximumDelayMs: 10,
      random: () => 1,
      wait: async (milliseconds) => {
        assert.equal(activeTransactions, 0);
        assert.deepEqual(events.slice(-2), ["rollback:1", "release:1"]);
        waits.push(milliseconds);
      },
      now: () => new Date("2026-07-28T15:00:00.000Z")
    }
  );

  assert.equal(result.status, "persisted");
  assert.equal(result.persistence.finalDisposition, "PERSISTED_AFTER_RETRY");
  assert.equal(activeTransactions, 0);
  assert.equal(connectCount, 2);
  assert.equal(releaseCount, 2);
  assert.deepEqual(waits, [10]);
  assert.deepEqual(events.slice(-2), ["commit:2", "release:2"]);
});

test("an exact event replay is idempotent and creates no duplicate append", async () => {
  let insertAttempts = 0;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("WHERE event_id = $1")) {
        return {
          rows: [{ event_id: "existing", payload_fingerprint: "matching" }],
          rowCount: 1
        } as unknown as QueryResult;
      }
      insertAttempts += 1;
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as PoolClient;

  const result = await persistAutonomousWorkerStateWithClient(client, {
    cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
    eventType: "cycle_started",
    payload: { workerPid: 12 },
    occurredAt: "2026-07-20T22:00:00.000Z"
  });

  assert.equal(result.status, "persisted");
  assert.equal(result.replayed, true);
  assert.equal(insertAttempts, 0);
});

test("exact workstream and terminal replays create no duplicate lifecycle records", async () => {
  let insertAttempts = 0;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("WHERE event_id = $1")) {
        return {
          rows: [{ event_id: "existing" }],
          rowCount: 1
        } as unknown as QueryResult;
      }
      insertAttempts += 1;
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as PoolClient;

  for (const eventType of ["workstream_completed", "cycle_completed"] as const) {
    const result = await persistAutonomousWorkerStateWithClient(client, {
      cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
      eventType,
      payload:
        eventType === "workstream_completed"
          ? { workstream: "research:daily", code: "WORKSTREAM_COMPLETED" }
          : { workstreamCount: 20, failed: 0 },
      occurredAt: "2026-07-20T22:02:00.000Z"
    });
    assert.equal(result.status, "persisted");
    assert.equal(result.replayed, true);
  }
  assert.equal(insertAttempts, 0);
});

test("lost scheduler ownership prevents a stale worker-state commit", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("FROM scheduler_leases")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      throw new Error("no lifecycle query expected after fence loss");
    }
  } as unknown as PoolClient;

  await assert.rejects(
    persistAutonomousWorkerStateWithClient(
      client,
      {
        cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
        eventType: "cycle_started",
        payload: { workerPid: 12 },
        occurredAt: "2026-07-20T22:00:00.000Z"
      },
      {
        jobName: "autonomous-worker-state",
        workstream: "autonomous_worker_state",
        ownerId: "worker-state-owner",
        runId: "worker-state-run",
        fencingToken: "42"
      }
    ),
    /SCHEDULER_FENCE_LOST/
  );
  assert.equal(calls.length, 1);
});

test("cycle_started records a prior nonterminal cycle as orphaned before restarting", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("FROM workstream_events started")) {
        return {
          rows: [{ entity_id: "81ef842a-c66e-4f91-944d-65b78102ea50" }],
          rowCount: 1
        } as QueryResult;
      }
      if (sql.includes("SELECT event_type")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
  } as unknown as PoolClient;

  const result = await persistAutonomousWorkerStateWithClient(client, {
    cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
    eventType: "cycle_started",
    payload: { workerPid: 12 },
    occurredAt: "2026-07-20T22:00:00.000Z"
  });

  assert.equal(result.status, "persisted");
  assert.equal(calls.some((call) => /'cycle_failed'/.test(call.sql)), true);
  assert.equal(calls.some((call) => /AUTONOMOUS_CYCLE_ORPHANED_ON_RESTART/.test(String(call.values))), true);
  assert.equal(calls.some((call) => /INSERT INTO workstream_event_failures/.test(call.sql)), true);
});

test("failed worker events persist an event and a nonretryable failure", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("SELECT event_type")) {
        return {
          rows: [{ event_type: "workstream_started", workstream: "paper:review" }],
          rowCount: 1
        } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }
  } as unknown as PoolClient;

  const result = await persistAutonomousWorkerStateWithClient(client, {
    cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
    eventType: "workstream_failed",
    payload: {
      workstream: "paper:review",
      code: "POSTGRES_UNAVAILABLE",
      message: "connection failed"
    },
    occurredAt: "2026-07-20T22:01:00.000Z"
  });

  assert.equal(result.status, "persisted");
  assert.equal(calls.length, 4);
  assert.match(calls[0]!.sql, /WHERE event_id = \$1/);
  assert.match(calls[1]!.sql, /SELECT event_type/);
  assert.match(calls[2]!.sql, /INSERT INTO workstream_events/);
  assert.match(calls[3]!.sql, /INSERT INTO workstream_event_failures/);
  assert.equal(calls[3]!.values?.includes(false), true);
});

test("a completion cannot cross the persisted workstream identity", async () => {
  let insertAttempts = 0;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("WHERE event_id = $1")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (sql.includes("SELECT event_type")) {
        return {
          rows: [{ event_type: "workstream_started", workstream: "research:daily" }],
          rowCount: 1
        } as unknown as QueryResult;
      }
      insertAttempts += 1;
      throw new Error("no insert expected");
    }
  } as unknown as PoolClient;

  await assert.rejects(
    persistAutonomousWorkerStateWithClient(client, {
      cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
      eventType: "workstream_completed",
      payload: { workstream: "paper:review" },
      occurredAt: "2026-07-20T22:02:00.000Z"
    }),
    /AUTONOMOUS_WORKER_WORKSTREAM_IDENTITY_MISMATCH/
  );
  assert.equal(insertAttempts, 0);
});

test("cycle terminal events require a started cycle", async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("WHERE event_id = $1")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (sql.includes("SELECT event_type")) return { rows: [], rowCount: 0 } as unknown as QueryResult;
      throw new Error("no insert expected");
    }
  } as unknown as PoolClient;
  await assert.rejects(
    persistAutonomousWorkerStateWithClient(client, {
      cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
      eventType: "cycle_completed",
      payload: { workstreamCount: 16 },
      occurredAt: "2026-07-20T22:02:00.000Z"
    }),
    /AUTONOMOUS_WORKER_STATE_TRANSITION_INVALID/
  );
});

test("a completed workstream cannot follow a failed workstream", async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("WHERE event_id = $1")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (sql.includes("SELECT event_type")) {
        return { rows: [{ event_type: "workstream_failed" }], rowCount: 1 } as unknown as QueryResult;
      }
      throw new Error("no insert expected");
    }
  } as unknown as PoolClient;
  await assert.rejects(
    persistAutonomousWorkerStateWithClient(client, {
      cycleId: "9e158ccc-16ce-41c8-a098-9cc386312f2e",
      eventType: "workstream_completed",
      payload: { workstream: "paper:review" },
      occurredAt: "2026-07-20T22:02:00.000Z"
    }),
    /AUTONOMOUS_WORKER_STATE_TRANSITION_INVALID/
  );
});
