import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import {
  runAutonomousPostgresCommand,
  runAutonomousPostgresRecovery,
  type AutonomousPostgresQueryExecutor
} from "../src/services/autonomousPostgresCommandService.js";
import { loadDatabaseConfig } from "../src/lib/database/config.js";
import { createPostgresPool } from "../src/lib/database/postgres.js";
import { runPostgresMigrations } from "../src/lib/database/postgresMigrations.js";

const completeEvidence = {
  account_count: "1",
  snapshot_count: "1",
  risk_limit_count: "1",
  allocation_count: "1",
  exposure_count: "1",
  active_reservation_count: "0",
  pending_intent_count: "0",
  open_order_count: "0",
  open_position_count: "2",
  completed_research_count: "1",
  eligible_candidate_count: "0",
  valid_review_count: "0",
  reconciliable_order_count: "0"
};

const executor = (row: Record<string, unknown>, calls: string[] = []): AutonomousPostgresQueryExecutor => ({
  query: async (sql: string) => {
    calls.push(sql);
    return { rows: [row], rowCount: 1 };
  }
});

test("research performs a PostgreSQL evidence evaluation and returns a legitimate no-trade result", async () => {
  const calls: string[] = [];
  const result = await runAutonomousPostgresCommand({
    command: "research:daily",
    query: executor(completeEvidence, calls),
    fence: {
      jobName: "research",
      workstream: "research",
      ownerId: "owner",
      runId: "run",
      fencingToken: "4"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });
  assert.equal(result.status, "no_op");
  assert.equal(result.code, "NO_ELIGIBLE_POSTGRES_CANDIDATES");
  assert.equal(result.evidence.completedResearchCount, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /FROM accounts/);
  assert.match(calls[0]!, /FROM candidates/);
});

test("every command fails closed when current PostgreSQL authority evidence is incomplete", async () => {
  await assert.rejects(
    runAutonomousPostgresCommand({
      command: "paper:review",
      query: executor({ ...completeEvidence, risk_limit_count: "0" }),
      fence: {
        jobName: "allocation",
        workstream: "allocation",
        ownerId: "owner",
        runId: "run",
        fencingToken: "8"
      }
    }),
    /POSTGRES_RISK_LIMIT_EVIDENCE_MISSING/
  );
});

test("system recovery performs bounded fenced PostgreSQL recovery before evaluating evidence", async () => {
  const calls: string[] = [];
  const query: AutonomousPostgresQueryExecutor = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("UPDATE research_runs")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE buying_power_reservations")) return { rows: [], rowCount: 2 };
      if (sql.includes("UPDATE execution_reviews")) return { rows: [], rowCount: 3 };
      if (sql.includes("UPDATE confirmation_evidence")) return { rows: [], rowCount: 4 };
      if (sql.includes("UPDATE order_intents")) return { rows: [], rowCount: 5 };
      return { rows: [completeEvidence], rowCount: 1 };
    }
  };
  const result = await runAutonomousPostgresCommand({
    command: "system:recover",
    query,
    fence: {
      jobName: "autonomous-recovery",
      workstream: "autonomous_recovery",
      ownerId: "owner",
      runId: "run",
      fencingToken: "9"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.recovery, {
    researchRuns: 1,
    reservations: 2,
    reviews: 3,
    confirmations: 4,
    intents: 5
  });
  assert.equal(calls.length, 6);
  for (const sql of calls.slice(0, 5)) assert.match(sql, /scheduler_leases/);
});

test("system recovery cancels only provably stale created intents and fences allocation release", async () => {
  const calls: string[] = [];
  const query: AutonomousPostgresQueryExecutor = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("UPDATE research_runs")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE buying_power_reservations")) return { rows: [], rowCount: 2 };
      if (sql.includes("UPDATE execution_reviews")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE confirmation_evidence")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE order_intents")) return { rows: [], rowCount: 3 };
      return { rows: [completeEvidence], rowCount: 1 };
    }
  };

  const result = await runAutonomousPostgresCommand({
    command: "system:recover",
    query,
    fence: {
      jobName: "autonomous-recovery",
      workstream: "autonomous_recovery",
      ownerId: "owner",
      runId: "run",
      fencingToken: "10"
    },
    now: new Date("2026-07-20T22:00:00.000Z")
  });

  const reservationSql = calls.find((sql) => sql.includes("UPDATE buying_power_reservations"));
  const intentSql = calls.find((sql) => sql.includes("UPDATE order_intents"));
  assert.equal(result.recovery?.intents, 3);
  assert.match(reservationSql ?? "", /UPDATE strategy_allocations/);
  assert.match(reservationSql ?? "", /reserved_amount = GREATEST\(0, allocation\.reserved_amount - totals\.amount\)/);
  assert.match(reservationSql ?? "", /scheduler_leases/);
  assert.match(intentSql ?? "", /intent\.status = 'created'/);
  assert.match(intentSql ?? "", /review\.status IN \('expired', 'revoked', 'blocked'\)/);
  assert.match(intentSql ?? "", /review\.expires_at <= \$1/);
  assert.match(intentSql ?? "", /status = 'cancelled'/);
  assert.match(intentSql ?? "", /terminal_at = \$1/);
  assert.match(intentSql ?? "", /version = intent\.version \+ 1/);
  assert.match(intentSql ?? "", /encode\(sha256\(convert_to/);
  assert.match(intentSql ?? "", /concat_ws\('\|', intent\.id, intent\.lifecycle_fingerprint, 'cancelled', \$1::text\)/);
  assert.doesNotMatch(intentSql ?? "", /\bmd5\(/);
  assert.match(intentSql ?? "", /INSERT INTO lifecycle_fingerprints/);
  assert.match(intentSql ?? "", /order_intent_id, entity_type, entity_id/);
  assert.match(intentSql ?? "", /'order_intent'/);
  assert.match(intentSql ?? "", /'cancelled'/);
  assert.match(intentSql ?? "", /'sha256'/);
  assert.match(intentSql ?? "", /payload_version/);
  assert.match(intentSql ?? "", /reviewStatus/);
  assert.match(intentSql ?? "", /recoveryReason/);
  assert.match(intentSql ?? "", /captured_at, created_at/);
  assert.match(intentSql ?? "", /SELECT cancelled\.id\s+FROM cancelled\s+JOIN fingerprints/);
  assert.match(intentSql ?? "", /scheduler_leases/);
});

test("PostgreSQL recovery persists SHA-256 cancellation audit rows in an isolated schema", {
  skip: process.env.POSTGRES_INTEGRATION_TEST_ENABLED !== "true"
}, async () => {
  const config = loadDatabaseConfig(
    {
      ...process.env,
      DATABASE_BACKEND: "postgres",
      POSTGRES_APPLICATION_NAME: "alpaca-review-recovery-integration-test"
    },
    { runtime: "test", purpose: "migration" }
  );
  const schema = `review_recovery_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const adminPool = createPostgresPool(config, "direct");
  let schemaPool: Pool | undefined;
  const now = "2026-07-20T22:00:00.000Z";
  const createdAt = "2026-07-20T20:00:00.000Z";
  const liveExpiry = "2026-07-20T23:00:00.000Z";
  const staleExpiry = "2026-07-20T21:30:00.000Z";
  const fence = {
    jobName: "autonomous-recovery",
    workstream: "autonomous_recovery",
    ownerId: "integration-owner",
    runId: "integration-run",
    fencingToken: "77"
  };
  const priorFingerprint = "prior-created-fingerprint";

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaPool = createPostgresPool(config, "direct", {
      sessionOptions: `-c search_path=${schema}`
    });
    await runPostgresMigrations(schemaPool, config);
    await schemaPool.query(
      `INSERT INTO accounts(id, broker_account_id, environment, status, created_at, updated_at)
       VALUES ('account-recovery-test', 'broker-recovery-test', 'paper', 'active', $1, $1);
       INSERT INTO account_snapshots(
         id, account_id, observed_at, account_status, cash, portfolio_value,
         equity, buying_power, snapshot_fingerprint, created_at
       ) VALUES (
         'snapshot-recovery-test', 'account-recovery-test', $1, 'active',
         1000, 1000, 1000, 1000, 'snapshot-fingerprint', $1
       );
       INSERT INTO scheduler_leases(
         job_name, workstream, owner_id, run_id, fencing_token, status,
         acquired_at, heartbeat_at, expires_at, created_at, updated_at
       ) VALUES ('autonomous-recovery', 'autonomous_recovery', 'integration-owner',
         'integration-run', 77, 'held', $1, $1, $2, $1, $1);
       INSERT INTO strategy_allocations(
         id, account_id, strategy_key, status, allocation_amount, reserved_amount,
         deployed_amount, config_version, config_fingerprint, effective_from,
         created_at, updated_at
       ) VALUES (
         'allocation-recovery-test', 'account-recovery-test', 'baseline', 'active',
         1000, 50, 125, 'test-v1', 'allocation-fingerprint', $1, $1, $1
       );`,
      [createdAt, liveExpiry]
    );

    const insertReservation = async (id: string, amount: number, expiresAt: string) => {
      await schemaPool!.query(
        `INSERT INTO buying_power_reservations(
           id, account_id, strategy_key, symbol, asset_class, amount, status,
           idempotency_key, reservation_fingerprint, account_snapshot_id,
           expires_at, created_at, updated_at
         ) VALUES ($1, 'account-recovery-test', 'baseline', 'SPY', 'equity', $2,
           'active', $3, $4, 'snapshot-recovery-test', $5, $6, $6)`,
        [id, amount, `reservation-key-${id}`, `reservation-fingerprint-${id}`, expiresAt, createdAt]
      );
    };
    await insertReservation("reservation-expired", 30, staleExpiry);
    await insertReservation("reservation-live", 20, liveExpiry);

    const insertReview = async (id: string, status: string, expiresAt: string) => {
      await schemaPool!.query(
        `INSERT INTO execution_reviews(
           id, account_id, review_type, environment, paper_only,
           live_trading_enabled, status, client_order_id, account_fingerprint,
           configuration_fingerprint, payload_fingerprint, signature_algorithm,
           signature, order_intent, expires_at, created_at, updated_at
         ) VALUES ($1, 'account-recovery-test', 'entry', 'paper', true, false, $2,
           $3, 'account-fingerprint', $4, $5, 'hmac-sha256', 'signature',
           '{}'::jsonb, $6, $7, $7)`,
        [id, status, `client-${id}`, `config-${id}`, `payload-${id}`, expiresAt, createdAt]
      );
    };
    await insertReview("review-stale", "revoked", staleExpiry);
    await insertReview("review-current", "valid", liveExpiry);

    const insertIntent = async (id: string, reviewId: string, status: string, lifecycleFingerprint: string) => {
      await schemaPool!.query(
        `INSERT INTO order_intents(
           id, account_id, execution_review_id, environment, client_order_id,
           idempotency_key, strategy_key, symbol, asset_class, side, order_type,
           time_in_force, notional, status, intent_fingerprint,
           lifecycle_fingerprint, request_payload, created_at, updated_at
         ) VALUES ($1, 'account-recovery-test', $2, 'paper', $3, $4, 'baseline',
           'SPY', 'equity', 'buy', 'market', 'day', 100, $5, $6, $7,
           '{}'::jsonb, $8, $8)`,
        [id, reviewId, `intent-client-${id}`, `intent-key-${id}`, status,
          `intent-fingerprint-${id}`, lifecycleFingerprint, createdAt]
      );
    };
    await insertIntent("intent-stale", "review-stale", "created", priorFingerprint);
    await insertIntent("intent-current", "review-current", "created", "current-created-fingerprint");
    await insertIntent("intent-ready", "review-stale", "ready_for_submission", "ready-fingerprint");

    const result = await runAutonomousPostgresRecovery(schemaPool, fence, new Date(now));
    assert.equal(result.intents, 1);
    assert.equal(result.reservations, 1);

    const intents = await schemaPool.query(
      `SELECT id, status, terminal_at, version, lifecycle_fingerprint
       FROM order_intents ORDER BY id`
    );
    assert.deepEqual(
      intents.rows.map((row) => ({
        id: row.id,
        status: row.status,
        terminalAt: row.terminal_at,
        version: Number(row.version),
        lifecycleFingerprint: row.lifecycle_fingerprint
      })),
      [
        {
          id: "intent-current", status: "created", terminalAt: null, version: 1,
          lifecycleFingerprint: "current-created-fingerprint"
        },
        {
          id: "intent-ready", status: "ready_for_submission", terminalAt: null, version: 1,
          lifecycleFingerprint: "ready-fingerprint"
        },
        { id: "intent-stale", status: "cancelled", terminalAt: new Date(now), version: 2,
          lifecycleFingerprint: createHash("sha256").update(
            ["intent-stale", priorFingerprint, "cancelled", now].join("|"), "utf8"
          ).digest("hex") }
      ]
    );
    const staleIntent = intents.rows.find((row) => row.id === "intent-stale")!;
    assert.equal(new Date(staleIntent.terminal_at).toISOString(), now);

    const audits = await schemaPool.query(
      `SELECT entity_type, entity_id, order_intent_id, lifecycle_stage, fingerprint,
              algorithm, payload_version, evidence, captured_at, created_at
       FROM lifecycle_fingerprints WHERE order_intent_id = 'intent-stale'`
    );
    assert.equal(audits.rowCount, 1);
    const audit = audits.rows[0]!;
    assert.equal(audit.entity_type, "order_intent");
    assert.equal(audit.entity_id, "intent-stale");
    assert.equal(audit.order_intent_id, "intent-stale");
    assert.equal(audit.lifecycle_stage, "cancelled");
    assert.equal(audit.fingerprint, staleIntent.lifecycle_fingerprint);
    assert.equal(audit.algorithm, "sha256");
    assert.equal(audit.payload_version, 1);
    assert.deepEqual(audit.evidence, {
      executionReviewId: "review-stale",
      reviewStatus: "revoked",
      reviewExpiresAt: new Date(staleExpiry).toISOString(),
      recoveryReason: "STALE_CREATED_INTENT_RECOVERY"
    });
    assert.equal(new Date(audit.captured_at).toISOString(), now);
    assert.equal(new Date(audit.created_at).toISOString(), now);

    const allocation = await schemaPool.query(
      `SELECT reserved_amount::text, deployed_amount::text
       FROM strategy_allocations WHERE id = 'allocation-recovery-test'`
    );
    assert.equal(allocation.rows[0]?.reserved_amount, "20.00000000");
    assert.equal(allocation.rows[0]?.deployed_amount, "125.00000000");
    const reservations = await schemaPool.query(
      `SELECT id, status FROM buying_power_reservations ORDER BY id`
    );
    assert.deepEqual(reservations.rows, [
      { id: "reservation-expired", status: "expired" },
      { id: "reservation-live", status: "active" }
    ]);
  } finally {
    await schemaPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});
