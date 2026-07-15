import type { PoolClient } from "pg";

import type { SchedulerFence } from "../contracts/common.js";
import type {
  SchedulerLeaseAcquisitionResult,
  SchedulerLeaseMutationResult,
  SchedulerLeaseRecord,
  SchedulerLeaseRepository,
  SchedulerLeaseStatus
} from "../contracts/schedulerLeaseRepository.js";
import {
  asIsoString,
  type PostgresRepositoryContext
} from "./postgresRepositorySupport.js";

type SchedulerLeaseAcquireInput = Parameters<
  SchedulerLeaseRepository<PoolClient>["acquire"]
>[0];
type SchedulerLeaseHeartbeatInput = Parameters<
  SchedulerLeaseRepository<PoolClient>["heartbeat"]
>[0];
type SchedulerLeaseReleaseInput = Parameters<
  SchedulerLeaseRepository<PoolClient>["release"]
>[0];
type SchedulerFencingIdentity = Pick<
  SchedulerFence,
  "jobName" | "ownerId" | "runId" | "fencingToken"
>;

type SchedulerLeaseRow = {
  job_name: string;
  workstream: string;
  owner_id: string;
  run_id: string;
  fencing_token: string;
  status: SchedulerLeaseStatus;
  acquired_at: Date | string;
  heartbeat_at: Date | string;
  expires_at: Date | string;
  released_at: Date | string | null;
  release_reason: string | null;
  version: number | string;
  lease_is_current?: boolean;
};

const selectColumns = `
  job_name, workstream, owner_id, run_id, fencing_token::text AS fencing_token,
  status, acquired_at, heartbeat_at, expires_at, released_at, release_reason,
  version
`;

const decimalToken = (value: string) => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("SCHEDULER_FENCING_TOKEN_INVALID");
  }
  return value;
};

const leaseTtlMilliseconds = (start: string, end: string) => {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const ttlMs = endMs - startMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("SCHEDULER_LEASE_TTL_INVALID");
  }
  return ttlMs;
};

const mapLease = (row: SchedulerLeaseRow): SchedulerLeaseRecord => ({
  jobName: row.job_name,
  workstream: row.workstream,
  ownerId: row.owner_id,
  runId: row.run_id,
  fencingToken: decimalToken(String(row.fencing_token)),
  acquiredAt: asIsoString(row.acquired_at)!,
  heartbeatAt: asIsoString(row.heartbeat_at)!,
  expiresAt: asIsoString(row.expires_at)!,
  releasedAt: asIsoString(row.released_at),
  releaseReason: row.release_reason,
  status: row.status,
  version: Number(row.version)
});

const lockLease = async (client: PoolClient, jobName: string) => {
  const result = await client.query<SchedulerLeaseRow>(
    `SELECT ${selectColumns},
            (status = 'held' AND expires_at > statement_timestamp()) AS lease_is_current
     FROM scheduler_leases
     WHERE job_name = $1
     FOR UPDATE`,
    [jobName]
  );
  return result.rows[0] || null;
};

const fenceMatches = (
  row: SchedulerLeaseRow,
  fence: SchedulerFencingIdentity
) =>
  row.job_name === fence.jobName &&
  row.owner_id === fence.ownerId &&
  row.run_id === fence.runId &&
  String(row.fencing_token) === fence.fencingToken &&
  row.status === "held" &&
  row.lease_is_current === true;

const rejectedLockedMutation = (
  row: SchedulerLeaseRow | null
): SchedulerLeaseMutationResult =>
  row
    ? {
        status: "fence_rejected",
        currentFencingToken: decimalToken(String(row.fencing_token))
      }
    : { status: "not_found" };

