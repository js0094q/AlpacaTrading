import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";

import {
  decodeAutonomousWorkerStatePayload,
  persistAutonomousWorkerStateWithClient
} from "../src/services/autonomousWorkerStateService.js";

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("worker-state payload decoding is bounded and requires an object", () => {
  assert.deepEqual(decodeAutonomousWorkerStatePayload(encoded({ code: "OK", count: 2 })), {
    code: "OK",
    count: 2
  });
  assert.throws(
    () => decodeAutonomousWorkerStatePayload(encoded(["not", "an", "object"])),
    /AUTONOMOUS_WORKER_STATE_PAYLOAD_INVALID/
  );
  assert.throws(
    () => decodeAutonomousWorkerStatePayload(encoded({ text: "x".repeat(33_000) })),
    /AUTONOMOUS_WORKER_STATE_PAYLOAD_TOO_LARGE/
  );
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
        return { rows: [{ event_type: "workstream_started" }], rowCount: 1 } as unknown as QueryResult;
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
  assert.equal(calls.length, 3);
  assert.match(calls[0]!.sql, /SELECT event_type/);
  assert.match(calls[1]!.sql, /INSERT INTO workstream_events/);
  assert.match(calls[2]!.sql, /INSERT INTO workstream_event_failures/);
  assert.equal(calls[2]!.values?.includes(false), true);
});

test("cycle terminal events require a started cycle", async () => {
  const client = {
    query: async (sql: string) => {
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
