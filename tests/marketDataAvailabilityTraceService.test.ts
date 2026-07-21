import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketDataCoverage,
  runDeterministicMarketDataTrace
} from "../src/services/marketDataAvailabilityTraceService.js";

test("coverage separates provider availability, PostgreSQL persistence, and material decision use", () => {
  const report = buildMarketDataCoverage({
    asset: "options",
    now: "2026-07-21T14:00:00.000Z",
    provider: {
      endpoint: "/v1beta1/options/snapshots",
      feed: "opra",
      values: { delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, rho: null, impliedVolatility: 0.25 },
      timestamps: { quoteTimestamp: "2026-07-21T13:59:59.000Z" }
    },
    postgres: {
      table: "option_snapshots",
      values: { delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, rho: null, impliedVolatility: 0.25 }
    },
    decision: {
      values: { delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, impliedVolatility: 0.25 },
      materiallyConsumed: ["delta", "gamma", "theta", "vega", "impliedVolatility"]
    }
  });

  assert.equal(report.fields.delta.availability, "AVAILABLE");
  assert.equal(report.fields.delta.consumption, "DECISION_INPUT");
  assert.equal(report.fields.rho.availability, "PROVIDER_UNAVAILABLE");
  assert.equal(report.fields.rho.consumption, "PERSISTED_UNUSED");
  assert.equal(report.fields.rho.normalizedValue, null);
});

test("deterministic trace changes only delta and proves its ranking impact", () => {
  const trace = runDeterministicMarketDataTrace({
    baseline: {
      confidence: 0.8,
      expectedReturn: 0.03,
      baseLiquidityScore: 0.45,
      option: { symbol: "SPY260821C00750000", delta: null, gamma: 0.02, theta: -0.08, vega: 0.12, impliedVolatility: 0.25, spreadPct: 0.04 }
    },
    field: "delta",
    afterValue: 0.5
  });

  assert.deepEqual(trace.changedInputs, ["delta"]);
  assert.equal(trace.before.marketDataScore, 0.525);
  assert.equal(trace.after.marketDataScore, 0.55);
  assert.notEqual(trace.before.candidateRankingScore, trace.after.candidateRankingScore);
  assert.equal(trace.diff.gate, "unchanged");
  assert.equal(trace.diff.positionSize, "not_applicable");
  assert.equal(trace.diff.limitPrice, "unchanged");
});

test("missing required quote timestamp is unavailable and rejects rather than becoming zero", () => {
  const report = buildMarketDataCoverage({
    asset: "options",
    now: "2026-07-21T14:00:00.000Z",
    provider: { endpoint: "/v1beta1/options/snapshots", feed: "opra", values: { delta: null }, timestamps: {} },
    postgres: { table: "option_snapshots", values: { delta: null } },
    decision: { values: { delta: null }, materiallyConsumed: [] }
  });
  assert.equal(report.fields.delta.rawValue, null);
  assert.equal(report.fields.delta.normalizedValue, null);
  assert.equal(report.fields.delta.availability, "PROVIDER_UNAVAILABLE");
  assert.equal(report.executionAllowed, false);
  assert.deepEqual(report.rejectionReasons, ["OPTION_QUOTE_TIMESTAMP_UNAVAILABLE"]);
});
