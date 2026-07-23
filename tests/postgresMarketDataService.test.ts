import assert from "node:assert/strict";
import test from "node:test";

import {
  optionSnapshotEvidenceFingerprint,
  type PostgresOptionSnapshot
} from "../src/repositories/postgres/postgresMarketDataRepository.js";
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

const withEvidenceFingerprints = (
  rows: readonly unknown[]
): Array<Record<string, unknown> & { evidenceFingerprint: string }> => rows.map((value) => {
  const row = value as PostgresOptionSnapshot;
  return {
    ...row,
    // PostgreSQL stores the canonical enriched evidence document, then hydrates
    // that document on readback rather than returning the provider-only input.
    evidence: {
      ...row.evidence,
      optionSymbol: row.optionSymbol,
      underlyingSymbol: row.underlyingSymbol,
      observedAt: row.observedAt
    },
    evidenceFingerprint: optionSnapshotEvidenceFingerprint(row)
  };
});

test("refresh persists genuine SIP and OPRA evidence in PostgreSQL", async () => {
  const calls: Record<string, unknown[][]> = {};
  let readbackYielded = false;
  const writer = Object.fromEntries([
    "upsertUniverseSymbols",
    "upsertBars",
    "upsertStockSnapshots",
    "upsertOptionContracts",
    "upsertOptionSnapshots"
  ].map((name) => [name, async (rows: unknown[]) => {
    (calls[name] ??= []).push(rows);
    return { stored: rows.length };
  }]));
  const repository = {
    ...writer,
    listOptionContractsBySymbols: async () => calls.upsertOptionContracts?.[0] ?? [],
    listOptionSnapshotsByIdentity: async () => {
      setImmediate(() => { readbackYielded = true; });
      return withEvidenceFingerprints(calls.upsertOptionSnapshots?.[0] ?? []);
    }
  } as never;

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
        status: "active",
        tradable: true,
        requestId: "request-contracts"
      }],
      fetchOptionSnapshots: async () => [],
      fetchOptionChainSnapshots: async () => ({
        underlyingSymbol: "SPY",
        pagesConsumed: 1,
        snapshots: [{
          symbol: "SPY260720C00625000",
          raw: {
            snapshotTimestamp: "2026-07-20T20:00:02.000Z",
            latestQuote: { bp: 1.2, ap: 1.3, t: "2026-07-20T20:00:02.000Z" },
            latestTrade: { p: 1.25, t: "2026-07-20T20:00:01.000Z" },
            dailyBar: { v: 500 },
            impliedVolatility: 0.2,
            greeks: { delta: 0.5 }
          },
          requestId: "request-options",
          endpoint: "/v1beta1/options/snapshots/SPY?feed=opra&limit=1000",
          underlyingSymbol: "SPY",
          requestedFeed: "opra",
          effectiveFeed: "opra",
          pageToken: null,
          retrievedAt: "2026-07-20T20:05:00.000Z"
        }]
      })
    }
  });

  assert.deepEqual(result.summary, {
    symbolCount: 1,
    barCount: 1,
    stockSnapshotCount: 1,
    optionContractCount: 1,
    optionSnapshotCount: 1,
    optionChainPageCount: 1,
    optionContractsByUnderlying: { SPY: 1 },
    optionSnapshotsByUnderlying: { SPY: 1 },
    freshOptionSnapshotsByUnderlying: { SPY: 1 },
    optionDataStatus: "current",
    optionDataRejectionReasons: []
  });
  assert.equal(calls.upsertBars?.[0]?.[0] && (calls.upsertBars[0][0] as { requestId: string }).requestId, "request-bars");
  assert.equal((calls.upsertStockSnapshots?.[0]?.[0] as { effectiveFeed: string }).effectiveFeed, "sip");
  assert.equal((calls.upsertOptionSnapshots?.[0]?.[0] as { midpoint: number }).midpoint, 1.25);
  assert.equal(readbackYielded, true);
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

