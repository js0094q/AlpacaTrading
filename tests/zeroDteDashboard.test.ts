import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-dashboard-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

import { closeDbForTests } from "../src/lib/db.js";
import {
  buildZeroDteDashboardSummary,
  runZeroDteEngine,
  type ZeroDteMarketContext
} from "../src/services/zeroDte/zeroDteEngineService.js";

const now = "2026-07-13T14:00:00.000Z";
const bars = Array.from({ length: 25 }, (_, index) => ({
  timestamp: new Date(Date.parse(now) - (24 - index) * 60_000).toISOString(),
  open: 499 + index * 0.05,
  high: 499.5 + index * 0.05,
  low: 498.8 + index * 0.05,
  close: 499.2 + index * 0.05,
  volume: 1_000 + index * 10
}));

const context = (): ZeroDteMarketContext => ({
  underlying: "SPY",
  tradingDate: "2026-07-13",
  price: 500.4,
  direction: "bullish",
  contract: {
    symbol: "SPY260713C00500000",
    underlying: "SPY",
    expirationDate: "2026-07-13",
    type: "call",
    strike: 500,
    tradable: true
  },
  option: {
    symbol: "SPY260713C00500000",
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
  requestIds: {
    clock: "clock-1",
    underlying: "underlying-1",
    option: "option-1",
    bars: ["bars-1"],
    contracts: ["contracts-1"]
  },
  blockers: []
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("dashboard summary is bounded, paper-only, and separates simulated shadow rows", async () => {
  await runZeroDteEngine({
    now,
    dryRun: true,
    provider: {
      getClock: async () => ({ timestamp: now, isOpen: true, nextClose: now }),
      collectContexts: async () => [context()]
    }
  });

  const summary = buildZeroDteDashboardSummary({
    tradingDate: "2026-07-13",
    limit: 2
  });

  assert.equal(summary.paperOnly, true);
  assert.equal(summary.engine.status, "completed");
  assert.ok(summary.queue.length <= 2);
  assert.ok(summary.shadowTrades.length <= 2);
  assert.ok(summary.shadowTrades.every((trade) => trade.simulated === true));
  assert.equal(summary.paperPositions.length, 0);
  assert.ok(Object.keys(summary.lifecycle.counts).length > 0);
  assert.doesNotMatch(JSON.stringify(summary), /VPS_CONTROL_TOKEN|Authorization|supersecret/i);
});

test("Vercel 0DTE summary route is read-only and uses the VPS bridge path", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  process.env.VERCEL = "1";
  process.env.VPS_CONTROL_BASE_URL = "https://vps.internal:4100";
  process.env.VPS_CONTROL_TOKEN = "bridge-secret";
  process.env.DASHBOARD_ADMIN_TOKEN = "dashboard-admin-secret";
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      ok: true,
      data: {
        paperOnly: true,
        engine: { enabled: true, status: "completed", queueSize: 0, staleDataCount: 0, lastRunAt: null },
        queue: [],
        paperPositions: [],
        shadowTrades: [],
        lifecycle: { counts: {}, recent: [] },
        learning: null,
        blockers: []
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const route = await import(`${pathToFileURL(`${process.cwd()}/apps/dashboard/app/api/paper/zero-dte/summary/route.ts`).href}?dashboard=${Date.now()}`) as {
      GET: (request: Request) => Promise<Response>;
    };
    const response = await route.GET(new Request("http://localhost/api/paper/zero-dte/summary"));
    const payload = await response.json() as { ok: boolean; data: { paperOnly: boolean } };
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.paperOnly, true);
    assert.deepEqual(calls, ["https://vps.internal:4100/api/v1/zero-dte/summary"]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VERCEL;
    delete process.env.VPS_CONTROL_BASE_URL;
    delete process.env.VPS_CONTROL_TOKEN;
    delete process.env.DASHBOARD_ADMIN_TOKEN;
  }
});
