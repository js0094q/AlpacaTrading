import type { PoolClient } from "pg";

import type {
  IdempotencyBeginResult,
  IdempotencyRecord,
  IdempotencyRepository
} from "../contracts/idempotencyRepository.js";
import type { VersionedWriteResult } from "../contracts/common.js";
import {
  asIsoString,
  parseJsonValue,
  stableRecordId,
  type PostgresRepositoryContext
} from "./postgresRepositorySupport.js";

type IdempotencyRow = {
  scope: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: IdempotencyRecord["status"];
  response_data: unknown;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
  version: number | string;
};

const columns = `scope, idempotency_key, request_fingerprint, status,
  response_data, error_code, created_at, updated_at, expires_at, version`;

const mapRecord = (row: IdempotencyRow): IdempotencyRecord => ({
  scope: row.scope,
  key: row.idempotency_key,
  requestHash: row.request_fingerprint,
  status: row.status,
  response: row.response_data === null ? null : parseJsonValue(row.response_data),
  errorCode: row.error_code,
  createdAt: asIsoString(row.created_at)!,
  updatedAt: asIsoString(row.updated_at)!,
  expiresAt: asIsoString(row.expires_at),
  version: Number(row.version)
});

const mutationMiss = async (
  context: PostgresRepositoryContext,
  input: { scope: string; key: string; requestHash: string; expectedVersion: number }
): Promise<VersionedWriteResult> => {
  const result = await context.transaction.query<IdempotencyRow>(
    `SELECT ${columns}
     FROM idempotency_records WHERE scope = $1 AND idempotency_key = $2`,
    [input.scope, input.key]
  );
  const row = result.rows[0];
  if (!row) return { status: "not_found" };
  if (row.request_fingerprint !== input.requestHash || Number(row.version) !== input.expectedVersion) {
    return { status: "version_conflict", currentVersion: Number(row.version) };
  }
  return { status: "not_found" };
};

export class PostgresIdempotencyRepository implements IdempotencyRepository<PoolClient> {
  async find(
    input: { readonly scope: string; readonly key: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<IdempotencyRow>(
      `SELECT ${columns}
       FROM idempotency_records WHERE scope = $1 AND idempotency_key = $2`,
      [input.scope, input.key]
    );
    return result.rows[0] ? mapRecord(result.rows[0]) : null;
  }

  async begin(
    input: Parameters<IdempotencyRepository<PoolClient>["begin"]>[0],
    context: PostgresRepositoryContext
  ): Promise<IdempotencyBeginResult> {
    const inserted = await context.transaction.query<IdempotencyRow>(
      `INSERT INTO idempotency_records(
         id, scope, idempotency_key, request_fingerprint, status,
         owner_id, run_id, expires_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7, $8, $8)
       ON CONFLICT (scope, idempotency_key) DO NOTHING
       RETURNING ${columns}`,
      [
        stableRecordId(input.scope, input.key),
        input.scope,
        input.key,
        input.requestHash,
        context.actorId,
        context.operationId,
        input.expiresAt ?? null,
        input.startedAt
      ]
    );
    if (inserted.rows[0]) {
      return { status: "acquired", record: mapRecord(inserted.rows[0]) };
    }

    const selected = await context.transaction.query<IdempotencyRow>(
      `SELECT ${columns}
       FROM idempotency_records
       WHERE scope = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [input.scope, input.key]
    );
    const row = selected.rows[0];
    if (!row) throw new Error("POSTGRES_IDEMPOTENCY_CONFLICT_ROW_MISSING");
    if (row.request_fingerprint !== input.requestHash) {
      return { status: "request_conflict", existingRequestHash: row.request_fingerprint };
    }
    if (row.status === "completed") return { status: "replay", record: mapRecord(row) };
    const expired = row.expires_at !== null && new Date(row.expires_at).getTime() <= new Date(input.startedAt).getTime();
    if (row.status === "in_progress" && !expired) {
      return { status: "in_progress", record: mapRecord(row) };
    }
    const reset = await context.transaction.query<IdempotencyRow>(
      `UPDATE idempotency_records
       SET status = 'in_progress', response_data = NULL, response_fingerprint = NULL,
           error_code = NULL, owner_id = $3, run_id = $4, expires_at = $5,
           completed_at = NULL, updated_at = $6, version = version + 1
       WHERE scope = $1 AND idempotency_key = $2
       RETURNING ${columns}`,
      [
        input.scope,
        input.key,
        context.actorId,
        context.operationId,
        input.expiresAt ?? null,
        input.startedAt
      ]
    );
    return { status: "acquired", record: mapRecord(reset.rows[0]!) };
  }

  async complete(
    input: Parameters<IdempotencyRepository<PoolClient>["complete"]>[0],
    context: PostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const responseFingerprint = stableRecordId("response", JSON.stringify(input.response));
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE idempotency_records
       SET status = 'completed', response_data = $5::jsonb,
           response_fingerprint = $6, completed_at = $4, updated_at = $4,
           version = version + 1
       WHERE scope = $1 AND idempotency_key = $2
         AND request_fingerprint = $3 AND version = $7
         AND status = 'in_progress'
       RETURNING version`,
      [
        input.scope,
        input.key,
        input.requestHash,
        input.completedAt,
        JSON.stringify(input.response),
        responseFingerprint,
        input.expectedVersion
      ]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : mutationMiss(context, input);
  }

  async fail(
    input: Parameters<IdempotencyRepository<PoolClient>["fail"]>[0],
    context: PostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE idempotency_records
       SET status = 'failed', error_code = $4, updated_at = $5,
           version = version + 1
       WHERE scope = $1 AND idempotency_key = $2
         AND request_fingerprint = $3 AND version = $6
         AND status = 'in_progress'
       RETURNING version`,
      [
        input.scope,
        input.key,
        input.requestHash,
        input.errorCode,
        input.failedAt,
        input.expectedVersion
      ]
    );
    return result.rows[0]
      ? { status: "updated", version: Number(result.rows[0].version) }
      : mutationMiss(context, input);
  }
}
