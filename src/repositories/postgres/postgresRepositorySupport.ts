import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { canonicalizeJson } from "../../lib/canonicalJson.js";
import type {
  FencedRepositoryOperationContext,
  JsonValue,
  SchedulerFence,
  TransactionScopedOperationContext
} from "../contracts/common.js";

export type PostgresRepositoryContext =
  TransactionScopedOperationContext<PoolClient>;
export type FencedPostgresRepositoryContext =
  FencedRepositoryOperationContext<PoolClient>;

export const canonicalJson = (value: JsonValue) =>
  JSON.stringify(canonicalizeJson(value));

export const stableRecordId = (scope: string, key: string) =>
  createHash("sha256").update(scope).update("\0").update(key).digest("hex");

export const asIsoString = (value: Date | string | null | undefined) =>
  value === null || value === undefined ? null : new Date(value).toISOString();

export const asNumber = (value: number | string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

export const parseJsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) return value.map(parseJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        parseJsonValue(entry)
      ])
    );
  }
  throw new Error("POSTGRES_JSON_VALUE_INVALID");
};

export const currentFenceToken = async (
  client: PoolClient,
  fence: SchedulerFence
): Promise<string | null> => {
  const result = await client.query<{ fencing_token: string }>(
    `SELECT fencing_token
     FROM scheduler_leases
     WHERE job_name = $1
       AND status = 'held'
       AND expires_at > now()`,
    [fence.jobName]
  );
  return result.rows[0]?.fencing_token ?? null;
};

export const requireCurrentFence = async (
  context: FencedPostgresRepositoryContext
) => {
  const result = await context.transaction.query<{
    fencing_token: string;
    workstream: string;
    owner_id: string;
    run_id: string;
    current: boolean;
    heartbeat_at: Date | string | null;
    expires_at: Date | string | null;
    remaining_lease_ms: string | number | null;
  }>(
    `SELECT fencing_token, workstream, owner_id, run_id,
            status = 'held' AND expires_at > now() AS current,
            heartbeat_at, expires_at,
            GREATEST(
              0,
              floor(extract(epoch FROM (expires_at - clock_timestamp())) * 1000)
            )::bigint AS remaining_lease_ms
     FROM scheduler_leases
     WHERE job_name = $1
     FOR UPDATE`,
    [context.schedulerFence.jobName]
  );
  const row = result.rows[0];
  const accepted = Boolean(
    row?.current &&
    row.fencing_token === context.schedulerFence.fencingToken &&
    row.workstream === context.schedulerFence.workstream &&
    row.owner_id === context.schedulerFence.ownerId &&
    row.run_id === context.schedulerFence.runId
  );
  if (!accepted) {
    const current = row?.current ? row.fencing_token : null;
    return {
      accepted: false as const,
      currentFencingToken: current,
      leaseOwner: row?.owner_id ?? null,
      heartbeatAt: asIsoString(row?.heartbeat_at),
      expiresAt: asIsoString(row?.expires_at),
      remainingLeaseMs: asNumber(row?.remaining_lease_ms)
    };
  }
  return {
    accepted: true as const,
    currentFencingToken: row.fencing_token,
    leaseOwner: row.owner_id,
    heartbeatAt: asIsoString(row.heartbeat_at),
    expiresAt: asIsoString(row.expires_at),
    remainingLeaseMs: asNumber(row.remaining_lease_ms)
  };
};

export const fencePredicate = (startIndex: number) => `EXISTS (
  SELECT 1
  FROM scheduler_leases scheduler_fence
  WHERE scheduler_fence.job_name = $${startIndex}
    AND scheduler_fence.workstream = $${startIndex + 1}
    AND scheduler_fence.owner_id = $${startIndex + 2}
    AND scheduler_fence.run_id = $${startIndex + 3}
    AND scheduler_fence.fencing_token = $${startIndex + 4}
    AND scheduler_fence.status = 'held'
    AND scheduler_fence.expires_at > now()
)`;

export const fenceValues = (fence: SchedulerFence) => [
  fence.jobName,
  fence.workstream,
  fence.ownerId,
  fence.runId,
  fence.fencingToken
] as const;
