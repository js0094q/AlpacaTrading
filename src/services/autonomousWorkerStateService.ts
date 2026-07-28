import type { Pool, PoolClient } from "pg";

import type {
  JsonValue,
  SchedulerFence
} from "../repositories/contracts/common.js";
import {
  canonicalJson,
  fenceValues,
  parseJsonValue,
  stableRecordId
} from "../repositories/postgres/postgresRepositorySupport.js";
import type { DatabaseConfig } from "../lib/database/config.js";
import { withPostgresTransaction } from "../lib/database/postgresTransaction.js";
import { redactSensitiveData } from "../lib/securityRedaction.js";

export const AUTONOMOUS_WORKER_STATE_MAX_PAYLOAD_BYTES = 256 * 1024;
const ACTIVE_CYCLE_WINDOW_HOURS = 6;
const CYCLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAXIMUM_PERSISTENCE_ATTEMPTS = 3;
const DEFAULT_PERSISTENCE_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_PERSISTENCE_RETRY_MAXIMUM_DELAY_MS = 1_000;
const RETRYABLE_POSTGRES_CODES = new Set([
  "40001",
  "40P01",
  "53300",
  "55P03",
  "57P01",
  "57P02",
  "57P03"
]);
const RETRYABLE_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT"
]);
const SQLSTATE_PATTERN = /^(?:(?:[0-9]{2}|[0-9][A-Z])|P0|XX)[0-9A-Z]{3}$/;
const APPLICATION_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,159}$/;

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

export type AutonomousWorkerPersistenceClassification =
  | "AUTHORITATIVE_REQUIRED"
  | "AUTHORITATIVE_RECOVERABLE"
  | "OBSERVABILITY_SUPPLEMENTAL";

export type AutonomousWorkerPersistenceDisposition =
  | "PERSISTED"
  | "PERSISTED_AFTER_RETRY"
  | "CYCLE_FAILED_WORKER_CONTINUED"
  | "SUPPLEMENTAL_WRITE_SKIPPED"
  | "NONRETRYABLE_PERSISTENCE_FAILURE"
  | "SCHEDULER_FENCE_LOST";

export type AutonomousWorkerPersistenceEvidence = {
  readonly operationName: string;
  readonly persistenceClassification: AutonomousWorkerPersistenceClassification;
  readonly cycleId: string;
  readonly workstreamName: string;
  readonly lifecycleState: string;
  readonly retryAttempt: number;
  readonly maximumAttempts: number;
  readonly errorCode: string | null;
  readonly postgresErrorCode: string | null;
  readonly retryable: boolean;
  readonly schedulerFenceStatus: "held" | "lost" | "not_applicable";
  readonly transactionStatus: "committed" | "rolled_back_or_not_started";
  readonly finalDisposition: AutonomousWorkerPersistenceDisposition;
  readonly timestamp: string;
};

export class AutonomousWorkerPersistenceError extends Error {
  readonly code = "AUTONOMOUS_WORKER_STATE_PERSIST_FAILED";
  readonly evidence: AutonomousWorkerPersistenceEvidence;
  override readonly cause?: unknown;

  constructor(evidence: AutonomousWorkerPersistenceEvidence, cause?: unknown) {
    super("AUTONOMOUS_WORKER_STATE_PERSIST_FAILED");
    this.name = "AutonomousWorkerPersistenceError";
    this.evidence = evidence;
    this.cause = cause;
  }
}

export type AutonomousWorkerStateInput = {
  readonly cycleId: string;
  readonly eventType: AutonomousWorkerEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
};

export const autonomousWorkerPersistenceClassification = (
  eventType: AutonomousWorkerEventType
): AutonomousWorkerPersistenceClassification =>
  eventType === "preflight_failed"
    ? "OBSERVABILITY_SUPPLEMENTAL"
    : "AUTHORITATIVE_RECOVERABLE";

type AutonomousWorkerPersistenceOperationInput<T> = {
  readonly operationName: string;
  readonly persistenceClassification: AutonomousWorkerPersistenceClassification;
  readonly cycleId: string;
  readonly workstreamName: string;
  readonly lifecycleState: string;
  readonly schedulerFenceStatus: "held" | "not_applicable";
  readonly operation: () => Promise<T>;
};

type AutonomousWorkerPersistenceDependencies = {
  readonly maximumAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly emit?: (evidence: Readonly<Record<string, unknown>>) => void;
};

