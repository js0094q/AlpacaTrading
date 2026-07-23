import type { Pool, PoolClient } from "pg";

import type { JsonValue } from "../repositories/contracts/common.js";
import {
  canonicalJson,
  parseJsonValue,
  stableRecordId
} from "../repositories/postgres/postgresRepositorySupport.js";
import type { DatabaseConfig } from "../lib/database/config.js";
import { withPostgresTransaction } from "../lib/database/postgresTransaction.js";
import { redactSensitiveData } from "../lib/securityRedaction.js";

const MAX_PAYLOAD_BYTES = 32 * 1024;
const ACTIVE_CYCLE_WINDOW_HOURS = 6;
const CYCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AUTONOMOUS_WORKER_EVENT_TYPES = [
  "preflight_failed",
  "cycle_started",
  "workstream_started",
  "workstream_completed",
  "workstream_failed",
  "cycle_completed",
  "cycle_failed",
  "worker_stopped"
] as const;

export type AutonomousWorkerEventType =
  (typeof AUTONOMOUS_WORKER_EVENT_TYPES)[number];

export type AutonomousWorkerStateInput = {
  readonly cycleId: string;
  readonly eventType: AutonomousWorkerEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
};

const fail = (code: string): never => {
  throw new Error(code);
};

const objectPayload = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("AUTONOMOUS_WORKER_STATE_PAYLOAD_INVALID");
  }
  return value as Record<string, unknown>;
};

export const decodeAutonomousWorkerStatePayload = (encoded: string) => {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    return fail("AUTONOMOUS_WORKER_STATE_PAYLOAD_INVALID");
  }
  if (decoded.byteLength > MAX_PAYLOAD_BYTES) {
    return fail("AUTONOMOUS_WORKER_STATE_PAYLOAD_TOO_LARGE");
  }
  try {
    return objectPayload(JSON.parse(decoded.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AUTONOMOUS_")) throw error;
    return fail("AUTONOMOUS_WORKER_STATE_PAYLOAD_INVALID");
  }
};

const asJsonPayload = (payload: Readonly<Record<string, unknown>>): JsonValue =>
  parseJsonValue(redactSensitiveData(payload));

const boundedText = (value: unknown, fallback: string, max = 500) => {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, max);
};

const allowedTransition = (
  previous: AutonomousWorkerEventType | null,
  next: AutonomousWorkerEventType
) => {
  if (previous === null) return next === "cycle_started" || next === "preflight_failed";
  if (previous === "preflight_failed" || previous === "worker_stopped") return false;
  if (next === "worker_stopped") return true;
  if (previous === "cycle_started") {
    return next === "workstream_started" || next === "cycle_failed";
  }
  if (previous === "workstream_started") {
    return ["workstream_completed", "workstream_failed", "cycle_failed"].includes(next);
  }
  if (previous === "workstream_completed") {
    return ["workstream_started", "cycle_completed", "cycle_failed"].includes(next);
  }
  if (previous === "workstream_failed") return next === "cycle_failed";
  return false;
};

