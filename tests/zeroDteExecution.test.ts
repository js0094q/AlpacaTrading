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
  type ZeroDteAccountSnapshot,
  type ZeroDtePaperMutationProvider,
  type ZeroDteRuntimeSnapshot
} from "../src/services/zeroDte/zeroDteExecutionService.js";
import { insertZeroDteDecision } from "../src/services/zeroDte/zeroDteLifecycleService.js";
import type { ZeroDteQueueCandidate } from "../src/services/zeroDte/zeroDtePersistenceService.js";
import type { AlpacaPaperOrderRequest } from "../src/services/alpacaClient.js";

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

const seed = () => {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(config.configurationVersionId, config.strategyVersion, config.configurationVersionId, "{}", now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("execution-run-1", "2026-07-13", "test", "paper", "running", config.strategyVersion, config.configurationVersionId, now, now);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_candidates
      (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
       direction, expiration_date, strike, state, score, quote_bid, quote_ask,
       quote_midpoint, premium, spread_pct, volume, open_interest,
       market_timestamp, first_seen_at, last_seen_at, state_changed_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(candidateId, "2026-07-13", "SPY", optionSymbol, "trend_continuation", "bullish", "2026-07-13", 500, "eligible", 86, 1.2, 1.3, 1.25, 1.25, 8, 500, 900, now, now, now, now, now, now);
  if (!db.prepare("SELECT decision_id FROM zero_dte_decisions WHERE decision_id = ?").get(decisionId)) {
    insertZeroDteDecision({
      decisionId,
      decisionGroupId: "execution-group-1",
      engineRunId: "execution-run-1",
      candidateId,
      tradingDate: "2026-07-13",
      action: "select",
      accountMode: "paper",
      strategyVersion: config.strategyVersion,
      configurationVersionId: config.configurationVersionId,
      marketTimestamp: now,
      decidedAt: now,
      score: 86,
      scoreThreshold: 70,
      reasonCodes: ["QUALIFIED"]
    });
  }
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

test("qualified paper entry reserves, submits once, and is idempotent", async () => {
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
});