test("stock freshness uses provider retrieval time instead of the cycle start time", async () => {
  const stored: unknown[][] = [];
  const repository = {
    upsertUniverseSymbols: async () => ({ stored: 1 }),
    upsertBars: async () => ({ stored: 1 }),
    upsertStockSnapshots: async (rows: unknown[]) => {
      stored.push(rows);
      return { stored: rows.length };
    }
  } as never;

  const result = await refreshPostgresMarketData({
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
          latestTrade: { ...stockRaw.latestTrade, t: "2026-07-20T20:24:59.000Z" },
          latestQuote: { ...stockRaw.latestQuote, t: "2026-07-20T20:24:59.000Z" },
          minuteBar: { ...stockRaw.minuteBar, t: "2026-07-20T20:24:00.000Z" }
        },
        requestedFeed: "sip",
        effectiveFeed: "sip",
        currency: "USD",
        requestId: "request-stocks",
        retrievedAt: "2026-07-20T20:25:00.000Z"
      }],
      fetchOptionContracts: async () => [],
      fetchOptionSnapshots: async () => [],
      fetchOptionChainSnapshots: async () => ({ underlyingSymbol: "SPY", pagesConsumed: 0, snapshots: [] })
    }
  });

  assert.equal(result.stockSnapshots[0]?.observedAt, "2026-07-20T20:25:00.000Z");
  assert.equal(result.stockSnapshots[0]?.evidence.freshnessStatus, "FRESH");
  assert.equal(stored.length, 1);
});

test("refresh rejects stale option evidence, persists ingestion telemetry, and returns equity-only data", async () => {
  const calls: Record<string, unknown[][]> = {};
  const ingestionRuns: Array<Record<string, unknown>> = [];
  const writer = Object.fromEntries([
    "upsertUniverseSymbols",
    "upsertBars",
    "upsertStockSnapshots",
    "upsertOptionContracts",
    "upsertOptionSnapshots"
  ].map((name) => [name, async (rows: unknown[]) => {
    (calls[name] ??= []).push(rows);
    return { stored: rows.length };
  }]));
  const repository = {
    ...writer,
    recordMarketDataIngestionRun: async (run: Record<string, unknown>) => {
      ingestionRuns.push(run);
      return { stored: 1 };
    },
    listOptionContractsBySymbols: async () => calls.upsertOptionContracts?.[0] ?? [],
    listOptionSnapshotsByIdentity: async () => withEvidenceFingerprints(calls.upsertOptionSnapshots?.[0] ?? [])
  } as never;

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
          status: "active",
          tradable: true
        }],
        fetchOptionSnapshots: async () => [],
        fetchOptionChainSnapshots: async () => ({
          underlyingSymbol: "SPY",
          pagesConsumed: 1,
          snapshots: [{
            symbol: "SPY260720C00625000",
            raw: {
              snapshotTimestamp: "2026-07-10T20:00:02.000Z",
              latestQuote: { bp: 1.2, ap: 1.3, t: "2026-07-10T20:00:02.000Z" }
            },
            requestId: "request-options",
            endpoint: "/v1beta1/options/snapshots/SPY?feed=opra&limit=1000",
            underlyingSymbol: "SPY",
            requestedFeed: "opra",
            effectiveFeed: "opra",
            pageToken: null,
            retrievedAt: "2026-07-20T20:05:00.000Z"
          }]
        })
      }
    });

  assert.equal(result.bars.length, 1);
  assert.equal(result.stockSnapshots.length, 1);
  assert.equal(result.optionSnapshots.length, 0);
  assert.equal(calls.upsertOptionSnapshots, undefined);
  assert.equal(result.summary.optionDataStatus, "degraded");
  assert.deepEqual(result.summary.optionDataRejectionReasons, [
    "POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING:SPY"
  ]);
  assert.equal(ingestionRuns.length, 1);
  assert.deepEqual(ingestionRuns[0], {
    cycleId: null,
    workstream: "research",
    symbol: "SPY",
    provider: "alpaca",
    endpoint: "/v1beta1/options/snapshots/SPY?feed=opra&limit=1000",
    requestedFeed: "opra",
    effectiveFeed: "opra",
    requestStartedAt: "2026-07-20T20:05:00.000Z",
    requestCompletedAt: "2026-07-20T20:05:00.000Z",
    pagesRetrieved: 1,
    rowsReceived: 1,
    newestProviderTimestamp: "2026-07-10T20:00:02.000Z",
    oldestProviderTimestamp: "2026-07-10T20:00:02.000Z",
    newestProviderAgeSeconds: 864_298,
    acceptedRows: 0,
    staleRows: 1,
    rejectedRows: 1,
    freshnessThresholdSeconds: 1_200,
    rejectionReason: "POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING:SPY",
    persistenceResult: "not_persisted_stale",
    requestIds: ["request-options"]
  });
});

