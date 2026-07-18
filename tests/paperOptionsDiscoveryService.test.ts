import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-options-discovery-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import { buildPaperOptionsDiscoveryReport } from "../src/services/paperOptionsDiscoveryService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM option_snapshots;
    DELETE FROM option_contracts;
  `);
};

const insertContract = (input: {
  symbol: string;
  expirationDate: string;
  type?: "call" | "put";
  strike?: number;
}) => {
  getDb().prepare(`
    INSERT INTO option_contracts(
      underlying_symbol, option_symbol, type, expiration_date, strike, multiplier, tradable, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("SPY", input.symbol, input.type || "call", input.expirationDate, input.strike ?? 450, 100, 1, "test");
};

const insertSnapshot = (input: {
  symbol: string;
  bid?: number | null;
  ask?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
}) => {
  const bid = input.bid ?? 1;
  const ask = input.ask ?? 1.1;
  getDb().prepare(`
    INSERT INTO option_snapshots(
      option_symbol, underlying_symbol, timestamp, bid, ask, midpoint, last, quote_status,
      executable, executable_price, executable_price_source, rejection_reason, quote_timestamp,
      volume, open_interest, implied_volatility, delta, gamma, theta, vega, rho,
      source_feed, quote_age_ms, spread_percentage, source
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?
    )
  `).run(
    input.symbol,
    "SPY",
    "2026-07-07T14:00:00.000Z",
    bid,
    ask,
    bid !== null && ask !== null ? (bid + ask) / 2 : null,
    bid,
    bid !== null && ask !== null ? "valid" : "missing",
    bid !== null && ask !== null ? 1 : 0,
    bid !== null && ask !== null ? (bid + ask) / 2 : null,
    "mid",
    bid !== null && ask !== null ? null : "quote_unavailable",
    "2026-07-07T14:00:00.000Z",
    100,
    1000,
    0.3,
    0.5,
    input.gamma ?? null,
    input.theta ?? null,
    input.vega ?? null,
    input.rho ?? null,
    "opra",
    500,
    bid !== null && ask !== null ? ((ask - bid) / ((bid + ask) / 2)) * 100 : null,
    "test"
  );
};

beforeEach(() => {
  process.env.PAPER_0DTE_DISCOVERY_ENABLED = "true";
  process.env.PAPER_0DTE_SPY_MAX_SPREAD_PCT = "20";
  process.env.PAPER_0DTE_SPY_MAX_PREMIUM_PER_CONTRACT = "250";
  process.env.PAPER_0DTE_SPY_HARD_SPREAD_CAP_ENABLED = "true";
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("paper options discovery", () => {
  test("discovers current-day 0DTE contracts", async () => {
    insertContract({ symbol: "SPY260707C00450000", expirationDate: "2026-07-07", type: "call" });
    insertContract({ symbol: "SPY260707P00450000", expirationDate: "2026-07-07", type: "put" });
    insertSnapshot({ symbol: "SPY260707C00450000" });
    insertSnapshot({ symbol: "SPY260707P00450000" });

    const report = await buildPaperOptionsDiscoveryReport({
      underlying: "SPY",
      dte: 0,
      asOf: "2026-07-07T13:00:00.000Z"
    });

    assert.equal(report.status, "success");
    assert.equal(report.nextSessionPreparation, false);
    assert.equal(report.summary.selected, 2);
    assert.equal(report.candidates.every((candidate) => candidate.currentSession0Dte), true);
  });

  test("labels next-session preparation when current day has no usable contract", async () => {
    insertContract({ symbol: "SPY260708C00450000", expirationDate: "2026-07-08", type: "call" });
    insertSnapshot({ symbol: "SPY260708C00450000" });

    const report = await buildPaperOptionsDiscoveryReport({
      underlying: "SPY",
      dte: 0,
      asOf: "2026-07-07T21:30:00.000Z"
    });

    assert.equal(report.nextSessionPreparation, true);
    assert.equal(report.selectedExpirationDate, "2026-07-08");
    assert.equal(report.candidates[0]?.nextSessionPreparation, true);
  });

  test("rejects missing quote data", async () => {
    insertContract({ symbol: "SPY260707C00450000", expirationDate: "2026-07-07" });

    const report = await buildPaperOptionsDiscoveryReport({
      underlying: "SPY",
      dte: 0,
      asOf: "2026-07-07T13:00:00.000Z",
      allowNextSessionPreparation: false
    });

    assert.equal(report.summary.rejectedMissingQuote, 1);
    assert.equal(report.candidates[0]?.reasonSkipped, "MISSING_OR_INVALID_QUOTE");
  });

  test("rejects excessive spread when hard spread cap is enabled", async () => {
    insertContract({ symbol: "SPY260707C00450000", expirationDate: "2026-07-07" });
    insertSnapshot({ symbol: "SPY260707C00450000", bid: 1, ask: 2 });

    const report = await buildPaperOptionsDiscoveryReport({
      underlying: "SPY",
      dte: 0,
      asOf: "2026-07-07T13:00:00.000Z",
      allowNextSessionPreparation: false
    });

    assert.equal(report.summary.rejectedWideSpread, 1);
    assert.equal(report.candidates[0]?.reasonSkipped, "SPREAD_TOO_WIDE");
  });

  test("already-held equity symbols do not block option candidate discovery", async () => {
    insertContract({ symbol: "SPY260707C00450000", expirationDate: "2026-07-07" });
    insertSnapshot({ symbol: "SPY260707C00450000" });

    const report = await buildPaperOptionsDiscoveryReport({
      underlying: "SPY",
      dte: 0,
      asOf: "2026-07-07T13:00:00.000Z"
    });

    assert.equal(report.summary.selected, 1);
    assert.equal(report.candidates[0]?.selected, true);
  });

  test("retains evaluated Greek evidence and rejection reasons when nothing is selected", async () => {
    insertContract({ symbol: "SPY260707C00450000", expirationDate: "2026-07-07" });
    insertSnapshot({
      symbol: "SPY260707C00450000",
      bid: 1,
      ask: 2,
      gamma: 0.0049,
      theta: -0.0986,
      vega: 2.0038,
      rho: 0.12
    });

    const report = await buildPaperOptionsDiscoveryReport({
      underlying: "SPY",
      dte: 0,
      asOf: "2026-07-07T13:00:00.000Z",
      allowNextSessionPreparation: false
    });
    const candidate = report.candidates[0];

    assert.equal(report.summary.selected, 0);
    assert.equal(candidate?.reasonSkipped, "SPREAD_TOO_WIDE");
    assert.equal(candidate?.gamma, 0.0049);
    assert.equal(candidate?.theta, -0.0986);
    assert.equal(candidate?.vega, 2.0038);
    assert.equal(candidate?.rho, 0.12);
    assert.equal(candidate?.sourceFeed, "opra");
    assert.equal(candidate?.quoteAgeMs, 500);
    assert.deepEqual(candidate?.rejectionReasons, ["SPREAD_TOO_WIDE"]);
  });
});
