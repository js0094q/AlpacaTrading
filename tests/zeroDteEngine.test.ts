import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-engine-"));
const researchDbPath = join(dbDir, "research.db");
process.env.RESEARCH_DB_PATH = researchDbPath;

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  buildZeroDteDashboardSummary,
  buildZeroDteSummary,
  createZeroDteEngineMutationProvider,
  isActionableZeroDteCandidate,
  runZeroDteEodSummary,
  runZeroDteEngine,
  runZeroDteReconciliation,
  type ZeroDteEngineProvider
} from "../src/services/zeroDte/zeroDteEngineService.js";
import type { ZeroDteMarketContext } from "../src/services/zeroDte/zeroDteMarketDataService.js";
import type { ZeroDtePaperMutationProvider } from "../src/services/zeroDte/zeroDteExecutionService.js";
import { loadZeroDteConfig } from "../src/services/zeroDte/zeroDteConfigService.js";
import { insertZeroDteDecision } from "../src/services/zeroDte/zeroDteLifecycleService.js";

const now = "2026-07-13T14:30:00.000Z";
const optionSymbol = "SPY260713C00500000";

const bars = Array.from({ length: 25 }, (_, index) => {
  const timestamp = new Date(Date.parse(now) - (24 - index) * 60_000).toISOString();
  const close = 498 + index * 0.15;
  return {
    timestamp,
    open: close - 0.05,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume: 2_000 + index * 10
  };
});

const context = (): ZeroDteMarketContext => ({
  underlying: "SPY",
  tradingDate: "2026-07-13",
  price: 501.6,
  direction: "bullish",
  contract: {
    symbol: optionSymbol,
    underlying: "SPY",
    expirationDate: "2026-07-13",
    type: "call",
    strike: 500,
    tradable: true
  },
  option: {
    symbol: optionSymbol,
    side: "call",
    bid: 1.2,
    ask: 1.3,
    midpoint: 1.25,
    spreadPct: 8,
    volume: 500,
    openInterest: 900,
    gamma: 0.08,
    delta: 0.5,
    impliedVolatility: 0.3,
    quoteTimestamp: now,
    quoteStatus: "valid",
    executable: true
  },
  barsByTimeframe: { "1Min": bars, "5Min": bars, "15Min": bars },
  asOf: now,
  ingestedAt: now,
  source: "alpaca",
  sourceTimestamps: {
    clock: now,
    underlying: now,
    optionQuote: now,
    optionSnapshot: now
  },
  requestIds: { clock: "clock-1", underlying: "stock-1", option: "option-1", bars: [], contracts: [] },
  blockers: []
});

