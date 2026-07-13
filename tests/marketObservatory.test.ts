import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-market-observatory-test-")),
  "research.db"
);
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

const [
  libDb,
  universeService,
  stockSnapshotNormalizer,
  stockObservationService,
  alpacaProvider
] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/universeService.js"),
  import("../src/services/stockSnapshotNormalizer.js"),
  import("../src/services/stockObservationService.js"),
  import("../src/services/providers/alpaca.js")
]);

const { closeDbForTests, getDb } = libDb;
const {
  getAllUniverse,
  getUniverseSymbol,
  refreshUniverseAssetMetadata,
  seedInitialUniverse
} = universeService;
const { normalizeStockSnapshot } = stockSnapshotNormalizer;
const { persistStockSnapshot } = stockObservationService;
const { fetchStockSnapshots } = alpacaProvider;

const originalSymbols = [
  "SPY", "NEE", "POOL", "NFG", "CVS", "SOFI", "XLE", "XLK", "QQQ", "IWM",
  "TSLA", "HNRG", "HRB", "NSP", "SCHD", "TWO", "VWO", "VUG", "RSP", "VTI",
  "IVV", "VOO", "IJR", "XLF", "TQQQ", "VTV", "VO", "VB", "VXF", "VBR",
  "COP", "VEA"
];

