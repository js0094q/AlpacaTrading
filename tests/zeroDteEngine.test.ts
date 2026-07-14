import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-engine-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  buildZeroDteSummary,
  createZeroDteEngineMutationProvider,
  isActionableZeroDteCandidate,
  runZeroDteEodSummary,
  runZeroDteEngine,
  runZeroDteReconciliation,
  type ZeroDteEngineProvider
} from "../src/services/zeroDte/zeroDteEngineService.js";
import type { ZeroDteMarketContext } from "../src/services/zeroDte/zeroDteMarketDataService.js";

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
  assert.equal(eod.paperOnly, true);
  assert.equal(eod.tradingDate, "2026-07-13");
});

test("engine mutation fallback evaluates quote age against the execution clock", () => {
  const executionTime = "2026-07-13T14:30:08.000Z";
  const fallback = createZeroDteEngineMutationProvider(
    {} as Parameters<typeof createZeroDteEngineMutationProvider>[0],
    undefined,
    () => executionTime
  );
  const override = createZeroDteEngineMutationProvider(
    {} as Parameters<typeof createZeroDteEngineMutationProvider>[0],
    { now: () => now },
    () => executionTime
  );

  assert.equal(fallback.now?.(), executionTime);
  assert.equal(override.now?.(), now);
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
