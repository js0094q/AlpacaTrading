import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { normalizeOptionSnapshot } from "../src/services/optionSnapshotNormalizer.js";

describe("option snapshot normalizer", () => {
  test("normalizes the complete current snapshot shape", () => {
    const snapshot = normalizeOptionSnapshot(" spy270115c00805000 ", {
      snapshotTimestamp: "2026-07-10T19:58:00Z",
      latestQuote: {
        t: "2026-07-10T19:59:59.416029802Z",
        bp: 16.4,
        ap: "16.52",
        bs: 4,
        as: "6"
      },
      latestTrade: {
        t: "2026-07-10T19:59:21.881733892Z",
        p: "16.85",
        s: 3
      },
      impliedVolatility: "0.1379",
      greeks: {
        delta: 0.3459,
        gamma: 0.0049,
        rho: 0,
        theta: -0.0986,
        vega: 2.0038
      }
    });

    assert.deepEqual(snapshot, {
      symbol: "SPY270115C00805000",
      underlying: "SPY",
      expiration: "2027-01-15",
      strike: 805,
      optionType: "call",
      latestQuote: {
        bidPrice: 16.4,
        askPrice: 16.52,
        bidSize: 4,
        askSize: 6,
        timestamp: "2026-07-10T19:59:59.416Z"
      },
      latestTrade: {
        price: 16.85,
        size: 3,
        timestamp: "2026-07-10T19:59:21.881Z"
      },
      impliedVolatility: 0.1379,
      greeks: {
        delta: 0.3459,
        gamma: 0.0049,
        theta: -0.0986,
        vega: 2.0038,
        rho: 0
      },
      snapshotTimestamp: "2026-07-10T19:59:59.416Z",
      normalizationPath: "current"
    });
  });

  test("normalizes the complete legacy snapshot shape", () => {
    const snapshot = normalizeOptionSnapshot("QQQ270115P00400000", {
      snapshot_timestamp: "2026-07-10T17:00:00Z",
      latest_quote: {
        t: "2026-07-10T16:59:00Z",
        b: "7.1",
        a: 7.3,
        bs: "8",
        as: 9
      },
      latest_trade: {
        t: "2026-07-10T16:58:00Z",
        p: 7.2,
        s: "2"
      },
      implied_volatility: 0.31,
      Greeks: {
        delta: -0.4,
        gamma: 0.02,
        theta: -0.03,
        vega: 0.12,
        rho: -0.08
      }
    });

    assert.equal(snapshot.underlying, "QQQ");
    assert.equal(snapshot.expiration, "2027-01-15");
    assert.equal(snapshot.strike, 400);
    assert.equal(snapshot.optionType, "put");
    assert.deepEqual(snapshot.latestQuote, {
      bidPrice: 7.1,
      askPrice: 7.3,
      bidSize: 8,
      askSize: 9,
      timestamp: "2026-07-10T16:59:00.000Z"
    });
    assert.deepEqual(snapshot.latestTrade, {
      price: 7.2,
      size: 2,
      timestamp: "2026-07-10T16:58:00.000Z"
    });
    assert.equal(snapshot.impliedVolatility, 0.31);
    assert.deepEqual(snapshot.greeks, {
      delta: -0.4,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      rho: -0.08
    });
    assert.equal(snapshot.snapshotTimestamp, "2026-07-10T17:00:00.000Z");
    assert.equal(snapshot.normalizationPath, "legacy");
  });

  test("falls back field-by-field across partial current and legacy aliases", () => {
    const snapshot = normalizeOptionSnapshot("SPY270115C00805000", {
      latestQuote: {
        t: "not-a-timestamp",
        bp: Number.POSITIVE_INFINITY,
        ap: 16.6,
        bs: 0
      },
      latest_quote: {
        t: "2026-07-10T19:57:00Z",
        bp: 16.2,
        ap: 16.5,
        bs: 5,
        as: 7
      },
      latestTrade: {
        p: Number.NaN,
        t: "2026-99-99T00:00:00Z"
      },
      latest_trade: {
        p: 16.4,
        s: 10,
        t: "2026-07-10T19:58:00Z"
      },
      impliedVolatility: Number.NEGATIVE_INFINITY,
      implied_volatility: 0.22,
      greeks: {
        delta: 0.4,
        gamma: undefined,
        theta: Number.NaN,
        rho: 0
      },
      Greeks: {
        delta: 0.9,
        gamma: 0.02,
        theta: -0.01,
        vega: 0.13,
        rho: 0.2
      }
    });

    assert.deepEqual(snapshot.latestQuote, {
      bidPrice: 16.2,
      askPrice: 16.6,
      bidSize: 0,
      askSize: 7,
      timestamp: "2026-07-10T19:57:00.000Z"
    });
    assert.deepEqual(snapshot.latestTrade, {
      price: 16.4,
      size: 10,
      timestamp: "2026-07-10T19:58:00.000Z"
    });
    assert.equal(snapshot.impliedVolatility, 0.22);
    assert.deepEqual(snapshot.greeks, {
      delta: 0.4,
      gamma: 0.02,
      theta: -0.01,
      vega: 0.13,
      rho: 0
    });
    assert.equal(snapshot.snapshotTimestamp, "2026-07-10T19:58:00.000Z");
    assert.equal(snapshot.normalizationPath, "mixed");
  });

  test("preserves partial Greeks and returns nulls for missing evidence", () => {
    const partial = normalizeOptionSnapshot("SPY270115P00600000", {
      greeks: { delta: -0.25 }
    });
    const missing = normalizeOptionSnapshot("SPY270115P00600000", {});

    assert.deepEqual(partial.greeks, {
      delta: -0.25,
      gamma: null,
      theta: null,
      vega: null,
      rho: null
    });
    assert.equal(partial.normalizationPath, "current");
    assert.deepEqual(missing.greeks, {
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      rho: null
    });
    assert.equal(missing.latestQuote, null);
    assert.equal(missing.latestTrade, null);
    assert.equal(missing.impliedVolatility, null);
    assert.equal(missing.snapshotTimestamp, null);
    assert.equal(missing.normalizationPath, "none");
  });

  test("rejects non-finite numbers and malformed timestamps without hiding the observed path", () => {
    const snapshot = normalizeOptionSnapshot("SPY270115C00805000", {
      snapshotTimestamp: "2026-02-30T12:00:00Z",
      latestQuote: {
        bp: Number.NaN,
        ap: Number.POSITIVE_INFINITY,
        bs: "NaN",
        as: "Infinity",
        t: "yesterday"
      },
      latestTrade: {
        p: Number.NEGATIVE_INFINITY,
        s: Number.NaN,
        t: "2026-07-10"
      },
      impliedVolatility: Number.NaN,
      greeks: {
        delta: Number.NaN,
        gamma: Number.POSITIVE_INFINITY,
        theta: Number.NEGATIVE_INFINITY,
        vega: "not-a-number",
        rho: null
      }
    });

    assert.equal(snapshot.latestQuote, null);
    assert.equal(snapshot.latestTrade, null);
    assert.equal(snapshot.impliedVolatility, null);
    assert.deepEqual(snapshot.greeks, {
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      rho: null
    });
    assert.equal(snapshot.snapshotTimestamp, null);
    assert.equal(snapshot.normalizationPath, "current");
  });

  test("rejects invalid OCC symbols", () => {
    assert.throws(
      () => normalizeOptionSnapshot("SPY-NOT-OCC", {}),
      /OPTION_SYMBOL_FORMAT_INVALID/
    );
    assert.throws(
      () => normalizeOptionSnapshot("SPY270230C00805000", {}),
      /OPTION_EXPIRATION_INVALID/
    );
  });
});