export class PostgresSchedulerLeaseRepository
implements SchedulerLeaseRepository<PoolClient> {
  async findByJobName(
    input: { readonly jobName: string },
    context: PostgresRepositoryContext
  ): Promise<SchedulerLeaseRecord | null> {
    const result = await context.transaction.query<SchedulerLeaseRow>(
      `SELECT ${selectColumns}
       FROM scheduler_leases
       WHERE job_name = $1`,
      [input.jobName]
    );
    return result.rows[0] ? mapLease(result.rows[0]) : null;
  }

  async acquire(
    input: SchedulerLeaseAcquireInput,
    context: PostgresRepositoryContext
  ): Promise<SchedulerLeaseAcquisitionResult> {
    const ttlMs = leaseTtlMilliseconds(input.acquiredAt, input.expiresAt);
    const result = await context.transaction.query<SchedulerLeaseRow>(
      `INSERT INTO scheduler_leases(
         job_name, workstream, owner_id, run_id, fencing_token, status,
         acquired_at, heartbeat_at, expires_at, released_at, release_reason,
         version, created_at, updated_at
       )
       VALUES (
         $1, $2, $3, $4, nextval('scheduler_fencing_token_seq'), 'held',
         statement_timestamp(), statement_timestamp(),
         statement_timestamp() + ($5::bigint * interval '1 millisecond'),
         NULL, NULL, 1, statement_timestamp(), statement_timestamp()
       )
       ON CONFLICT (job_name) DO UPDATE
       SET workstream = EXCLUDED.workstream,
           owner_id = EXCLUDED.owner_id,
           run_id = EXCLUDED.run_id,
           fencing_token = EXCLUDED.fencing_token,
           status = 'held',
           acquired_at = statement_timestamp(),
           heartbeat_at = statement_timestamp(),
           expires_at = statement_timestamp() + ($5::bigint * interval '1 millisecond'),
           released_at = NULL,
           release_reason = NULL,
           version = scheduler_leases.version + 1,
           updated_at = statement_timestamp()
       WHERE scheduler_leases.status <> 'held'
          OR scheduler_leases.expires_at <= statement_timestamp()
       RETURNING ${selectColumns}`,
      [input.jobName, input.workstream, input.ownerId, input.runId, ttlMs]
    );

    if (result.rows[0]) {
      return { status: "acquired", lease: mapLease(result.rows[0]) };
    }
    const held = await lockLease(context.transaction, input.jobName);
    if (!held || held.status !== "held") {
      throw new Error("SCHEDULER_LEASE_COMPETITION_STATE_UNAVAILABLE");
    }
    return { status: "held", lease: mapLease(held) };
  }

  async heartbeat(
    input: SchedulerLeaseHeartbeatInput,
    context: PostgresRepositoryContext
  ): Promise<SchedulerLeaseMutationResult> {
    const ttlMs = leaseTtlMilliseconds(input.heartbeatAt, input.expiresAt);
    const locked = await lockLease(context.transaction, input.jobName);
    if (!locked || !fenceMatches(locked, input)) {
      return rejectedLockedMutation(locked);
    }

    const result = await context.transaction.query<SchedulerLeaseRow>(
      `UPDATE scheduler_leases
       SET heartbeat_at = statement_timestamp(),
           expires_at = statement_timestamp() + ($5::bigint * interval '1 millisecond'),
           version = version + 1,
           updated_at = statement_timestamp()
       WHERE job_name = $1
         AND owner_id = $2
         AND run_id = $3
         AND fencing_token = $4::bigint
         AND status = 'held'
         AND expires_at > statement_timestamp()
       RETURNING ${selectColumns}`,
      [input.jobName, input.ownerId, input.runId, input.fencingToken, ttlMs]
    );
    return result.rows[0]
      ? { status: "updated", lease: mapLease(result.rows[0]) }
      : rejectedLockedMutation(locked);
  }

  async release(
    input: SchedulerLeaseReleaseInput,
    context: PostgresRepositoryContext
  ): Promise<SchedulerLeaseMutationResult> {
    const locked = await lockLease(context.transaction, input.jobName);
    if (!locked || !fenceMatches(locked, input)) {
      return rejectedLockedMutation(locked);
    }

    const releaseReason = input.releaseReason?.trim() || "completed";
    const result = await context.transaction.query<SchedulerLeaseRow>(
      `UPDATE scheduler_leases
       SET status = 'released',
           released_at = statement_timestamp(),
           release_reason = $5,
           version = version + 1,
           updated_at = statement_timestamp()
       WHERE job_name = $1
         AND owner_id = $2
         AND run_id = $3
         AND fencing_token = $4::bigint
         AND status = 'held'
         AND expires_at > statement_timestamp()
       RETURNING ${selectColumns}`,
      [input.jobName, input.ownerId, input.runId, input.fencingToken, releaseReason]
    );
    return result.rows[0]
      ? { status: "updated", lease: mapLease(result.rows[0]) }
      : rejectedLockedMutation(locked);
  }

  async isCurrentFence(
    fence: SchedulerFence,
    context: PostgresRepositoryContext
  ) {
    const locked = await lockLease(context.transaction, fence.jobName);
    return Boolean(
      locked &&
        fenceMatches(locked, fence) &&
        locked.workstream === fence.workstream
    );
  }
}
