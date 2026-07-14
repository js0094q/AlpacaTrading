import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-execution-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

import { closeDbForTests, getDb } from "../src/lib/db.js";
import { loadZeroDteConfig } from "../src/services/zeroDte/zeroDteConfigService.js";
import {
  executeZeroDteCandidate,
  evaluateZeroDteExecutionEligibility,
  reconcileZeroDtePaperOrders,
  type ZeroDteAccountSnapshot,
  type ZeroDtePaperMutationProvider,
  type ZeroDteRuntimeSnapshot
} from "../src/services/zeroDte/zeroDteExecutionService.js";
import { insertZeroDteDecision } from "../src/services/zeroDte/zeroDteLifecycleService.js";
import type { ZeroDteQueueCandidate } from "../src/services/zeroDte/zeroDtePersistenceService.js";
import type { AlpacaPaperOrderRequest } from "../src/services/alpacaClient.js";
import { insertPaperExecutionLedgerEntry } from "../src/services/paperExecutionLedgerService.js";

const now = "2026-07-13T14:30:00.000Z";
const optionSymbol = "SPY260713C00500000";
const candidateId = "execution-candidate-1";
const decisionId = "execution-decision-1";
const config = loadZeroDteConfig({
  ZERO_DTE_MAX_CONTRACTS_PER_TRADE: "1",
  ZERO_DTE_MAX_PREMIUM_PER_TRADE: "250",
  ZERO_DTE_MAX_DAILY_PREMIUM: "750"
});

const runtime = (overrides: Partial<ZeroDteRuntimeSnapshot> = {}): ZeroDteRuntimeSnapshot => ({
  environment: "paper",
  tradingMode: "paper",
  paperOnly: true,
  liveTradingEnabled: false,
  engineEnabled: true,
  paperExecutionEnabled: true,
  paperOptionsExecutionEnabled: true,
  automatedPaperExecutionEnabled: true,
  paperAccountVerified: true,
  marketOpen: true,
  ...overrides
});

const account = (overrides: Partial<ZeroDteAccountSnapshot> = {}): ZeroDteAccountSnapshot => ({
  environment: "paper",
  paperVerified: true,
  status: "ACTIVE",
  buyingPower: 10_000,
  optionsBuyingPower: 10_000,
  optionApprovalLevel: 3,
  dailyTradeCount: 0,
  dailyPremium: 0,
  dailyRealizedLoss: 0,
  activityEvidenceComplete: true,
  activityEvidenceFingerprint: "test-activity-evidence",
  activityEvidenceBlockers: [],
  openPositionCount: 0,
  openOrderCount: 0,
  openExposureCount: 0,
  openPositions: [],
  openOrders: [],
  ...overrides
});

const candidate = (): ZeroDteQueueCandidate => ({
  candidateId,
  tradingDate: "2026-07-13",
  underlyingSymbol: "SPY",
  optionSymbol,
  playbook: "trend_continuation",
  direction: "bullish",
  expirationDate: "2026-07-13",
  strike: 500,
  state: "eligible",
  eligible: true,
  executable: true,
  rank: 1,
  totalScore: 86,
  score: 86,
  playbookScore: 84,
  signalStrengthAdjustment: 2,
  liquidityAdjustment: 0,
  regimeAdjustment: 0,
  executionQualityAdjustment: 0,
  riskPenalty: 0,
  staleDataPenalty: 0,
  confidence: 0.86,
  signalSlope: 3,
  shortWindowSlope: 3,
  mediumWindowSlope: 2,
  liquidityScore: 90,
  freshnessScore: 95,
  setupAgeSeconds: 60,
  quote: {
    bid: 1.2,
    ask: 1.3,
    midpoint: 1.25,
    premium: 1.25,
    spreadPct: 8,
    volume: 500,
    openInterest: 900,
    impliedVolatility: 0.3,
    delta: 0.5,
    gamma: 0.08,
    theta: -0.2,
    vega: 0.1,
    marketTimestamp: now
  },
  componentScores: {
    playbook: 84,
    signalStrength: 2,
    liquidity: 0,
    regime: 0,
    executionQuality: 0,
    riskPenalty: 0,
    staleDataPenalty: 0
  },
  blockers: [],
  reappearanceCount: 0,
  firstSeenAt: now,
  lastSeenAt: now
});

