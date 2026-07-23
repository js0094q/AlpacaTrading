import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Pool, PoolClient, QueryResult } from "pg";

import type { DatabaseConfig } from "../src/lib/database/config.js";
import {
  assertDurableControlPlaneCheckpoint,
  backfillControlPlaneSnapshot,
  canonicalizePostgresNumeric,
  createReadConsistentSqliteSnapshot,
  enableSqliteDefensiveModeIfSupported,
  mapSqliteCandidate,
  mapSqliteResearchRun,
  readControlPlaneSnapshot,
  reconcileControlPlaneSnapshot
} from "../src/services/controlPlaneMigrationService.js";
import { createControlPlaneSnapshotFixture } from "./helpers/controlPlaneSnapshotFixture.js";

test("completion requires a durable checkpoint with matching migration evidence", () => {
  const expected = {
    status: "passed",
    snapshotSha256: "a".repeat(64),
    discrepancyCount: 0,
    postgresMigrationVersion: 2,
    mappingVersion: 2,
    sourceAggregates: {
      researchRuns: 2,
      candidates: 2,
      candidateLifecycleEvents: 3,
      deferredLifecycleEvents: 1
    },
    targetAggregates: {
      researchRuns: 2,
      candidates: 2,
      candidateLifecycleEvents: 3
    },
    discrepancies: [],
    completedAt: "2026-07-15T13:00:00.000Z"
  };
  assert.throws(
    () => assertDurableControlPlaneCheckpoint(undefined, expected),
    /CONTROL_PLANE_DURABLE_CHECKPOINT_VERIFICATION_FAILED/
  );
  assert.throws(
    () => assertDurableControlPlaneCheckpoint({
      status: "passed",
      source_checksum: expected.snapshotSha256,
      discrepancy_count: 0,
      cursor_value: { postgresMigrationVersion: 2, mappingVersion: 1 },
      source_aggregates: expected.sourceAggregates,
      target_aggregates: expected.targetAggregates,
      discrepancy_report: { discrepancyIds: [] },
      completed_at: expected.completedAt
    }, expected),
    /CONTROL_PLANE_DURABLE_CHECKPOINT_VERIFICATION_FAILED/
  );
  const durableRow = {
    status: "passed",
    source_checksum: expected.snapshotSha256,
    discrepancy_count: 0,
    cursor_value: JSON.stringify({ mappingVersion: 2, postgresMigrationVersion: 2 }),
    source_aggregates: JSON.stringify(expected.sourceAggregates),
    target_aggregates: JSON.stringify(expected.targetAggregates),
    discrepancy_report: JSON.stringify({ discrepancyIds: [] }),
    completed_at: expected.completedAt
  };
  assert.equal(assertDurableControlPlaneCheckpoint(durableRow, expected), true);
  assert.throws(
    () => assertDurableControlPlaneCheckpoint({
      ...durableRow,
      target_aggregates: { ...expected.targetAggregates, candidates: 1 }
    }, expected),
    /CONTROL_PLANE_DURABLE_CHECKPOINT_VERIFICATION_FAILED/
  );
  assert.throws(
    () => assertDurableControlPlaneCheckpoint({ ...durableRow, completed_at: null }, expected),
    /CONTROL_PLANE_DURABLE_CHECKPOINT_VERIFICATION_FAILED/
  );
  assert.throws(
    () => assertDurableControlPlaneCheckpoint({
      ...durableRow,
      discrepancy_report: { discrepancyIds: ["stale-discrepancy"] }
    }, expected),
    /CONTROL_PLANE_DURABLE_CHECKPOINT_VERIFICATION_FAILED/
  );
});

test("canonicalizes fixed-scale PostgreSQL numerics without floating-point equality", () => {
  assert.equal(canonicalizePostgresNumeric("123.45678901234", 24, 10), "123.4567890123");
  assert.equal(canonicalizePostgresNumeric("1.23456789015", 24, 10), "1.2345678902");
  assert.equal(canonicalizePostgresNumeric("-1.23456789015", 24, 10), "-1.2345678902");
  assert.equal(canonicalizePostgresNumeric("8e-3", 12, 10), "0.0080000000");
  assert.equal(canonicalizePostgresNumeric(null, 24, 10), null);
});