const waitFor = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const errorIdentity = (error: unknown) => {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  let fallbackCode: string | null = null;
  while (pending.length > 0 && seen.size < 16) {
    const candidate = pending.shift();
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      seen.has(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    const record = candidate as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof record.code === "string" && record.code.trim()) {
      const code = record.code.trim().toUpperCase();
      if (
        code === "SCHEDULER_FENCE_LOST" ||
        (SQLSTATE_PATTERN.test(code) && code.startsWith("08")) ||
        RETRYABLE_POSTGRES_CODES.has(code) ||
        RETRYABLE_SYSTEM_CODES.has(code) ||
        SQLSTATE_PATTERN.test(code)
      ) {
        return {
          errorCode: code,
          postgresErrorCode: SQLSTATE_PATTERN.test(code) ? code : null
        };
      }
      if (APPLICATION_ERROR_CODE_PATTERN.test(code)) fallbackCode ??= code;
    }
    if (
      typeof record.message === "string" &&
      APPLICATION_ERROR_CODE_PATTERN.test(record.message.trim())
    ) {
      fallbackCode ??= record.message.trim();
    }
    if (record.cause !== undefined) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return {
    errorCode: fallbackCode,
    postgresErrorCode:
      fallbackCode && SQLSTATE_PATTERN.test(fallbackCode)
        ? fallbackCode
        : null
  };
};

const retryablePersistenceError = (code: string | null) =>
  Boolean(
    code &&
    (
      (SQLSTATE_PATTERN.test(code) && code.startsWith("08")) ||
      RETRYABLE_POSTGRES_CODES.has(code) ||
      RETRYABLE_SYSTEM_CODES.has(code)
    )
  );

const boundedRetryDelay = (
  retryAttempt: number,
  baseDelayMs: number,
  maximumDelayMs: number,
  random: () => number
) => {
  const exponential = Math.min(
    maximumDelayMs,
    baseDelayMs * (2 ** Math.max(0, retryAttempt - 1))
  );
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.min(
    maximumDelayMs,
    Math.max(0, Math.floor(exponential * (0.5 + jitter * 0.5)))
  );
};

export const runAutonomousWorkerPersistence = async <T>(
  input: AutonomousWorkerPersistenceOperationInput<T>,
  dependencies: AutonomousWorkerPersistenceDependencies = {}
) => {
  const maximumAttempts = Math.max(
    1,
    Math.min(
      5,
      Math.floor(
        dependencies.maximumAttempts ??
          DEFAULT_MAXIMUM_PERSISTENCE_ATTEMPTS
      )
    )
  );
  const baseDelayMs = Math.max(
    0,
    Math.floor(
      dependencies.baseDelayMs ??
        DEFAULT_PERSISTENCE_RETRY_BASE_DELAY_MS
    )
  );
  const maximumDelayMs = Math.max(
    baseDelayMs,
    Math.floor(
      dependencies.maximumDelayMs ??
        DEFAULT_PERSISTENCE_RETRY_MAXIMUM_DELAY_MS
    )
  );
  const wait = dependencies.wait ?? waitFor;
  const random = dependencies.random ?? Math.random;
  const now = dependencies.now ?? (() => new Date());
  let lastErrorCode: string | null = null;
  let lastPostgresErrorCode: string | null = null;
  let lastRetryable = false;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const value = await input.operation();
      const evidence: AutonomousWorkerPersistenceEvidence = {
        operationName: input.operationName,
        persistenceClassification: input.persistenceClassification,
        cycleId: input.cycleId,
        workstreamName: input.workstreamName,
        lifecycleState: input.lifecycleState,
        retryAttempt: attempt - 1,
        maximumAttempts,
        errorCode: lastErrorCode,
        postgresErrorCode: lastPostgresErrorCode,
        retryable: lastRetryable,
        schedulerFenceStatus: input.schedulerFenceStatus,
        transactionStatus: "committed",
        finalDisposition:
          attempt === 1 ? "PERSISTED" : "PERSISTED_AFTER_RETRY",
        timestamp: now().toISOString()
      };
      dependencies.emit?.(evidence);
      return { value, evidence };
    } catch (error) {
      const identity = errorIdentity(error);
      const fenceLost = identity.errorCode === "SCHEDULER_FENCE_LOST";
      const retryable =
        !fenceLost && retryablePersistenceError(identity.errorCode);
      lastErrorCode = identity.errorCode;
      lastPostgresErrorCode = identity.postgresErrorCode;
      lastRetryable = retryable;
      const canRetry = retryable && attempt < maximumAttempts;
      if (canRetry) {
        const retryDelayMs = boundedRetryDelay(
          attempt,
          baseDelayMs,
          maximumDelayMs,
          random
        );
        dependencies.emit?.({
          operationName: input.operationName,
          persistenceClassification: input.persistenceClassification,
          cycleId: input.cycleId,
          workstreamName: input.workstreamName,
          lifecycleState: input.lifecycleState,
          retryAttempt: attempt,
          maximumAttempts,
          errorCode: identity.errorCode,
          postgresErrorCode: identity.postgresErrorCode,
          retryable,
          schedulerFenceStatus: input.schedulerFenceStatus,
          transactionStatus: "rolled_back_or_not_started",
          retryDelayMs,
          timestamp: now().toISOString()
        });
        await wait(retryDelayMs);
        continue;
      }

      const evidence: AutonomousWorkerPersistenceEvidence = {
        operationName: input.operationName,
        persistenceClassification: input.persistenceClassification,
        cycleId: input.cycleId,
        workstreamName: input.workstreamName,
        lifecycleState: input.lifecycleState,
        retryAttempt: attempt - 1,
        maximumAttempts,
        errorCode: identity.errorCode,
        postgresErrorCode: identity.postgresErrorCode,
        retryable,
        schedulerFenceStatus: fenceLost
          ? "lost"
          : input.schedulerFenceStatus,
        transactionStatus: "rolled_back_or_not_started",
        finalDisposition: fenceLost
          ? "SCHEDULER_FENCE_LOST"
          : input.persistenceClassification === "OBSERVABILITY_SUPPLEMENTAL"
            ? "SUPPLEMENTAL_WRITE_SKIPPED"
            : retryable
              ? "CYCLE_FAILED_WORKER_CONTINUED"
              : "NONRETRYABLE_PERSISTENCE_FAILURE",
        timestamp: now().toISOString()
      };
      dependencies.emit?.(evidence);
      throw new AutonomousWorkerPersistenceError(evidence, error);
    }
  }

  throw new Error("AUTONOMOUS_WORKER_PERSISTENCE_RETRY_BOUNDS_INVALID");
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
  if (decoded.byteLength > AUTONOMOUS_WORKER_STATE_MAX_PAYLOAD_BYTES) {
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
  input: AutonomousWorkerStateInput,
  fence?: SchedulerFence
) => {
  if (!CYCLE_ID.test(input.cycleId)) fail("AUTONOMOUS_WORKER_CYCLE_ID_INVALID");
  if (!(AUTONOMOUS_WORKER_EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    fail("AUTONOMOUS_WORKER_EVENT_TYPE_INVALID");
  }
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) fail("AUTONOMOUS_WORKER_EVENT_TIME_INVALID");
  if (fence) {
    const currentFence = await client.query(
      `SELECT 1
       FROM scheduler_leases
       WHERE job_name = $1 AND workstream = $2 AND owner_id = $3
         AND run_id = $4 AND fencing_token = $5 AND status = 'held'
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [...fenceValues(fence)]
    );
    if (currentFence.rowCount !== 1) fail("SCHEDULER_FENCE_LOST");
  }

  const payload = asJsonPayload(input.payload);
  const workstreamName =
    typeof input.payload.workstream === "string"
      ? input.payload.workstream.trim()
      : "";
  if (input.eventType.startsWith("workstream_") && !workstreamName) {
    fail("AUTONOMOUS_WORKER_WORKSTREAM_IDENTITY_REQUIRED");
  }
  const eventKey = canonicalJson({
    cycleId: input.cycleId,
    eventType: input.eventType,
    occurredAt: occurredAt.toISOString(),
    payload
  });
  const eventId = `autonomous_${stableRecordId("autonomous_worker_event", eventKey)}`;
  const fingerprint = stableRecordId("autonomous_worker_payload", canonicalJson(payload));
  const replay = await client.query<{ event_id: string }>(
    `SELECT event_id
     FROM workstream_events
     WHERE event_id = $1
     FOR UPDATE`,
    [eventId]
  );
  if (replay.rows[0]?.event_id) {
    return {
      status: "persisted" as const,
      eventId,
      replayed: true as const
    };
  }

  let resumedCycleId: string | null = null;

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
      resumedCycleId = orphanedCycleId;
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

  const previousResult = await client.query<{
    event_type: AutonomousWorkerEventType;
    workstream: string | null;
  }>(
    `SELECT event_type, payload->>'workstream' AS workstream
     FROM workstream_events
     WHERE workstream = 'autonomous_worker' AND entity_id = $1
     ORDER BY occurred_at DESC, event_id DESC
     LIMIT 1
     FOR UPDATE`,
    [input.cycleId]
  );
  const previousRow = previousResult.rows[0];
  const previous = previousRow?.event_type ?? null;
  if (!allowedTransition(previous, input.eventType)) {
    fail("AUTONOMOUS_WORKER_STATE_TRANSITION_INVALID");
  }
  if (
    ["workstream_completed", "workstream_failed"].includes(input.eventType) &&
    previous === "workstream_started" &&
    previousRow?.workstream !== workstreamName
  ) {
    fail("AUTONOMOUS_WORKER_WORKSTREAM_IDENTITY_MISMATCH");
  }

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

  return {
    status: "persisted" as const,
    eventId,
    ...(resumedCycleId ? { resumedCycleId } : {})
  };
};

export const persistAutonomousWorkerState = (
  pool: Pool,
  config: DatabaseConfig,
  input: AutonomousWorkerStateInput,
  fence?: SchedulerFence,
  dependencies: AutonomousWorkerPersistenceDependencies = {}
) => runAutonomousWorkerPersistence(
  {
    operationName: `persist_autonomous_worker_state:${input.eventType}`,
    persistenceClassification:
      autonomousWorkerPersistenceClassification(input.eventType),
    cycleId: input.cycleId,
    workstreamName: boundedText(
      input.payload.workstream,
      "autonomous_worker",
      160
    ),
    lifecycleState: input.eventType,
    schedulerFenceStatus: fence ? "held" : "not_applicable",
    operation: () => withPostgresTransaction(
      pool,
      config,
      (client) =>
        persistAutonomousWorkerStateWithClient(client, input, fence),
      { isolationLevel: "serializable" }
    )
  },
  dependencies
).then(({ value, evidence }) => ({
  ...value,
  persistence: evidence
}));
