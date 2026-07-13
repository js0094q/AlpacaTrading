import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const testRoot = mkdtempSync(join(tmpdir(), "alpaca-position-lifecycle-test-"));
process.env.RESEARCH_DB_PATH = join(testRoot, "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

const [libDb, evidenceService, ledgerService, lifecycleService] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/marketDecisionEvidenceService.js"),
  import("../src/services/paperExecutionLedgerService.js"),
  import("../src/services/paperPositionLifecycleService.js")
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

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_position_outcome_revisions;
    DELETE FROM paper_position_outcomes;
    DELETE FROM paper_position_observation_links;
    DELETE FROM paper_position_observations;
    DELETE FROM paper_positions;
    DELETE FROM paper_execution_ledger;
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
  `);
};

const entryDecision = (originId: string, symbol = "AAPL") =>
  persistDecisionSnapshot({
    originType: "test_candidate",
    originId,
    decisionRole: "entry",
    decisionStatus: "SELECTED",
    createdAt: "2026-07-13T14:00:00.000Z",
    symbol,
    reasonCodes: ["RANKED_SELECTED"],
    dataQualityStatus: "COMPLETE",
    sourceTimestamps: {},
    environment: "paper",
    configAllowlistVersion: "phase1b-v1"
  });

const entryLedger = (input: {
  originId: string;
  symbol?: string;
  assetClass?: "equity" | "option";
  underlyingSymbol?: string;
  side?: "buy" | "sell";
}) => {
  const symbol = input.symbol ?? "AAPL";
  const decision = entryDecision(input.originId, input.underlyingSymbol ?? symbol);
  const ledger = insertPaperExecutionLedgerEntry({
    mode: "reviewedConfirmPaper",
    assetClass: input.assetClass ?? "equity",
    symbol,
    underlyingSymbol: input.underlyingSymbol ?? null,
    side: input.side ?? "buy",
    orderType: "market",
    timeInForce: "day",
    qty: "1",
    dedupeKey: `fill:${input.originId}`,
    clientOrderId: `client-${input.originId}`,
    status: "submitted",
    decisionId: decision.decisionId,
    decisionLinkageStatus: "EXACT",
    payload: {
      position_intent: input.side === "sell" ? "sell_to_open" : "buy_to_open"
    }
  });
  return { decision, ledger };
};

const reconcileEntry = (input: {
  originId: string;
  symbol?: string;
  assetClass?: "equity" | "option";
  underlyingSymbol?: string;
  side?: "buy" | "sell";
  price?: number;
  quantity?: number;
  observedAt?: string;
  underlyingPrice?: number;
}) => {
  const created = entryLedger(input);
  const result = reconcilePaperEntryFill({
    ledgerId: created.ledger.id,
    brokerOrderId: `broker-${input.originId}`,
    clientOrderId: created.ledger.clientOrderId,
    status: "filled",
    filledQuantity: input.quantity ?? 1,
    filledAveragePrice: input.price ?? 100,
    observedAt: input.observedAt ?? "2026-07-13T14:00:00.000Z",
    brokerRequestId: `request-${input.originId}`,
    underlyingPrice: input.underlyingPrice ?? null
  });
  return { ...created, result };
};

beforeEach(resetDatabase);

after(() => {
  closeDbForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("broker-reconciled analytical position lifecycles", () => {
  test("creates a lifecycle only from an exact broker-confirmed fill and retries idempotently", () => {
    const { ledger } = entryLedger({ originId: "exact-fill" });

    assert.throws(
      () =>
        reconcilePaperEntryFill({
          ledgerId: ledger.id,
          brokerOrderId: "broker-unfilled",
          clientOrderId: ledger.clientOrderId,
          status: "accepted",
          filledQuantity: 0,
          filledAveragePrice: null,
          observedAt: "2026-07-13T14:00:00.000Z"
        }),
      /BROKER_FILL_NOT_CONFIRMED/
    );

    const first = reconcilePaperEntryFill({
      ledgerId: ledger.id,
      brokerOrderId: "broker-exact-fill",
      clientOrderId: ledger.clientOrderId,
      status: "filled",
      filledQuantity: 2,
      filledAveragePrice: 100,
      observedAt: "2026-07-13T14:01:00.000Z",
      brokerRequestId: "request-fill"
    });
    const retry = reconcilePaperEntryFill({
      ledgerId: ledger.id,
      brokerOrderId: "broker-exact-fill",
      clientOrderId: ledger.clientOrderId,
      status: "filled",
      filledQuantity: 2,
      filledAveragePrice: 100,
      observedAt: "2026-07-13T14:01:00.000Z",
      brokerRequestId: "request-fill"
    });

    assert.equal(retry.positionLifecycleId, first.positionLifecycleId);
    assert.notEqual(first.positionLifecycleId, first.entryDecisionId);
    const row = getDb().prepare(`
      SELECT p.status, p.linkage_status, l.position_lifecycle_id,
             (SELECT COUNT(*) FROM paper_position_observations) AS observations
      FROM paper_positions p
      JOIN paper_execution_ledger l ON l.id = ?
      WHERE p.position_lifecycle_id = ?
    `).get(ledger.id, first.positionLifecycleId) as Record<string, unknown>;
    assert.equal(row.status, "OPEN");
    assert.equal(row.linkage_status, "EXACT");
    assert.equal(row.position_lifecycle_id, first.positionLifecycleId);
    assert.equal(row.observations, 1);

    const partial = entryLedger({ originId: "partial-fill", symbol: "MSFT" });
    const partialPosition = reconcilePaperEntryFill({
      ledgerId: partial.ledger.id,
      brokerOrderId: "broker-partial-fill",
      clientOrderId: partial.ledger.clientOrderId,
      status: "partially_filled",
      filledQuantity: 0.5,
      filledAveragePrice: 410,
      observedAt: "2026-07-13T14:02:00.000Z"
    });
    assert.equal(partialPosition.entryQuantity, 0.5);
    const partialEvidence = getDb().prepare(`
      SELECT data_quality_status
      FROM paper_position_observations
      WHERE broker_symbol_key = 'MSFT'
    `).get() as { data_quality_status: string };
    assert.equal(partialEvidence.data_quality_status, "PARTIAL");
    const completedPartial = reconcilePaperEntryFill({
      ledgerId: partial.ledger.id,
      brokerOrderId: "broker-partial-fill",
      clientOrderId: partial.ledger.clientOrderId,
      status: "filled",
      filledQuantity: 1,
      filledAveragePrice: 412,
      observedAt: "2026-07-13T14:03:00.000Z"
    });
    assert.equal(completedPartial.positionLifecycleId, partialPosition.positionLifecycleId);
    assert.equal(completedPartial.entryQuantity, 1);
    assert.equal(completedPartial.entryPrice, 412);
    const partialObservationCount = getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM paper_position_observations
      WHERE broker_symbol_key = 'MSFT'
    `).get() as { count: number };
    assert.equal(partialObservationCount.count, 2);
  });

  test("persists symbol evidence but marks all possible netted lifecycles ambiguous", () => {
    const first = reconcileEntry({ originId: "netted-1", observedAt: "2026-07-13T14:00:00.000Z" });
    const second = reconcileEntry({ originId: "netted-2", observedAt: "2026-07-13T14:01:00.000Z" });

    const observation = capturePaperPositionObservation({
      brokerSymbolKey: "AAPL",
      symbol: "AAPL",
      observedAt: "2026-07-13T15:00:00.000Z",
      mark: 105,
      quantity: 2,
      averageEntryPrice: 100,
      dataQualityStatus: "COMPLETE",
      feed: "iex"
    });

    assert.equal(observation.linkageStatus, "AMBIGUOUS_NETTED_POSITION");
    const links = getDb().prepare(`
      SELECT position_lifecycle_id, decision_id, linkage_status
      FROM paper_position_observation_links
      WHERE observation_id = ?
      ORDER BY position_lifecycle_id
    `).all(observation.observationId) as Array<Record<string, unknown>>;
    assert.equal(links.length, 2);
    assert.ok(links.every((link) => link.decision_id === null));
    assert.ok(
      links.every((link) => link.linkage_status === "AMBIGUOUS_NETTED_POSITION")
    );
    const positions = getDb().prepare(`
      SELECT position_lifecycle_id, linkage_status
      FROM paper_positions
      ORDER BY position_lifecycle_id
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      new Set(positions.map((row) => row.position_lifecycle_id)),
      new Set([first.result.positionLifecycleId, second.result.positionLifecycleId])
    );
    assert.ok(
      positions.every((row) => row.linkage_status === "AMBIGUOUS_NETTED_POSITION")
    );

    const exit = persistDecisionSnapshot({
      originType: "test_exit",
      originId: "netted-1-exit",
      decisionRole: "exit",
      positionLifecycleId: first.result.positionLifecycleId,
      decisionStatus: "REVIEWED",
      createdAt: "2026-07-13T15:30:00.000Z",
      symbol: "AAPL",
      reasonCodes: ["BROKER_POSITION_CLOSED"],
      dataQualityStatus: "COMPLETE",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });
    closePaperPositionFromFill({
      positionLifecycleId: first.result.positionLifecycleId,
      exitDecisionId: exit.decisionId,
      brokerOrderId: "broker-netted-exit",
      status: "filled",
      filledQuantity: 1,
      filledAveragePrice: 106,
      observedAt: "2026-07-13T15:30:00.000Z",
      exitReasonCode: "BROKER_POSITION_CLOSED"
    });
    const outcome = persistPaperPositionOutcome({
      positionLifecycleId: first.result.positionLifecycleId,
      exitReasonCode: "BROKER_POSITION_CLOSED"
    });
    assert.equal(outcome.completenessStatus, "AMBIGUOUS_LINEAGE");
    assert.equal(outcome.realizedReturnPct, null);
    assert.equal(outcome.mfePct, null);
  });

  test("calculates long excursions and timing from persisted observations only", () => {
    const opened = reconcileEntry({
      originId: "long-outcome",
      price: 100,
      quantity: 2,
      observedAt: "2026-07-13T14:00:00.000Z"
    });
    capturePaperPositionObservation({
      brokerSymbolKey: "AAPL",
      symbol: "AAPL",
      observedAt: "2026-07-13T14:30:00.000Z",
      mark: 110,
      quantity: 2,
      averageEntryPrice: 100,
      dataQualityStatus: "COMPLETE"
    });
    capturePaperPositionObservation({
      brokerSymbolKey: "AAPL",
      symbol: "AAPL",
      observedAt: "2026-07-13T15:00:00.000Z",
      mark: 90,
      quantity: 2,
      averageEntryPrice: 100,
      dataQualityStatus: "COMPLETE"
    });
    const exit = persistDecisionSnapshot({
      originType: "test_exit",
      originId: "long-outcome-exit",
      decisionRole: "exit",
      positionLifecycleId: opened.result.positionLifecycleId,
      decisionStatus: "REVIEWED",
      createdAt: "2026-07-13T15:30:00.000Z",
      symbol: "AAPL",
      reasonCodes: ["TAKE_PROFIT"],
      dataQualityStatus: "COMPLETE",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });
    closePaperPositionFromFill({
      positionLifecycleId: opened.result.positionLifecycleId,
      exitDecisionId: exit.decisionId,
      brokerOrderId: "broker-long-exit",
      status: "filled",
      filledQuantity: 2,
      filledAveragePrice: 105,
      observedAt: "2026-07-13T15:30:00.000Z",
      exitReasonCode: "TAKE_PROFIT"
    });
    const outcome = persistPaperPositionOutcome({
      positionLifecycleId: opened.result.positionLifecycleId,
      exitReasonCode: "TAKE_PROFIT"
    });
    const retry = persistPaperPositionOutcome({
      positionLifecycleId: opened.result.positionLifecycleId,
      exitReasonCode: "CHANGED_LATER"
    });

    assert.equal(outcome.outcomeId, retry.outcomeId);
    assert.equal(outcome.completenessStatus, "COMPLETE");
    assert.equal(outcome.realizedReturnPct, 5);
    assert.equal(outcome.realizedPnl, 10);
    assert.equal(outcome.mfePct, 10);
    assert.equal(outcome.maePct, -10);
    assert.equal(outcome.timeToMfeMs, 30 * 60 * 1000);
    assert.equal(outcome.timeToMaeMs, 60 * 60 * 1000);
    assert.equal(outcome.timeToFirstProfitMs, 30 * 60 * 1000);
    assert.equal(outcome.holdingDurationMs, 90 * 60 * 1000);
    assert.equal(outcome.maximumRunupPct, 20);
    assert.equal(outcome.maximumDrawdownPct, -20);
    assert.equal(retry.exitReasonCode, "TAKE_PROFIT");
  });

  test("keeps option-position and underlying-return bases separate", () => {
    const opened = reconcileEntry({
      originId: "option-outcome",
      symbol: "SPY260918C00600000",
      underlyingSymbol: "SPY",
      assetClass: "option",
      price: 5,
      underlyingPrice: 100,
      observedAt: "2026-07-13T14:00:00.000Z"
    });
    const exit = persistDecisionSnapshot({
      originType: "test_exit",
      originId: "option-outcome-exit",
      decisionRole: "exit",
      positionLifecycleId: opened.result.positionLifecycleId,
      decisionStatus: "REVIEWED",
      createdAt: "2026-07-13T15:00:00.000Z",
      symbol: "SPY",
      optionSymbol: "SPY260918C00600000",
      reasonCodes: ["OPTION_PROFIT_TARGET_REVIEW"],
      dataQualityStatus: "COMPLETE",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });
    closePaperPositionFromFill({
      positionLifecycleId: opened.result.positionLifecycleId,
      exitDecisionId: exit.decisionId,
      brokerOrderId: "broker-option-exit",
      status: "filled",
      filledQuantity: 1,
      filledAveragePrice: 10,
      underlyingPrice: 110,
      observedAt: "2026-07-13T15:00:00.000Z",
      exitReasonCode: "OPTION_PROFIT_TARGET_REVIEW"
    });
    const outcome = persistPaperPositionOutcome({
      positionLifecycleId: opened.result.positionLifecycleId,
      exitReasonCode: "OPTION_PROFIT_TARGET_REVIEW"
    });

    assert.equal(outcome.optionPositionReturnPct, 100);
    assert.equal(outcome.underlyingReturnPct, 10);
    assert.equal(outcome.realizedPnl, 500);
  });

  test("supports short-direction outcome calculations without changing execution gates", () => {
    const opened = reconcileEntry({
      originId: "short-outcome",
      side: "sell",
      price: 100,
      observedAt: "2026-07-13T14:00:00.000Z"
    });
    capturePaperPositionObservation({
      brokerSymbolKey: "AAPL",
      symbol: "AAPL",
      observedAt: "2026-07-13T14:30:00.000Z",
      mark: 90,
      quantity: 1,
      averageEntryPrice: 100,
      dataQualityStatus: "COMPLETE"
    });
    const exit = persistDecisionSnapshot({
      originType: "test_exit",
      originId: "short-outcome-exit",
      decisionRole: "exit",
      positionLifecycleId: opened.result.positionLifecycleId,
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
      positionLifecycleId: opened.result.positionLifecycleId,
      exitDecisionId: exit.decisionId,
      brokerOrderId: "broker-short-exit",
      status: "filled",
      filledQuantity: 1,
      filledAveragePrice: 80,
      observedAt: "2026-07-13T15:00:00.000Z",
      exitReasonCode: "TAKE_PROFIT"
    });
    const outcome = persistPaperPositionOutcome({
      positionLifecycleId: opened.result.positionLifecycleId,
      exitReasonCode: "TAKE_PROFIT"
    });
    assert.equal(outcome.realizedReturnPct, 20);
    assert.equal(outcome.realizedPnl, 20);
    assert.equal(outcome.mfePct, 20);
    assert.equal(outcome.maePct, 0);
  });

  test("withholds metrics for incomplete evidence and appends corrections", () => {
    const opened = reconcileEntry({ originId: "incomplete-outcome", price: 100 });
    getDb().prepare(`
      UPDATE paper_positions
      SET status = 'CLOSED', closed_at = '2026-07-13T15:00:00.000Z'
      WHERE position_lifecycle_id = ?
    `).run(opened.result.positionLifecycleId);
    const outcome = persistPaperPositionOutcome({
      positionLifecycleId: opened.result.positionLifecycleId,
      exitReasonCode: "BROKER_POSITION_CLOSED"
    });
    assert.equal(outcome.completenessStatus, "INSUFFICIENT_OBSERVATIONS");
    assert.equal(outcome.realizedReturnPct, null);
    assert.equal(outcome.mfePct, null);

    const firstRevision = appendPaperPositionOutcomeRevision({
      outcomeId: outcome.outcomeId,
      correctionReason: "LATE_BROKER_CONFIRMATION",
      correctedFields: { brokerStatus: "filled" }
    });
    const secondRevision = appendPaperPositionOutcomeRevision({
      outcomeId: outcome.outcomeId,
      correctionReason: "DATA_VENDOR_CORRECTION",
      correctedFields: { exitPrice: 101 }
    });
    assert.equal(firstRevision.revisionNumber, 1);
    assert.equal(secondRevision.revisionNumber, 2);
    assert.equal(secondRevision.supersedesRevisionId, firstRevision.revisionId);
    const original = getDb().prepare(`
      SELECT realized_return_pct, completeness_status
      FROM paper_position_outcomes WHERE outcome_id = ?
    `).get(outcome.outcomeId) as Record<string, unknown>;
    assert.equal(original.realized_return_pct, null);
    assert.equal(original.completeness_status, "INSUFFICIENT_OBSERVATIONS");
  });
});
