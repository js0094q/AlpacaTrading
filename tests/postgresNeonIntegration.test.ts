import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool, PoolClient } from "pg";

import { loadDatabaseConfig } from "../src/lib/database/config.js";
import { createPostgresPool } from "../src/lib/database/postgres.js";
import { runPostgresMigrations } from "../src/lib/database/postgresMigrations.js";
import { sanitizeDatabaseError } from "../src/lib/database/redaction.js";
import { verifyPostgresSchema } from "../src/lib/database/postgresSchema.js";
import { withPostgresTransaction } from "../src/lib/database/postgresTransaction.js";
import { PostgresIdempotencyRepository } from "../src/repositories/postgres/postgresIdempotencyRepository.js";
import {
  PostgresCandidateLifecycleEventRepository,
  PostgresCandidateRepository
} from "../src/repositories/postgres/postgresCandidateRepository.js";
import { PostgresResearchRunRepository } from "../src/repositories/postgres/postgresResearchRunRepository.js";
import { PostgresSchedulerLeaseRepository } from "../src/repositories/postgres/postgresSchedulerLeaseRepository.js";
import { createDecisionId } from "../src/services/marketDecisionIdentityService.js";

const enabled = process.env.POSTGRES_INTEGRATION_TEST_ENABLED === "true";