test("normalizes negative zero and rejects overflow and non-finite numerics", () => {
  assert.equal(canonicalizePostgresNumeric("-0.00000000001", 24, 10), "0.0000000000");
  assert.throws(
    () => canonicalizePostgresNumeric("10", 3, 2),
    /POSTGRES_NUMERIC_OVERFLOW/
  );
  assert.throws(
    () => canonicalizePostgresNumeric(Number.NaN, 24, 10),
    /POSTGRES_NUMERIC_NONFINITE/
  );
  assert.throws(
    () => canonicalizePostgresNumeric(Number.POSITIVE_INFINITY, 24, 10),
    /POSTGRES_NUMERIC_NONFINITE/
  );
});

test("SQLite defensive mode is optional on the Node 22 runtime", () => {
  assert.equal(enableSqliteDefensiveModeIfSupported({}), false);
  let enabled = false;
  assert.equal(
    enableSqliteDefensiveModeIfSupported({
      enableDefensive: (value) => {
        enabled = value;
      }
    }),
    true
  );
  assert.equal(enabled, true);
});

const migrationPath = new URL(
  "../src/lib/database/migrations/002_control_plane_authority.sql",
  import.meta.url
);

test("migration 002 adds Release 3 snapshot and reconciliation schema", async () => {
  const sql = await readFile(migrationPath, "utf8");

  assert.match(sql, /ALTER TABLE candidates\s+ADD COLUMN decision_id text/i);
  assert.match(sql, /ALTER TABLE candidates\s+ADD COLUMN decision_id text NOT NULL/i);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX candidates_decision_id_idx\s+ON candidates \(decision_id\)/i
  );
  assert.doesNotMatch(sql, /candidates_decision_id_idx[\s\S]*WHERE decision_id IS NOT NULL/i);
  assert.match(
    sql,
    /ALTER TABLE workstream_events[\s\S]*ADD COLUMN processing_started_at timestamptz[\s\S]*ADD COLUMN attempts integer NOT NULL DEFAULT 0/i
  );
  assert.match(sql, /CHECK \(attempts >= 0\)/i);
  assert.match(sql, /workstream_events_processing_started_required/i);
  assert.match(sql, /workstream_events_stale_processing_idx/i);
  assert.match(sql, /CREATE TABLE reconciliation_discrepancies/i);
  assert.match(sql, /CREATE TABLE reconciliation_discrepancies \(\s*id text PRIMARY KEY/i);
  assert.doesNotMatch(sql, /discrepancy_id text PRIMARY KEY/i);
  assert.match(
    sql,
    /checkpoint_id text NOT NULL REFERENCES reconciliation_checkpoints\(id\)/i
  );
  assert.match(sql, /expected jsonb/);
  assert.match(sql, /actual jsonb/);
  assert.match(sql, /reconciliation_discrepancies_checkpoint_idx/);
  assert.match(sql, /reconciliation_discrepancies_domain_idx/);
  assert.match(
    sql,
    /ALTER TABLE scheduler_leases\s+DROP CONSTRAINT scheduler_leases_timestamp_order/i
  );
  assert.match(
    sql,
    /ADD CONSTRAINT scheduler_leases_timestamp_order CHECK \([\s\S]*expires_at > heartbeat_at/i
  );
});

const migrationConfig: DatabaseConfig = {
  backend: "postgres",
  runtime: "test",
  purpose: "migration",
  directUrl: "postgresql://synthetic:synthetic@host.invalid/db",
  directVariable: "DATABASE_URL_UNPOOLED",
  sslRequired: true,
  applicationName: "control-plane-migration-test",
  maxConnections: 1,
  minConnections: 0,
  idleTimeoutMs: 1_000,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 120_000,
  lockTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 60_000,
  transactionTimeoutMs: 180_000,
  features: {
    postgresReads: false,
    postgresWrites: false,
    shadowComparison: false,
    controlPlaneAuthority: false,
    schedulerAuthority: false,
    executionStateShadow: false,
    executionStateAuthority: false,
    sqliteAuditMirror: false
  }
};

const createBackfillSource = createControlPlaneSnapshotFixture;

const fakeBackfillPool = () => {
  const rows = {
    research_runs: new Map<string, readonly unknown[]>(),
    candidates: new Map<string, readonly unknown[]>(),
    candidate_lifecycle_events: new Map<string, readonly unknown[]>()
  };
  const insertionOrder: string[] = [];
  const transactionSizes: number[] = [];
  let currentTransactionSize: number | null = null;
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      if (text === "BEGIN") currentTransactionSize = 0;
      if (text === "COMMIT") {
        transactionSizes.push(currentTransactionSize ?? 0);
        currentTransactionSize = null;
      }
      const comparison = /AS matches\s+FROM (research_runs|candidates|candidate_lifecycle_events)/.exec(
        text
      );
      if (comparison) {
        const table = comparison[1] as keyof typeof rows;
        const stored = rows[table].get(String(values?.[0]));
        return {
          rows: [
            {
              matches:
                stored !== undefined &&
                JSON.stringify(stored) === JSON.stringify([...(values || [])])
            }
          ],
          rowCount: stored ? 1 : 0
        } as unknown as QueryResult;
      }
      const match = /^INSERT INTO (research_runs|candidates|candidate_lifecycle_events)/.exec(
        text.trim()
      );
      if (!match) return { rows: [], rowCount: 0 } as unknown as QueryResult;
      const table = match[1] as keyof typeof rows;
      const id = String(values?.[0]);
      currentTransactionSize = (currentTransactionSize ?? 0) + 1;
      insertionOrder.push(table);
      if (rows[table].has(id)) return { rows: [], rowCount: 0 } as unknown as QueryResult;
      rows[table].set(id, [...(values || [])]);
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    },
    release: () => undefined
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, rows, insertionOrder, transactionSizes };
};

