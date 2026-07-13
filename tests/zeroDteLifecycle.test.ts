import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendZeroDteLifecycleEvent, insertZeroDteDecision } from "../src/services/zeroDte/zeroDteLifecycleService.js";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-lifecycle-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

const { closeDbForTests, getDb } = await import("../src/lib/db.js");

const configId = "task5-lifecycle-config";
const runId = "task5-lifecycle-run";
const candidateId = "task5-lifecycle-candidate";
const timestamp = "2026-07-13T19:20:00.000Z";

const seedLifecycleFixtures = () => {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    configId,
    "zero-dte-level-2-v1",
    "task5-lifecycle-config-hash",
    "{}",
    timestamp
  );
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    "2026-07-13",
    "test",
    "paper",
    "running",
    "zero-dte-level-2-v1",
    configId,
    timestamp,
    timestamp
  );
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_candidates
      (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
       direction, expiration_date, strike, state, first_seen_at, last_seen_at,
       state_changed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    candidateId,
    "2026-07-13",
    "SPY",
    "SPY260713C00500000",
    "trend_continuation",
    "bullish",
    "2026-07-13",
    500,
    "eligible",
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp
  );
};

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("decisions are immutable paper-only records with sanitized evidence", () => {
  seedLifecycleFixtures();
  const decision = insertZeroDteDecision({
    decisionId: "task5-decision-1",
    decisionGroupId: "task5-group-1",
    engineRunId: runId,
    candidateId,
    tradingDate: "2026-07-13",
    action: "select",
    accountMode: "paper",
    strategyVersion: "zero-dte-level-2-v1",
    configurationVersionId: configId,
    marketTimestamp: timestamp,
    decidedAt: timestamp,
    score: 88,
    scoreThreshold: 70,
    appliedThresholds: { minScore: 70 },
    reasonCodes: ["ELIGIBLE"],
    evidence: {
      note: "paper-only decision",
      apiKey: "do-not-persist",
      authorization: "Bearer task5-secret-value"
    },
    clientOrderId: null
  });

  assert.equal(decision.decisionId, "task5-decision-1");
  assert.equal(decision.decisionGroupId, "task5-group-1");
  assert.throws(() =>
    insertZeroDteDecision({
      decisionId: "task5-decision-1",
      decisionGroupId: "task5-group-correction",
      engineRunId: runId,
      candidateId,
      tradingDate: "2026-07-13",
      action: "reject",
      accountMode: "paper",
      strategyVersion: "zero-dte-level-2-v1",
      configurationVersionId: configId,
      decidedAt: "2026-07-13T19:21:00.000Z",
      reasonCodes: ["CORRECTION"]
    })
  );

  const row = getDb().prepare(
    "SELECT evidence_json FROM zero_dte_decisions WHERE decision_id = ?"
  ).get(decision.decisionId) as { evidence_json: string };
  assert.doesNotMatch(row.evidence_json, /do-not-persist|task5-secret-value/);
  assert.match(row.evidence_json, /paper-only decision/);
});

test("lifecycle events append corrections and preserve all linkage IDs", () => {
  seedLifecycleFixtures();
  const first = appendZeroDteLifecycleEvent({
    eventId: "task5-event-1",
    eventType: "candidate_selected",
    reasonCode: "HIGH_SCORE",
    engineRunId: runId,
    candidateId,
    decisionId: "task5-decision-1",
    decisionGroupId: "task5-group-1",
    accountMode: "paper",
    strategyVersion: "zero-dte-level-2-v1",
    configurationVersionId: configId,
    marketTimestamp: timestamp,
    occurredAt: timestamp,
    details: {
      source: "test",
      rawPayload: "Authorization: Bearer task5-secret-value"
    }
  });
  const correction = appendZeroDteLifecycleEvent({
    eventId: "task5-event-2",
    eventType: "candidate_selected",
    reasonCode: "CORRECTED_SCORE",
    engineRunId: runId,
    candidateId,
    decisionId: "task5-decision-1",
    decisionGroupId: "task5-group-1",
    accountMode: "paper",
    strategyVersion: "zero-dte-level-2-v1",
    configurationVersionId: configId,
    marketTimestamp: timestamp,
    occurredAt: "2026-07-13T19:21:00.000Z",
    details: { correction: true }
  });

  assert.equal(first.eventId, "task5-event-1");
  assert.equal(correction.eventId, "task5-event-2");
  const rows = getDb().prepare(
    `SELECT event_id, reason_code, engine_run_id, candidate_id,
            decision_id, decision_group_id, details_json
     FROM zero_dte_lifecycle_events
     WHERE candidate_id = ?
     ORDER BY occurred_at ASC`
  ).all(candidateId) as Array<{
    event_id: string;
    reason_code: string;
    engine_run_id: string;
    candidate_id: string;
    decision_id: string;
    decision_group_id: string;
    details_json: string;
  }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.engine_run_id, runId);
  assert.equal(rows[0]?.candidate_id, candidateId);
  assert.equal(rows[0]?.decision_id, "task5-decision-1");
  assert.equal(rows[0]?.decision_group_id, "task5-group-1");
  assert.doesNotMatch(rows[0]?.details_json ?? "", /task5-secret-value/);
  assert.deepEqual(rows.map((row) => row.reason_code), ["HIGH_SCORE", "CORRECTED_SCORE"]);
});

test("live account modes are rejected before persistence", () => {
  seedLifecycleFixtures();
  assert.throws(
    () =>
      insertZeroDteDecision({
        decisionId: "task5-live-decision",
        decisionGroupId: "task5-live-group",
        engineRunId: runId,
        candidateId,
        tradingDate: "2026-07-13",
        action: "select",
        accountMode: "live",
        strategyVersion: "zero-dte-level-2-v1",
        configurationVersionId: configId,
        decidedAt: timestamp
      }),
    /paper-only|live/i
  );
  assert.throws(
    () =>
      appendZeroDteLifecycleEvent({
        eventId: "task5-live-event",
        eventType: "candidate_selected",
        engineRunId: runId,
        candidateId,
        accountMode: "live",
        strategyVersion: "zero-dte-level-2-v1",
        configurationVersionId: configId,
        occurredAt: timestamp
      }),
    /paper-only|live/i
  );
  assert.equal(
    (getDb().prepare(
      "SELECT COUNT(*) AS count FROM zero_dte_decisions WHERE decision_id = 'task5-live-decision'"
    ).get() as { count: number }).count,
    0
  );
});
