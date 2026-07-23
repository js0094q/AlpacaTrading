import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { PostgresSchedulerLeaseRepository } from "../src/repositories/postgres/postgresSchedulerLeaseRepository.js";

type LeaseRow = {
  job_name: string;
  workstream: string;
  owner_id: string;
  run_id: string;
  fencing_token: string;
  status: "held" | "released" | "expired";
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
  version: number;
};

const result = <T extends QueryResultRow>(rows: T[]) =>
  ({ rows, rowCount: rows.length } as unknown as QueryResult<T>);

const createLeaseClient = () => {
  let row: LeaseRow | null = null;
  let sequence = 9_007_199_254_740_990n;
  let now = "2026-07-15T20:00:00.000Z";
  const clientsSeen: PoolClient[] = [];
  const statements: string[] = [];

  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      clientsSeen.push(client as unknown as PoolClient);
      statements.push(text);
      const sql = text.replace(/\s+/g, " ").trim();

      if (sql.startsWith("INSERT INTO scheduler_leases")) {
        const candidateToken = String(++sequence);
        const [jobName, workstream, ownerId, runId, ttlMs] = values as [
          string,
          string,
          string,
          string,
          number
        ];
        const acquiredAt = now;
        const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
        if (
          !row ||
          row.status !== "held" ||
          Date.parse(row.expires_at) <= Date.parse(acquiredAt)
        ) {
          row = {
            job_name: jobName,
            workstream,
            owner_id: ownerId,
            run_id: runId,
            fencing_token: candidateToken,
            status: "held",
            acquired_at: acquiredAt,
            heartbeat_at: acquiredAt,
            expires_at: expiresAt,
            released_at: null,
            release_reason: null,
            version: (row?.version || 0) + 1
          };
          return result([row]);
        }
        return result([]);
      }

      if (sql.includes("FROM scheduler_leases") && sql.includes("FOR UPDATE")) {
        return result(
          row && row.job_name === values[0]
            ? [
                {
                  ...row,
                  lease_is_current:
                    row.status === "held" &&
                    Date.parse(row.expires_at) > Date.parse(now)
                }
              ]
            : []
        );
      }

      if (sql.startsWith("UPDATE scheduler_leases") && sql.includes("SET heartbeat_at")) {
        const [jobName, ownerId, runId, fencingToken, ttlMs] = values as [
          string,
          string,
          string,
          string,
          number
        ];
        const heartbeatAt = now;
        const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
        if (
          row &&
          row.job_name === jobName &&
          row.owner_id === ownerId &&
          row.run_id === runId &&
          row.fencing_token === fencingToken &&
          row.status === "held" &&
          Date.parse(row.expires_at) > Date.parse(heartbeatAt) &&
          ttlMs > 0
        ) {
          row = {
            ...row,
            heartbeat_at: heartbeatAt,
            expires_at: expiresAt,
            version: row.version + 1
          };
          return result([row]);
        }
        return result([]);
      }

      if (sql.startsWith("UPDATE scheduler_leases") && sql.includes("status = 'released'")) {
        const [jobName, ownerId, runId, fencingToken, releaseReason] = values as [
          string,
          string,
          string,
          string,
          string
        ];
        const releasedAt = now;
        if (
          row &&
          row.job_name === jobName &&
          row.owner_id === ownerId &&
          row.run_id === runId &&
          row.fencing_token === fencingToken &&
          row.status === "held" &&
          Date.parse(row.expires_at) > Date.parse(releasedAt)
        ) {
          row = {
            ...row,
            status: "released",
            released_at: releasedAt,
            release_reason: releaseReason,
            version: row.version + 1
          };
          return result([row]);
        }
        return result([]);
      }

      if (sql.includes("FROM scheduler_leases") && sql.includes("job_name = $1")) {
        return result(row && row.job_name === values[0] ? [row] : []);
      }

      throw new Error(`Unexpected query: ${sql}`);
    }
  } as unknown as PoolClient;

  return {
    client,
    clientsSeen,
    statements,
    setNow(value: string) {
      now = value;
    }
  };
};

const context = (client: PoolClient) => ({
  transaction: client,
  operationId: "scheduler-lease-test",
  actorId: "test-worker"
});

test("atomically fences competing owners and lets an expired lease be reacquired", async () => {
  const fake = createLeaseClient();
  const repository = new PostgresSchedulerLeaseRepository();

  const first = await repository.acquire(
    {
      jobName: "research",
      workstream: "research",
      ownerId: "worker-a",
      runId: "run-a",
      acquiredAt: "2026-07-15T20:00:00.000Z",
      expiresAt: "2026-07-15T20:05:00.000Z"
    },
    context(fake.client)
  );
  fake.setNow("2026-07-15T20:01:00.000Z");
  const competing = await repository.acquire(
    {
      jobName: "research",
      workstream: "research",
      ownerId: "worker-b",
      runId: "run-b",
      acquiredAt: "2026-07-15T20:01:00.000Z",
      expiresAt: "2026-07-15T20:06:00.000Z"
    },
    context(fake.client)
  );
  fake.setNow("2026-07-15T20:05:00.000Z");
  const afterExpiration = await repository.acquire(
    {
      jobName: "research",
      workstream: "research",
      ownerId: "worker-b",
      runId: "run-b",
      acquiredAt: "2026-07-15T20:05:00.000Z",
      expiresAt: "2026-07-15T20:10:00.000Z"
    },
    context(fake.client)
  );

  assert.equal(first.status, "acquired");
  assert.equal(first.lease.fencingToken, "9007199254740991");
  assert.equal(competing.status, "held");
  assert.equal(competing.lease.ownerId, "worker-a");
  assert.equal(afterExpiration.status, "acquired");
  assert.equal(afterExpiration.lease.ownerId, "worker-b");
  assert.ok(BigInt(afterExpiration.lease.fencingToken) > BigInt(first.lease.fencingToken));
  assert.ok(
    fake.statements.some(
      (sql) =>
        /ON CONFLICT \(job_name\) DO UPDATE/.test(sql) &&
        /nextval\('scheduler_fencing_token_seq'\)/.test(sql) &&
        /scheduler_leases\.expires_at <= statement_timestamp\(\)/.test(sql) &&
        /interval '1 millisecond'/.test(sql)
    )
  );
  assert.ok(fake.clientsSeen.every((client) => client === fake.client));
});

