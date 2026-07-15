import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";

import { PostgresReconciliationCheckpointRepository } from "../src/repositories/postgres/postgresReconciliationCheckpointRepository.js";
import { PostgresWorkstreamEventRepository } from "../src/repositories/postgres/postgresWorkstreamEventRepository.js";

const fence = {
  jobName: "research",
  workstream: "research",
  ownerId: "worker-1",
  runId: "scheduler-run-1",
  fencingToken: "17"
};

const currentFenceRow = {
  fencing_token: fence.fencingToken,
  workstream: fence.workstream,
  owner_id: fence.ownerId,
  run_id: fence.runId,
  current: true
};

const contextFor = (client: PoolClient) => ({
  transaction: client,
  operationId: "operation-1",
  actorId: fence.ownerId,
  schedulerFence: fence
});

const processingEvent = {
  event_id: "event-1",
  workstream: "research",
  event_type: "candidate.scored",
  entity_type: "candidate",
  entity_id: "candidate-1",
  occurred_at: "2026-07-15T12:00:00.000Z",
  produced_at: "2026-07-15T12:00:01.000Z",
  schema_version: 1,
  run_id: "run-1",
  request_id: null,
  correlation_id: null,
  source_sequence: 1,
  payload: { score: 0.8 },
  payload_fingerprint: "fingerprint",
  processing_status: "processing",
  processing_started_at: "2026-07-15T12:01:00.000Z",
  processed_at: null,
  attempts: 1,
  version: 2,
  created_at: "2026-07-15T12:00:01.000Z"
};

const appendEvent = {
  eventId: "event-1",
  workstream: "research",
  eventType: "candidate.scored",
  entityType: "candidate",
  entityId: "candidate-1",
  occurredAt: "2026-07-15T12:00:00.000Z",
  producedAt: "2026-07-15T12:00:01.000Z",
  schemaVersion: 1,
  runId: "run-1",
  requestId: null,
  correlationId: null,
  entityVersion: 1,
  payload: { score: 0.8 }
} as const;

test("event ID replay requires the complete immutable envelope", async () => {
  const client = {
    query: async (text: string) => {
      if (text.startsWith("INSERT INTO workstream_events")) return { rows: [] } as unknown as QueryResult;
      if (text.startsWith("SELECT") && text.includes("FROM workstream_events")) {
        return { rows: [processingEvent] } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;
  const repository = new PostgresWorkstreamEventRepository();
  const context = {
    transaction: client,
    operationId: "event-replay",
    actorId: "worker-1",
    requestId: null,
    correlationId: null
  };
  assert.equal((await repository.append(appendEvent, context)).status, "duplicate");
  for (const changed of [
    { ...appendEvent, eventType: "candidate.reviewed" },
    { ...appendEvent, occurredAt: "2026-07-15T12:00:02.000Z" },
    { ...appendEvent, producedAt: "2026-07-15T12:00:03.000Z" },
    { ...appendEvent, schemaVersion: 2 },
    { ...appendEvent, runId: "run-2" },
    { ...appendEvent, requestId: "request-2" },
    { ...appendEvent, correlationId: "correlation-2" },
    { ...appendEvent, entityVersion: 2 }
  ]) {
    await assert.rejects(
      repository.append(changed, context),
      /POSTGRES_WORKSTREAM_EVENT_ID_CONFLICT/
    );
  }
});

test("a stale processing event is reclaimable under the current fence", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFenceRow] } as unknown as QueryResult;
      }
      if (text.includes("FROM workstream_events WHERE event_id") && text.includes("FOR UPDATE")) {
        return { rows: [processingEvent] } as unknown as QueryResult;
      }
      if (text.includes("SELECT MAX(source_sequence)")) {
        return { rows: [{ version: null }] } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE workstream_events")) {
        return {
          rows: [{
            ...processingEvent,
            processing_started_at: "2026-07-15T12:20:00.000Z",
            attempts: 2,
            version: 3
          }]
        } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;
  const repository = new PostgresWorkstreamEventRepository();
  const result = await repository.claimForProcessing(
    {
      eventId: "event-1",
      expectedEntityVersion: null,
      processingStartedAt: "2026-07-15T12:20:00.000Z",
      processingStaleBefore: "2026-07-15T12:05:00.000Z"
    },
    contextFor(client)
  );
  assert.equal(result.status, "claimed");
  assert.equal(result.status === "claimed" ? result.record.attempts : 0, 2);
  assert.ok(queries.some((query) => query.startsWith("UPDATE workstream_events")));
});

