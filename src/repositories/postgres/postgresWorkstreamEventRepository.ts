import type { PoolClient } from "pg";

import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import type { VersionedWriteResult } from "../contracts/common.js";
import type {
  WorkstreamEvent,
  WorkstreamEventAppendResult,
  WorkstreamEventClaimResult,
  WorkstreamEventFailure,
  WorkstreamEventRecord,
  WorkstreamEventRepository
} from "../contracts/workstreamEventRepository.js";
import {
  asIsoString,
  currentFenceToken,
  fencePredicate,
  fenceValues,
  parseJsonValue,
  requireCurrentFence,
  type FencedPostgresRepositoryContext,
  type PostgresRepositoryContext
} from "./postgresRepositorySupport.js";

type EventRow = {
  event_id: string;
  workstream: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  occurred_at: Date | string;
  produced_at: Date | string;
  schema_version: number;
  run_id: string | null;
  request_id: string | null;
  correlation_id: string | null;
  source_sequence: number | string | null;
  payload: unknown;
  payload_fingerprint: string;
  processing_status: WorkstreamEventRecord["status"];
  processing_started_at: Date | string | null;
  processed_at: Date | string | null;
  attempts: number;
  version: number | string;
  created_at: Date | string;
};

const eventColumns = `event_id, workstream, event_type, entity_type, entity_id,
  occurred_at, produced_at, schema_version, run_id, request_id, correlation_id,
  source_sequence, payload, payload_fingerprint, processing_status,
  processing_started_at, processed_at, attempts, version, created_at`;

const mapEvent = (row: EventRow): WorkstreamEventRecord => ({
  eventId: row.event_id,
  workstream: row.workstream,
  eventType: row.event_type,
  entityType: row.entity_type,
  entityId: row.entity_id,
  occurredAt: asIsoString(row.occurred_at)!,
  producedAt: asIsoString(row.produced_at)!,
  schemaVersion: Number(row.schema_version),
  runId: row.run_id,
  requestId: row.request_id,
  correlationId: row.correlation_id,
  entityVersion: row.source_sequence === null ? null : Number(row.source_sequence),
  payload: parseJsonValue(row.payload),
  status: row.processing_status,
  receivedAt: asIsoString(row.created_at)!,
  processingStartedAt: asIsoString(row.processing_started_at),
  processedAt: asIsoString(row.processed_at),
  attempts: Number(row.attempts),
  version: Number(row.version)
});

type FailureRow = {
  id: string;
  event_id: string;
  attempt_number: number;
  error_code: string | null;
  error_classification: string;
  redacted_error_message: string;
  retryable: boolean;
  failed_at: Date | string;
  next_retry_at: Date | string | null;
  dead_lettered_at: Date | string | null;
  details: unknown;
};

const mapFailure = (row: FailureRow): WorkstreamEventFailure => ({
  failureId: row.id,
  eventId: row.event_id,
  attempt: Number(row.attempt_number),
  errorCode: row.error_code || "WORKSTREAM_EVENT_FAILED",
  errorClassification: row.error_classification,
  redactedErrorMessage: row.redacted_error_message,
  retryable: row.retryable,
  failedAt: asIsoString(row.failed_at)!,
  nextRetryAt: asIsoString(row.next_retry_at),
  deadLetteredAt: asIsoString(row.dead_lettered_at),
  details: row.details === null ? null : parseJsonValue(row.details)
});

const eventMutationMiss = async (
  input: { eventId: string; expectedVersion: number },
  context: FencedPostgresRepositoryContext
): Promise<VersionedWriteResult> => {
  const token = await currentFenceToken(context.transaction, context.schedulerFence);
  if (token !== context.schedulerFence.fencingToken) {
    return { status: "fence_rejected", currentFencingToken: token };
  }
  const current = await context.transaction.query<{ version: number | string }>(
    "SELECT version FROM workstream_events WHERE event_id = $1",
    [input.eventId]
  );
  if (!current.rows[0]) return { status: "not_found" };
  const version = Number(current.rows[0].version);
  return version === input.expectedVersion
    ? { status: "not_found" }
    : { status: "version_conflict", currentVersion: version };
};

