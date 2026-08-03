import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { PostgresMarketDataRepository } from "../src/repositories/postgres/postgresMarketDataRepository.js";
import { PostgresResearchRunRepository } from "../src/repositories/postgres/postgresResearchRunRepository.js";
import { PostgresSchedulerLeaseRepository } from "../src/repositories/postgres/postgresSchedulerLeaseRepository.js";
import { createDecisionId } from "../src/services/marketDecisionIdentityService.js";
import {
  assertDurableControlPlaneCheckpoint,
  backfillControlPlaneSnapshot,
  reconcileControlPlaneSnapshot,
  readControlPlaneSnapshot
} from "../src/services/controlPlaneMigrationService.js";
import {
  assertDurableExecutionStateCheckpoint,
  backfillExecutionStateSnapshot,
  reconcileExecutionStateSnapshot
} from "../src/services/executionStateMigrationService.js";
import { createControlPlaneSnapshotFixture } from "./helpers/controlPlaneSnapshotFixture.js";
import {
  createExecutionStateSnapshotFixture,
  executionStateCandidateId
} from "./helpers/executionStateSnapshotFixture.js";

const enabled = process.env.POSTGRES_INTEGRATION_TEST_ENABLED === "true";

test("PostgreSQL integration cleanup attempts every step and aggregates failures", async () => {
  const attempted: string[] = [];

  await assert.rejects(
    runPostgresIntegrationCleanup([
      {
        name: "schema_pool_close",
        run: async () => {
          attempted.push("schema_pool_close");
          throw new Error("schema pool close failed");
        }
      },
      {
        name: "schema_drop",
        run: async () => {
          attempted.push("schema_drop");
        }
      },
      {
        name: "admin_pool_close",
        run: async () => {
          attempted.push("admin_pool_close");
          throw new Error("admin pool close failed");
        }
      },
      {
        name: "temporary_directory_remove",
        run: async () => {
          attempted.push("temporary_directory_remove");
        }
      }
    ]),
    (error: unknown) => {
      if (!(error instanceof AggregateError) || error.errors.length !== 2) return false;
      assert.deepEqual(
        error.errors.map((failure) => (failure as Error).message),
        [
          "POSTGRES_INTEGRATION_CLEANUP_FAILED:schema_pool_close",
          "POSTGRES_INTEGRATION_CLEANUP_FAILED:admin_pool_close"
        ]
      );
      return true;
    }
  );
  assert.deepEqual(attempted, [
    "schema_pool_close",
    "schema_drop",
    "admin_pool_close",
    "temporary_directory_remove"
  ]);
});

type PostgresIntegrationCleanupStep = {
  readonly name: string;
  readonly run: () => Promise<void>;
};

const runPostgresIntegrationCleanup = async (
  steps: readonly PostgresIntegrationCleanupStep[]
) => {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(new Error(`POSTGRES_INTEGRATION_CLEANUP_FAILED:${step.name}`, {
        cause: error
      }));
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "POSTGRES_INTEGRATION_CLEANUP_FAILED");
  }
};

