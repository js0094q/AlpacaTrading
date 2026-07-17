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
    database.exec(`
      DELETE FROM decision_snapshots;
      DELETE FROM paper_trade_candidates;
      UPDATE paper_execution_ledger
      SET decision_id = 'legacy-decision-without-source',
          source_candidate_id = 'missing-candidate',
          decision_linkage_status = 'EXACT';
    `);
    database.close();

    assert.throws(
      () => mapPaperSubmitStateToExecutionProjection(artifact.submitState),
      /EXECUTION_ACCOUNT_EVIDENCE_INCOMPLETE/
    );

    const snapshot = await readExecutionStateSnapshot(path);
    assert.deepEqual(snapshot.sourceIssues, []);
    assert.equal(snapshot.rows.get("accounts")?.length, 1);
    assert.equal(snapshot.rows.get("order_intents")?.length, 1);
    assert.equal(snapshot.rows.get("order_intents")?.[0]?.candidate_id, null);
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