export class PostgresWorkstreamEventRepository
implements WorkstreamEventRepository<PoolClient> {
  async find(
    input: { readonly eventId: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<EventRow>(
      `SELECT ${eventColumns} FROM workstream_events WHERE event_id = $1`,
      [input.eventId]
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async append(
    event: WorkstreamEvent,
    context: PostgresRepositoryContext
  ): Promise<WorkstreamEventAppendResult> {
    const fingerprint = canonicalJsonHash(event.payload);
    const result = await context.transaction.query<EventRow>(
      `INSERT INTO workstream_events(
         event_id, workstream, event_type, entity_type, entity_id,
         occurred_at, produced_at, schema_version, run_id, request_id,
         correlation_id, source_sequence, payload, payload_fingerprint,
         processing_status, attempts
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13::jsonb, $14, 'received', 0)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING ${eventColumns}`,
      [
        event.eventId,
        event.workstream,
        event.eventType,
        event.entityType,
        event.entityId,
        event.occurredAt,
        event.producedAt,
        event.schemaVersion,
        event.runId ?? null,
        event.requestId ?? context.requestId ?? null,
        event.correlationId ?? context.correlationId ?? null,
        event.entityVersion ?? null,
        JSON.stringify(event.payload),
        fingerprint
      ]
    );
    if (result.rows[0]) return { status: "inserted", record: mapEvent(result.rows[0]) };
    const existing = await this.find({ eventId: event.eventId }, context);
    if (!existing) throw new Error("POSTGRES_WORKSTREAM_EVENT_CONFLICT_ROW_MISSING");
    const requestId = event.requestId ?? context.requestId ?? null;
    const correlationId = event.correlationId ?? context.correlationId ?? null;
    if (
      existing.workstream !== event.workstream ||
      existing.eventType !== event.eventType ||
      existing.entityType !== event.entityType ||
      existing.entityId !== event.entityId ||
      existing.occurredAt !== asIsoString(event.occurredAt) ||
      existing.producedAt !== asIsoString(event.producedAt) ||
      existing.schemaVersion !== event.schemaVersion ||
      existing.runId !== (event.runId ?? null) ||
      existing.requestId !== requestId ||
      existing.correlationId !== correlationId ||
      existing.entityVersion !== (event.entityVersion ?? null) ||
      canonicalJsonHash(existing.payload) !== fingerprint
    ) {
      throw new Error("POSTGRES_WORKSTREAM_EVENT_ID_CONFLICT");
    }
    return { status: "duplicate", record: existing };
  }

  async claimForProcessing(
    input: Parameters<WorkstreamEventRepository<PoolClient>["claimForProcessing"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<WorkstreamEventClaimResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    const selected = await context.transaction.query<EventRow>(
      `SELECT ${eventColumns}
       FROM workstream_events WHERE event_id = $1 FOR UPDATE`,
      [input.eventId]
    );
    const row = selected.rows[0];
    if (!row) return { status: "not_found" };
    const record = mapEvent(row);
    if (record.status === "completed") return { status: "already_completed", record };
    if (
      record.status === "processing" &&
      record.processingStartedAt !== null &&
      record.processingStartedAt > input.processingStaleBefore
    ) {
      return { status: "already_processing", record };
    }

    const currentProjection = await context.transaction.query<{ version: number | string | null }>(
      `SELECT MAX(source_sequence) AS version
       FROM workstream_events
       WHERE entity_type = $1 AND entity_id = $2 AND processing_status = 'completed'`,
      [record.entityType, record.entityId]
    );
    const currentVersion = currentProjection.rows[0]?.version === null ||
      currentProjection.rows[0]?.version === undefined
      ? null
      : Number(currentProjection.rows[0].version);
    if (currentVersion !== input.expectedEntityVersion) {
      return { status: "out_of_order", currentEntityVersion: currentVersion };
    }

    const updated = await context.transaction.query<EventRow>(
      `UPDATE workstream_events
       SET processing_status = 'processing', processing_started_at = $2,
           attempts = attempts + 1, updated_at = $2, version = version + 1
       WHERE event_id = $1 AND ${fencePredicate(3)}
       RETURNING ${eventColumns}`,
      [input.eventId, input.processingStartedAt, ...fenceValues(context.schedulerFence)]
    );
    if (!updated.rows[0]) {
      const token = await currentFenceToken(context.transaction, context.schedulerFence);
      return { status: "fence_rejected", currentFencingToken: token };
    }
    return { status: "claimed", record: mapEvent(updated.rows[0]) };
  }

  async markCompleted(
    input: Parameters<WorkstreamEventRepository<PoolClient>["markCompleted"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE workstream_events
       SET processing_status = 'completed', processed_at = $3, updated_at = $3,
           projection_version = COALESCE(source_sequence, projection_version, 1),
           version = version + 1
       WHERE event_id = $1 AND version = $2 AND processing_status = 'processing'
         AND ${fencePredicate(4)}
       RETURNING version`,
      [input.eventId, input.expectedVersion, input.processedAt, ...fenceValues(context.schedulerFence)]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : eventMutationMiss(input, context);
  }

  async markFailed(
    input: Parameters<WorkstreamEventRepository<PoolClient>["markFailed"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    const status = input.failure.deadLetteredAt ? "dead_letter" : "failed";
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE workstream_events
       SET processing_status = $3, updated_at = $4, version = version + 1
       WHERE event_id = $1 AND version = $2 AND ${fencePredicate(5)}
       RETURNING version`,
      [
        input.eventId,
        input.expectedVersion,
        status,
        input.failure.failedAt,
        ...fenceValues(context.schedulerFence)
      ]
    );
    if (!result.rows[0]) return eventMutationMiss(input, context);
    await context.transaction.query(
      `INSERT INTO workstream_event_failures(
         id, event_id, attempt_number, error_classification, error_code,
         redacted_error_message, retryable, failed_at, next_retry_at,
         dead_lettered_at, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (event_id, attempt_number) DO NOTHING`,
      [
        input.failure.failureId,
        input.eventId,
        input.failure.attempt,
        input.failure.errorClassification,
        input.failure.errorCode,
        input.failure.redactedErrorMessage,
        input.failure.retryable,
        input.failure.failedAt,
        input.failure.nextRetryAt,
        input.failure.deadLetteredAt ?? null,
        input.failure.details === null ? null : JSON.stringify(input.failure.details)
      ]
    );
    return { status: "updated", version: Number(result.rows[0].version) };
  }

  async listPending(
    input: Parameters<WorkstreamEventRepository<PoolClient>["listPending"]>[0],
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<EventRow>(
      `SELECT ${eventColumns}
       FROM workstream_events
       WHERE workstream = $1
         AND (
           processing_status IN ('received', 'deferred', 'failed')
           OR (
             processing_status = 'processing'
             AND (processing_started_at IS NULL OR processing_started_at <= $3)
           )
         )
       ORDER BY produced_at, event_id
       LIMIT $2`,
      [input.workstream, input.limit, input.processingStaleBefore]
    );
    return result.rows.map(mapEvent);
  }

  async listFailures(
    input: { readonly eventId: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<FailureRow>(
      `SELECT id, event_id, attempt_number, error_code, error_classification,
              redacted_error_message, retryable, failed_at, next_retry_at,
              dead_lettered_at, details
       FROM workstream_event_failures
       WHERE event_id = $1 ORDER BY attempt_number`,
      [input.eventId]
    );
    return result.rows.map(mapFailure);
  }
}