test("actual Neon PostgreSQL applies every migration twice and fences concurrent control-plane writers", {
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

    assert.deepEqual(first.appliedVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(first.currentVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(first.latestVersion, 10);
    assert.deepEqual(second.appliedVersions, []);
    assert.deepEqual(second.currentVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(second.latestVersion, 10);
    assert.equal(verification.verificationPassed, true);
    assert.equal(verification.presentTableCount, 40);
    assert.equal(verification.presentIndexCount, 90);
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
    const marketDataRepository = new PostgresMarketDataRepository();
    const targetAsOf = "2026-07-15T20:00:00.000Z";
    const targetContext = (client: PoolClient) => ({
      transaction: client,
      operationId: "lane-target-integration",
      actorId: recoveryFence.ownerId,
      schedulerFence: recoveryFence
    });
    const laneTargets = [
      {
        strategyFamily: "equity" as const,
        expressionId: "equity:shares",
        preferredExpression: "shares",
        optionsStrategy: null
      },
      {
        strategyFamily: "standard_option" as const,
        expressionId: "option:SPY260815C00600000",
        preferredExpression: "long_call",
        optionsStrategy: {
          alternatives: ["shares"],
          rationale: ["standard option lane"],
          optionsCandidate: { symbol: "SPY260815C00600000" }
        }
      },
      {
        strategyFamily: "zero_dte_spy" as const,
        expressionId: "option:SPY260715C00600000",
        preferredExpression: "long_call",
        optionsStrategy: {
          alternatives: ["shares"],
          rationale: ["zero DTE SPY lane"],
          optionsCandidate: { symbol: "SPY260715C00600000" }
        }
      },
      {
        strategyFamily: "leaps" as const,
        expressionId: "option:SPY271217C00600000",
        preferredExpression: "long_call",
        optionsStrategy: {
          alternatives: ["shares"],
          rationale: ["LEAPS lane"],
          optionsCandidate: { symbol: "SPY271217C00600000" }
        }
      }
    ];
    phase = "lane_target_identity";
    await withPostgresTransaction(schemaPool, integrationConfig, async (client) => {
      const context = targetContext(client);
      await marketDataRepository.upsertUniverseSymbols([{
        symbol: "SPY",
        assetClass: "equity",
        source: "integration",
        enabled: true,
        observedAt: targetAsOf
      }], context);
      const result = await marketDataRepository.upsertTargetSnapshots(
        laneTargets.map((lane) => ({
          symbol: "SPY",
          asOf: targetAsOf,
          direction: "long" as const,
          horizon: "1d",
          entryReference: 600,
          upsideTarget: 612,
          downsideRisk: 594,
          stopLoss: 594,
          takeProfit: 612,
          confidence: 0.8,
          expectedReturn: 0.02,
          volatilityAdjustedScore: 1.2,
          riskProfile: "aggressive",
          rationale: ["lane target integration"],
          sourceFingerprint: `lane-target:${lane.strategyFamily}`,
          ...lane
        })),
        context
      );
      assert.deepEqual(result, { stored: 4 });
    });
    const targets = await schemaPool.query<{
      strategy_family: string;
      expression_id: string;
    }>(
      `SELECT strategy_family, expression_id
       FROM target_snapshots
       WHERE symbol = 'SPY' AND as_of = $1 AND risk_profile = 'aggressive'
       ORDER BY strategy_family, expression_id`,
      [targetAsOf]
    );
    assert.deepEqual(targets.rows, [
      { strategy_family: "equity", expression_id: "equity:shares" },
      { strategy_family: "leaps", expression_id: "option:SPY271217C00600000" },
      { strategy_family: "standard_option", expression_id: "option:SPY260815C00600000" },
      { strategy_family: "zero_dte_spy", expression_id: "option:SPY260715C00600000" }
    ]);
    const optionStrategies = await schemaPool.query<{
      strategy_family: string;
      expression_id: string;
    }>(
      `SELECT strategy_family, expression_id
       FROM options_strategy_snapshots
       WHERE symbol = 'SPY' AND as_of = $1 AND risk_profile = 'aggressive'
       ORDER BY strategy_family, expression_id`,
      [targetAsOf]
    );
    assert.deepEqual(optionStrategies.rows, [
      { strategy_family: "leaps", expression_id: "option:SPY271217C00600000" },
      { strategy_family: "standard_option", expression_id: "option:SPY260815C00600000" },
      { strategy_family: "zero_dte_spy", expression_id: "option:SPY260715C00600000" }
    ]);
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
    const cleanupFailure = await runPostgresIntegrationCleanup([
      { name: "schema_pool_close", run: async () => { if (schemaPool) await schemaPool.end(); } },
      {
        name: "schema_drop",
        run: async () => { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      },
      { name: "admin_pool_close", run: async () => { await adminPool.end(); } }
    ]).then(() => null, (error: unknown) => error);
    if (cleanupFailure) {
      failureCode ||= sanitizeDatabaseError(cleanupFailure).code ||
        "POSTGRES_INTEGRATION_CLEANUP_FAILED";
    }
  }

  if (failureCode) throw new Error(`POSTGRES_INTEGRATION_TEST_FAILED:${failureCode}`);
});

test("actual Neon reconciles fixed-scale partial state without candidate updates", {
  skip: !enabled
}, async () => {
  const config = loadDatabaseConfig(
    {
      ...process.env,
      DATABASE_BACKEND: "postgres",
      POSTGRES_APPLICATION_NAME: "alpaca-paper-neon-reconciliation-test"
    },
    { runtime: "test", purpose: "migration" }
  );
  const schema = `neon_release3_reconcile_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "neon-release3-reconcile-"));
  const sourcePath = join(directory, "source.db");
  const adminPool = createPostgresPool(config, "direct");
  let schemaPool: Pool | undefined;
  let failureCode: string | null = null;
  let phase = "create_source";

  try {
    createControlPlaneSnapshotFixture(sourcePath);
    const sqlite = new DatabaseSync(sourcePath);
    sqlite.exec(`
      UPDATE paper_trade_candidates
      SET score = 0.1234567890123,
          confidence = 0.7654321098765,
          estimated_max_loss = 12.345678905,
          estimated_max_profit = 23.456789015
      WHERE id = 'candidate-1'
    `);
    sqlite.close();
    const source = await readControlPlaneSnapshot(sourcePath);
    phase = "create_schema";
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaPool = createPostgresPool({ ...config, maxConnections: 2 }, "direct", {
      sessionOptions: `-c search_path=${schema}`
    });
    phase = "migrate_twice";
    assert.deepEqual((await runPostgresMigrations(schemaPool, config)).appliedVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual((await runPostgresMigrations(schemaPool, config)).appliedVersions, []);

    phase = "seed_partial_state";
    await backfillControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config,
      batchSize: 1
    });
    await schemaPool.query("DELETE FROM candidate_lifecycle_events");
    await schemaPool.query(
      `INSERT INTO reconciliation_checkpoints(
         id, workstream, checkpoint_key, source_name, target_name, status,
         source_checksum, source_row_count, target_row_count, discrepancy_count,
         cursor_value, source_aggregates, target_aggregates, discrepancy_report,
         started_at, completed_at, created_at, updated_at
       ) VALUES (
         'historical-blocked', 'control_plane', 'historical-blocked',
         'sqlite_snapshot', 'postgres_control_plane', 'blocked', $1, 2, 1, 1,
         '{"mappingVersion":1}'::jsonb, '{}'::jsonb, '{}'::jsonb,
         '{"category":"historical"}'::jsonb, statement_timestamp(),
         statement_timestamp(), statement_timestamp(), statement_timestamp()
       )`,
      [source.inspection.sha256]
    );
    const blockedBefore = await schemaPool.query(
      `SELECT status, source_checksum, source_row_count::text, target_row_count::text,
              discrepancy_count::text, cursor_value, source_aggregates,
              target_aggregates, discrepancy_report, version::text,
              created_at::text, updated_at::text
       FROM reconciliation_checkpoints WHERE id = 'historical-blocked'`
    );
    const candidateBefore = await schemaPool.query<{ xmin: string; score: string }>(
      `SELECT xmin::text AS xmin, score::text AS score
       FROM candidates WHERE id = 'candidate-1'`
    );

    phase = "service_resume_backfill";
    const resumed = await backfillControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    assert.deepEqual(resumed.insertedRows, {
      researchRuns: 0,
      candidates: 0,
      candidateLifecycleEvents: 3
    });
    phase = "service_backfill_replay";
    const replayedBackfill = await backfillControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    assert.deepEqual(replayedBackfill.insertedRows, {
      researchRuns: 0,
      candidates: 0,
      candidateLifecycleEvents: 0
    });

    phase = "service_reconcile_dry_run";
    const dryRun = await reconcileControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config,
      dryRun: true
    });
    assert.equal(dryRun.status, "passed");
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.mutationCount, 0);
    assert.equal(dryRun.candidateMutationCount, 0);
    assert.deepEqual(dryRun.candidateNumericClassification, {
      rowsExamined: 2,
      exactBeforeNormalization: 1,
      normalizedEquivalent: 1,
      overflow: 0,
      invalidNumeric: 0,
      unexplainedMismatch: 0
    });
    assert.equal((await schemaPool.query(
      "SELECT COUNT(*)::text AS count FROM reconciliation_checkpoints"
    )).rows[0]?.count, "1");

    phase = "service_reconcile_commit";
    const reconciliation = await reconcileControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    assert.equal(reconciliation.status, "passed");
    assert.equal(reconciliation.candidateMutationCount, 0);
    assert.equal(reconciliation.checkpointMutationCount, 1);
    assert.equal(typeof reconciliation.checkpointId, "string");
    const durable = await schemaPool.query<{
      status: string;
      source_checksum: string | null;
      discrepancy_count: string;
      cursor_value: Record<string, unknown>;
      source_aggregates: Record<string, unknown>;
      target_aggregates: Record<string, unknown>;
      discrepancy_report: Record<string, unknown>;
      completed_at: Date | string | null;
    }>(
      `SELECT status, source_checksum, discrepancy_count::text AS discrepancy_count,
              cursor_value, source_aggregates, target_aggregates,
              discrepancy_report, completed_at
       FROM reconciliation_checkpoints WHERE id = $1`,
      [reconciliation.checkpointId]
    );
    assert.equal(
      assertDurableControlPlaneCheckpoint(durable.rows[0], reconciliation),
      true
    );
    assert.equal(durable.rows[0]?.status, "passed");
    assert.equal(durable.rows[0]?.source_checksum, source.inspection.sha256);
    assert.equal(Number(durable.rows[0]?.discrepancy_count), 0);
    assert.deepEqual(durable.rows[0]?.cursor_value, {
      snapshotSha256: source.inspection.sha256,
      postgresMigrationVersion: 2,
      mappingVersion: 2
    });
    assert.equal(durable.rows[0]?.source_aggregates.candidates, 2);
    assert.equal(durable.rows[0]?.source_aggregates.deferredLifecycleEvents, 1);
    assert.equal(durable.rows[0]?.target_aggregates.candidates, 2);
    assert.deepEqual(durable.rows[0]?.discrepancy_report, { discrepancyIds: [] });
    assert.ok(durable.rows[0]?.completed_at);

    phase = "service_reconcile_replay";
    const replay = await reconcileControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    assert.equal(replay.status, "passed");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);
    assert.equal(replay.candidateMutationCount, 0);
    assert.equal(assertDurableControlPlaneCheckpoint(durable.rows[0], replay), true);

    const candidateAfter = await schemaPool.query<{ xmin: string; score: string }>(
      `SELECT xmin::text AS xmin, score::text AS score
       FROM candidates WHERE id = 'candidate-1'`
    );
    const blockedAfter = await schemaPool.query(
      `SELECT status, source_checksum, source_row_count::text, target_row_count::text,
              discrepancy_count::text, cursor_value, source_aggregates,
              target_aggregates, discrepancy_report, version::text,
              created_at::text, updated_at::text
       FROM reconciliation_checkpoints WHERE id = 'historical-blocked'`
    );
    assert.deepEqual(candidateAfter.rows, candidateBefore.rows);
    assert.deepEqual(blockedAfter.rows, blockedBefore.rows);
    assert.equal((await schemaPool.query(
      "SELECT COUNT(*)::text AS count FROM reconciliation_checkpoints"
    )).rows[0]?.count, "2");

    phase = "seed_unexplained_numeric_fixture";
    await schemaPool.query(
      "UPDATE candidates SET score = score + 0.0000000001 WHERE id = 'candidate-1'"
    );
    phase = "unexplained_numeric_mismatch";
    const mismatch = await reconcileControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config,
      dryRun: true
    });
    assert.equal(mismatch.status, "blocked");
    assert.equal(mismatch.dryRun, true);
    assert.equal(mismatch.mutationCount, 0);
    assert.equal(mismatch.candidateMutationCount, 0);
    assert.equal(mismatch.candidateNumericClassification.unexplainedMismatch, 1);
    assert.equal(mismatch.discrepancyCount, 1);
    assert.deepEqual(
      mismatch.discrepancies.map((row) => `${row.domain}:${row.discrepancyType}`),
      ["candidates:CANDIDATE_NUMERIC_MISMATCH"]
    );

    phase = "concurrent_checkpoint_creation";
    const concurrentObservedAt = "2026-07-15T22:00:00.000Z";
    const concurrent = await Promise.all([
      reconcileControlPlaneSnapshot({
        snapshotPath: sourcePath,
        pool: schemaPool,
        config,
        checkpointId: "concurrent-blocked",
        observedAt: concurrentObservedAt
      }),
      reconcileControlPlaneSnapshot({
        snapshotPath: sourcePath,
        pool: schemaPool,
        config,
        checkpointId: "concurrent-blocked",
        observedAt: concurrentObservedAt
      })
    ]);
    assert.deepEqual(concurrent.map((result) => result.status), ["blocked", "blocked"]);
    assert.deepEqual(
      concurrent.map((result) => result.mutationCount).sort((left, right) => left - right),
      [0, 2]
    );
    assert.deepEqual(
      concurrent.map((result) => result.idempotentReplay).sort(),
      [false, true]
    );
    assert.ok(concurrent.every((result) => result.candidateMutationCount === 0));
  } catch (error) {
    const safe = sanitizeDatabaseError(error);
    failureCode = `${phase}:${safe.code || "POSTGRES_RECONCILIATION_TEST_FAILED"}`;
  } finally {
    const cleanupFailure = await runPostgresIntegrationCleanup([
      { name: "schema_pool_close", run: async () => { if (schemaPool) await schemaPool.end(); } },
      {
        name: "schema_drop",
        run: async () => { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      },
      { name: "admin_pool_close", run: async () => { await adminPool.end(); } },
      { name: "temporary_directory_remove", run: async () => { await rm(directory, { recursive: true, force: true }); } }
    ]).then(() => null, (error: unknown) => error);
    if (cleanupFailure) {
      failureCode ||= sanitizeDatabaseError(cleanupFailure).code ||
        "POSTGRES_INTEGRATION_CLEANUP_FAILED";
    }
  }

  if (failureCode) throw new Error(`POSTGRES_RECONCILIATION_TEST_FAILED:${failureCode}`);
});

test("actual Neon backfills and reconciles Release 4 execution state idempotently", {
  skip: !enabled
}, async () => {
  const config = loadDatabaseConfig(
    {
      ...process.env,
      DATABASE_BACKEND: "postgres",
      POSTGRES_APPLICATION_NAME: "alpaca-paper-neon-execution-state-test"
    },
    { runtime: "test", purpose: "migration" }
  );
  const schema = `neon_release4_execution_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "neon-release4-execution-"));
  const sourcePath = join(directory, "source.db");
  const adminPool = createPostgresPool(config, "direct");
  let schemaPool: Pool | undefined;
  let failureCode: string | null = null;
  let phase = "create_source";
  try {
    createExecutionStateSnapshotFixture(sourcePath);
    phase = "create_schema";
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaPool = createPostgresPool({ ...config, maxConnections: 2 }, "direct", {
      sessionOptions: `-c search_path=${schema}`
    });
    phase = "migrate_twice";
    assert.deepEqual((await runPostgresMigrations(schemaPool, config)).appliedVersions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual((await runPostgresMigrations(schemaPool, config)).appliedVersions, []);
    assert.deepEqual(
      (await schemaPool.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version"
      )).rows.map((row) => Number(row.version)),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    );
    phase = "seed_control_plane_candidate";
    await schemaPool.query(
      `INSERT INTO research_runs(
         id, workstream, run_key, status, risk_profile, options_enabled,
         config, started_at, completed_at, created_at, updated_at
       ) VALUES (
         'release-4-run', 'research', 'release-4-run', 'completed', 'aggressive',
         true, '{}'::jsonb, '2026-07-16T15:00:00Z', '2026-07-16T15:30:00Z',
         '2026-07-16T15:00:00Z', '2026-07-16T15:30:00Z'
       )`
    );
    await schemaPool.query(
      `INSERT INTO candidates(
         id, decision_id, research_run_id, candidate_key, symbol, asset_class,
         as_of, rank, direction, horizon, risk_profile, preferred_expression,
         score, confidence, decision, lifecycle_status, rationale, signal_inputs,
         data_quality_status, source_candidate_id, created_at, updated_at
       ) VALUES (
         $1, '11111111-1111-4111-8111-111111111111', 'release-4-run', $1,
         'SPY', 'equity', '2026-07-16T15:30:00Z', 1, 'long', 'day',
         'aggressive', 'equity', 0.9, 0.8, 'selected', 'selected', '[]'::jsonb,
         '{}'::jsonb, 'COMPLETE', $1, '2026-07-16T15:30:00Z',
         '2026-07-16T15:30:00Z'
       )`,
      [executionStateCandidateId]
    );
    phase = "service_backfill";
    const firstBackfill = await backfillExecutionStateSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    assert.equal(firstBackfill.status, "completed");
    const durableBatchCheckpoints = await schemaPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reconciliation_checkpoints
       WHERE workstream = 'execution_state_backfill'
         AND status = 'passed'
         AND source_checksum = $1
         AND cursor_value->>'mappingVersion' = $2`,
      [firstBackfill.snapshotSha256, firstBackfill.mappingVersion]
    );
    assert.ok(Number(durableBatchCheckpoints.rows[0]?.count) >= firstBackfill.batchCount);
    assert.ok(firstBackfill.rowMutationCount > 0);
    const orderBeforeReplay = await schemaPool.query<{ xmin: string }>(
      "SELECT xmin::text AS xmin FROM orders"
    );
    phase = "service_backfill_replay";
    const secondBackfill = await backfillExecutionStateSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    phase = "assert_backfill_replay";
    assert.equal(secondBackfill.rowMutationCount, 0);
    assert.equal(secondBackfill.checkpointMutationCount, 0);
    assert.equal(secondBackfill.mutationCount, 0);
    assert.equal(secondBackfill.idempotentReplay, true);
    assert.deepEqual(
      (await schemaPool.query<{ xmin: string }>(
        "SELECT xmin::text AS xmin FROM orders"
      )).rows,
      orderBeforeReplay.rows
    );
    phase = "service_reconcile_dry_run";
    const dryRun = await reconcileExecutionStateSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config,
      dryRun: true
    });
    assert.equal(dryRun.status, "passed");
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.rowMutationCount, 0);
    assert.equal(dryRun.mutationCount, 0);
    assert.equal(dryRun.discrepancyCount, 0);
    assert.equal(dryRun.duplicateCount, 0);
    assert.equal(dryRun.orphanCount, 0);
    phase = "service_reconcile";
    const reconciliation = await reconcileExecutionStateSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    assert.equal(reconciliation.status, "passed");
    assert.equal(reconciliation.rowMutationCount, 0);
    assert.equal(reconciliation.checkpointMutationCount, 1);
    const checkpointId = reconciliation.checkpointId;
    const durable = await schemaPool.query<{
      status: string;
      source_checksum: string | null;
      discrepancy_count: string;
      cursor_value: Record<string, unknown>;
      source_aggregates: Record<string, unknown>;
      target_aggregates: Record<string, unknown>;
      discrepancy_report: Record<string, unknown>;
      completed_at: Date | string | null;
    }>(
      `SELECT status, source_checksum, discrepancy_count::text AS discrepancy_count,
              cursor_value, source_aggregates, target_aggregates,
              discrepancy_report, completed_at
       FROM reconciliation_checkpoints WHERE id = $1`,
      [checkpointId]
    );
    assert.equal(
      assertDurableExecutionStateCheckpoint(durable.rows[0], reconciliation),
      true
    );
    assert.equal(durable.rows[0]?.status, "passed");
    assert.equal(durable.rows[0]?.discrepancy_count, "0");
    assert.equal(durable.rows[0]?.cursor_value.postgresMigrationVersion, 2);
    assert.equal(durable.rows[0]?.cursor_value.mappingVersion, "release-4-v1");
    phase = "service_reconcile_replay";
    const replay = await reconcileExecutionStateSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config
    });
    assert.equal(replay.status, "passed");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);
    assert.equal(assertDurableExecutionStateCheckpoint(durable.rows[0], replay), true);
    phase = "unexplained_target_mismatch";
    await schemaPool.query("UPDATE orders SET symbol = 'QQQ'");
    const mismatch = await reconcileExecutionStateSnapshot({
      snapshotPath: sourcePath,
      pool: schemaPool,
      config,
      dryRun: true
    });
    assert.equal(mismatch.status, "blocked");
    assert.equal(mismatch.rowMutationCount, 0);
    assert.equal(mismatch.tableComparisons.orders.mismatch, 1);
    assert.equal(mismatch.discrepancyCategories["orders:MISMATCH"], 1);
  } catch (error) {
    const safe = sanitizeDatabaseError(error);
    failureCode = `${phase}:${safe.code || "POSTGRES_EXECUTION_STATE_TEST_FAILED"}`;
  } finally {
    const cleanupFailure = await runPostgresIntegrationCleanup([
      { name: "schema_pool_close", run: async () => { if (schemaPool) await schemaPool.end(); } },
      {
        name: "schema_drop",
        run: async () => { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      },
      { name: "admin_pool_close", run: async () => { await adminPool.end(); } },
      { name: "temporary_directory_remove", run: async () => { await rm(directory, { recursive: true, force: true }); } }
    ]).then(() => null, (error: unknown) => error);
    if (cleanupFailure) {
      failureCode ||= sanitizeDatabaseError(cleanupFailure).code ||
        "POSTGRES_INTEGRATION_CLEANUP_FAILED";
    }
  }
  if (failureCode) throw new Error(`POSTGRES_EXECUTION_STATE_TEST_FAILED:${failureCode}`);
});