test("an unavailable OPRA endpoint records the failure and does not block current equity research", async () => {
  const ingestionRuns: Array<Record<string, unknown>> = [];
  const result = await refreshPostgresMarketData({
    symbols: ["SPY"],
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-20T23:59:59.999Z",
    optionsEnabled: true,
    now: new Date("2026-07-20T20:05:00.000Z"),
    repository: {
      upsertUniverseSymbols: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertBars: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertStockSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertOptionContracts: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertOptionSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
      listOptionContractsBySymbols: async () => [],
      listOptionSnapshotsByIdentity: async () => [],
      recordMarketDataIngestionRun: async (run: Record<string, unknown>) => {
        ingestionRuns.push(run);
        return { stored: 1 };
      }
    } as never,
    context,
    dependencies: {
      fetchAllBars: async () => [{
        symbol: "SPY",
        bar: {
          t: "2026-07-20T20:00:00.000Z",
          o: 620,
          h: 625,
          l: 618,
          c: 624,
          v: 1_000_000
        },
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
        status: "active",
        tradable: true
      }],
      fetchOptionSnapshots: async () => [],
      fetchOptionChainSnapshots: async () => {
        throw new Error("ALPACA_API_UNAVAILABLE");
      }
    }
  });

  assert.equal(result.bars.length, 1);
  assert.equal(result.stockSnapshots.length, 1);
  assert.equal(result.optionSnapshots.length, 0);
  assert.equal(result.summary.optionDataStatus, "degraded");
  assert.deepEqual(result.summary.optionDataRejectionReasons, [
    "POSTGRES_OPTION_PROVIDER_UNAVAILABLE:SPY:ALPACA_API_UNAVAILABLE"
  ]);
  assert.equal(ingestionRuns.length, 1);
  assert.deepEqual(ingestionRuns[0], {
    cycleId: null,
    workstream: "research",
    symbol: "SPY",
    provider: "alpaca",
    endpoint: "/v1beta1/options/snapshots/SPY",
    requestedFeed: "opra",
    effectiveFeed: null,
    requestStartedAt: "2026-07-20T20:05:00.000Z",
    requestCompletedAt: "2026-07-20T20:05:00.000Z",
    pagesRetrieved: 0,
    rowsReceived: 0,
    newestProviderTimestamp: null,
    oldestProviderTimestamp: null,
    newestProviderAgeSeconds: null,
    acceptedRows: 0,
    staleRows: 0,
    rejectedRows: 0,
    freshnessThresholdSeconds: 1_200,
    rejectionReason: "POSTGRES_OPTION_PROVIDER_UNAVAILABLE:SPY:ALPACA_API_UNAVAILABLE",
    persistenceResult: "not_persisted_provider_unavailable",
    requestIds: []
  });
});

