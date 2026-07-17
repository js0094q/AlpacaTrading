import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  assertDurableExecutionStateCheckpoint,
  readExecutionStateSnapshot,
  type ExecutionStateReconciliationResult
} from "../src/services/executionStateMigrationService.js";
import {
  mapPaperSubmitStateToExecutionProjection
} from "../src/services/executionStateProjectionService.js";
import { createExecutionStateSnapshotFixture } from "./helpers/executionStateSnapshotFixture.js";

test("execution-state snapshot projects every Release 4 domain with PostgreSQL scales", async () => {
  const directory = await mkdtemp(join(tmpdir(), "execution-state-source-"));
  const path = join(directory, "source.db");
  try {
    createExecutionStateSnapshotFixture(path);
    const snapshot = await readExecutionStateSnapshot(path);
    assert.deepEqual(snapshot.sourceIssues, []);
    assert.equal(snapshot.accountId, "account_account-hash-release-4");
    assert.equal(snapshot.rows.get("accounts")?.length, 1);
    assert.equal(snapshot.rows.get("account_snapshots")?.length, 1);
    assert.equal(snapshot.rows.get("execution_reviews")?.length, 1);
    assert.equal(snapshot.rows.get("confirmation_evidence")?.length, 1);
    assert.equal(snapshot.rows.get("buying_power_reservations")?.length, 1);
    assert.equal(snapshot.rows.get("order_intents")?.length, 1);
    assert.equal(snapshot.rows.get("orders")?.length, 1);
    assert.equal(snapshot.rows.get("broker_events")?.length, 1);
    assert.equal(snapshot.rows.get("lifecycle_fingerprints")?.length, 2);
    assert.equal(snapshot.rows.get("account_snapshots")?.[0]?.cash, "4000.12345679");
    assert.equal(snapshot.rows.get("order_intents")?.[0]?.quantity, "2.000000000000");
    assert.equal(snapshot.rows.get("order_intents")?.[0]?.limit_price, "500.12345679");
    assert.equal(snapshot.rows.get("order_intents")?.[0]?.max_risk, "1000.24691358");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid source numerics become a blocking aggregate source issue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "execution-state-invalid-"));
  const path = join(directory, "source.db");
  try {
    createExecutionStateSnapshotFixture(path);
    const database = new DatabaseSync(path);
    database.exec("UPDATE paper_execution_ledger SET limit_price = 'not-a-number'");
    database.close();
    const snapshot = await readExecutionStateSnapshot(path);
    assert.ok(snapshot.sourceIssues.includes("EXECUTION_INTENT_MAPPING_INVALID"));
    assert.equal(snapshot.rows.get("order_intents")?.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production-shaped blocked evidence and detached legacy decisions remain migration-safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "execution-state-production-source-"));
  const path = join(directory, "source.db");
  try {
    createExecutionStateSnapshotFixture(path);
    const database = new DatabaseSync(path);
    const artifactRow = database.prepare(
      "SELECT artifact_json FROM paper_review_artifacts LIMIT 1"
    ).get() as { artifact_json: string };
    const artifact = JSON.parse(artifactRow.artifact_json);
    artifact.submitState.complete = false;
    artifact.submitState.blockers = ["SUBMIT_MARKET_EVIDENCE_STALE"];
    database.prepare(
      "UPDATE paper_review_artifacts SET artifact_json = ?"
    ).run(JSON.stringify(artifact));
    const repeatedArtifact = structuredClone(artifact);
    repeatedArtifact.id = "review-release-4-repeated-snapshot";
    repeatedArtifact.createdAt = "2026-07-16T16:01:00.000Z";
    repeatedArtifact.expiresAt = "2026-07-16T17:01:00.000Z";
    repeatedArtifact.submitState.capturedAt = repeatedArtifact.createdAt;
    database.prepare(`
      INSERT INTO paper_review_artifacts(
        id, created_at, expires_at, source_action, status,
        payload_signature, payload_count, artifact_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      repeatedArtifact.id,
      repeatedArtifact.createdAt,
      repeatedArtifact.expiresAt,
      repeatedArtifact.sourceAction,
      repeatedArtifact.status,
      repeatedArtifact.payloadSignature,
      1,
      JSON.stringify(repeatedArtifact)
    );
    database.exec(`
      DELETE FROM decision_snapshots;
      DELETE FROM paper_trade_candidates;
      UPDATE paper_execution_ledger
      SET decision_id = 'legacy-decision-without-source',
          source_candidate_id = 'missing-candidate',
          decision_linkage_status = 'EXACT';
    `);
    const sourceLedger = database.prepare(
      "SELECT * FROM paper_execution_ledger WHERE id = 1"
    ).get() as Record<string, unknown>;
    const retryResponse = JSON.parse(String(sourceLedger.raw_response_json));
    retryResponse.status = "filled";
    const correctedLedger = {
      ...sourceLedger,
      id: 2,
      updated_at: "2026-07-16T16:10:00.000Z",
      client_order_id: "legacy-retry-client-order",
      alpaca_status: "filled",
      source_plan_id: null,
      status: "filled",
      raw_response_json: JSON.stringify(retryResponse)
    };
    const columns = Object.keys(correctedLedger);
    database.prepare(`
      INSERT INTO paper_execution_ledger(${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
    `).run(...Object.values(correctedLedger));
    database.close();

    assert.throws(
      () => mapPaperSubmitStateToExecutionProjection(artifact.submitState),
      /EXECUTION_ACCOUNT_EVIDENCE_INCOMPLETE/
    );

    const snapshot = await readExecutionStateSnapshot(path);
    assert.deepEqual(snapshot.sourceIssues, []);
    assert.equal(snapshot.rows.get("accounts")?.length, 1);
    assert.equal(snapshot.rows.get("account_snapshots")?.length, 1);
    assert.equal(snapshot.rows.get("order_intents")?.length, 1);
    assert.ok(snapshot.rows.get("order_intents")?.every((row) => row.candidate_id === null));
    assert.equal(snapshot.rows.get("orders")?.length, 1);
    assert.equal(snapshot.rows.get("orders")?.[0]?.status, "filled");
    assert.equal(snapshot.rows.get("broker_events")?.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical retries share one idempotent intent while preserving broker history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "execution-state-idempotent-retry-"));
  const path = join(directory, "source.db");
  try {
    createExecutionStateSnapshotFixture(path);
    const database = new DatabaseSync(path);
    const source = database.prepare(
      "SELECT * FROM paper_execution_ledger WHERE id = 1"
    ).get() as Record<string, unknown>;
    const response = JSON.parse(String(source.raw_response_json));
    response.id = "broker-order-retry";
    response.client_order_id = "client-order-retry";
    response.status = "filled";
    const retry = {
      ...source,
      id: 2,
      updated_at: "2026-07-16T16:10:00.000Z",
      client_order_id: "client-order-retry",
      alpaca_order_id: "broker-order-retry",
      alpaca_status: "filled",
      source_candidate_id: "candidate-retry",
      max_risk: Number(source.max_risk) + 1,
      status: "filled",
      raw_payload_json: JSON.stringify({ position_intent: "buy_to_open" }),
      raw_response_json: JSON.stringify(response)
    };
    const columns = Object.keys(retry);
    database.prepare(`
      INSERT INTO paper_execution_ledger(${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
    `).run(...Object.values(retry));
    database.close();

    const snapshot = await readExecutionStateSnapshot(path);
    assert.deepEqual(snapshot.sourceIssues, []);
    assert.equal(snapshot.rows.get("buying_power_reservations")?.length, 1);
    assert.equal(snapshot.rows.get("order_intents")?.length, 1);
    assert.equal(snapshot.rows.get("orders")?.length, 2);
    assert.equal(snapshot.rows.get("broker_events")?.length, 2);
    const intentId = snapshot.rows.get("order_intents")?.[0]?.id;
    assert.ok(snapshot.rows.get("orders")?.every((row) => row.order_intent_id === intentId));
    assert.ok(snapshot.rows.get("broker_events")?.every(
      (row) => row.order_intent_id === intentId
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable execution checkpoint verification binds the snapshot and aggregates", () => {
  const completedAt = "2026-07-16T18:00:00.000Z";
  const expected: ExecutionStateReconciliationResult = {
    operation: "execution_state_reconciliation",
    checkpointId: "checkpoint-release-4",
    status: "passed",
    authorityAllowed: true,
    snapshotSha256: "snapshot-checksum",
    postgresMigrationVersion: 2,
    mappingVersion: "release-4-v1",
    tableComparisons: {},
    sourceAggregates: { tables: { orders: 1 } },
    targetAggregates: { tables: { orders: 1 } },
    discrepancyCategories: {},
    discrepancyCount: 0,
    duplicateCount: 0,
    orphanCount: 0,
    lifecycleOrderingCount: 0,
    reservationAllocationInvariantCount: 0,
    rowMutationCount: 0,
    checkpointMutationCount: 1,
    discrepancyMutationCount: 0,
    mutationCount: 1,
    idempotentReplay: false,
    dryRun: false,
    completedAt
  };
  const row = {
    status: "passed",
    source_checksum: expected.snapshotSha256,
    discrepancy_count: "0",
    cursor_value: {
      snapshotSha256: expected.snapshotSha256,
      postgresMigrationVersion: 2,
      mappingVersion: expected.mappingVersion
    },
    source_aggregates: expected.sourceAggregates,
    target_aggregates: expected.targetAggregates,
    discrepancy_report: { discrepancyCategories: {} },
    completed_at: completedAt
  };
  assert.equal(assertDurableExecutionStateCheckpoint(row, expected), true);
  assert.throws(
    () => assertDurableExecutionStateCheckpoint({ ...row, source_checksum: "other" }, expected),
    /EXECUTION_STATE_DURABLE_CHECKPOINT_VERIFICATION_FAILED/
  );
});

test("PostgreSQL schema remains migrations 1 and 2 only", async () => {
  const files = await readdir(new URL("../src/lib/database/migrations", import.meta.url));
  assert.deepEqual(files.sort(), [
    "001_initial_operational_state.sql",
    "002_control_plane_authority.sql"
  ]);
});