test("backfills normalized candidates once and rejects unexplained replay conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-backfill-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      UPDATE paper_trade_candidates
      SET score = 0.1234567890123,
          confidence = 0.7654321098765,
          estimated_max_loss = 12.345678905,
          estimated_max_profit = 23.456789015
      WHERE id = 'candidate-1';
    `);
    source.close();
    const fake = fakeBackfillPool();

    const first = await backfillControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1
    });
    const second = await backfillControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: fake.pool,
      config: migrationConfig,
      batchSize: 1
    });

    assert.deepEqual(first.sourceRows, {
      researchRuns: 2,
      candidates: 2,
      candidateLifecycleEvents: 3,
      deferredLifecycleEvents: 1
    });
    assert.deepEqual(first.insertedRows, {
      researchRuns: 2,
      candidates: 2,
      candidateLifecycleEvents: 3
    });
    assert.deepEqual(second.insertedRows, {
      researchRuns: 0,
      candidates: 0,
      candidateLifecycleEvents: 0
    });
    assert.equal(fake.rows.research_runs.size, 2);
    assert.equal(fake.rows.candidates.size, 2);
    assert.equal(fake.rows.candidate_lifecycle_events.size, 3);
    const normalizedCandidate = fake.rows.candidates.get("candidate-1")!;
    assert.equal(normalizedCandidate[15], "0.1234567890");
    assert.equal(normalizedCandidate[16], "0.7654321099");
    assert.equal(normalizedCandidate[18], "12.34567891");
    assert.equal(normalizedCandidate[19], "23.45678902");
    assert.deepEqual(fake.insertionOrder.slice(0, 7), [
      "research_runs",
      "research_runs",
      "candidates",
      "candidates",
      "candidate_lifecycle_events",
      "candidate_lifecycle_events",
      "candidate_lifecycle_events"
    ]);
    assert.ok(fake.transactionSizes.every((size) => size <= 1));

    const conflictingCandidate = [...normalizedCandidate];
    conflictingCandidate[15] = "0.1234567891";
    fake.rows.candidates.set("candidate-1", conflictingCandidate);
    await assert.rejects(
      () =>
        backfillControlPlaneSnapshot({
          snapshotPath: sourcePath,
          pool: fake.pool,
          config: migrationConfig,
          batchSize: 1
        }),
      (error) => error instanceof Error && error.message === "CONTROL_PLANE_BACKFILL_CONFLICT:candidates"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps exact candidate lifecycle events and reports non-candidate events as deferred", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-events-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const snapshot = await readControlPlaneSnapshot(sourcePath);

    assert.deepEqual(
      snapshot.candidateLifecycleEvents.map((event) => event.eventId),
      ["event-1a", "event-1b", "event-2a"]
    );
    assert.deepEqual(
      snapshot.candidateLifecycleEvents
        .filter((event) => event.candidateId === "candidate-1")
        .map((event) => ({
          sequence: event.sequenceNumber,
          priorStatus: event.priorStatus,
          status: event.status,
          eventType: event.eventType,
          idempotencyKey: event.idempotencyKey,
          sourceEventId: event.sourceEventId,
          requestId: event.requestId,
          correlationId: event.correlationId,
          reasonCodes: event.reasonCodes,
          evidence: event.evidence,
          occurredAt: event.occurredAt
        })),
      [
        {
          sequence: 0,
          priorStatus: null,
          status: "selected",
          eventType: "decision.lifecycle.selected",
          idempotencyKey: "sqlite:decision_lifecycle_events:event-1a",
          sourceEventId: "event-1a",
          requestId: "request-1",
          correlationId: "correlation-1",
          reasonCodes: [],
          evidence: { sourceType: "candidate", sourceId: "candidate-1" },
          occurredAt: "2026-07-15T12:11:00.000Z"
        },
        {
          sequence: 1,
          priorStatus: "selected",
          status: "reviewed",
          eventType: "decision.lifecycle.reviewed",
          idempotencyKey: "sqlite:decision_lifecycle_events:event-1b",
          sourceEventId: "event-1b",
          requestId: "request-1",
          correlationId: "correlation-1",
          reasonCodes: ["REVIEW_APPROVED"],
          evidence: { sourceType: "review", sourceId: "review-1", approved: true },
          occurredAt: "2026-07-15T12:12:00.000Z"
        }
      ]
    );
    assert.equal(snapshot.deferredLifecycleEvents.length, 1);
    assert.equal(
      snapshot.candidates.find((candidate) => candidate.id === "candidate-1")?.lifecycleStatus,
      "reviewed"
    );
    assert.deepEqual(snapshot.deferredLifecycleEvents[0], {
      eventId: "event-release-4",
      decisionId: "decision-release-4",
      status: "open",
      sourceType: "position",
      sourceId: "position-release-4"
    });
    assert.deepEqual(snapshot.sourceIssues, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps production decision snapshots without optional request provenance columns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-production-schema-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      ALTER TABLE decision_snapshots DROP COLUMN request_id;
      ALTER TABLE decision_snapshots DROP COLUMN correlation_id;
    `);
    source.close();

    const snapshot = await readControlPlaneSnapshot(sourcePath);
    assert.equal(snapshot.sourceIssues.length, 0);
    assert.equal(snapshot.candidates.length, 2);
    assert.equal(snapshot.candidateLifecycleEvents.length, 3);
    assert.equal(snapshot.candidateLifecycleEvents[0]?.requestId, "request-1");
    assert.equal(snapshot.candidateLifecycleEvents[0]?.correlationId, "correlation-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts deterministic exact legacy candidate identity without a decision snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-legacy-candidate-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      DELETE FROM decision_lifecycle_events WHERE decision_id = 'decision-1';
      DELETE FROM decision_snapshots WHERE decision_id = 'decision-1';
      UPDATE paper_trade_candidates
      SET decision_id = id,
          decision_linkage_status = 'EXACT_LEGACY_REUSE'
      WHERE id = 'candidate-1';
    `);
    source.close();

    const snapshot = await readControlPlaneSnapshot(sourcePath);
    assert.deepEqual(snapshot.sourceIssues, []);
    assert.equal(snapshot.candidates[0]?.decisionId, "candidate-1");
    assert.equal(snapshot.candidates[0]?.lifecycleStatus, "selected");
    assert.deepEqual(
      snapshot.candidateLifecycleEvents.map((event) => event.eventId),
      ["event-2a"]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("defers paper review lifecycle history whose candidate row is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-orphan-review-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      INSERT INTO decision_snapshots(
        decision_id, origin_type, decision_role, candidate_id, position_lifecycle_id
      ) VALUES (
        'decision-orphan-review', 'paper_review_artifact', 'entry',
        'candidate-no-longer-present', NULL
      );
      INSERT INTO decision_lifecycle_events(
        event_id, decision_id, status, reason_codes_json, occurred_at,
        source_type, source_id, evidence_json
      ) VALUES (
        'event-orphan-review', 'decision-orphan-review', 'REVIEWED', '[]',
        '2026-07-15T12:15:00.000Z', 'paper_review_artifact',
        'review-orphan', '{}'
      );
    `);
    source.close();

    const snapshot = await readControlPlaneSnapshot(sourcePath);
    assert.deepEqual(snapshot.sourceIssues, []);
    assert.equal(
      snapshot.candidateLifecycleEvents.some(
        (event) => event.eventId === "event-orphan-review"
      ),
      false
    );
    assert.deepEqual(snapshot.deferredLifecycleEvents.at(-1), {
      eventId: "event-orphan-review",
      decisionId: "decision-orphan-review",
      status: "reviewed",
      sourceType: "paper_review_artifact",
      sourceId: "review-orphan"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps non-legacy missing snapshots and unexpected orphan origins blocking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-strict-linkage-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      DELETE FROM decision_lifecycle_events WHERE decision_id = 'decision-1';
      DELETE FROM decision_snapshots WHERE decision_id = 'decision-1';
      UPDATE paper_trade_candidates
      SET decision_id = id,
          decision_linkage_status = 'EXACT'
      WHERE id = 'candidate-1';
      INSERT INTO decision_snapshots(
        decision_id, origin_type, decision_role, candidate_id, position_lifecycle_id
      ) VALUES (
        'decision-orphan-candidate', 'paper_trade_candidate', 'entry',
        'candidate-missing-unexpectedly', NULL
      );
      INSERT INTO decision_lifecycle_events(
        event_id, decision_id, status, reason_codes_json, occurred_at,
        source_type, source_id, evidence_json
      ) VALUES (
        'event-orphan-candidate', 'decision-orphan-candidate', 'SELECTED', '[]',
        '2026-07-15T12:15:00.000Z', 'paper_trade_candidate',
        'candidate-missing-unexpectedly', '{}'
      );
    `);
    source.close();

    const snapshot = await readControlPlaneSnapshot(sourcePath);
    const issueTypes = snapshot.sourceIssues.map((issue) => issue.discrepancyType);
    assert.ok(issueTypes.includes("CANDIDATE_DECISION_LINK_CONFLICT"));
    assert.ok(issueTypes.includes("LIFECYCLE_CANDIDATE_LINK_CONFLICT"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks lifecycle events linked through a non-canonical candidate decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-decision-link-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      INSERT INTO decision_snapshots(decision_id, candidate_id, position_lifecycle_id)
      VALUES ('decision-1-secondary', 'candidate-1', NULL);
      INSERT INTO decision_lifecycle_events(
        event_id, decision_id, status, reason_codes_json, occurred_at,
        source_type, source_id, evidence_json
      ) VALUES (
        'event-1-secondary', 'decision-1-secondary', 'BLOCKED', '[]',
        '2026-07-15T12:13:00.000Z', 'review', 'review-secondary', '{}'
      );
    `);
    source.close();

    const snapshot = await readControlPlaneSnapshot(sourcePath);
    assert.equal(
      snapshot.candidates.find((candidate) => candidate.id === "candidate-1")?.lifecycleStatus,
      "reviewed"
    );
    assert.equal(
      snapshot.candidateLifecycleEvents.some((event) => event.eventId === "event-1-secondary"),
      false
    );
    assert.ok(
      snapshot.sourceIssues.some(
        (issue) => issue.discrepancyType === "CANDIDATE_DECISION_LINK_MULTIPLE"
      )
    );
    assert.ok(
      snapshot.sourceIssues.some(
        (issue) => issue.discrepancyType === "LIFECYCLE_DECISION_CANDIDATE_MISMATCH"
      )
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks unknown, unlinked, and duplicate-rank candidate source data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-source-block-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.exec(`
      UPDATE paper_trade_candidates
      SET decision_id = NULL
      WHERE id = 'candidate-2';
      UPDATE paper_trade_candidates
      SET research_run_id = 'run-1'
      WHERE id = 'candidate-2';
      UPDATE decision_lifecycle_events
      SET status = 'UNKNOWN_STATUS'
      WHERE event_id = 'event-1b';
    `);
    source.close();

    const snapshot = await readControlPlaneSnapshot(sourcePath);
    const issueTypes = snapshot.sourceIssues.map((issue) => issue.discrepancyType);
    assert.ok(issueTypes.includes("CANDIDATE_DECISION_LINK_MISSING"));
    assert.ok(issueTypes.includes("CANDIDATE_RANK_CONFLICT"));
    assert.ok(issueTypes.includes("LIFECYCLE_STATUS_UNKNOWN"));
    await assert.rejects(
      () =>
        backfillControlPlaneSnapshot({
          snapshotPath: sourcePath,
          pool: fakeBackfillPool().pool,
          config: migrationConfig
        }),
      /CONTROL_PLANE_SOURCE_RECONCILIATION_BLOCKED/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const fakeReconciliationPool = (
  existingCheckpoint: Record<string, unknown> | null = null
) => {
  const readQueries: string[] = [];
  const writeQueries: string[] = [];
  const discrepancyWrites: readonly unknown[][] = [];
  const checkpointWrites: readonly unknown[][] = [];
  const readQuery = async (text: string) => {
    readQueries.push(text);
    if (/FROM research_runs/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM candidates/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM candidate_lifecycle_events/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM scheduler_leases/.test(text)) {
      return { rows: [{ held_count: "0" }], rowCount: 1 };
    }
    if (/FROM idempotency_records/.test(text)) {
      return { rows: [{ total_count: "0", unique_count: "0" }], rowCount: 1 };
    }
    if (/FROM workstream_events/.test(text)) {
      return {
        rows: [{ total_count: "0", unique_count: "0", failure_count: "0" }],
        rowCount: 1
      };
    }
    if (/FROM reconciliation_checkpoints\s+WHERE id = \$1/.test(text)) {
      return {
        rows: existingCheckpoint === null ? [] : [existingCheckpoint],
        rowCount: existingCheckpoint === null ? 0 : 1
      };
    }
    if (/FROM reconciliation_checkpoints/.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|SET LOCAL)/.test(text)) {
        readQueries.push(text);
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      if (/INSERT INTO reconciliation_discrepancies/.test(text)) {
        writeQueries.push(text);
        (discrepancyWrites as unknown[][]).push([...(values || [])]);
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      if (/INSERT INTO reconciliation_checkpoints/.test(text)) {
        writeQueries.push(text);
        (checkpointWrites as unknown[][]).push([...(values || [])]);
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      }
      return readQuery(text);
    },
    release: () => undefined
  } as unknown as PoolClient;
  const pool = {
    query: readQuery,
    connect: async () => client
  } as unknown as Pool;
  return { pool, readQueries, writeQueries, discrepancyWrites, checkpointWrites };
};

test("blocks reconciliation and durably records every unexplained discrepancy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-reconcile-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const source = new DatabaseSync(sourcePath);
    source.prepare(`
      INSERT INTO runtime_write_leases(lease_name, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      "research-options-and-zero-dte-engine",
      "local-worker",
      "2026-07-15T12:00:00.000Z",
      "2026-07-15T14:00:00.000Z"
    );
    source.close();
    const fake = fakeReconciliationPool();

    const result = await reconcileControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "checkpoint-release-3",
      observedAt: "2026-07-15T13:00:00.000Z"
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.authorityAllowed, false);
    assert.ok(result.discrepancies.some((row) => row.discrepancyType === "ROW_COUNT_MISMATCH"));
    assert.ok(
      result.discrepancies.some(
        (row) => row.discrepancyType === "LOCAL_RUNTIME_LEASE_ACTIVE"
      )
    );
    assert.equal(fake.discrepancyWrites.length, result.discrepancyCount);
    assert.ok(fake.discrepancyWrites.every((values) => String(values[0]).length > 0));
    assert.ok(fake.checkpointWrites.some((values) => values.includes("blocked")));
    assert.ok(
      fake.readQueries.some((query) =>
        query.includes("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE")
      )
    );
    assert.ok(
      fake.readQueries.some((query) =>
        query.includes("LOCK TABLE reconciliation_checkpoints IN SHARE ROW EXCLUSIVE MODE")
      )
    );
    for (const table of [
      "idempotency_records",
      "workstream_events",
      "scheduler_leases",
      "reconciliation_checkpoints"
    ]) {
      assert.ok(fake.readQueries.some((query) => query.includes(table)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a reconciliation checkpoint cannot be rebound to a different snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-checkpoint-source-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    for (const dryRun of [true, false]) {
      const fake = fakeReconciliationPool({
        status: "blocked",
        source_checksum: "different-source-checksum",
        discrepancy_count: "1",
        cursor_value: {},
        source_aggregates: {},
        target_aggregates: {},
        discrepancy_report: { discrepancyIds: ["stale-discrepancy"] },
        completed_at: "2026-07-15T13:00:00.000Z"
      });
      await assert.rejects(
        () => reconcileControlPlaneSnapshot({
          snapshotPath: sourcePath,
          pool: fake.pool,
          config: migrationConfig,
          checkpointId: "checkpoint-release-3",
          observedAt: "2026-07-15T13:00:00.000Z",
          dryRun
        }),
        /CONTROL_PLANE_CHECKPOINT_IMMUTABLE/
      );
      assert.equal(fake.writeQueries.length, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replays a passed checkpoint without changing its completion timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-checkpoint-replay-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    const database = new DatabaseSync(sourcePath);
    database.exec(`
      DELETE FROM decision_lifecycle_events;
      DELETE FROM decision_snapshots;
      DELETE FROM paper_trade_candidates;
      DELETE FROM research_runs;
    `);
    database.close();
    const snapshot = await readControlPlaneSnapshot(sourcePath);
    const completedAt = "2026-07-15T13:00:00.000Z";
    const sourceAggregates = {
      researchRuns: 0,
      candidates: 0,
      candidateLifecycleEvents: 0,
      deferredLifecycleEvents: 0,
      sourceIssues: 0,
      activeLocalRuntimeLeases: 0,
      idempotencyRecords: 0,
      workstreamEvents: 0,
      workstreamEventFailures: 0
    };
    const targetAggregates = {
      researchRuns: 0,
      candidates: 0,
      candidateLifecycleEvents: 0,
      heldSchedulerLeases: 0,
      idempotencyRecords: 0,
      workstreamEvents: 0,
      workstreamEventFailures: 0
    };
    const fake = fakeReconciliationPool({
      status: "passed",
      source_checksum: snapshot.inspection.sha256,
      discrepancy_count: "0",
      cursor_value: {
        snapshotSha256: snapshot.inspection.sha256,
        postgresMigrationVersion: 2,
        mappingVersion: 2
      },
      source_aggregates: sourceAggregates,
      target_aggregates: targetAggregates,
      discrepancy_report: { discrepancyIds: [] },
      completed_at: completedAt
    });

    const replay = await reconcileControlPlaneSnapshot({
      snapshotPath: sourcePath,
      pool: fake.pool,
      config: migrationConfig,
      checkpointId: "checkpoint-passed",
      observedAt: "2026-07-15T14:00:00.000Z"
    });

    assert.equal(replay.status, "passed");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.mutationCount, 0);
    assert.equal(replay.completedAt, completedAt);
    assert.equal(fake.writeQueries.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates an immutable read-consistent SQLite snapshot without changing the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-snapshot-"));
  const sourcePath = join(directory, "source.db");
  const snapshotDirectory = join(directory, "snapshots");
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec("CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    source.prepare("INSERT INTO sample(id, value) VALUES (?, ?)").run("one", "original");
    source.close();
    const sourceBefore = await readFile(sourcePath);

    const snapshot = await createReadConsistentSqliteSnapshot({
      sourcePath,
      destinationDirectory: snapshotDirectory
    });

    assert.notEqual(snapshot.path, sourcePath);
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(snapshot.integrityCheck, ["ok"]);
    assert.equal(snapshot.foreignKeyViolationCount, 0);
    assert.equal(snapshot.tableCounts.sample, 1);
    assert.deepEqual(await readFile(sourcePath), sourceBefore);

    const sourceAfter = new DatabaseSync(sourcePath);
    sourceAfter.prepare("INSERT INTO sample(id, value) VALUES (?, ?)").run("two", "later");
    sourceAfter.close();
    const snapshotDb = new DatabaseSync(snapshot.path, { readOnly: true });
    const snapshotCount = snapshotDb.prepare("SELECT COUNT(*) AS count FROM sample").get() as {
      count: number;
    };
    snapshotDb.close();
    assert.equal(snapshotCount.count, 1);
  } finally {
    try {
      source.close();
    } catch {
      // The source is normally closed before the snapshot is created.
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects SQLite snapshots with WAL, shared-memory, or rollback-journal sidecars", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-plane-sidecar-"));
  try {
    const sourcePath = join(directory, "source.db");
    createBackfillSource(sourcePath);
    await writeFile(`${sourcePath}-wal`, "synthetic-sidecar");
    await assert.rejects(
      () => readControlPlaneSnapshot(sourcePath),
      /SQLITE_SNAPSHOT_SIDE_FILE_PRESENT/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps SQLite control-plane rows without changing IDs, timestamps, or nulls", () => {
  const run = mapSqliteResearchRun({
    id: "run-1",
    started_at: "2026-07-15T12:00:00.000Z",
    heartbeat_at: null,
    completed_at: "2026-07-15T12:05:00.000Z",
    status: "completed",
    risk_profile: "moderate",
    options_enabled: 1,
    universe_size: 51,
    targets_generated: 4,
    candidates_selected: 1,
    error_message: null,
    config_json: "{\"maxCandidates\":4}",
    summary_json: null,
    worker_identity: "worker-1",
    request_id: null,
    correlation_id: "correlation-1",
    recovered_at: null,
    recovery_reason: null,
    recovery_source: null
  });
  assert.equal(run.id, "run-1");
  assert.equal(run.startedAt, "2026-07-15T12:00:00.000Z");
  assert.equal(run.heartbeatAt, null);
  assert.equal(run.completedAt, "2026-07-15T12:05:00.000Z");
  assert.equal(run.summary, null);
  assert.deepEqual(run.config, { maxCandidates: 4 });

  const candidate = mapSqliteCandidate({
    id: "candidate-1",
    decision_id: null,
    decision_linkage_status: "LEGACY_UNLINKED",
    research_run_id: "run-1",
    symbol: "SPY",
    as_of: "2026-07-15T12:04:00.000Z",
    rank: 1,
    direction: "long",
    horizon: "swing",
    risk_profile: "moderate",
    preferred_expression: "call",
    score: 0.75,
    confidence: 0.8,
    expected_return: null,
    estimated_max_loss: null,
    estimated_max_profit: 12.5,
    rationale: "[\"positive momentum\"]",
    relevant_backtest_run_id: null,
    historical_win_rate: null,
    historical_avg_return: null,
    historical_max_drawdown: null,
    similar_setup_count: null,
    option_liquidity_score: null,
    volatility_score: 0.4,
    signal_freshness_days: 0,
    recent_learning_adjustment: null,
    directional_accuracy: null,
    option_outperformance_accuracy: null,
    option_symbol: "SPY260821C00600000",
    strike: 600,
    short_strike: null,
    decision: "selected",
    decision_reason: null,
    strategy_family: "momentum",
    signal_inputs_json: "{\"rsi\":55}",
    data_quality_status: "COMPLETE"
  });
  assert.equal(candidate.id, "candidate-1");
  assert.equal(candidate.decisionId, null);
  assert.equal(candidate.asOf, "2026-07-15T12:04:00.000Z");
  assert.equal(candidate.expectedReturn, null);
  assert.equal(candidate.optionSymbol, "SPY260821C00600000");
  assert.equal(candidate.underlyingSymbol, "SPY");
  assert.deepEqual(candidate.rationale, ["positive momentum"]);
  assert.deepEqual(candidate.signalInputs, { rsi: 55 });

  assert.throws(
    () =>
      mapSqliteResearchRun({
        id: "run-invalid-boolean",
        started_at: "2026-07-15T12:00:00.000Z",
        heartbeat_at: null,
        completed_at: "2026-07-15T12:05:00.000Z",
        status: "completed",
        risk_profile: "moderate",
        options_enabled: 2,
        universe_size: 1,
        targets_generated: 0,
        candidates_selected: 0,
        error_message: null,
        config_json: "{}",
        summary_json: null,
        worker_identity: null,
        request_id: null,
        correlation_id: null,
        recovered_at: null,
        recovery_reason: null,
        recovery_source: null
      }),
    /SQLITE_COLUMN_INVALID:research_runs.options_enabled/
  );
});

test("rejects malformed SQLite JSON without including the value in the error", () => {
  assert.throws(
    () =>
      mapSqliteCandidate({
        id: "candidate-json",
        decision_id: null,
        decision_linkage_status: "LEGACY_UNLINKED",
        research_run_id: "run-json",
        symbol: "SPY",
        as_of: "2026-07-15T12:04:00.000Z",
        rank: 1,
        direction: "long",
        horizon: "swing",
        risk_profile: "moderate",
        preferred_expression: "equity",
        score: 0.75,
        confidence: 0.8,
        expected_return: null,
        estimated_max_loss: null,
        estimated_max_profit: null,
        rationale: "secret malformed value {",
        relevant_backtest_run_id: null,
        historical_win_rate: null,
        historical_avg_return: null,
        historical_max_drawdown: null,
        similar_setup_count: null,
        option_liquidity_score: null,
        volatility_score: null,
        signal_freshness_days: null,
        recent_learning_adjustment: null,
        directional_accuracy: null,
        option_outperformance_accuracy: null,
        option_symbol: null,
        strike: null,
        short_strike: null,
        decision: "selected",
        decision_reason: null,
        strategy_family: "momentum",
        signal_inputs_json: "{}",
        data_quality_status: "COMPLETE"
      }),
    (error) =>
      error instanceof Error &&
      error.message === "SQLITE_JSON_INVALID:paper_trade_candidates.rationale" &&
      !error.message.includes("secret malformed value")
  );
});