test("refresh ingests complete OPRA chains per underlying and persists documented fields without synthetic defaults", async () => {
  const contractCalls: string[][] = [];
  const chainCalls: string[] = [];
  let storedContracts: Array<Record<string, unknown>> = [];
  let storedSnapshots: Array<Record<string, unknown>> = [];
  const repository = {
    upsertUniverseSymbols: async (rows: unknown[]) => ({ stored: rows.length }),
    upsertBars: async (rows: unknown[]) => ({ stored: rows.length }),
    upsertStockSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
    upsertOptionContracts: async (rows: Array<Record<string, unknown>>) => {
      storedContracts = rows;
      return { stored: rows.length };
    },
    upsertOptionSnapshots: async (rows: Array<Record<string, unknown>>) => {
      storedSnapshots = rows;
      return { stored: rows.length };
    },
    listOptionContractsBySymbols: async () => storedContracts,
    listOptionSnapshotsByIdentity: async () => withEvidenceFingerprints(storedSnapshots).map((row) => ({
      ...row,
      midpoint: Number(Number(row.midpoint).toFixed(8)),
      persistedAt: "2026-07-21T13:42:01.000Z"
    }))
  } as never;
  const underlyings = ["SPY", "QQQ", "AAPL"];
  const optionSymbols: Record<string, string> = {
    SPY: "SPY260724C00744000",
    QQQ: "QQQ260724C00600000",
    AAPL: "AAPL260724C00325000"
  };

  const result = await refreshPostgresMarketData({
    symbols: underlyings,
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-21T13:42:00.000Z",
    optionsEnabled: true,
    now: new Date("2026-07-21T13:42:00.000Z"),
    repository,
    context,
    dependencies: {
      fetchAllBars: async () => underlyings.map((symbol) => ({
        symbol,
        bar: { t: "2026-07-21T13:41:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
        requestIds: [`bars-${symbol}`]
      })),
      fetchStockSnapshots: async () => underlyings.map((symbol) => ({
        symbol,
        raw: {
          ...stockRaw,
          latestTrade: { ...stockRaw.latestTrade, t: "2026-07-21T13:41:58.000Z" },
          latestQuote: { ...stockRaw.latestQuote, t: "2026-07-21T13:41:58.000Z" },
          minuteBar: { ...stockRaw.minuteBar, t: "2026-07-21T13:41:00.000Z" },
          dailyBar: { ...stockRaw.dailyBar, t: "2026-07-21T13:41:00.000Z" },
          prevDailyBar: { ...stockRaw.prevDailyBar, t: "2026-07-20T20:00:00.000Z" }
        },
        requestedFeed: "sip",
        effectiveFeed: "sip",
        currency: "USD",
        requestId: `stocks-${symbol}`
      })),
      fetchOptionContracts: async (filters: { underlyingSymbols?: string[] }) => {
        contractCalls.push(filters.underlyingSymbols ?? []);
        const underlying = filters.underlyingSymbols?.[0];
        if (!underlying || filters.underlyingSymbols?.length !== 1) return [];
        return [
          {
            id: `contract-${underlying}`,
            symbol: optionSymbols[underlying],
            underlying_symbol: underlying,
            type: "call",
            expiration_date: "2026-07-24",
            strike_price: underlying === "SPY" ? "744" : underlying === "QQQ" ? "600" : "325",
            size: "100",
            status: "active",
            tradable: underlying !== "SPY",
            style: "american",
            open_interest: "1200",
            open_interest_date: "2026-07-20",
            close_price: "2.95",
            close_price_date: "2026-07-20",
            requestId: `contracts-${underlying}`
          },
          ...(underlying === "SPY" ? [{
            symbol: "SPY260724X00745000",
            underlying_symbol: "SPY",
            type: "unknown",
            expiration_date: "2026-07-24",
            strike_price: "745",
            multiplier: "100",
            status: "active",
            tradable: true
          }, {
            symbol: "SPY260724C00746000",
            underlying_symbol: "SPY",
            type: "call",
            expiration_date: "2026-07-24",
            strike_price: "746",
            status: "active",
            tradable: true
          }, {
            symbol: "SPY260724P00747000",
            underlying_symbol: "SPY",
            type: "put",
            expiration_date: "2026-07-24",
            strike_price: "747",
            multiplier: "100",
            status: "inactive",
            tradable: true
          }] : [])
        ];
      },
      fetchOptionSnapshots: async () => {
        throw new Error("legacy batch option snapshot endpoint must not run");
      },
      fetchOptionChainSnapshots: async (underlying: string) => {
        chainCalls.push(underlying);
        return {
          underlyingSymbol: underlying,
          pagesConsumed: 2,
          snapshots: [{
            symbol: optionSymbols[underlying]!,
            raw: {
              volume: 999_999,
              latestQuote: { bp: 3.1, ap: 3.2, bs: 10, as: 12, t: "2026-07-21T13:41:58.000Z" },
              latestTrade: { p: 3.15, s: 2, t: "2026-07-21T13:41:57.000Z" },
              dailyBar: { v: 321 },
              impliedVolatility: 0.1663,
              greeks: { delta: 0.5276, gamma: 0.0355, theta: -0.7831, vega: 0.2686, rho: 0.0319 }
            },
            requestId: `chain-${underlying}`,
            endpoint: `/v1beta1/options/snapshots/${underlying}?feed=opra&limit=1000&page_token=page-2`,
            underlyingSymbol: underlying,
            requestedFeed: "opra",
            effectiveFeed: "opra",
            pageToken: "page-2",
            retrievedAt: "2026-07-21T13:42:00.000Z"
          }]
        };
      }
    } as never
  });

  assert.deepEqual(contractCalls, [["SPY"], ["QQQ"], ["AAPL"]]);
  assert.deepEqual(chainCalls, underlyings);
  assert.equal(result.summary.optionContractCount, 3);
  assert.equal(result.summary.optionSnapshotCount, 3);
  assert.equal(result.summary.optionChainPageCount, 6);
  assert.deepEqual(result.summary.freshOptionSnapshotsByUnderlying, { SPY: 1, QQQ: 1, AAPL: 1 });
  assert.equal(result.optionSnapshots[0]?.persistedAt, "2026-07-21T13:42:01.000Z");
  assert.equal(storedContracts.length, 3);
  assert.equal(storedContracts.some((row) => row.optionSymbol === "SPY260724X00745000"), false);
  assert.equal(storedContracts.some((row) => row.optionSymbol === "SPY260724C00746000"), false);
  assert.equal(storedContracts.some((row) => row.optionSymbol === "SPY260724P00747000"), false);
  assert.equal(storedContracts.find((row) => row.underlyingSymbol === "SPY")?.tradable, false);
  assert.equal(storedContracts.find((row) => row.underlyingSymbol === "SPY")?.status, "active");
  assert.equal(storedContracts.find((row) => row.underlyingSymbol === "SPY")?.multiplier, 100);
  assert.equal(
    (storedContracts.find((row) => row.underlyingSymbol === "SPY")?.evidence as Record<string, unknown>).multiplierSource,
    "size"
  );
  const snapshot = storedSnapshots.find((row) => row.underlyingSymbol === "SPY")!;
  assert.equal(snapshot.volume, 321);
  assert.equal(snapshot.openInterest, 1200);
  assert.equal(snapshot.impliedVolatility, 0.1663);
  assert.equal(snapshot.delta, 0.5276);
  assert.equal(snapshot.gamma, 0.0355);
  assert.equal(snapshot.theta, -0.7831);
  assert.equal(snapshot.vega, 0.2686);
  assert.equal(snapshot.rho, 0.0319);
  assert.equal(snapshot.bidSize, 10);
  assert.equal(snapshot.askSize, 12);
  assert.equal(snapshot.requestId, "chain-SPY");
  assert.equal((snapshot.evidence as Record<string, unknown>).endpoint, "/v1beta1/options/snapshots/SPY?feed=opra&limit=1000&page_token=page-2");
  assert.equal((snapshot.evidence as Record<string, unknown>).dailyVolumeSource, "dailyBar.v");
  assert.equal((snapshot.evidence as Record<string, unknown>).openInterestSource, "option_contracts.open_interest");
});

test("refresh rejects conflicting material contract evidence across pages", async () => {
  const writer = Object.fromEntries([
    "upsertUniverseSymbols", "upsertBars", "upsertStockSnapshots",
    "upsertOptionContracts", "upsertOptionSnapshots"
  ].map((name) => [name, async (rows: unknown[]) => ({ stored: rows.length })]));

  await assert.rejects(refreshPostgresMarketData({
    symbols: ["SPY"],
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-21T13:42:00.000Z",
    optionsEnabled: true,
    now: new Date("2026-07-21T13:42:00.000Z"),
    repository: writer as never,
    context,
    dependencies: {
      fetchAllBars: async () => [{
        symbol: "SPY",
        bar: { t: "2026-07-21T13:41:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
        requestIds: ["bars-SPY"]
      }],
      fetchStockSnapshots: async () => [{
        symbol: "SPY", raw: {
          ...stockRaw,
          latestTrade: { ...stockRaw.latestTrade, t: "2026-07-21T13:41:58.000Z" },
          latestQuote: { ...stockRaw.latestQuote, t: "2026-07-21T13:41:58.000Z" },
          minuteBar: { ...stockRaw.minuteBar, t: "2026-07-21T13:41:00.000Z" },
          dailyBar: { ...stockRaw.dailyBar, t: "2026-07-21T13:41:00.000Z" }
        },
        requestedFeed: "sip", effectiveFeed: "sip", currency: "USD", requestId: "stocks-SPY"
      }],
      fetchOptionContracts: async () => [100, 200].map((multiplier) => ({
        id: "contract-SPY", symbol: "SPY260724C00744000", underlying_symbol: "SPY",
        type: "call", expiration_date: "2026-07-24", strike_price: "744",
        size: String(multiplier), status: "active", tradable: true
      })),
      fetchOptionSnapshots: async () => [],
      fetchOptionChainSnapshots: async () => ({ underlyingSymbol: "SPY", pagesConsumed: 0, snapshots: [] })
    } as never
  }), /POSTGRES_OPTION_CONTRACT_IDENTITY_CONFLICT:SPY260724C00744000/);
});

test("refresh rejects same-count PostgreSQL readback when material values or evidence fingerprints differ", async () => {
  let contracts: Array<Record<string, unknown>> = [];
  let snapshots: Array<Record<string, unknown>> = [];
  let readbackMode: "material" | "fingerprint" = "material";
  const repository = {
    upsertUniverseSymbols: async (rows: unknown[]) => ({ stored: rows.length }),
    upsertBars: async (rows: unknown[]) => ({ stored: rows.length }),
    upsertStockSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
    upsertOptionContracts: async (rows: Array<Record<string, unknown>>) => {
      contracts = rows;
      return { stored: rows.length };
    },
    upsertOptionSnapshots: async (rows: Array<Record<string, unknown>>) => {
      snapshots = rows;
      return { stored: rows.length };
    },
    listOptionContractsBySymbols: async () => contracts,
    listOptionSnapshotsByIdentity: async () => withEvidenceFingerprints(snapshots).map((row) =>
      readbackMode === "material"
        ? { ...row, delta: 0.9 }
        : { ...row, evidenceFingerprint: "tampered" }
    )
  } as never;

  const run = () => refreshPostgresMarketData({
    symbols: ["SPY"],
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-21T13:42:00.000Z",
    optionsEnabled: true,
    now: new Date("2026-07-21T13:42:00.000Z"),
    repository,
    context,
    dependencies: {
      fetchAllBars: async () => [{
        symbol: "SPY",
        bar: { t: "2026-07-21T13:41:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
        requestIds: ["bars-SPY"]
      }],
      fetchStockSnapshots: async () => [{
        symbol: "SPY", raw: {
          ...stockRaw,
          latestTrade: { ...stockRaw.latestTrade, t: "2026-07-21T13:41:58.000Z" },
          latestQuote: { ...stockRaw.latestQuote, t: "2026-07-21T13:41:58.000Z" },
          minuteBar: { ...stockRaw.minuteBar, t: "2026-07-21T13:41:00.000Z" },
          dailyBar: { ...stockRaw.dailyBar, t: "2026-07-21T13:41:00.000Z" }
        },
        requestedFeed: "sip", effectiveFeed: "sip", currency: "USD", requestId: "stocks-SPY"
      }],
      fetchOptionContracts: async () => [{
        id: "contract-SPY", symbol: "SPY260724C00744000", underlying_symbol: "SPY",
        type: "call", expiration_date: "2026-07-24", strike_price: "744",
        multiplier: "100", status: "active", tradable: true, open_interest: "1200"
      }],
      fetchOptionSnapshots: async () => [],
      fetchOptionChainSnapshots: async () => ({
        underlyingSymbol: "SPY", pagesConsumed: 1, snapshots: [{
          symbol: "SPY260724C00744000",
          raw: {
            latestQuote: { bp: 3.1, ap: 3.2, t: "2026-07-21T13:41:58.000Z" },
            latestTrade: { p: 3.15, t: "2026-07-21T13:41:57.000Z" },
            dailyBar: { v: 321 }, impliedVolatility: 0.1663,
            greeks: { delta: 0.5276, gamma: 0.0355, theta: -0.7831, vega: 0.2686, rho: 0.0319 }
          },
          requestId: "chain-SPY", endpoint: "/v1beta1/options/snapshots/SPY?feed=opra&limit=1000",
          underlyingSymbol: "SPY", requestedFeed: "opra", effectiveFeed: "opra",
          pageToken: null, retrievedAt: "2026-07-21T13:42:00.000Z"
        }]
      })
    } as never
  });
  await assert.rejects(run(), /POSTGRES_OPTION_SNAPSHOT_READBACK_MISMATCH/);
  readbackMode = "fingerprint";
  await assert.rejects(run(), /POSTGRES_OPTION_SNAPSHOT_EVIDENCE_FINGERPRINT_MISMATCH/);
});

test("refresh fails closed when a required underlying has no active contracts", async () => {
  await assert.rejects(refreshPostgresMarketData({
    symbols: ["SPY", "AAPL"],
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-21T13:42:00.000Z",
    optionsEnabled: true,
    now: new Date("2026-07-21T13:42:00.000Z"),
    repository: {
      upsertUniverseSymbols: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertBars: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertStockSnapshots: async (rows: unknown[]) => ({ stored: rows.length })
    } as never,
    context,
    dependencies: {
      fetchAllBars: async () => ["SPY", "AAPL"].map((symbol) => ({
        symbol,
        bar: { t: "2026-07-21T13:41:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
        requestIds: [`bars-${symbol}`]
      })),
      fetchStockSnapshots: async () => ["SPY", "AAPL"].map((symbol) => ({
        symbol,
        raw: {
          ...stockRaw,
          latestTrade: { ...stockRaw.latestTrade, t: "2026-07-21T13:41:58.000Z" },
          latestQuote: { ...stockRaw.latestQuote, t: "2026-07-21T13:41:58.000Z" },
          minuteBar: { ...stockRaw.minuteBar, t: "2026-07-21T13:41:00.000Z" },
          dailyBar: { ...stockRaw.dailyBar, t: "2026-07-21T13:41:00.000Z" }
        },
        requestedFeed: "sip", effectiveFeed: "sip", currency: "USD", requestId: `stocks-${symbol}`
      })),
      fetchOptionContracts: async (filters: { underlyingSymbols?: string[] }) =>
        filters.underlyingSymbols?.[0] === "SPY" ? [] : [{
          id: "contract-AAPL", symbol: "AAPL260724C00325000", underlying_symbol: "AAPL",
          type: "call", expiration_date: "2026-07-24", strike_price: "325",
          size: "100", status: "active", tradable: true
        }],
      fetchOptionSnapshots: async () => [],
      fetchOptionChainSnapshots: async () => ({ underlyingSymbol: "AAPL", pagesConsumed: 0, snapshots: [] })
    } as never
  }), /POSTGRES_OPTION_CONTRACTS_MISSING:SPY/);
});

test("required underlying without fresh OPRA snapshots degrades only option-dependent paths", async () => {
  const result = await refreshPostgresMarketData({
    symbols: ["SPY"],
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-21T13:42:00.000Z",
    optionsEnabled: true,
    now: new Date("2026-07-21T13:42:00.000Z"),
    repository: {
      upsertUniverseSymbols: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertBars: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertStockSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertOptionContracts: async (rows: unknown[]) => ({ stored: rows.length })
    } as never,
    context,
    dependencies: {
      fetchAllBars: async () => [{
        symbol: "SPY",
        bar: { t: "2026-07-21T13:41:00.000Z", o: 620, h: 625, l: 618, c: 624, v: 1_000_000 },
        requestIds: ["bars-SPY"]
      }],
      fetchStockSnapshots: async () => [{
        symbol: "SPY",
        raw: {
          ...stockRaw,
          latestTrade: { ...stockRaw.latestTrade, t: "2026-07-21T13:41:58.000Z" },
          latestQuote: { ...stockRaw.latestQuote, t: "2026-07-21T13:41:58.000Z" },
          minuteBar: { ...stockRaw.minuteBar, t: "2026-07-21T13:41:00.000Z" },
          dailyBar: { ...stockRaw.dailyBar, t: "2026-07-21T13:41:00.000Z" }
        },
        requestedFeed: "sip", effectiveFeed: "sip", currency: "USD", requestId: "stocks-SPY"
      }],
      fetchOptionContracts: async () => [{
        id: "contract-SPY", symbol: "SPY260724C00744000", underlying_symbol: "SPY",
        type: "call", expiration_date: "2026-07-24", strike_price: "744",
        size: "100", status: "active", tradable: true
      }],
      fetchOptionSnapshots: async () => [],
      fetchOptionChainSnapshots: async () => ({
        underlyingSymbol: "SPY", pagesConsumed: 1, snapshots: [{
          symbol: "SPY260724C00744000",
          raw: {
            latestQuote: { bp: 3.1, ap: 3.2, t: "2026-07-21T12:00:00.000Z" },
            impliedVolatility: 0.1663,
            greeks: { delta: 0.5276, gamma: 0.0355, theta: -0.7831, vega: 0.2686, rho: 0.0319 }
          },
          requestId: "chain-SPY", endpoint: "/v1beta1/options/snapshots/SPY?feed=opra&limit=1000",
          underlyingSymbol: "SPY", requestedFeed: "opra", effectiveFeed: "opra",
          pageToken: null, retrievedAt: "2026-07-21T13:42:00.000Z"
        }]
      })
    } as never
  });
  assert.equal(result.optionSnapshots.length, 0);
  assert.equal(result.summary.optionDataStatus, "degraded");
  assert.deepEqual(result.summary.optionDataRejectionReasons, [
    "POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING:SPY"
  ]);
});