const requestedSymbols = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX",
  "JPM", "GS", "XOM", "LLY", "UNH", "COST", "WMT", "CAT", "PLTR", "SMCI"
];

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM stock_snapshots;
    DELETE FROM universe_symbols;
  `);
};

const completeSnapshot = {
  latestTrade: {
    t: "2026-07-13T16:44:48.000Z",
    p: 100.1,
    s: 10,
    x: "V",
    c: ["@"]
  },
  latestQuote: {
    t: "2026-07-13T16:44:50.000Z",
    bp: 100,
    ap: 100.2,
    bs: 5,
    as: 7,
    bx: "V",
    ax: "V",
    c: ["R"]
  },
  minuteBar: {
    t: "2026-07-13T16:44:00.000Z",
    o: 99.9,
    h: 100.3,
    l: 99.8,
    c: 100.1,
    v: 1000,
    n: 40,
    vw: 100.05
  },
  dailyBar: {
    t: "2026-07-13T04:00:00.000Z",
    o: 98,
    h: 101,
    l: 97.5,
    c: 100,
    v: 100_000,
    n: 4000,
    vw: 99.5
  },
  prevDailyBar: {
    t: "2026-07-10T04:00:00.000Z",
    o: 96,
    h: 99,
    l: 95,
    c: 97,
    v: 200_000,
    n: 8000,
    vw: 97.25
  }
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

describe("market observatory universe", () => {
  test("canonical universe retains existing symbols and includes the requested set once", async () => {
    const first = await seedInitialUniverse();
    const second = await seedInitialUniverse();

    assert.equal(first.symbols.length, 51);
    assert.deepEqual(second.symbols, first.symbols);
    assert.equal(new Set(second.symbols).size, 51);
    requestedSymbols.forEach((symbol) => assert.equal(second.symbols.includes(symbol), true));
    originalSymbols.forEach((symbol) => assert.equal(second.symbols.includes(symbol), true));
    assert.equal(getAllUniverse().length, 51);
  });

  test("Alpaca asset validation persists traceable metadata", async () => {
    await seedInitialUniverse();
    const result = await refreshUniverseAssetMetadata({
      symbols: ["AAPL"],
      getAsset: async () => ({
        id: "asset-aapl",
        class: "us_equity",
        exchange: "NASDAQ",
        symbol: "AAPL",
        status: "active",
        tradable: true,
        marginable: true,
        shortable: true,
        fractionable: true,
        attributes: ["has_options", "overnight_tradable"],
        requestId: "asset-request"
      })
    });

    const row = getUniverseSymbol("AAPL");
    assert.deepEqual(result, { checked: 1, active: 1, disabled: 0, failed: [] });
    assert.equal(row?.assetId, "asset-aapl");
    assert.equal(row?.assetStatus, "active");
    assert.equal(row?.exchange, "NASDAQ");
    assert.equal(row?.fractionable, 1);
    assert.equal(row?.shortable, 1);
    assert.equal(row?.marginable, 1);
    assert.equal(row?.optionsEnabled, 1);
    assert.deepEqual(row?.assetAttributes, ["has_options", "overnight_tradable"]);
    assert.equal(row?.assetRequestId, "asset-request");
    assert.ok(row?.assetValidatedAt);
  });

  test("inactive or non-tradable Alpaca assets are retained but disabled", async () => {
    await seedInitialUniverse();
    const result = await refreshUniverseAssetMetadata({
      symbols: ["AAPL", "MSFT"],
      getAsset: async (symbol: string) => ({
        symbol,
        status: symbol === "AAPL" ? "inactive" : "active",
        tradable: false
      })
    });

    assert.equal(result.disabled, 2);
    assert.equal(getUniverseSymbol("AAPL")?.enabled, 0);
    assert.equal(getUniverseSymbol("AAPL")?.tradable, 0);
    assert.equal(getUniverseSymbol("AAPL")?.assetStatus, "inactive");
    assert.equal(getUniverseSymbol("MSFT")?.enabled, 0);
    assert.equal(getUniverseSymbol("MSFT")?.tradable, 0);
  });
});

describe("market observatory stock snapshots", () => {
  test("uses Alpaca multi-symbol snapshots and represents a partial response", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return {
        ok: true,
        status: 200,
        headers: { get: () => "snapshot-request" },
        text: async () => JSON.stringify({ AAPL: completeSnapshot })
      } as unknown as Response;
    };

    const rows = await fetchStockSnapshots({
      symbols: ["AAPL", "MSFT"],
      feed: "iex",
      currency: "USD"
    });

    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? "", /\/v2\/stocks\/snapshots\?/);
    assert.match(urls[0] ?? "", /symbols=AAPL%2CMSFT/);
    assert.match(urls[0] ?? "", /feed=iex/);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.symbol, "AAPL");
    assert.equal(rows[0]?.requestId, "snapshot-request");
    assert.equal(rows[0]?.requestedFeed, "iex");
    assert.equal(rows[0]?.effectiveFeed, "iex");
    assert.equal(rows[1]?.symbol, "MSFT");
    assert.equal(rows[1]?.raw, null);
    assert.equal(rows[1]?.error, "SOURCE_SYMBOL_MISSING");
  });

  test("normalizes complete evidence while preserving source and ingestion timestamps", () => {
    const row = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: completeSnapshot,
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      currency: "USD",
      requestId: "snapshot-request",
      now: new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(row.observedAt, "2026-07-13T16:45:00.000Z");
    assert.equal(row.sourceTimestamp, "2026-07-13T16:44:50.000Z");
    assert.equal(row.tradeTimestamp, "2026-07-13T16:44:48.000Z");
    assert.equal(row.quoteTimestamp, "2026-07-13T16:44:50.000Z");
    assert.equal(row.minuteTimestamp, "2026-07-13T16:44:00.000Z");
    assert.equal(row.latestTradePrice, 100.1);
    assert.equal(row.midpoint, 100.1);
    assert.ok(Math.abs((row.spread ?? 0) - 0.2) < 1e-10);
    assert.ok(Math.abs((row.spreadPct ?? 0) - 0.1998001998) < 1e-8);
    assert.equal(row.dailyReturn, 100 / 97 - 1);
    assert.equal(row.gapFromPreviousClose, 98 / 97 - 1);
    assert.equal(row.returnFromOpen, 100 / 98 - 1);
    assert.equal(row.distanceFromVwap, 100 / 99.5 - 1);
    assert.equal(row.intradayRange, 3.5);
    assert.equal(row.relativeCurrentDayVolume, 0.5);
    assert.equal(row.freshnessStatus, "FRESH");
    assert.equal(row.dataQualityStatus, "COMPLETE");
    assert.equal(row.requestedFeed, "iex");
    assert.equal(row.effectiveFeed, "iex");
    assert.equal(row.requestId, "snapshot-request");
  });

  test("represents missing and stale evidence explicitly", () => {
    const missingQuote = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: { ...completeSnapshot, latestQuote: undefined },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });
    const missingTrade = normalizeStockSnapshot({
      symbol: "MSFT",
      raw: { ...completeSnapshot, latestTrade: undefined },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });
    const missingMinute = normalizeStockSnapshot({
      symbol: "NVDA",
      raw: { ...completeSnapshot, minuteBar: undefined },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });
    const stale = normalizeStockSnapshot({
      symbol: "AMZN",
      raw: completeSnapshot,
      observedAt: "2026-07-13T17:30:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T17:30:00.000Z")
    });

    assert.equal(missingQuote.dataQualityStatus, "MISSING_QUOTE");
    assert.equal(missingQuote.bidPrice, null);
    assert.equal(missingQuote.spread, null);
    assert.equal(missingTrade.dataQualityStatus, "MISSING_TRADE");
    assert.equal(missingTrade.latestTradePrice, null);
    assert.equal(missingMinute.dataQualityStatus, "MISSING_MINUTE_BAR");
    assert.equal(missingMinute.minuteTimestamp, null);
    assert.equal(stale.freshnessStatus, "STALE");
  });

  test("marks incomplete daily context partial and preserves observed zeroes", () => {
    const row = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: {
        ...completeSnapshot,
        latestQuote: { ...completeSnapshot.latestQuote, bp: 0, ap: 0 },
        prevDailyBar: undefined
      },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(row.bidPrice, 0);
    assert.equal(row.askPrice, 0);
    assert.equal(row.midpoint, 0);
    assert.equal(row.spread, 0);
    assert.equal(row.spreadPct, null);
    assert.equal(row.previousDailyClose, null);
    assert.equal(row.dailyReturn, null);
    assert.equal(row.dataQualityStatus, "PARTIAL");
  });

  test("persists append-only evidence and deduplicates repeated source timestamps", () => {
    const row = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: completeSnapshot,
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(persistStockSnapshot(row, 1), 1);
    assert.equal(persistStockSnapshot(row, 2), 0);
    const stored = getDb()
      .prepare("SELECT * FROM stock_snapshots WHERE symbol = ?")
      .all("AAPL") as Array<Record<string, unknown>>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.source_timestamp, "2026-07-13T16:44:50.000Z");
    assert.equal(stored[0]?.observed_at, "2026-07-13T16:45:00.000Z");
  });
});