const seed = (input: {
  candidate?: ZeroDteQueueCandidate;
  decisionId?: string;
  configuration?: typeof config;
} = {}) => {
  const seededCandidate = input.candidate ?? candidate();
  const seededDecisionId = input.decisionId ?? decisionId;
  const seededConfig = input.configuration ?? config;
  const runId = `execution-run-${seededCandidate.candidateId}`;
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(seededConfig.configurationVersionId, seededConfig.strategyVersion, seededConfig.configurationVersionId, "{}", now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, seededCandidate.tradingDate, "test", "paper", "running", seededConfig.strategyVersion, seededConfig.configurationVersionId, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_candidates
      (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
       direction, expiration_date, strike, state, score, quote_bid, quote_ask,
       quote_midpoint, premium, spread_pct, volume, open_interest,
       market_timestamp, first_seen_at, last_seen_at, state_changed_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seededCandidate.candidateId,
    seededCandidate.tradingDate,
    seededCandidate.underlyingSymbol,
    seededCandidate.optionSymbol,
    seededCandidate.playbook,
    seededCandidate.direction,
    seededCandidate.expirationDate,
    seededCandidate.strike,
    seededCandidate.state,
    seededCandidate.totalScore,
    seededCandidate.quote.bid,
    seededCandidate.quote.ask,
    seededCandidate.quote.midpoint,
    seededCandidate.quote.premium,
    seededCandidate.quote.spreadPct,
    seededCandidate.quote.volume,
    seededCandidate.quote.openInterest,
    seededCandidate.quote.marketTimestamp,
    seededCandidate.firstSeenAt,
    seededCandidate.lastSeenAt,
    seededCandidate.lastSeenAt,
    seededCandidate.firstSeenAt,
    seededCandidate.lastSeenAt
  );
  if (!db.prepare("SELECT decision_id FROM zero_dte_decisions WHERE decision_id = ?").get(seededDecisionId)) {
    insertZeroDteDecision({
      decisionId: seededDecisionId,
      decisionGroupId: `execution-group-${seededCandidate.candidateId}`,
      engineRunId: runId,
      candidateId: seededCandidate.candidateId,
      tradingDate: seededCandidate.tradingDate,
      action: "select",
      accountMode: "paper",
      strategyVersion: seededConfig.strategyVersion,
      configurationVersionId: seededConfig.configurationVersionId,
      marketTimestamp: now,
      decidedAt: now,
      score: seededCandidate.totalScore,
      scoreThreshold: 70,
      reasonCodes: ["QUALIFIED"]
    });
  }
  return { candidate: seededCandidate, decisionId: seededDecisionId, configuration: seededConfig };
};

const scenarioCandidate = (input: {
  candidateId: string;
  optionSymbol: string;
  strike: number;
  quantity?: number;
}): ZeroDteQueueCandidate => ({
  ...candidate(),
  candidateId: input.candidateId,
  optionSymbol: input.optionSymbol,
  strike: input.strike,
  ...(input.quantity === undefined ? {} : { quantity: input.quantity })
});

const createPendingEntry = async (input: {
  candidate: ZeroDteQueueCandidate;
  decisionId: string;
  brokerOrderId: string;
  configuration?: typeof config;
}) => {
  const configuration = input.configuration ?? config;
  seed({ candidate: input.candidate, decisionId: input.decisionId, configuration });
  const result = await executeZeroDteCandidate({
    candidate: input.candidate,
    decisionId: input.decisionId,
    confirmPaper: true,
    provider: {
      config: configuration,
      runtime: runtime(),
      account: account(),
      now: () => now,
      submitPaperOrder: async (payload) => ({
        data: {
          id: input.brokerOrderId,
          client_order_id: payload.client_order_id,
          symbol: payload.symbol,
          qty: payload.qty,
          status: "accepted",
          filled_qty: "0"
        },
        requestId: `request-${input.brokerOrderId}`,
        status: 200,
        url: "paper"
      })
    }
  });
  assert.equal(result.status, "submitted");
  return result;
};

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("eligibility fails closed for non-paper, stale, crossed, duplicate, and capped state", () => {
  const result = evaluateZeroDteExecutionEligibility({
    candidate: candidate(),
    config,
    runtime: runtime({ environment: "live", tradingMode: "live", paperOnly: false, liveTradingEnabled: true }),
    account: account({ buyingPower: 10, optionsBuyingPower: 10, openPositions: [{ symbol: optionSymbol, quantity: 1 }] }),
    now,
    existingLedgerEntries: [{ dedupeKey: "2026-07-13:SPY260713C00500000:entry", status: "reserved" }]
  });

  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("ACCOUNT_NOT_PAPER"));
  assert.ok(result.blockers.includes("DUPLICATE_EXPOSURE"));
  assert.ok(result.blockers.includes("BUYING_POWER"));
  assert.ok(result.blockers.includes("DUPLICATE_ORDER"));
});

test("selected engine candidates remain eligible for the guarded execution step", () => {
  const result = evaluateZeroDteExecutionEligibility({
    candidate: { ...candidate(), state: "selected" },
    config,
    runtime: runtime(),
    account: account(),
    now
  });

  assert.equal(result.eligible, true);
  assert.doesNotMatch(result.blockers.join(","), /CANDIDATE_NOT_ELIGIBLE/);
});

test("unrelated equity and long-dated option positions do not consume the 0DTE position cap", () => {
  const result = evaluateZeroDteExecutionEligibility({
    candidate: candidate(),
    config,
    runtime: runtime(),
    account: account({
      openPositions: [
        { symbol: "CVS", quantity: 30 },
        { symbol: "RSP", quantity: 15 },
        { symbol: "SPY270115C00805000", quantity: 1 },
        { symbol: "QQQ270115C00825000", quantity: 1 }
      ]
    }),
    now
  });

  assert.equal(result.eligible, true);
  assert.doesNotMatch(result.blockers.join(","), /MAX_OPEN_0DTE_POSITIONS/);
});

test("eligibility fails closed when any daily activity counter lacks complete evidence", () => {
  const missingPremium = evaluateZeroDteExecutionEligibility({
    candidate: candidate(),
    config,
    runtime: runtime(),
    account: account({ dailyPremium: null }),
    now
  });
  const incomplete = evaluateZeroDteExecutionEligibility({
    candidate: candidate(),
    config,
    runtime: runtime(),
    account: account({
      activityEvidenceComplete: false,
      activityEvidenceBlockers: ["ZERO_DTE_REALIZED_LOSS_EVIDENCE_REQUIRED"]
    }),
    now
  });

  assert.equal(missingPremium.eligible, false);
  assert.ok(missingPremium.blockers.includes("ZERO_DTE_DAILY_COUNTER_EVIDENCE_REQUIRED"));
  assert.equal(incomplete.eligible, false);
  assert.ok(incomplete.blockers.includes("ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE"));
  assert.ok(incomplete.blockers.includes("ZERO_DTE_REALIZED_LOSS_EVIDENCE_REQUIRED"));
});

test("active 0DTE order symbols consume the shared open-exposure cap", () => {
  const result = evaluateZeroDteExecutionEligibility({
    candidate: candidate(),
    config: { ...config, maxOpenPositions: 2 },
    runtime: runtime(),
    account: account({
      openPositionCount: 1,
      openOrderCount: 2,
      openExposureCount: 2,
      openPositions: [{ symbol: "QQQ260713C00500000", quantity: 1 }],
      openOrders: [
        { symbol: "QQQ260713C00500000", status: "accepted" },
        { symbol: "IWM260713C00200000", status: "accepted" }
      ]
    }),
    now
  });

  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("MAX_OPEN_0DTE_POSITIONS"));
});