export const persistAutonomousWorkerStateWithClient = async (
  client: PoolClient,
  input: AutonomousWorkerStateInput
) => {
  if (!CYCLE_ID.test(input.cycleId)) fail("AUTONOMOUS_WORKER_CYCLE_ID_INVALID");
  if (!(AUTONOMOUS_WORKER_EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    fail("AUTONOMOUS_WORKER_EVENT_TYPE_INVALID");
  }
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) fail("AUTONOMOUS_WORKER_EVENT_TIME_INVALID");

  if (input.eventType === "cycle_started") {
    const active = await client.query<{ entity_id: string }>(
      `SELECT started.entity_id
       FROM workstream_events started
       WHERE started.workstream = 'autonomous_worker'
         AND started.event_type = 'cycle_started'
         AND started.entity_id <> $1
         AND started.occurred_at >= now() - interval '${ACTIVE_CYCLE_WINDOW_HOURS} hours'
         AND NOT EXISTS (
           SELECT 1
           FROM workstream_events terminal
           WHERE terminal.workstream = 'autonomous_worker'
             AND terminal.entity_id = started.entity_id
             AND terminal.event_type IN ('cycle_completed', 'cycle_failed', 'worker_stopped')
         )
       ORDER BY started.occurred_at DESC
       LIMIT 1
       FOR UPDATE`,
      [input.cycleId]
    );
    const orphanedCycleId = active.rows[0]?.entity_id;
    if (orphanedCycleId) {
      const orphanPayload = asJsonPayload({
        code: "AUTONOMOUS_CYCLE_ORPHANED_ON_RESTART",
        message: "A nonterminal autonomous cycle was closed before its replacement started.",
        replacementCycleId: input.cycleId
      });
      const orphanKey = canonicalJson({
        cycleId: orphanedCycleId,
        eventType: "cycle_failed",
        occurredAt: occurredAt.toISOString(),
        payload: orphanPayload
      });
      const orphanEventId = `autonomous_${stableRecordId("autonomous_worker_event", orphanKey)}`;
      const orphanFingerprint = stableRecordId(
        "autonomous_worker_payload",
        canonicalJson(orphanPayload)
      );
      const orphanEvent = await client.query(
        `INSERT INTO workstream_events(
           event_id, workstream, event_type, entity_type, entity_id,
           occurred_at, produced_at, schema_version, run_id, correlation_id,
           payload, payload_fingerprint, processing_status, projection_version,
           processed_at, attempts
         ) VALUES (
           $1, 'autonomous_worker', 'cycle_failed', 'autonomous_cycle', $2,
           $3, $3, 1, $2, $2, $4::jsonb, $5, 'completed', 1, $3, 1
         ) ON CONFLICT (event_id) DO NOTHING`,
        [
          orphanEventId,
          orphanedCycleId,
          occurredAt.toISOString(),
          canonicalJson(orphanPayload),
          orphanFingerprint
        ]
      );
      if (orphanEvent.rowCount === 1) {
        const failureId = `autonomous_failure_${stableRecordId(
          "autonomous_worker_failure",
          orphanEventId
        )}`;
        await client.query(
          `INSERT INTO workstream_event_failures(
             id, event_id, attempt_number, error_classification, error_code,
             redacted_error_message, retryable, failed_at, details
           ) VALUES (
             $1, $2, 1, 'autonomous_worker_restart',
             'AUTONOMOUS_CYCLE_ORPHANED_ON_RESTART',
             'A nonterminal autonomous cycle was closed before restart.',
             false, $3, $4::jsonb
           ) ON CONFLICT (event_id, attempt_number) DO NOTHING`,
          [
            failureId,
            orphanEventId,
            occurredAt.toISOString(),
            canonicalJson(orphanPayload)
          ]
        );
      }
    }
  }

  const previousResult = await client.query<{ event_type: AutonomousWorkerEventType }>(
    `SELECT event_type
     FROM workstream_events
     WHERE workstream = 'autonomous_worker' AND entity_id = $1
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT 1
     FOR UPDATE`,
    [input.cycleId]
  );
  const previous = previousResult.rows[0]?.event_type ?? null;
  if (!allowedTransition(previous, input.eventType)) {
    fail("AUTONOMOUS_WORKER_STATE_TRANSITION_INVALID");
  }

  const payload = asJsonPayload(input.payload);
  const eventKey = canonicalJson({
    cycleId: input.cycleId,
    eventType: input.eventType,
    occurredAt: occurredAt.toISOString(),
    payload
  });
  const eventId = `autonomous_${stableRecordId("autonomous_worker_event", eventKey)}`;
  const fingerprint = stableRecordId("autonomous_worker_payload", canonicalJson(payload));
  await client.query(
    `INSERT INTO workstream_events(
       event_id, workstream, event_type, entity_type, entity_id,
       occurred_at, produced_at, schema_version, run_id, correlation_id,
       payload, payload_fingerprint, processing_status, projection_version,
       processed_at, attempts
     ) VALUES (
       $1, 'autonomous_worker', $2, 'autonomous_cycle', $3,
       $4, $4, 1, $3, $3, $5::jsonb, $6, 'completed', 1, $4, 1
     ) ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      input.eventType,
      input.cycleId,
      occurredAt.toISOString(),
      canonicalJson(payload),
      fingerprint
    ]
  );

  if (input.eventType.endsWith("_failed")) {
    const record = input.payload;
    const failureId = `autonomous_failure_${stableRecordId("autonomous_worker_failure", eventId)}`;
    await client.query(
      `INSERT INTO workstream_event_failures(
         id, event_id, attempt_number, error_classification, error_code,
         redacted_error_message, retryable, failed_at, details
       ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (event_id, attempt_number) DO NOTHING`,
      [
        failureId,
        eventId,
        boundedText(record.classification, "autonomous_worker_failure", 120),
        boundedText(record.code, "AUTONOMOUS_WORKER_FAILED", 160),
        boundedText(record.message, "Autonomous worker event failed."),
        false,
        occurredAt.toISOString(),
        canonicalJson(payload)
      ]
    );
  }

  return { status: "persisted" as const, eventId };
};

export const persistAutonomousWorkerState = (
  pool: Pool,
  config: DatabaseConfig,
  input: AutonomousWorkerStateInput
) => withPostgresTransaction(
  pool,
  config,
  (client) => persistAutonomousWorkerStateWithClient(client, input),
  { isolationLevel: "serializable" }
);
