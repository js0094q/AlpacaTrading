import assert from "node:assert/strict";
import test from "node:test";

import { refreshPostgresMarketData } from "../src/services/postgresMarketDataService.js";

const fence = {
  jobName: "research-daily",
  workstream: "research",
  ownerId: "worker-1",
  runId: "run-1",
  fencingToken: "9"
};

const context = {
  transaction: {} as never,
  operationId: "market-refresh-1",
  actorId: fence.ownerId,
  schedulerFence: fence
};

const stockRaw = {
  latestTrade: { p: 624, s: 10, t: "2026-07-20T20:00:00.000Z" },
  latestQuote: { bp: 623.99, ap: 624.01, bs: 2, as: 3, t: "2026-07-20T20:00:00.000Z" },
  minuteBar: { o: 623, h: 624, l: 622, c: 624, v: 10_000, t: "2026-07-20T20:00:00.000Z" },
  dailyBar: { o: 620, h: 625, l: 618, c: 624, v: 1_000_000, t: "2026-07-20T20:00:00.000Z" },
  prevDailyBar: { o: 616, h: 621, l: 615, c: 620, v: 900_000, t: "2026-07-17T20:00:00.000Z" }
};

test("refresh persists genuine SIP and OPRA evidence in PostgreSQL", async () => {
  const calls: Record<string, unknown[][]> = {};
  const repository = Object.fromEntries([
    "upsertUniverseSymbols",
    "upsertBars",
    "upsertStockSnapshots",
    "upsertOptionContracts",
    "upsertOptionSnapshots"
  ].map((name) => [name, async (rows: unknown[]) => {
    (calls[name] ??= []).push(rows);
    return { stored: rows.length };
  }])) as never;

  const result = await refreshPostgresMarketData({
    symbols: ["SPY"],
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-20T23:59:59.999Z",
    optionsEnabled: true,
    now: new Date("2026-07-20T20:05:00.000Z"),
    repository,
    context,
    dependencies: {
      fetchAllBars: async () => [{
        symbol: "SPY",
        bar: { t: "2026-07-20T20:00:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
        requestIds: ["request-bars"]
      }],
      fetchStockSnapshots: async () => [{
        symbol: "SPY",
        raw: stockRaw,
        requestedFeed: "sip",
        effectiveFeed: "sip",
        currency: "USD",
        requestId: "request-stocks"
      }],
      fetchOptionContracts: async () => [{
        symbol: "SPY260720C00625000",
        underlying_symbol: "SPY",
        type: "call",
        expiration_date: "2026-07-20",
        strike_price: "625",
        multiplier: "100",
        tradable: true,
        requestId: "request-contracts"
      }],
      fetchOptionSnapshots: async () => [{
        symbol: "SPY260720C00625000",
        raw: {
          snapshotTimestamp: "2026-07-20T20:00:02.000Z",
          latestQuote: { bp: 1.2, ap: 1.3, t: "2026-07-20T20:00:02.000Z" },
          latestTrade: { p: 1.25, t: "2026-07-20T20:00:01.000Z" },
          impliedVolatility: 0.2,
          greeks: { delta: 0.5 }
        }
      }]
    }
  });

  assert.deepEqual(result.summary, {
    symbolCount: 1,
    barCount: 1,
    stockSnapshotCount: 1,
    optionContractCount: 1,
    optionSnapshotCount: 1
  });
  assert.equal(calls.upsertBars?.[0]?.[0] && (calls.upsertBars[0][0] as { requestId: string }).requestId, "request-bars");
  assert.equal((calls.upsertStockSnapshots?.[0]?.[0] as { effectiveFeed: string }).effectiveFeed, "sip");
  assert.equal((calls.upsertOptionSnapshots?.[0]?.[0] as { midpoint: number }).midpoint, 1.25);
});

test("refresh fails closed when a required symbol has no current bars", async () => {
  await assert.rejects(
    refreshPostgresMarketData({
      symbols: ["SPY", "QQQ"],
      timeframe: "1Day",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-07-20T23:59:59.999Z",
      optionsEnabled: false,
      now: new Date("2026-07-20T20:05:00.000Z"),
      repository: {
        upsertUniverseSymbols: async () => ({ stored: 2 }),
        upsertBars: async () => ({ stored: 1 }),
        upsertStockSnapshots: async () => ({ stored: 2 })
      } as never,
      context,
      dependencies: {
        fetchAllBars: async () => [{
          symbol: "SPY",
          bar: { t: "2026-07-20T20:00:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
          requestIds: ["request-bars"]
        }],
        fetchStockSnapshots: async () => [],
        fetchOptionContracts: async () => [],
        fetchOptionSnapshots: async () => []
      }
    }),
    /POSTGRES_MARKET_BARS_MISSING:QQQ/
  );
});

test("refresh rejects stale bar evidence instead of synthesizing success", async () => {
  await assert.rejects(
    refreshPostgresMarketData({
      symbols: ["SPY"],
      timeframe: "1Day",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-07-20T23:59:59.999Z",
      optionsEnabled: false,
      now: new Date("2026-07-20T20:05:00.000Z"),
      repository: {
        upsertUniverseSymbols: async () => ({ stored: 1 }),
        upsertBars: async () => ({ stored: 1 }),
        upsertStockSnapshots: async () => ({ stored: 1 })
      } as never,
      context,
      dependencies: {
        fetchAllBars: async () => [{
          symbol: "SPY",
          bar: { t: "2026-07-10T20:00:00.000Z", o: 600, h: 605, l: 598, c: 604, v: 1_000_000 },
          requestIds: ["request-bars"]
        }],
        fetchStockSnapshots: async () => [],
        fetchOptionContracts: async () => [],
        fetchOptionSnapshots: async () => []
      }
    }),
    /POSTGRES_MARKET_BARS_STALE:SPY/
  );
});

test("refresh rejects stale stock snapshot evidence", async () => {
  const repository = {
    upsertUniverseSymbols: async () => ({ stored: 1 }),
    upsertBars: async () => ({ stored: 1 }),
    upsertStockSnapshots: async () => ({ stored: 1 })
  } as never;

  await assert.rejects(
    refreshPostgresMarketData({
      symbols: ["SPY"],
      timeframe: "1Day",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-07-20T23:59:59.999Z",
      optionsEnabled: false,
      now: new Date("2026-07-20T20:05:00.000Z"),
      repository,
      context,
      dependencies: {
        fetchAllBars: async () => [{
          symbol: "SPY",
          bar: { t: "2026-07-20T20:00:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
          requestIds: ["request-bars"]
        }],
        fetchStockSnapshots: async () => [{
          symbol: "SPY",
          raw: {
            ...stockRaw,
            latestTrade: { ...stockRaw.latestTrade, t: "2026-07-10T20:00:00.000Z" },
            latestQuote: { ...stockRaw.latestQuote, t: "2026-07-10T20:00:00.000Z" },
            minuteBar: { ...stockRaw.minuteBar, t: "2026-07-10T20:00:00.000Z" },
            dailyBar: { ...stockRaw.dailyBar, t: "2026-07-10T20:00:00.000Z" }
          },
          requestedFeed: "sip",
          effectiveFeed: "sip",
          currency: "USD",
          requestId: "request-stocks"
        }],
        fetchOptionContracts: async () => [],
        fetchOptionSnapshots: async () => []
      }
    }),
    /POSTGRES_STOCK_SNAPSHOT_STALE:SPY/
  );
});

test("refresh rejects stale option snapshot evidence", async () => {
  const repository = Object.fromEntries([
    "upsertUniverseSymbols",
    "upsertBars",
    "upsertStockSnapshots",
    "upsertOptionContracts",
    "upsertOptionSnapshots"
  ].map((name) => [name, async (rows: unknown[]) => ({ stored: rows.length })])) as never;

  await assert.rejects(
    refreshPostgresMarketData({
      symbols: ["SPY"],
      timeframe: "1Day",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-07-20T23:59:59.999Z",
      optionsEnabled: true,
      now: new Date("2026-07-20T20:05:00.000Z"),
      repository,
      context,
      dependencies: {
        fetchAllBars: async () => [{
          symbol: "SPY",
          bar: { t: "2026-07-20T20:00:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
          requestIds: ["request-bars"]
        }],
        fetchStockSnapshots: async () => [{
          symbol: "SPY",
          raw: stockRaw,
          requestedFeed: "sip",
          effectiveFeed: "sip",
          currency: "USD",
          requestId: "request-stocks"
        }],
        fetchOptionContracts: async () => [{
          symbol: "SPY260720C00625000",
          underlying_symbol: "SPY",
          type: "call",
          expiration_date: "2026-07-20",
          strike_price: "625",
          multiplier: "100",
          tradable: true
        }],
        fetchOptionSnapshots: async () => [{
          symbol: "SPY260720C00625000",
          raw: {
            snapshotTimestamp: "2026-07-10T20:00:02.000Z",
            latestQuote: { bp: 1.2, ap: 1.3, t: "2026-07-10T20:00:02.000Z" }
          }
        }]
      }
    }),
    /POSTGRES_OPTION_SNAPSHOT_STALE:SPY260720C00625000/
  );
});