test("execution derives complete daily counters from broker and persisted evidence", async () => {
  const evidenceCandidate = scenarioCandidate({
    candidateId: "execution-candidate-activity-evidence",
    optionSymbol: "SPY260713C00590000",
    strike: 590
  });
  const evidenceDecisionId = "execution-decision-activity-evidence";
  seed({ candidate: evidenceCandidate, decisionId: evidenceDecisionId });
  let brokerCalls = 0;
  const emptyResponse = <T>(data: T) => ({ data, status: 200, url: "paper" });

  const result = await executeZeroDteCandidate({
    candidate: evidenceCandidate,
    decisionId: evidenceDecisionId,
    confirmPaper: true,
    provider: {
      config,
      runtime: runtime(),
      now: () => now,
      getAccount: async () => emptyResponse({
        id: "paper-account",
        status: "ACTIVE",
        buying_power: "10000",
        options_buying_power: "10000",
        equity: "10000",
        options_approved_level: 3
      }),
      listPositions: async () => emptyResponse([]),
      listOrders: async () => emptyResponse([]),
      submitPaperOrder: async (payload) => {
        brokerCalls += 1;
        return emptyResponse({
          id: "paper-order-activity-evidence",
          client_order_id: payload.client_order_id,
          symbol: payload.symbol,
          qty: payload.qty,
          status: "accepted",
          filled_qty: "0"
        });
      }
    }
  });

  if (result.paperTradeId) {
    getDb().prepare("DELETE FROM zero_dte_lifecycle_events WHERE paper_trade_id = ?").run(result.paperTradeId);
    getDb().prepare("DELETE FROM zero_dte_paper_trades WHERE paper_trade_id = ?").run(result.paperTradeId);
  }
  if (result.ledgerId) {
    getDb().prepare("DELETE FROM paper_execution_ledger WHERE id = ?").run(result.ledgerId);
  }

  assert.equal(result.status, "submitted");
  assert.equal(brokerCalls, 1);
  assert.equal(result.eligibility?.evidence.activityEvidenceComplete, true);
  assert.equal(result.eligibility?.evidence.dailyTradeCount, 0);
  assert.match(
    String(result.eligibility?.evidence.activityEvidenceFingerprint),
    /^[a-f0-9]{64}$/
  );
});