const provider = (): ZeroDteEngineProvider => ({
  getClock: async () => ({ timestamp: now, isOpen: true, nextClose: "2026-07-13T20:00:00.000Z", requestId: "clock-1" }),
  getStockSnapshot: async () => ({}),
  getBars: async () => bars,
  listContracts: async () => [],
  getOptionSnapshots: async () => ({}),
  collectContexts: async () => [context()]
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("dry engine cycle persists one bounded run, playbook evaluations, queue, and no order", async () => {
  const first = await runZeroDteEngine({ now, dryRun: true, provider: provider() });
  const second = await runZeroDteEngine({ now, dryRun: true, provider: provider() });

  assert.equal(first.paperOnly, true);
  assert.equal(first.status, "completed");
  assert.equal(first.runId, second.runId);
  assert.equal(first.contexts, 1);
  assert.ok(first.candidatesEvaluated >= 5);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_engine_runs").get() as { count: number }).count,
    1
  );
  assert.ok(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_playbook_evaluations").get() as { count: number }).count >= 5
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM paper_execution_ledger").get() as { count: number }).count,
    0
  );
  assert.ok(buildZeroDteSummary({ tradingDate: "2026-07-13", limit: 20 }).queue.length >= 1);
});

test("reconciliation and eod remain bounded when no broker mutation is requested", async () => {
  const reconciliation = await runZeroDteReconciliation({ now, provider: provider() });
  const eod = await runZeroDteEodSummary({ now, provider: provider() });
  assert.equal(reconciliation.paperOnly, true);
  assert.equal(reconciliation.mutationAttempted, false);
  assert.equal(reconciliation.paperOrders.checked, 0);
  assert.equal(reconciliation.exitOrders.checked, 0);
  assert.equal(eod.paperOnly, true);
  assert.equal(eod.tradingDate, "2026-07-13");
});

test("accepted but unfilled entries are not marked as paper positions", async () => {
  const config = loadZeroDteConfig();
  const runId = "engine-unfilled-mark-run";
  const candidateId = "engine-unfilled-mark-candidate";
  const decisionId = "engine-unfilled-mark-decision";
  const paperTradeId = "engine-unfilled-mark-trade";
  const markOptionSymbol = "SPY260713C00501000";
  const markProvider = provider();
  markProvider.collectContexts = async () => [{
    ...context(),
    contract: { ...context().contract, symbol: markOptionSymbol, strike: 501 },
    option: { ...context().option, symbol: markOptionSymbol }
  }];
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, '{}', ?)`
  ).run(config.configurationVersionId, config.strategyVersion, config.configurationVersionId, now);
  db.prepare(
    `INSERT INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, '2026-07-13', 'test', 'paper', 'running', ?, ?, ?, ?)`
  ).run(runId, config.strategyVersion, config.configurationVersionId, now, now);
  db.prepare(
    `INSERT INTO zero_dte_candidates
      (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
       direction, expiration_date, strike, state, score, quote_bid, quote_ask,
       quote_midpoint, premium, spread_pct, volume, open_interest,
       market_timestamp, first_seen_at, last_seen_at, state_changed_at,
       created_at, updated_at)
     VALUES (?, '2026-07-13', 'SPY', ?, 'trend_continuation', 'bullish',
             '2026-07-13', 501, 'selected', 86, 1.2, 1.3, 1.25, 1.25,
             8, 500, 900, ?, ?, ?, ?, ?, ?)`
  ).run(candidateId, markOptionSymbol, now, now, now, now, now, now);
  insertZeroDteDecision({
    decisionId,
    decisionGroupId: "engine-unfilled-mark-group",
    engineRunId: runId,
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
  db.prepare(
    `INSERT INTO zero_dte_paper_trades
      (paper_trade_id, decision_id, candidate_id, trading_date,
       underlying_symbol, option_symbol, playbook, direction, status,
       quantity, entry_premium, fees, slippage, requested_at, submitted_at,
       created_at, updated_at)
     VALUES (?, ?, ?, '2026-07-13', 'SPY', ?, 'trend_continuation',
             'bullish', 'submitted', 1, 1.25, 0, 0, ?, ?, ?, ?)`
  ).run(paperTradeId, decisionId, candidateId, markOptionSymbol, now, now, now, now);

  const unfilled = await runZeroDteReconciliation({ now, provider: markProvider });
  assert.deepEqual(unfilled.paperMarks, { paperOnly: true, marked: 0, blocked: 0 });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM zero_dte_position_marks WHERE paper_trade_id = ?").get(paperTradeId) as { count: number }).count,
    0
  );
  assert.equal(
    buildZeroDteDashboardSummary({ tradingDate: "2026-07-13" }).paperPositions
      .some((position) => position.paperTradeId === paperTradeId),
    false
  );

  const partiallyFilledAt = "2026-07-13T14:30:30.000Z";
  db.prepare(
    `UPDATE zero_dte_paper_trades
     SET status = 'partially_filled', quantity = 1, entry_premium = 1.21,
         filled_at = ?, updated_at = ?
     WHERE paper_trade_id = ?`
  ).run(partiallyFilledAt, partiallyFilledAt, paperTradeId);
  const filledEvidence = await runZeroDteReconciliation({
    now: "2026-07-13T14:31:00.000Z",
    provider: markProvider
  });
  assert.equal(filledEvidence.paperMarks.marked, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM zero_dte_position_marks WHERE paper_trade_id = ?").get(paperTradeId) as { count: number }).count,
    1
  );
  assert.equal(
    buildZeroDteDashboardSummary({ tradingDate: "2026-07-13" }).paperPositions
      .some((position) => position.paperTradeId === paperTradeId),
    true
  );
});

test("engine mutation fallback preserves prototype provider methods and execution clock", async () => {
  const executionTime = "2026-07-13T14:30:08.000Z";
  class PrototypeMutationProvider {
    calls = 0;
    quoteCalls = 0;
    snapshotCalls = 0;

    now() {
      return now;
    }

    async submitPaperOrder() {
      this.calls += 1;
      return { data: { id: "prototype-paper-order" } };
    }

    async refreshQuote() {
      this.quoteCalls += 1;
      return {};
    }

    async getLatestOptionSnapshots() {
      this.snapshotCalls += 1;
      return { data: {} };
    }
  }
  const original = new PrototypeMutationProvider();
  const fallback = createZeroDteEngineMutationProvider(
    {} as Parameters<typeof createZeroDteEngineMutationProvider>[0],
    undefined,
    () => executionTime
  );
  const override = createZeroDteEngineMutationProvider(
    {} as Parameters<typeof createZeroDteEngineMutationProvider>[0],
    original as unknown as ZeroDtePaperMutationProvider,
    () => executionTime
  );

  assert.equal(fallback.now?.(), executionTime);
  assert.equal(override.now?.(), now);
  assert.equal(typeof override.submitPaperOrder, "function");
  assert.equal(typeof override.refreshQuote, "function");
  assert.equal(typeof override.getLatestOptionSnapshots, "function");
  await override.submitPaperOrder?.({} as never);
  await override.refreshQuote?.(optionSymbol);
  await override.getLatestOptionSnapshots?.([optionSymbol]);
  assert.equal(original.calls, 1);
  assert.equal(original.quoteCalls, 1);
  assert.equal(original.snapshotCalls, 1);
});

test("engine selection rejects eligible candidates with execution blockers", () => {
  assert.equal(isActionableZeroDteCandidate({
    state: "eligible",
    eligible: true,
    executable: false
  }), false);
  assert.equal(isActionableZeroDteCandidate({
    state: "eligible",
    eligible: true,
    executable: true
  }), true);
});

test("engine persistence failures roll back the full cycle before broker handling", async () => {
  const failureDir = mkdtempSync(join(tmpdir(), "zero-dte-engine-failure-"));
  const environmentKeys = [
    "ALPACA_ENV",
    "TRADING_MODE",
    "LIVE_TRADING_ENABLED",
    "ALPACA_LIVE_TRADE",
    "ZERO_DTE_ENGINE_ENABLED",
    "ZERO_DTE_MIN_CONFIRMATION_OBSERVATIONS",
    "ZERO_DTE_PAPER_EXECUTION_ENABLED",
    "PAPER_ORDER_EXECUTION_ENABLED",
    "PAPER_OPTIONS_EXECUTION_ENABLED",
    "AUTOMATED_PAPER_EXECUTION_ENABLED"
  ] as const;
  const savedEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]])
  );
  closeDbForTests();
  process.env.RESEARCH_DB_PATH = join(failureDir, "research.db");
  Object.assign(process.env, {
    ALPACA_ENV: "paper",
    TRADING_MODE: "paper",
    LIVE_TRADING_ENABLED: "false",
    ALPACA_LIVE_TRADE: "false",
    ZERO_DTE_ENGINE_ENABLED: "true",
    ZERO_DTE_MIN_CONFIRMATION_OBSERVATIONS: "1",
    ZERO_DTE_PAPER_EXECUTION_ENABLED: "true",
    PAPER_ORDER_EXECUTION_ENABLED: "true",
    PAPER_OPTIONS_EXECUTION_ENABLED: "true",
    AUTOMATED_PAPER_EXECUTION_ENABLED: "true"
  });

  try {
    getDb().exec(`
      CREATE TRIGGER test_abort_zero_dte_observation
      BEFORE INSERT ON zero_dte_candidate_observations
      BEGIN
        SELECT RAISE(ABORT, 'forced observation failure');
      END;
    `);
    let brokerCalls = 0;
    const result = await runZeroDteEngine({
      now,
      confirmPaper: true,
      provider: {
        getClock: async () => ({
          timestamp: now,
          isOpen: true,
          nextClose: "2026-07-13T20:00:00.000Z",
          requestId: "clock-failure"
        }),
        collectContexts: async () => [context()],
        mutationProvider: {
          runtime: {
            environment: "paper",
            tradingMode: "paper",
            paperOnly: true,
            liveTradingEnabled: false,
            engineEnabled: true,
            paperExecutionEnabled: true,
            paperOptionsExecutionEnabled: true,
            automatedPaperExecutionEnabled: true,
            marketOpen: true
          },
          account: {
            environment: "paper",
            paperVerified: true,
            status: "ACTIVE",
            buyingPower: 10_000,
            optionsBuyingPower: 10_000,
            equity: 100_000,
            optionApprovalLevel: 3,
            openPositions: [],
            openOrders: []
          },
          now: () => now,
          submitPaperOrder: async () => {
            brokerCalls += 1;
            throw new Error("broker must not be called");
          }
        }
      }
    });

    assert.equal(result.status, "failed");
    assert.ok(result.errors.some((error) => error.code === "PERSISTENCE_BATCH_FAILED"));
    assert.equal(result.candidatesDiscovered, 0);
    assert.equal(result.candidatesEligible, 0);
    assert.equal(result.selectedCount, 0);
    assert.equal(result.shadowCount, 0);
    assert.equal(result.executionResults.length, 0);
    assert.equal(brokerCalls, 0);
    for (const table of [
      "zero_dte_candidates",
      "zero_dte_candidate_observations",
      "zero_dte_playbook_evaluations",
      "zero_dte_decisions",
      "zero_dte_lifecycle_events",
      "zero_dte_shadow_trades",
      "paper_execution_ledger"
    ]) {
      assert.equal(
        (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        0,
        table
      );
    }
  } finally {
    closeDbForTests();
    rmSync(failureDir, { recursive: true, force: true });
    for (const key of environmentKeys) {
      const value = savedEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.RESEARCH_DB_PATH = researchDbPath;
  }
});