test("actual Neon PostgreSQL applies Release 3 twice and fences concurrent control-plane writers", {
  skip: !enabled
}, async () => {
  const config = loadDatabaseConfig(
    {
      ...process.env,
      DATABASE_BACKEND: "postgres",
      POSTGRES_APPLICATION_NAME: "alpaca-paper-neon-integration-test"
    },
    { runtime: "test", purpose: "migration" }
  );
  const schema = `neon_release3_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const adminPool = createPostgresPool(config, "direct");
  let schemaPool: Pool | undefined;
  let failureCode: string | null = null;
  let phase = "create_schema";

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    phase = "migrate_and_verify";
    const integrationConfig = { ...config, maxConnections: 4 };
    schemaPool = createPostgresPool(integrationConfig, "direct", {
      sessionOptions: `-c search_path=${schema}`
    });

    const first = await runPostgresMigrations(schemaPool, config);
    const second = await runPostgresMigrations(schemaPool, config);
    const verification = await verifyPostgresSchema(schemaPool);

    assert.deepEqual(first.appliedVersions, [1, 2]);
    assert.deepEqual(second.appliedVersions, []);
    assert.equal(verification.verificationPassed, true);
    assert.equal(verification.presentTableCount, 23);
    assert.equal(verification.presentIndexCount, 59);
    assert.equal(verification.schedulerFencingSequencePresent, true);
    assert.deepEqual(verification.missingColumns, []);
    assert.deepEqual(verification.missingConstraints, []);
    assert.deepEqual(verification.invalidNotNullColumns, []);
    assert.deepEqual(verification.invalidIndexes, []);
    assert.deepEqual(verification.invalidConstraints, []);

    const scheduler = new PostgresSchedulerLeaseRepository();
    phase = "scheduler_fencing";
    const acquire = (ownerId: string, runId: string) =>
      withPostgresTransaction(schemaPool!, integrationConfig, (client) =>
        scheduler.acquire(
          {
            jobName: "research",
            workstream: "research",
            ownerId,
            runId,
            acquiredAt: "2026-07-15T20:00:00.000Z",
            expiresAt: "2026-07-15T20:01:00.000Z"
          },
          {
            transaction: client,
            operationId: `acquire:${runId}`,
            actorId: ownerId
          }
        )
      );
    const acquisitions = await Promise.all([
      acquire("worker-a", "scheduler-run-a"),
      acquire("worker-b", "scheduler-run-b")
    ]);
    assert.deepEqual(
      acquisitions.map((entry) => entry.status).sort(),
      ["acquired", "held"]
    );
    const original = acquisitions.find((entry) => entry.status === "acquired")!;
    await schemaPool.query(
      `UPDATE scheduler_leases
       SET acquired_at = statement_timestamp() - interval '3 minutes',
           heartbeat_at = statement_timestamp() - interval '2 minutes',
           expires_at = statement_timestamp() - interval '1 minute'
       WHERE job_name = 'research'`
    );
    const takeover = await acquire("worker-c", "scheduler-run-c");
    assert.equal(takeover.status, "acquired");
    assert.ok(BigInt(takeover.lease.fencingToken) > BigInt(original.lease.fencingToken));

    const staleFence = {
      jobName: original.lease.jobName,
      workstream: original.lease.workstream,
      ownerId: original.lease.ownerId,
      runId: original.lease.runId,
      fencingToken: original.lease.fencingToken
    };
    const currentFence = {
      jobName: takeover.lease.jobName,
      workstream: takeover.lease.workstream,
      ownerId: takeover.lease.ownerId,
      runId: takeover.lease.runId,
      fencingToken: takeover.lease.fencingToken
    };
    const research = new PostgresResearchRunRepository();
    phase = "research_recovery";
    const reserveWith = (fence: typeof currentFence, runId: string) =>
      withPostgresTransaction(schemaPool!, integrationConfig, (client) =>
        research.reserve(
          {
            runId,
            startedAt: new Date().toISOString(),
            staleBefore: new Date(Date.now() - 15 * 60_000).toISOString(),
            recoveryReason: "WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED",
            recoverySource: "research_preflight",
            riskProfile: "aggressive",
            optionsEnabled: true,
            config: {},
            workerIdentity: fence.ownerId
          },
          {
            transaction: client,
            operationId: `research:${runId}`,
            actorId: fence.ownerId,
            schedulerFence: fence
          }
        )
      );
    const staleReserve = await reserveWith(staleFence, "research-stale");
    assert.equal(staleReserve.status, "fence_rejected");
    const currentReserve = await reserveWith(currentFence, "research-current");
    assert.equal(currentReserve.status, "reserved");

    await schemaPool.query(
      `UPDATE research_runs
       SET started_at = statement_timestamp() - interval '20 minutes',
           heartbeat_at = statement_timestamp() - interval '16 minutes'
       WHERE id = 'research-current'`
    );
    await schemaPool.query(
      `UPDATE scheduler_leases
       SET acquired_at = statement_timestamp() - interval '3 minutes',
           heartbeat_at = statement_timestamp() - interval '2 minutes',
           expires_at = statement_timestamp() - interval '1 minute'
       WHERE job_name = 'research'`
    );
    const recoveryTakeover = await acquire("worker-d", "scheduler-run-d");
    assert.equal(recoveryTakeover.status, "acquired");
    if (recoveryTakeover.status !== "acquired") {
      throw new Error("SCHEDULER_RECOVERY_TAKEOVER_FAILED");
    }
    const recoveredReserve = await reserveWith(
      {
        jobName: recoveryTakeover.lease.jobName,
        workstream: recoveryTakeover.lease.workstream,
        ownerId: recoveryTakeover.lease.ownerId,
        runId: recoveryTakeover.lease.runId,
        fencingToken: recoveryTakeover.lease.fencingToken
      },
      "research-after-recovery"
    );
    assert.equal(recoveredReserve.status, "reserved");
    const recoveredRun = await schemaPool.query<{
      status: string;
      recovery_reason: string | null;
      scheduler_fencing_token: string;
    }>(
      `SELECT status, recovery_reason,
              scheduler_fencing_token::text AS scheduler_fencing_token
       FROM research_runs WHERE id = 'research-current'`
    );
    assert.deepEqual(recoveredRun.rows[0], {
      status: "recovered",
      recovery_reason: "WORKER_TERMINATED_OR_HEARTBEAT_EXPIRED",
      scheduler_fencing_token: recoveryTakeover.lease.fencingToken
    });

    const recoveryFence = {
      jobName: recoveryTakeover.lease.jobName,
      workstream: recoveryTakeover.lease.workstream,
      ownerId: recoveryTakeover.lease.ownerId,
      runId: recoveryTakeover.lease.runId,
      fencingToken: recoveryTakeover.lease.fencingToken
    };
    const candidateRepository = new PostgresCandidateRepository();
    phase = "candidate_idempotency";
    const lifecycleRepository = new PostgresCandidateLifecycleEventRepository();
    const candidate = {
      id: "candidate-integration-1",
      decisionId: createDecisionId(),
      symbol: "SPY",
      asOf: "2026-07-15T20:00:00.000Z",
      rank: 1,
      direction: "long" as const,
      horizon: "1d" as const,
      riskProfile: "aggressive" as const,
      preferredExpression: "shares" as const,
      score: 0.9,
      confidence: 0.8,
      expectedReturn: null,
      estimatedMaxLoss: null,
      estimatedMaxProfit: null,
      rationale: ["integration"],
      relevantBacktestRunId: null,
      historicalWinRate: null,
      historicalAvgReturn: null,
      historicalMaxDrawdown: null,
      similarSetupCount: null,
      optionLiquidityScore: null,
      volatilityAdjustedScore: null,
      signalFreshnessDays: 0,
      recentLearningAdjustment: null,
      directionalAccuracy: null,
      optionOutperformanceAccuracy: null,
      optionSymbol: null,
      strike: null,
      shortStrike: null,
      decision: "selected" as const,
      decisionReason: "INTEGRATION_SELECTED",
      strategyFamily: "integration",
      signalInputs: {},
      dataQualityStatus: "COMPLETE"
    };
    const candidateContext = (client: PoolClient) => ({
      transaction: client,
      operationId: "candidate-integration",
      actorId: recoveryFence.ownerId,
      schedulerFence: recoveryFence
    });
    const insertCandidate = (value = candidate) => withPostgresTransaction(
      schemaPool!,
      integrationConfig,
      (client) => candidateRepository.insertMany(
        {
          researchRunId: "research-after-recovery",
          candidates: [value],
          createdAt: "2026-07-15T20:00:00.000Z"
        },
        candidateContext(client)
      )
    );
    phase = "candidate_insert";
    assert.equal((await insertCandidate())[0]?.status, "inserted");
    assert.equal((await insertCandidate())[0]?.status, "duplicate");
    await assert.rejects(
      insertCandidate({ ...candidate, symbol: "QQQ" }),
      /POSTGRES_CANDIDATE_ID_CONFLICT/
    );
    phase = "candidate_lifecycle_event";
    const lifecycleEvent = {
      eventId: "candidate-event-integration-1",
      candidateId: candidate.id,
      researchRunId: "research-after-recovery",
      sequence: 0,
      fromStatus: null,
      toStatus: "selected" as const,
      reasonCode: "INTEGRATION_SELECTED",
      occurredAt: "2026-07-15T20:00:00.000Z",
      producedAt: "2026-07-15T20:00:00.000Z",
      source: "candidate.initial.selected",
      schemaVersion: 1,
      requestId: null,
      correlationId: null,
      evidence: { source: "integration" }
    };
    const appendLifecycle = (event = lifecycleEvent) => withPostgresTransaction(
      schemaPool!,
      integrationConfig,
      (client) => lifecycleRepository.append(event, candidateContext(client))
    );
    assert.equal((await appendLifecycle()).status, "inserted");
    assert.equal((await appendLifecycle()).status, "duplicate");
    await assert.rejects(
      appendLifecycle({ ...lifecycleEvent, evidence: { source: "conflict" } }),
      /POSTGRES_CANDIDATE_EVENT_ID_CONFLICT/
    );

    const idempotency = new PostgresIdempotencyRepository();
    phase = "idempotency_records";
    const idempotencyContext = (client: PoolClient) => ({
      transaction: client,
      operationId: "idempotency-integration",
      actorId: "worker-c"
    });
    const firstIdempotency = await withPostgresTransaction(
      schemaPool,
      integrationConfig,
      (client) => idempotency.begin(
        {
          scope: "research",
          key: "request-1",
          requestHash: "hash-1",
          startedAt: new Date().toISOString()
        },
        idempotencyContext(client)
      )
    );
    assert.equal(firstIdempotency.status, "acquired");
    if (firstIdempotency.status !== "acquired") throw new Error("IDEMPOTENCY_ACQUIRE_FAILED");
    const completed = await withPostgresTransaction(
      schemaPool,
      integrationConfig,
      (client) => idempotency.complete(
        {
          scope: "research",
          key: "request-1",
          requestHash: "hash-1",
          expectedVersion: firstIdempotency.record.version,
          response: { status: "completed" },
          completedAt: new Date().toISOString()
        },
        idempotencyContext(client)
      )
    );
    assert.equal(completed.status, "updated");
    const replay = await withPostgresTransaction(
      schemaPool,
      integrationConfig,
      (client) => idempotency.begin(
        {
          scope: "research",
          key: "request-1",
          requestHash: "hash-1",
          startedAt: new Date().toISOString()
        },
        idempotencyContext(client)
      )
    );
    assert.equal(replay.status, "replay");
  } catch (error) {
    const safe = sanitizeDatabaseError(error);
    const parameter = `${(error as { message?: unknown }).message || ""} ${(error as { where?: unknown }).where || ""}`
      .match(/parameter \$\d+/i)?.[0]
      .replaceAll(" ", "_") || "parameter_unknown";
    failureCode = `${phase}:${safe.code || "POSTGRES_INTEGRATION_TEST_FAILED"}:${parameter}`;
  } finally {
    try {
      if (schemaPool) await schemaPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch (error) {
      failureCode ||= sanitizeDatabaseError(error).code || "POSTGRES_INTEGRATION_CLEANUP_FAILED";
    }
    await adminPool.end();
  }

  if (failureCode) throw new Error(`POSTGRES_INTEGRATION_TEST_FAILED:${failureCode}`);
});