test("blocked runtime records no order mutation", async () => {
  seed();
  let brokerCalls = 0;
  const provider: ZeroDtePaperMutationProvider = {
    config,
    runtime: runtime({ paperExecutionEnabled: false }),
    account: account(),
    now: () => now,
    submitPaperOrder: async () => {
      brokerCalls += 1;
      throw new Error("must not submit");
    }
  };

  const result = await executeZeroDteCandidate({
    candidate: candidate(),
    decisionId,
    confirmPaper: true,
    provider
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.mutationAttempted, false);
  assert.equal(brokerCalls, 0);
  assert.ok(result.blockers.includes("EXECUTION_DISABLED"));
  assert.equal(
    (getDb().prepare("SELECT blocked_reason FROM paper_execution_ledger WHERE source_candidate_id = ?").get(candidateId) as { blocked_reason: string }).blocked_reason,
    "EXECUTION_DISABLED"
  );
});

test("a terminal reservation creates a fresh exact ledger for a new 0DTE candidate", async () => {
  const retryCandidate = scenarioCandidate({
    candidateId: "execution-candidate-fresh-ledger",
    optionSymbol: "SPY260713C00512000",
    strike: 512
  });
  const retryDecisionId = "execution-decision-fresh-ledger";
  seed({ candidate: retryCandidate, decisionId: retryDecisionId });
  const reservationKey = `${retryCandidate.tradingDate}:${retryCandidate.optionSymbol}:entry`;
  const staleLedger = insertPaperExecutionLedgerEntry({
    mode: "zero-dte-entry",
    assetClass: "option",
    symbol: retryCandidate.optionSymbol,
    underlyingSymbol: retryCandidate.underlyingSymbol,
    strategy: "zero_dte_level_2",
    side: "buy",
    orderType: "limit",
    timeInForce: "day",
    qty: "1",
    limitPrice: "1.10",
    estimatedPremium: 110,
    maxRisk: 110,
    dedupeKey: reservationKey,
    clientOrderId: "stale-terminal-client-order-id",
    status: "failed",
    sourceCandidateId: "stale-terminal-candidate",
    payload: { candidateId: "stale-terminal-candidate" }
  });

  const result = await executeZeroDteCandidate({
    candidate: retryCandidate,
    decisionId: retryDecisionId,
    confirmPaper: true,
    provider: {
      config,
      runtime: runtime(),
      account: account(),
      now: () => now,
      submitPaperOrder: async (payload) => ({
        data: {
          id: "paper-order-fresh-ledger",
          client_order_id: payload.client_order_id,
          symbol: payload.symbol,
          qty: payload.qty,
          status: "accepted",
          filled_qty: "0"
        },
        requestId: "paper-request-fresh-ledger",
        status: 200,
        url: "paper"
      })
    }
  });

  const resultLedger = { ...getDb().prepare(
    `SELECT client_order_id, source_candidate_id, decision_id,
            decision_linkage_status, status
     FROM paper_execution_ledger
     WHERE id = ?`
  ).get(result.ledgerId) as Record<string, unknown> };
  const preservedStaleLedger = { ...getDb().prepare(
      `SELECT client_order_id, source_candidate_id, status
       FROM paper_execution_ledger
       WHERE id = ?`
    ).get(staleLedger.id) as Record<string, unknown> };
  if (result.paperTradeId) {
    getDb().prepare("DELETE FROM zero_dte_lifecycle_events WHERE paper_trade_id = ?").run(result.paperTradeId);
    getDb().prepare("DELETE FROM zero_dte_paper_trades WHERE paper_trade_id = ?").run(result.paperTradeId);
  }
  getDb().prepare("DELETE FROM paper_execution_ledger WHERE id IN (?, ?)").run(result.ledgerId, staleLedger.id);

  assert.equal(result.status, "submitted");
  assert.notEqual(result.ledgerId, staleLedger.id);
  assert.deepEqual(resultLedger, {
    client_order_id: result.clientOrderId,
    source_candidate_id: retryCandidate.candidateId,
    decision_id: retryDecisionId,
    decision_linkage_status: "EXACT",
    status: "submitted"
  });
  assert.deepEqual(
    preservedStaleLedger,
    {
      client_order_id: "stale-terminal-client-order-id",
      source_candidate_id: "stale-terminal-candidate",
      status: "failed"
    }
  );
});

test("reconciliation relinks a submitted 0DTE trade only from exact broker identity", async () => {
  const recoveryCandidate = scenarioCandidate({
    candidateId: "execution-candidate-ledger-recovery",
    optionSymbol: "SPY260713C00513000",
    strike: 513
  });
  const recoveryDecisionId = "execution-decision-ledger-recovery";
  const recoveryPaperTradeId = "execution-paper-trade-ledger-recovery";
  const recoveryClientOrderId = "recovery-client-order-id";
  const recoveryBrokerOrderId = "recovery-broker-order-id";
  seed({ candidate: recoveryCandidate, decisionId: recoveryDecisionId });
  const staleLedger = insertPaperExecutionLedgerEntry({
    mode: "zero-dte-entry",
    assetClass: "option",
    symbol: recoveryCandidate.optionSymbol,
    underlyingSymbol: recoveryCandidate.underlyingSymbol,
    strategy: "zero_dte_level_2",
    side: "buy",
    orderType: "limit",
    timeInForce: "day",
    qty: "1",
    limitPrice: "1.11",
    estimatedPremium: 111,
    maxRisk: 111,
    dedupeKey: `${recoveryCandidate.tradingDate}:${recoveryCandidate.optionSymbol}:entry`,
    clientOrderId: "stale-recovery-client-order-id",
    status: "failed",
    sourceCandidateId: "stale-recovery-candidate",
    payload: { candidateId: "stale-recovery-candidate" }
  });
  getDb().prepare(
    `UPDATE paper_execution_ledger
     SET alpaca_order_id = ?, alpaca_status = 'pending_new'
     WHERE id = ?`
  ).run(recoveryBrokerOrderId, staleLedger.id);
  getDb().prepare(
    `INSERT INTO zero_dte_paper_trades
      (paper_trade_id, decision_id, candidate_id, trading_date, underlying_symbol,
       option_symbol, playbook, direction, status, client_order_id, broker_order_id,
       source_ledger_id, quantity, entry_premium, fees, slippage, entry_quote_json,
       requested_at, submitted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, 1, 1.25, 0, 0, '{}', ?, ?, ?, ?)`
  ).run(
    recoveryPaperTradeId,
    recoveryDecisionId,
    recoveryCandidate.candidateId,
    recoveryCandidate.tradingDate,
    recoveryCandidate.underlyingSymbol,
    recoveryCandidate.optionSymbol,
    recoveryCandidate.playbook,
    recoveryCandidate.direction,
    recoveryClientOrderId,
    recoveryBrokerOrderId,
    staleLedger.id,
    now,
    now,
    now,
    now
  );
  const filledAt = "2026-07-13T14:30:10.000Z";

  const rejectedRelink = await reconcileZeroDtePaperOrders({
    now: "2026-07-13T14:30:09.000Z",
    provider: {
      runtime: runtime(),
      getOrder: async () => ({
        data: {
          id: recoveryBrokerOrderId,
          client_order_id: "different-broker-client-order-id",
          symbol: recoveryCandidate.optionSymbol,
          side: "buy",
          position_intent: "buy_to_open",
          type: "limit",
          time_in_force: "day",
          qty: "1",
          limit_price: "1.20",
          status: "filled",
          filled_qty: "1",
          filled_avg_price: "1.20",
          filled_at: filledAt
        },
        requestId: "paper-request-ledger-recovery-mismatch",
        status: 200,
        url: "paper"
      })
    }
  });
  assert.equal(rejectedRelink.linkageUpdated, 0);
  assert.equal(rejectedRelink.errors[0]?.message, "BROKER_CLIENT_ORDER_ID_MISMATCH");
  assert.equal(
    (getDb().prepare(
      "SELECT source_ledger_id FROM zero_dte_paper_trades WHERE paper_trade_id = ?"
    ).get(recoveryPaperTradeId) as { source_ledger_id: number }).source_ledger_id,
    staleLedger.id
  );

  const reconciliation = await reconcileZeroDtePaperOrders({
    now: filledAt,
    provider: {
      runtime: runtime(),
      getOrder: async () => ({
        data: {
          id: recoveryBrokerOrderId,
          client_order_id: recoveryClientOrderId,
          symbol: recoveryCandidate.optionSymbol,
          side: "buy",
          position_intent: "buy_to_open",
          type: "limit",
          time_in_force: "day",
          qty: "1",
          limit_price: "1.20",
          status: "filled",
          filled_qty: "1",
          filled_avg_price: "1.20",
          filled_at: filledAt
        },
        requestId: "paper-request-ledger-recovery",
        status: 200,
        url: "paper"
      })
    }
  });

  const repairedTrade = getDb().prepare(
    `SELECT status, source_ledger_id, quantity, entry_premium, filled_at
     FROM zero_dte_paper_trades
     WHERE paper_trade_id = ?`
  ).get(recoveryPaperTradeId) as {
    status: string;
    source_ledger_id: number;
    quantity: number;
    entry_premium: number;
    filled_at: string;
  };
  const repairedLedger = { ...getDb().prepare(
      `SELECT client_order_id, alpaca_order_id, alpaca_status,
              source_candidate_id, decision_id, decision_linkage_status, status
       FROM paper_execution_ledger
       WHERE id = ?`
    ).get(repairedTrade.source_ledger_id) as Record<string, unknown> };
  const preservedStaleLedger = { ...getDb().prepare(
    `SELECT client_order_id, source_candidate_id, status
     FROM paper_execution_ledger
     WHERE id = ?`
  ).get(staleLedger.id) as Record<string, unknown> };
  getDb().prepare("DELETE FROM zero_dte_lifecycle_events WHERE paper_trade_id = ?").run(recoveryPaperTradeId);
  getDb().prepare("DELETE FROM zero_dte_paper_trades WHERE paper_trade_id = ?").run(recoveryPaperTradeId);
  getDb().prepare("DELETE FROM paper_execution_ledger WHERE id IN (?, ?)").run(
    repairedTrade.source_ledger_id,
    staleLedger.id
  );

  assert.equal(reconciliation.filled, 1);
  assert.equal(reconciliation.linkageUpdated, 1);
  assert.deepEqual(reconciliation.errors, []);
  assert.equal(repairedTrade.status, "open");
  assert.notEqual(repairedTrade.source_ledger_id, staleLedger.id);
  assert.equal(repairedTrade.quantity, 1);
  assert.equal(repairedTrade.entry_premium, 1.2);
  assert.equal(repairedTrade.filled_at, filledAt);
  assert.deepEqual(
    repairedLedger,
    {
      client_order_id: recoveryClientOrderId,
      alpaca_order_id: recoveryBrokerOrderId,
      alpaca_status: "filled",
      source_candidate_id: recoveryCandidate.candidateId,
      decision_id: recoveryDecisionId,
      decision_linkage_status: "EXACT",
      status: "filled"
    }
  );
  assert.deepEqual(
    preservedStaleLedger,
    {
      client_order_id: "stale-recovery-client-order-id",
      source_candidate_id: "stale-recovery-candidate",
      status: "failed"
    }
  );
});

test("qualified paper entry links its decision, reconciles a fill, and is idempotent", async () => {
  seed();
  const submitted: AlpacaPaperOrderRequest[] = [];
  const provider: ZeroDtePaperMutationProvider = {
    config,
    runtime: runtime(),
    account: account(),
    now: () => now,
    submitPaperOrder: async (payload) => {
      submitted.push(payload);
      return {
        data: {
          id: "paper-order-1",
          client_order_id: payload.client_order_id,
          symbol: payload.symbol,
          status: "accepted"
        },
        requestId: "paper-request-1",
        status: 200,
        url: "paper"
      };
    }
  };

  const first = await executeZeroDteCandidate({ candidate: candidate(), decisionId, confirmPaper: true, provider });
  const second = await executeZeroDteCandidate({ candidate: candidate(), decisionId, confirmPaper: true, provider });

  assert.equal(first.status, "submitted");
  assert.equal(first.paperTradeId, `zpt_${first.paperTradeId?.slice(4)}`);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.position_intent, "buy_to_open");
  assert.equal(submitted[0]?.type, "limit");
  assert.equal(second.status, "duplicate_blocked");
  assert.equal(second.mutationAttempted, false);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_paper_trades").get() as { count: number }).count,
    1
  );
  assert.ok(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_lifecycle_events WHERE event_type = 'paper_order_requested'").get() as { count: number }).count >= 1
  );

  const linkedLedger = getDb().prepare(
    `SELECT decision_id, decision_linkage_status
     FROM paper_execution_ledger
     WHERE source_candidate_id = ?`
  ).get(candidateId) as { decision_id: string | null; decision_linkage_status: string };
  assert.equal(linkedLedger.decision_id, decisionId);
  assert.equal(linkedLedger.decision_linkage_status, "EXACT");

  let nonPaperBrokerCalls = 0;
  const nonPaper = await reconcileZeroDtePaperOrders({
    now,
    provider: {
      runtime: runtime({
        environment: "live",
        tradingMode: "live",
        paperOnly: false,
        liveTradingEnabled: true
      }),
      getOrder: async () => {
        nonPaperBrokerCalls += 1;
        throw new Error("must not query a live order");
      }
    }
  });
  assert.equal(nonPaperBrokerCalls, 0);
  assert.equal(nonPaper.checked, 0);
  assert.deepEqual(nonPaper.errors.map((error) => error.code), ["ACCOUNT_NOT_PAPER"]);

  const filledAt = "2026-07-13T14:30:05.000Z";
  const reconciliation = await reconcileZeroDtePaperOrders({
    now: filledAt,
    provider: {
      runtime: runtime(),
      getOrder: async (orderId) => {
        assert.equal(orderId, "paper-order-1");
        return {
          data: {
            id: orderId,
            client_order_id: first.clientOrderId,
            symbol: optionSymbol,
            status: "filled",
            filled_qty: "1",
            filled_avg_price: "1.21",
            filled_at: filledAt
          },
          requestId: "paper-fill-request-1",
          status: 200,
          url: "paper"
        };
      }
    }
  });

  assert.deepEqual(
    {
      checked: reconciliation.checked,
      updated: reconciliation.updated,
      filled: reconciliation.filled,
      errors: reconciliation.errors
    },
    { checked: 1, updated: 1, filled: 1, errors: [] }
  );
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, quantity, entry_premium, filled_at, terminal_state
       FROM zero_dte_paper_trades
       WHERE paper_trade_id = ?`
    ).get(first.paperTradeId) as Record<string, unknown> },
    {
      status: "open",
      quantity: 1,
      entry_premium: 1.21,
      filled_at: filledAt,
      terminal_state: null
    }
  );
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, alpaca_status, decision_id, decision_linkage_status
       FROM paper_execution_ledger
       WHERE source_candidate_id = ?`
    ).get(candidateId) as Record<string, unknown> },
    {
      status: "filled",
      alpaca_status: "filled",
      decision_id: decisionId,
      decision_linkage_status: "EXACT"
    }
  );
  assert.equal(
    (getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM zero_dte_lifecycle_events
       WHERE paper_trade_id = ?
         AND event_type IN ('paper_order_filled', 'position_opened')`
    ).get(first.paperTradeId) as { count: number }).count,
    2
  );

  const repeated = await reconcileZeroDtePaperOrders({
    now: "2026-07-13T14:30:10.000Z",
    provider: {
      runtime: runtime(),
      getOrder: async () => {
        throw new Error("an open trade must not be reconciled twice");
      }
    }
  });
  assert.equal(repeated.checked, 0);
  assert.equal(repeated.updated, 0);
});

test("immediate broker fills persist verified actual quantity, premium, and time", async () => {
  const immediateCandidate = scenarioCandidate({
    candidateId: "execution-candidate-immediate-fill",
    optionSymbol: "SPY260713C00501000",
    strike: 501
  });
  const immediateDecisionId = "execution-decision-immediate-fill";
  const filledAt = "2026-07-13T14:30:01.000Z";
  seed({ candidate: immediateCandidate, decisionId: immediateDecisionId });

  const result = await executeZeroDteCandidate({
    candidate: immediateCandidate,
    decisionId: immediateDecisionId,
    confirmPaper: true,
    provider: {
      config,
      runtime: runtime(),
      account: account(),
      now: () => now,
      submitPaperOrder: async (payload) => ({
        data: {
          id: "paper-order-immediate-fill",
          client_order_id: payload.client_order_id,
          symbol: payload.symbol,
          qty: payload.qty,
          status: "filled",
          filled_qty: "1",
          filled_avg_price: "1.19",
          filled_at: filledAt
        },
        requestId: "paper-request-immediate-fill",
        status: 200,
        url: "paper"
      })
    }
  });

  assert.equal(result.status, "filled");
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, quantity, entry_premium, filled_at
       FROM zero_dte_paper_trades
       WHERE paper_trade_id = ?`
    ).get(result.paperTradeId) as Record<string, unknown> },
    { status: "open", quantity: 1, entry_premium: 1.19, filled_at: filledAt }
  );
  const reconciliation = await reconcileZeroDtePaperOrders({
    now: "2026-07-13T14:30:10.000Z",
    provider: {
      runtime: runtime(),
      getOrder: async () => {
        throw new Error("an immediate fill must already be terminalized locally");
      }
    }
  });
  assert.equal(reconciliation.checked, 0);
});