test("heartbeats and releases only the current unexpired owner and token", async () => {
  const fake = createLeaseClient();
  const repository = new PostgresSchedulerLeaseRepository();
  const acquired = await repository.acquire(
    {
      jobName: "observatory",
      workstream: "market-data",
      ownerId: "worker-a",
      runId: "run-a",
      acquiredAt: "2026-07-15T20:00:00.000Z",
      expiresAt: "2026-07-15T20:05:00.000Z"
    },
    context(fake.client)
  );
  assert.equal(acquired.status, "acquired");

  fake.setNow("2026-07-15T20:02:00.000Z");
  const heartbeat = await repository.heartbeat(
    {
      jobName: "observatory",
      ownerId: "worker-a",
      runId: "run-a",
      fencingToken: acquired.lease.fencingToken,
      heartbeatAt: "2026-07-15T20:02:00.000Z",
      expiresAt: "2026-07-15T20:07:00.000Z"
    },
    context(fake.client)
  );
  assert.equal(heartbeat.status, "updated");
  assert.equal(heartbeat.lease.version, 2);

  fake.setNow("2026-07-15T20:03:00.000Z");
  const release = await repository.release(
    {
      jobName: "observatory",
      ownerId: "worker-a",
      runId: "run-a",
      fencingToken: acquired.lease.fencingToken,
      releasedAt: "2026-07-15T20:03:00.000Z",
      releaseReason: "completed"
    },
    context(fake.client)
  );
  assert.equal(release.status, "updated");
  assert.equal(release.lease.status, "released");
  assert.equal(release.lease.releasedAt, "2026-07-15T20:03:00.000Z");
  assert.equal(release.lease.releaseReason, "completed");
  assert.ok(
    fake.statements.filter((statement) => statement.includes("FOR UPDATE")).length >= 2
  );

  const afterRelease = await repository.heartbeat(
    {
      jobName: "observatory",
      ownerId: "worker-a",
      runId: "run-a",
      fencingToken: acquired.lease.fencingToken,
      heartbeatAt: "2026-07-15T20:04:00.000Z",
      expiresAt: "2026-07-15T20:09:00.000Z"
    },
    context(fake.client)
  );
  assert.deepEqual(afterRelease, {
    status: "fence_rejected",
    currentFencingToken: acquired.lease.fencingToken
  });
});

test("rejects expired and stale-token heartbeats and releases", async () => {
  const fake = createLeaseClient();
  const repository = new PostgresSchedulerLeaseRepository();
  const first = await repository.acquire(
    {
      jobName: "reconciliation",
      workstream: "reconciliation",
      ownerId: "worker-a",
      runId: "run-a",
      acquiredAt: "2026-07-15T20:00:00.000Z",
      expiresAt: "2026-07-15T20:01:00.000Z"
    },
    context(fake.client)
  );
  assert.equal(first.status, "acquired");

  fake.setNow("2026-07-15T20:01:00.000Z");
  const expiredHeartbeat = await repository.heartbeat(
    {
      jobName: "reconciliation",
      ownerId: "worker-a",
      runId: "run-a",
      fencingToken: first.lease.fencingToken,
      heartbeatAt: "2026-07-15T20:01:00.000Z",
      expiresAt: "2026-07-15T20:06:00.000Z"
    },
    context(fake.client)
  );
  assert.equal(expiredHeartbeat.status, "fence_rejected");

  const second = await repository.acquire(
    {
      jobName: "reconciliation",
      workstream: "reconciliation",
      ownerId: "worker-b",
      runId: "run-b",
      acquiredAt: "2026-07-15T20:01:00.000Z",
      expiresAt: "2026-07-15T20:06:00.000Z"
    },
    context(fake.client)
  );
  assert.equal(second.status, "acquired");

  fake.setNow("2026-07-15T20:02:00.000Z");
  const staleHeartbeat = await repository.heartbeat(
    {
      jobName: "reconciliation",
      ownerId: "worker-a",
      runId: "run-a",
      fencingToken: first.lease.fencingToken,
      heartbeatAt: "2026-07-15T20:02:00.000Z",
      expiresAt: "2026-07-15T20:07:00.000Z"
    },
    context(fake.client)
  );
  const staleRelease = await repository.release(
    {
      jobName: "reconciliation",
      ownerId: "worker-a",
      runId: "run-a",
      fencingToken: first.lease.fencingToken,
      releasedAt: "2026-07-15T20:02:00.000Z"
    },
    context(fake.client)
  );

  assert.deepEqual(staleHeartbeat, {
    status: "fence_rejected",
    currentFencingToken: second.lease.fencingToken
  });
  assert.deepEqual(staleRelease, {
    status: "fence_rejected",
    currentFencingToken: second.lease.fencingToken
  });

  fake.setNow("2026-07-15T20:02:00.000Z");
  assert.equal(await repository.isCurrentFence(second.lease, context(fake.client)), true);
  assert.equal(await repository.isCurrentFence(first.lease, context(fake.client)), false);
});
