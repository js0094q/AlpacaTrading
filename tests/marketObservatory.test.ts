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

const [libDb, universeService] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/universeService.js")
]);

const { closeDbForTests, getDb } = libDb;
const {
  getAllUniverse,
  getUniverseSymbol,
  refreshUniverseAssetMetadata,
  seedInitialUniverse
} = universeService;

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
    DELETE FROM universe_symbols;
  `);
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