test("invalid immediate fill evidence stays recoverable through exact reconciliation", async () => {
  const recoverableCandidate = scenarioCandidate({
    candidateId: "execution-candidate-recoverable-fill",
    optionSymbol: "SPY260713C00508000",
    strike: 508
  });
  const recoverableDecisionId = "execution-decision-recoverable-fill";
  const brokerOrderId = "paper-order-recoverable-fill";
  seed({ candidate: recoverableCandidate, decisionId: recoverableDecisionId });

  const result = await executeZeroDteCandidate({
    candidate: recoverableCandidate,
    decisionId: recoverableDecisionId,
    confirmPaper: true,
    provider: {
      config,
      runtime: runtime(),
      account: account(),
      now: () => now,
      submitPaperOrder: async (payload) => ({
        data: {
          id: brokerOrderId,
          client_order_id: payload.client_order_id,
          symbol: payload.symbol,
          qty: payload.qty,
          status: "filled",
          filled_qty: "1",
          filled_at: "2026-07-13T14:30:02.000Z"
        },
        requestId: "paper-request-recoverable-invalid",
        status: 200,
        url: "paper"
      })
    }
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.blockers, ["BROKER_ORDER_EVIDENCE_INVALID"]);
  assert.ok(result.paperTradeId);
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, broker_order_id, entry_premium, filled_at
       FROM zero_dte_paper_trades
       WHERE paper_trade_id = ?`
    ).get(result.paperTradeId) as Record<string, unknown> },
    { status: "submitted", broker_order_id: brokerOrderId, entry_premium: 1.25, filled_at: null }
  );
  assert.equal(
    (getDb().prepare("SELECT status FROM paper_execution_ledger WHERE id = ?").get(result.ledgerId) as { status: string }).status,
    "failed"
  );

  const filledAt = "2026-07-13T14:30:03.000Z";
  const reconciliation = await reconcileZeroDtePaperOrders({
    now: filledAt,
    provider: {
      runtime: runtime(),
      getOrder: async () => ({
        data: {
          id: brokerOrderId,
          client_order_id: result.clientOrderId,
          symbol: recoverableCandidate.optionSymbol,
          qty: "1",
          status: "filled",
          filled_qty: "1",
          filled_avg_price: "1.18",
          filled_at: filledAt
        },
        requestId: "paper-request-recoverable-valid",
        status: 200,
        url: "paper"
      })
    }
  });
  assert.equal(reconciliation.filled, 1);
  assert.deepEqual(reconciliation.errors, []);
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, quantity, entry_premium, filled_at
       FROM zero_dte_paper_trades
       WHERE paper_trade_id = ?`
    ).get(result.paperTradeId) as Record<string, unknown> },
    { status: "open", quantity: 1, entry_premium: 1.18, filled_at: filledAt }
  );
});

