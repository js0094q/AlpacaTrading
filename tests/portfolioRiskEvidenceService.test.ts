import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const tempDir = mkdtempSync(join(tmpdir(), "portfolio-risk-evidence-"));
process.env.RESEARCH_DB_PATH = join(tempDir, "evidence.sqlite");

const { closeDbForTests, getDb } = await import("../src/lib/db.js");
const {
  readOptionRiskEvidence,
  readUnderlyingPriceEvidence
} = await import("../src/services/portfolioRiskEvidenceService.js");

before(() => {
  const db = getDb();
  db.exec("DELETE FROM option_snapshots; DELETE FROM option_contracts; DELETE FROM market_bars;");
  db.prepare(`
    INSERT INTO option_contracts(
      underlying_symbol, option_symbol, type, expiration_date, strike,
      multiplier, tradable, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("WRONG", "SPY260918P00500000", "put", "2026-09-18", 500, 100, 1, "alpaca");
  db.prepare(`
    INSERT INTO option_snapshots(
      option_symbol, underlying_symbol, timestamp, bid, ask, midpoint, last,
      quote_status, executable, quote_timestamp, bid_size, ask_size, trade_size,
      trade_timestamp, implied_volatility, delta, gamma, theta, vega, rho,
      snapshot_timestamp, normalization_path, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "SPY260918P00500000", "SPY", "2026-07-10T13:59:45.000Z", 9, 11, 10, 10,
    "tradable", 1, "2026-07-10T13:59:44.000Z", 12, 14, 3,
    "2026-07-10T13:59:43.000Z", 0.25, -0.4, 0.01, -0.05, 0.2, -0.1,
    "2026-07-10T13:59:45.000Z", "current", "alpaca"
  );
  db.prepare(`
    INSERT INTO market_bars(symbol, timestamp, timeframe, open, high, low, close, volume, source)
    VALUES (?, ?, '1Day', ?, ?, ?, ?, ?, ?)
  `).run("SPY", "2026-07-10T00:00:00.000Z", 590, 605, 588, 600, 1000, "alpaca");
  db.prepare(`
    INSERT INTO option_snapshots(
      option_symbol, underlying_symbol, timestamp, delta, snapshot_timestamp,
      normalization_path, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "IWM260918C00200000", "IWM", "2026-07-10T13:59:50.000Z", 0.35,
    "2026-07-10T13:59:50.000Z", "current", "alpaca"
  );
});

after(() => {
  closeDbForTests();
  rmSync(tempDir, { recursive: true, force: true });
});

test("reads canonical option identity and normalized evidence columns", () => {
  const evidence = readOptionRiskEvidence("SPY260918P00500000");

  assert.deepEqual(evidence, {
    symbol: "SPY260918P00500000",
    underlying: "SPY",
    expirationDate: "2026-09-18",
    strikePrice: 500,
    optionType: "put",
    multiplier: 100,
    delta: -0.4,
    gamma: 0.01,
    theta: -0.05,
    vega: 0.2,
    rho: -0.1,
    impliedVolatility: 0.25,
    bid: 9,
    ask: 11,
    midpoint: 10,
    quoteTimestamp: "2026-07-10T13:59:44.000Z",
    snapshotTimestamp: "2026-07-10T13:59:45.000Z",
    quoteStatus: "tradable",
    source: "alpaca",
    normalizationPath: "current"
  });
});

test("reads underlying price with its observation timestamp", () => {
  assert.deepEqual(readUnderlyingPriceEvidence("spy"), {
    symbol: "SPY",
    price: 600,
    timestamp: "2026-07-10T00:00:00.000Z"
  });
});

test("missing rows preserve null evidence without raw alias fallback", () => {
  const evidence = readOptionRiskEvidence("QQQ260918C00500000");

  assert.equal(evidence.symbol, "QQQ260918C00500000");
  assert.equal(evidence.underlying, "QQQ");
  assert.equal(evidence.multiplier, null);
  assert.equal(evidence.delta, null);
  assert.equal(evidence.snapshotTimestamp, null);
  assert.deepEqual(readUnderlyingPriceEvidence("QQQ"), {
    symbol: "QQQ",
    price: null,
    timestamp: null
  });
});

test("preserves canonical snapshot evidence when contract metadata is absent", () => {
  const evidence = readOptionRiskEvidence("IWM260918C00200000");

  assert.equal(evidence.underlying, "IWM");
  assert.equal(evidence.multiplier, null);
  assert.equal(evidence.delta, 0.35);
  assert.equal(evidence.snapshotTimestamp, "2026-07-10T13:59:50.000Z");
  assert.equal(evidence.normalizationPath, "current");
});
