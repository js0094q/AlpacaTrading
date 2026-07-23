import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const testRoot = mkdtempSync(join(tmpdir(), "alpaca-learning-trace-test-"));
process.env.RESEARCH_DB_PATH = join(testRoot, "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

const [libDb, evidenceService, ledgerService, lifecycleService, learningService, traceService] =
  await Promise.all([
    import("../src/lib/db.js"),
    import("../src/services/marketDecisionEvidenceService.js"),
    import("../src/services/paperExecutionLedgerService.js"),
    import("../src/services/paperPositionLifecycleService.js"),
    import("../src/services/paperLearningLedgerService.js"),
    import("../src/services/marketDecisionTraceService.js")
  ]);

const { closeDbForTests, getDb } = libDb;
const { persistDecisionSnapshot } = evidenceService;
const { insertPaperExecutionLedgerEntry } = ledgerService;
const {
  appendPaperPositionOutcomeRevision,
  capturePaperPositionObservation,
  closePaperPositionFromFill,
  persistPaperPositionOutcome,
  reconcilePaperEntryFill
} = lifecycleService;
const { insertPaperLearningRecord } = learningService;
const { buildMarketDecisionTrace } = traceService;

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_position_outcome_revisions;
    DELETE FROM paper_position_outcomes;
    DELETE FROM paper_position_observation_links;
    DELETE FROM paper_position_observations;
    DELETE FROM paper_positions;
    DELETE FROM paper_execution_ledger;
    DELETE FROM paper_learning_records;
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
  `);
};

beforeEach(resetDatabase);

after(() => {
  closeDbForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("learning linkage and read-only decision trace", () => {
  test("links candidate learning through effective outcome revision without exposing raw payloads", () => {
    const entry = persistDecisionSnapshot({
      originType: "paper_trade_candidate",
      originId: "candidate-trace",
      decisionRole: "entry",
      candidateId: "candidate-trace",
      decisionStatus: "SELECTED",
      createdAt: "2026-07-13T14:00:00.000Z",
      symbol: "AAPL",
      reasonCodes: ["RANKED_SELECTED"],
      rationale: ["Exact trace fixture"],
      signalInputs: { authorization: "Bearer must-never-appear" },
      dataQualityStatus: "COMPLETE",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });
    const learning = insertPaperLearningRecord({
      id: "learning-trace",
      createdAt: "2026-07-13T14:00:00.000Z",
      strategyFamily: "equity",
      symbol: "AAPL",
      decision: "submitted",
      hypothesis: "Trace the exact lifecycle",
      signalInputs: { apiKey: "must-never-appear" },
      sourceCandidateId: "candidate-trace"
    });
    assert.equal(learning.decisionId, entry.decisionId);
    assert.equal(learning.entryDecisionId, entry.decisionId);
    assert.equal(learning.decisionLinkageStatus, "EXACT");

    const ledger = insertPaperExecutionLedgerEntry({
      mode: "reviewedConfirmPaper",
      assetClass: "equity",
      symbol: "AAPL",
      side: "buy",
      orderType: "market",
      timeInForce: "day",
      qty: "1",
      dedupeKey: "trace-entry",
      clientOrderId: "trace-entry",
      status: "submitted",
      decisionId: entry.decisionId,
      decisionLinkageStatus: "EXACT",
      payload: { apiKey: "ledger-secret" }
    });
    const position = reconcilePaperEntryFill({
      ledgerId: ledger.id,
      brokerOrderId: "broker-trace-entry",
      clientOrderId: "trace-entry",
      status: "filled",
      filledQuantity: 1,
      filledAveragePrice: 100,
      observedAt: "2026-07-13T14:01:00.000Z",
      brokerRequestId: "request-entry"
    });
    capturePaperPositionObservation({
      brokerSymbolKey: "AAPL",
      symbol: "AAPL",
      observedAt: "2026-07-13T14:30:00.000Z",
      mark: 105,
      quantity: 1,
      dataQualityStatus: "COMPLETE",
      marketDataRequestId: "market-request-1",
      feed: "iex"
    });
    const exit = persistDecisionSnapshot({
      originType: "paper_review_artifact",
      originId: "trace-exit-artifact:equitySells:0",
      decisionRole: "exit",
      positionLifecycleId: position.positionLifecycleId,
      decisionStatus: "REVIEWED",
      createdAt: "2026-07-13T15:00:00.000Z",
      symbol: "AAPL",
      reasonCodes: ["TAKE_PROFIT"],
      dataQualityStatus: "COMPLETE",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });
    closePaperPositionFromFill({
      positionLifecycleId: position.positionLifecycleId,
      exitDecisionId: exit.decisionId,
      brokerOrderId: "broker-trace-exit",
      status: "filled",
      filledQuantity: 1,
      filledAveragePrice: 110,
      observedAt: "2026-07-13T15:00:00.000Z",
      exitReasonCode: "TAKE_PROFIT",
      brokerRequestId: "request-exit"
    });
    const outcome = persistPaperPositionOutcome({
      positionLifecycleId: position.positionLifecycleId,
      exitReasonCode: "TAKE_PROFIT"
    });
    const revision = appendPaperPositionOutcomeRevision({
      outcomeId: outcome.outcomeId,
      correctionReason: "BROKER_REQUEST_ID_CONFIRMED",
      correctedFields: { brokerRequestId: "request-exit" }
    });

    const linked = getDb().prepare(`
      SELECT decision_id, entry_decision_id, exit_decision_id,
             position_lifecycle_id, outcome_id, effective_outcome_revision_id,
             outcome_completeness_status, decision_linkage_status
      FROM paper_learning_records WHERE id = 'learning-trace'
    `).get() as Record<string, unknown>;
    assert.equal(linked.decision_id, entry.decisionId);
    assert.equal(linked.entry_decision_id, entry.decisionId);
    assert.equal(linked.exit_decision_id, exit.decisionId);
    assert.equal(linked.position_lifecycle_id, position.positionLifecycleId);
    assert.equal(linked.outcome_id, outcome.outcomeId);
    assert.equal(linked.effective_outcome_revision_id, revision.revisionId);
    assert.equal(linked.outcome_completeness_status, "COMPLETE");
    assert.equal(linked.decision_linkage_status, "EXACT");

    const trace = buildMarketDecisionTrace(entry.decisionId);
    assert.equal(trace.readOnly, true);
    assert.equal(trace.paperOnly, true);
    assert.equal(trace.decision.decisionId, entry.decisionId);
    assert.equal(trace.position?.positionLifecycleId, position.positionLifecycleId);
    assert.equal(trace.outcome?.outcomeId, outcome.outcomeId);
    assert.equal(trace.outcomeRevisions[0]?.revisionId, revision.revisionId);
    assert.equal(trace.learning[0]?.id, "learning-trace");
    assert.ok(trace.observations.length >= 3);
    const serialized = JSON.stringify(trace);
    assert.doesNotMatch(serialized, /must-never-appear|ledger-secret|apiKey|authorization/i);

    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/helpers/enableSqliteFixtureInitialization.mjs",
        "src/cli.ts",
        "paper:trace",
        "--decisionId",
        entry.decisionId
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, RESEARCH_DB_PATH: process.env.RESEARCH_DB_PATH }
      }
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /"readOnly": true/);
    assert.doesNotMatch(
      cli.stdout,
      /must-never-appear|ledger-secret|apiKey|authorization/i
    );
  });

  test("requires an existing immutable decision", () => {
    assert.throws(
      () => buildMarketDecisionTrace("00000000-0000-4000-8000-000000000000"),
      /DECISION_NOT_FOUND/
    );
  });
});