test("stale concurrent pending and partial responses cannot regress a confirmed fill", async () => {
  const twoContractConfig = loadZeroDteConfig({
    ZERO_DTE_MAX_CONTRACTS_PER_TRADE: "2",
    ZERO_DTE_MAX_PREMIUM_PER_TRADE: "500",
    ZERO_DTE_MAX_DAILY_PREMIUM: "1000"
  });
  const scenarios = [
    { name: "stale-pending", status: "accepted", strike: 509 },
    { name: "stale-partial", status: "partially_filled", strike: 510 }
  ] as const;

  for (const scenario of scenarios) {
    const scenarioOptionSymbol = `SPY260713C${String(scenario.strike * 1_000).padStart(8, "0")}`;
    const pending = await createPendingEntry({
      candidate: scenarioCandidate({
        candidateId: `execution-candidate-${scenario.name}`,
        optionSymbol: scenarioOptionSymbol,
        strike: scenario.strike,
        quantity: 2
      }),
      decisionId: `execution-decision-${scenario.name}`,
      brokerOrderId: `paper-order-${scenario.name}`,
      configuration: twoContractConfig
    });
    assert.ok(pending.paperTradeId);
    assert.ok(pending.ledgerId);

    let releaseStaleResponse: (() => void) | undefined;
    let markStaleRequestStarted: (() => void) | undefined;
    const staleRequestStarted = new Promise<void>((resolve) => {
      markStaleRequestStarted = resolve;
    });
    const staleResponseGate = new Promise<void>((resolve) => {
      releaseStaleResponse = resolve;
    });
    const staleFilledAt = "2026-07-13T14:30:04.000Z";
    const staleReconciliation = reconcileZeroDtePaperOrders({
      now: "2026-07-13T14:30:06.000Z",
      provider: {
        runtime: runtime(),
        getOrder: async () => {
          markStaleRequestStarted?.();
          await staleResponseGate;
          return {
            data: {
              id: pending.brokerOrderId ?? undefined,
              client_order_id: pending.clientOrderId,
              symbol: scenarioOptionSymbol,
              qty: "2",
              status: scenario.status,
              filled_qty: scenario.status === "accepted" ? "0" : "1",
              filled_avg_price: scenario.status === "accepted" ? undefined : "1.10",
              filled_at: scenario.status === "accepted" ? undefined : staleFilledAt
            },
            requestId: `request-${scenario.name}`,
            status: 200,
            url: "paper"
          };
        }
      }
    });
    await staleRequestStarted;

    const filledAt = "2026-07-13T14:30:05.000Z";
    const filledReconciliation = await reconcileZeroDtePaperOrders({
      now: filledAt,
      provider: {
        runtime: runtime(),
        getOrder: async () => ({
          data: {
            id: pending.brokerOrderId ?? undefined,
            client_order_id: pending.clientOrderId,
            symbol: scenarioOptionSymbol,
            qty: "2",
            status: "filled",
            filled_qty: "2",
            filled_avg_price: "1.20",
            filled_at: filledAt
          },
          requestId: `request-${scenario.name}-filled`,
          status: 200,
          url: "paper"
        })
      }
    });
    assert.equal(filledReconciliation.filled, 1);
    assert.deepEqual(filledReconciliation.errors, []);

    releaseStaleResponse?.();
    const staleResult = await staleReconciliation;
    assert.equal(staleResult.updated, 0);
    assert.deepEqual(staleResult.errors, []);
    assert.deepEqual(
      { ...getDb().prepare(
        `SELECT status, quantity, entry_premium, filled_at
         FROM zero_dte_paper_trades
         WHERE paper_trade_id = ?`
      ).get(pending.paperTradeId) as Record<string, unknown> },
      { status: "open", quantity: 2, entry_premium: 1.2, filled_at: filledAt }
    );
    assert.equal(
      (getDb().prepare("SELECT status FROM paper_execution_ledger WHERE id = ?").get(pending.ledgerId) as { status: string }).status,
      "filled"
    );
    assert.equal(
      (getDb().prepare(
        `SELECT COUNT(*) AS count
         FROM zero_dte_lifecycle_events
         WHERE paper_trade_id = ? AND event_type = 'paper_order_partially_filled'`
      ).get(pending.paperTradeId) as { count: number }).count,
      0
    );
  }

  const terminalRegressionSymbol = "SPY260713C00511000";
  const threeContractConfig = loadZeroDteConfig({
    ZERO_DTE_MAX_CONTRACTS_PER_TRADE: "3",
    ZERO_DTE_MAX_PREMIUM_PER_TRADE: "750",
    ZERO_DTE_MAX_DAILY_PREMIUM: "1500"
  });
  const terminalRegression = await createPendingEntry({
    candidate: scenarioCandidate({
      candidateId: "execution-candidate-terminal-regression",
      optionSymbol: terminalRegressionSymbol,
      strike: 511,
      quantity: 3
    }),
    decisionId: "execution-decision-terminal-regression",
    brokerOrderId: "paper-order-terminal-regression",
    configuration: threeContractConfig
  });
  assert.ok(terminalRegression.paperTradeId);
  assert.ok(terminalRegression.ledgerId);
  const partialAt = "2026-07-13T14:30:07.000Z";
  const partial = await reconcileZeroDtePaperOrders({
    now: partialAt,
    provider: {
      runtime: runtime(),
      getOrder: async () => ({
        data: {
          id: terminalRegression.brokerOrderId ?? undefined,
          client_order_id: terminalRegression.clientOrderId,
          symbol: terminalRegressionSymbol,
          qty: "3",
          status: "partially_filled",
          filled_qty: "2",
          filled_avg_price: "1.15",
          filled_at: partialAt
        },
        status: 200,
        url: "paper"
      })
    }
  });
  assert.equal(partial.partial, 1);
  const lowerFillTerminal = await reconcileZeroDtePaperOrders({
    now: "2026-07-13T14:30:08.000Z",
    provider: {
      runtime: runtime(),
      getOrder: async () => ({
        data: {
          id: terminalRegression.brokerOrderId ?? undefined,
          client_order_id: terminalRegression.clientOrderId,
          symbol: terminalRegressionSymbol,
          qty: "3",
          status: "expired",
          filled_qty: "1",
          filled_avg_price: "1.14",
          filled_at: partialAt
        },
        status: 200,
        url: "paper"
      })
    }
  });
  assert.equal(lowerFillTerminal.updated, 0);
  assert.deepEqual(lowerFillTerminal.errors, []);
  const zeroFillTerminal = await reconcileZeroDtePaperOrders({
    now: "2026-07-13T14:30:09.000Z",
    provider: {
      runtime: runtime(),
      getOrder: async () => ({
        data: {
          id: terminalRegression.brokerOrderId ?? undefined,
          client_order_id: terminalRegression.clientOrderId,
          symbol: terminalRegressionSymbol,
          qty: "3",
          status: "canceled",
          filled_qty: "0"
        },
        status: 200,
        url: "paper"
      })
    }
  });
  assert.equal(zeroFillTerminal.updated, 0);
  assert.deepEqual(zeroFillTerminal.errors, []);
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, quantity, entry_premium, filled_at
       FROM zero_dte_paper_trades
       WHERE paper_trade_id = ?`
    ).get(terminalRegression.paperTradeId) as Record<string, unknown> },
    { status: "partially_filled", quantity: 2, entry_premium: 1.15, filled_at: partialAt }
  );
  assert.equal(
    (getDb().prepare("SELECT status FROM paper_execution_ledger WHERE id = ?").get(terminalRegression.ledgerId) as { status: string }).status,
    "partial"
  );
  getDb().prepare(
    "UPDATE zero_dte_paper_trades SET status = 'open' WHERE paper_trade_id = ?"
  ).run(terminalRegression.paperTradeId);
});

test("reconciliation fails closed on invalid fill evidence and handles terminal orders", async () => {
  const scenarios = [
    ["missing-price", "SPY260713C00502000", 502],
    ["zero-quantity", "SPY260713C00503000", 503],
    ["malformed-time", "SPY260713C00504000", 504],
    ["identity-mismatch", "SPY260713C00505000", 505],
    ["canceled", "SPY260713C00506000", 506]
  ] as const;
  const pending = new Map<string, Awaited<ReturnType<typeof createPendingEntry>>>();
  for (const [name, symbol, strike] of scenarios) {
    pending.set(name, await createPendingEntry({
      candidate: scenarioCandidate({
        candidateId: `execution-candidate-${name}`,
        optionSymbol: symbol,
        strike
      }),
      decisionId: `execution-decision-${name}`,
      brokerOrderId: `paper-order-${name}`
    }));
  }

  const twoContractConfig = loadZeroDteConfig({
    ZERO_DTE_MAX_CONTRACTS_PER_TRADE: "2",
    ZERO_DTE_MAX_PREMIUM_PER_TRADE: "500",
    ZERO_DTE_MAX_DAILY_PREMIUM: "1000"
  });
  const partialTerminal = await createPendingEntry({
    candidate: scenarioCandidate({
      candidateId: "execution-candidate-partial-terminal",
      optionSymbol: "SPY260713C00507000",
      strike: 507,
      quantity: 2
    }),
    decisionId: "execution-decision-partial-terminal",
    brokerOrderId: "paper-order-partial-terminal",
    configuration: twoContractConfig
  });

  const filledAt = "2026-07-13T14:31:00.000Z";
  const reconciliation = await reconcileZeroDtePaperOrders({
    now: filledAt,
    provider: {
      runtime: runtime(),
      getOrder: async (orderId) => {
        const name = orderId.replace("paper-order-", "");
        const result = name === "partial-terminal" ? partialTerminal : pending.get(name);
        assert.ok(result);
        const base = {
          id: orderId,
          client_order_id: result.clientOrderId,
          symbol: name === "partial-terminal"
            ? "SPY260713C00507000"
            : scenarios.find(([scenario]) => scenario === name)?.[1],
          filled_qty: "1",
          filled_avg_price: "1.11",
          filled_at: filledAt
        };
        if (name === "missing-price") return { data: { ...base, filled_avg_price: undefined, status: "filled" }, status: 200, url: "paper" };
        if (name === "zero-quantity") return { data: { ...base, filled_qty: "0", status: "filled" }, status: 200, url: "paper" };
        if (name === "malformed-time") return { data: { ...base, filled_at: "not-a-time", status: "filled" }, status: 200, url: "paper" };
        if (name === "identity-mismatch") return { data: { ...base, id: "paper-order-other", status: "filled" }, status: 200, url: "paper" };
        if (name === "canceled") return { data: { ...base, filled_qty: "0", filled_avg_price: undefined, filled_at: undefined, status: "canceled" }, status: 200, url: "paper" };
        return { data: { ...base, status: "expired" }, status: 200, url: "paper" };
      }
    }
  });

  assert.equal(reconciliation.checked, 6);
  assert.equal(reconciliation.updated, 2);
  assert.equal(reconciliation.terminal, 2);
  assert.equal(reconciliation.partialTerminal, 1);
  assert.equal(reconciliation.errors.length, 4);
  assert.ok(reconciliation.errors.every((error) => error.code === "PAPER_ORDER_RECONCILIATION_FAILED"));
  for (const name of ["missing-price", "zero-quantity", "malformed-time", "identity-mismatch"]) {
    const result = pending.get(name);
    assert.ok(result?.paperTradeId);
    assert.equal(
      (getDb().prepare("SELECT status FROM zero_dte_paper_trades WHERE paper_trade_id = ?").get(result.paperTradeId) as { status: string }).status,
      "submitted"
    );
  }
  const canceled = pending.get("canceled");
  assert.ok(canceled?.paperTradeId);
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, terminal_state, exit_reason_code
       FROM zero_dte_paper_trades
       WHERE paper_trade_id = ?`
    ).get(canceled.paperTradeId) as Record<string, unknown> },
    { status: "canceled", terminal_state: "canceled", exit_reason_code: "ORDER_CANCELED" }
  );
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, quantity, entry_premium, filled_at, terminal_state
       FROM zero_dte_paper_trades
       WHERE paper_trade_id = ?`
    ).get(partialTerminal.paperTradeId) as Record<string, unknown> },
    { status: "open", quantity: 1, entry_premium: 1.11, filled_at: filledAt, terminal_state: null }
  );
  assert.deepEqual(
    { ...getDb().prepare(
      `SELECT status, alpaca_status
       FROM paper_execution_ledger
       WHERE id = ?`
    ).get(partialTerminal.ledgerId) as Record<string, unknown> },
    { status: "expired", alpaca_status: "expired" }
  );
  assert.equal(
    (getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM zero_dte_lifecycle_events
       WHERE paper_trade_id = ?
         AND event_type IN ('paper_order_partially_filled', 'position_opened', 'paper_order_canceled')`
    ).get(partialTerminal.paperTradeId) as { count: number }).count,
    3
  );
});
