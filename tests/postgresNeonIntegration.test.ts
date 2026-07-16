import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { PostgresResearchRunRepository } from "../src/repositories/postgres/postgresResearchRunRepository.js";
import { PostgresSchedulerLeaseRepository } from "../src/repositories/postgres/postgresSchedulerLeaseRepository.js";
import { createDecisionId } from "../src/services/marketDecisionIdentityService.js";
import {
  backfillControlPlaneSnapshot,
  reconcileControlPlaneSnapshot,
  readControlPlaneSnapshot
} from "../src/services/controlPlaneMigrationService.js";
import { createControlPlaneSnapshotFixture } from "./helpers/controlPlaneSnapshotFixture.js";

const enabled = process.env.POSTGRES_INTEGRATION_TEST_ENABLED === "true";

const runPackagedControlPlaneCommand = (input: {
  readonly command: "db:postgres:control-plane:backfill" | "db:postgres:control-plane:reconcile";
  readonly snapshotPath: string;
  readonly schema: string;
  readonly dryRun?: boolean;
}) => {
  const child = spawnSync(
    "npm",
    [
      "run",
      "--silent",
      input.command,
      "--",
      "--snapshot",
      input.snapshotPath,
      ...(input.dryRun ? ["--dryRun"] : [])
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PGOPTIONS: `-c search_path=${input.schema}`,
        DATABASE_BACKEND: "postgres",
        POSTGRES_READS_ENABLED: "false",
        POSTGRES_WRITES_ENABLED: "false",
        POSTGRES_SHADOW_COMPARE_ENABLED: "false",
        POSTGRES_CONTROL_PLANE_AUTHORITY_ENABLED: "false",
        POSTGRES_EXECUTION_STATE_AUTHORITY_ENABLED: "false",
        SQLITE_AUDIT_MIRROR_ENABLED: "false",
        ALPACA_ENV: "paper",
        TRADING_MODE: "paper",
        ALPACA_LIVE_TRADE: "false",
        LIVE_TRADING_ENABLED: "false"
      }
    }
  );
  if (child.error || child.status === null) {
    throw new Error("PACKAGED_CONTROL_PLANE_PROCESS_FAILED");
  }
  if (child.stderr !== "") {
    throw new Error("PACKAGED_CONTROL_PLANE_STDERR_NOT_EMPTY");
  }
  try {
    return {
      exitCode: child.status,
      report: JSON.parse(child.stdout) as Record<string, unknown>
    };
  } catch {
    throw new Error("PACKAGED_CONTROL_PLANE_REPORT_INVALID");
  }
};

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
    assert.deepEqual((await runPostgresMigrations(schemaPool, config)).appliedVersions, [1, 2]);
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

    phase = "packaged_resume_backfill";
    const resumed = runPackagedControlPlaneCommand({
      command: "db:postgres:control-plane:backfill",
      snapshotPath: sourcePath,
      schema
    });
    assert.equal(resumed.exitCode, 0);
    assert.deepEqual(resumed.report.insertedRows, {
      researchRuns: 0,
      candidates: 0,
      candidateLifecycleEvents: 3
    });
    phase = "packaged_backfill_replay";
    const replayedBackfill = runPackagedControlPlaneCommand({
      command: "db:postgres:control-plane:backfill",
      snapshotPath: sourcePath,
      schema
    });
    assert.equal(replayedBackfill.exitCode, 0);
    assert.deepEqual(replayedBackfill.report.insertedRows, {
      researchRuns: 0,
      candidates: 0,
      candidateLifecycleEvents: 0
    });
    assert.equal(replayedBackfill.report.mutationCount, 0);
    assert.equal(replayedBackfill.report.idempotentReplay, true);

    phase = "packaged_reconcile_dry_run";
    const dryRun = runPackagedControlPlaneCommand({
      command: "db:postgres:control-plane:reconcile",
      snapshotPath: sourcePath,
      schema,
      dryRun: true
    });
    assert.equal(dryRun.exitCode, 0);
    assert.equal(dryRun.report.status, "dry_run_passed");
    assert.equal(dryRun.report.mutationCount, 0);
    assert.equal(dryRun.report.candidateMutationCount, 0);
    assert.deepEqual(dryRun.report.candidateNumericClassification, {
      rowsExamined: 2,
      exactBeforeNormalization: 1,
      normalizedEquivalent: 1,
      overflow: 0,
      invalidNumeric: 0,
      unexplainedMismatch: 0
    });
    assert.equal(dryRun.report.durableCheckpointVerified, false);

    phase = "packaged_reconcile_commit";
    const reconciliation = runPackagedControlPlaneCommand({
      command: "db:postgres:control-plane:reconcile",
      snapshotPath: sourcePath,
      schema
    });
    assert.equal(reconciliation.exitCode, 0);
    assert.equal(reconciliation.report.status, "passed");
    assert.equal(reconciliation.report.candidateMutationCount, 0);
    assert.equal(reconciliation.report.checkpointMutationCount, 1);
    assert.equal(reconciliation.report.durableCheckpointVerified, true);
    assert.equal(typeof reconciliation.report.checkpointId, "string");
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
      [reconciliation.report.checkpointId]
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

    phase = "packaged_reconcile_replay";
    const replay = runPackagedControlPlaneCommand({
      command: "db:postgres:control-plane:reconcile",
      snapshotPath: sourcePath,
      schema
    });
    assert.equal(replay.exitCode, 0);
    assert.equal(replay.report.status, "passed");
    assert.equal(replay.report.idempotentReplay, true);
    assert.equal(replay.report.mutationCount, 0);
    assert.equal(replay.report.candidateMutationCount, 0);
    assert.equal(replay.report.durableCheckpointVerified, true);

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
    const mismatch = runPackagedControlPlaneCommand({
      command: "db:postgres:control-plane:reconcile",
      snapshotPath: sourcePath,
      schema,
      dryRun: true
    });
    assert.notEqual(mismatch.exitCode, 0);
    assert.equal(mismatch.report.status, "dry_run_blocked");
    assert.equal(mismatch.report.mutationCount, 0);
    assert.equal(mismatch.report.candidateMutationCount, 0);
    assert.equal(
      (mismatch.report.candidateNumericClassification as Record<string, unknown>)
        .unexplainedMismatch,
      1
    );
    assert.equal(mismatch.report.discrepancyCount, 1);
    assert.deepEqual(mismatch.report.discrepancyCategories, {
      "candidates:CANDIDATE_NUMERIC_MISMATCH": 1
    });
    assert.equal(mismatch.report.discrepancies, undefined);

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
    try {
      if (schemaPool) await schemaPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch (error) {
      failureCode ||= sanitizeDatabaseError(error).code || "POSTGRES_INTEGRATION_CLEANUP_FAILED";
    }
    await adminPool.end();
    await rm(directory, { recursive: true, force: true });
  }

  if (failureCode) throw new Error(`POSTGRES_RECONCILIATION_TEST_FAILED:${failureCode}`);
});