test("a failed version check cannot create an orphan workstream failure", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFenceRow] } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE workstream_events")) return { rows: [] } as unknown as QueryResult;
      if (text.includes("SELECT fencing_token") && text.includes("FROM scheduler_leases")) {
        return { rows: [{ fencing_token: fence.fencingToken }] } as unknown as QueryResult;
      }
      if (text.includes("SELECT version FROM workstream_events")) {
        return { rows: [{ version: 9 }] } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;
  const repository = new PostgresWorkstreamEventRepository();
  const result = await repository.markFailed(
    {
      eventId: "event-1",
      expectedVersion: 2,
      failure: {
        failureId: "failure-1",
        eventId: "event-1",
        attempt: 1,
        errorCode: "TRANSIENT",
        errorClassification: "transient",
        redactedErrorMessage: "redacted",
        retryable: true,
        failedAt: "2026-07-15T12:20:00.000Z",
        nextRetryAt: "2026-07-15T12:21:00.000Z",
        details: null
      }
    },
    contextFor(client)
  );
  assert.deepEqual(result, { status: "version_conflict", currentVersion: 9 });
  assert.equal(
    queries.some((query) => query.includes("INSERT INTO workstream_event_failures")),
    false
  );
});

test("nullable workstream failure details remain SQL null", async () => {
  const failureInsertValues: unknown[][] = [];
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFenceRow] } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE workstream_events")) {
        return { rows: [{ version: 3 }] } as unknown as QueryResult;
      }
      if (text.startsWith("INSERT INTO workstream_event_failures")) {
        failureInsertValues.push([...(values || [])]);
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;
  const repository = new PostgresWorkstreamEventRepository();
  const result = await repository.markFailed(
    {
      eventId: "event-1",
      expectedVersion: 2,
      failure: {
        failureId: "failure-null-details",
        eventId: "event-1",
        attempt: 1,
        errorCode: "TRANSIENT",
        errorClassification: "transient",
        redactedErrorMessage: "redacted",
        retryable: true,
        failedAt: "2026-07-15T12:20:00.000Z",
        nextRetryAt: null,
        details: null
      }
    },
    contextFor(client)
  );
  assert.deepEqual(result, { status: "updated", version: 3 });
  assert.equal(failureInsertValues[0]?.[10], null);
});

test("checkpoint completion counts persisted discrepancies and terminal checkpoints reject appends", async () => {
  const updateValues: unknown[][] = [];
  const queries: string[] = [];
  let checkpointStatus = "running";
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      queries.push(text);
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFenceRow] } as unknown as QueryResult;
      }
      if (text.includes("COUNT(*) AS count FROM reconciliation_discrepancies")) {
        return { rows: [{ count: "1" }] } as unknown as QueryResult;
      }
      if (text.startsWith("UPDATE reconciliation_checkpoints")) {
        updateValues.push([...(values || [])]);
        checkpointStatus = String(values?.[2]);
        return { rows: [{ version: 2 }] } as unknown as QueryResult;
      }
      if (text.includes("SELECT status FROM reconciliation_checkpoints")) {
        return { rows: [{ status: checkpointStatus }] } as unknown as QueryResult;
      }
      throw new Error(`UNEXPECTED_QUERY:${text}`);
    }
  } as unknown as PoolClient;
  const repository = new PostgresReconciliationCheckpointRepository();
  const result = await repository.complete(
    {
      checkpointId: "checkpoint-1",
      expectedVersion: 1,
      completedAt: "2026-07-15T12:30:00.000Z",
      discrepancyCount: 0
    },
    contextFor(client)
  );
  assert.deepEqual(result, { status: "updated", version: 2 });
  assert.equal(updateValues[0]?.[2], "blocked");
  assert.equal(updateValues[0]?.[3], 1);
  await assert.rejects(
    repository.appendDiscrepancy(
      {
        discrepancyId: "discrepancy-2",
        checkpointId: "checkpoint-1",
        domain: "candidates",
        entityId: "candidate-1",
        discrepancyType: "MISMATCH",
        expected: null,
        actual: null,
        observedAt: "2026-07-15T12:31:00.000Z"
      },
      contextFor(client)
    ),
    /POSTGRES_RECONCILIATION_CHECKPOINT_TERMINAL/
  );
  assert.equal(
    queries.some((query) => query.includes("INSERT INTO reconciliation_discrepancies")),
    false
  );
});
