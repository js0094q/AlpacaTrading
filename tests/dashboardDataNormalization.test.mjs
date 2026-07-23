import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDashboardBridgeSummary } from "../apps/dashboard/lib/data.ts";

test("normalizes PostgreSQL bridge rows to the dashboard render contract", () => {
  const normalized = normalizeDashboardBridgeSummary({
    latestPaperPlans: [{
      symbol: "AMD",
      decision: "selected",
      direction: "long",
      preferred_expression: "shares",
      strategy_family: "equity"
    }],
    plan: {
      ok: true,
      label: "plan",
      data: {
        plan: [{
          symbol: "AMD",
          decision: "selected",
          direction: "long",
          preferred_expression: "shares",
          strategy_family: "equity"
        }]
      }
    },
    optionContracts: [{
      underlying_symbol: "AMD",
      option_symbol: "AMD260821C00200000",
      type: "call",
      expiration_date: "2026-08-21",
      strike: "200",
      multiplier: "100",
      tradable: true,
      bid: "2.00",
      ask: "2.20",
      midpoint: "2.10",
      last: "2.05",
      volume: "1234",
      open_interest: "5678",
      implied_volatility: "0.31",
      delta: "0.55",
      gamma: "0.04",
      theta: "-0.08",
      vega: "0.22",
      rho: "0.07",
      spread_percentage: "9.52",
      quote_timestamp: "2026-07-23T14:59:00.000Z",
      quote_age_ms: "1000",
      snapshot_timestamp: "2026-07-23T14:59:01.000Z",
      source: "alpaca",
      source_feed: "opra",
      normalization_path: "current",
      days_to_expiration: "29",
      observed_at: "2026-07-23T14:59:00.000Z"
    }],
    hedge: {
      ok: true,
      label: "hedge",
      data: {
        paperOnly: true,
        environment: "paper",
        liveTradingEnabled: false,
        status: "blocked",
        blockers: ["NO_POSTGRES_HEDGE_STATE"]
      }
    }
  });

  const plan = normalized.plan.data.plan[0];
  assert.equal(plan.symbol, "AMD");
  assert.equal(plan.decision, "selected");
  assert.equal(plan.latestRank, 1);
  assert.equal(plan.strategy, "long / shares / equity");

  const option = normalized.optionContracts[0];
  assert.equal(option.underlying_symbol, "AMD");
  assert.equal(option.multiplier, 100);
  assert.equal(option.volume, 1234);
  assert.equal(option.openInterest, 5678);
  assert.equal(option.impliedVolatility, 0.31);
  assert.equal(option.delta, 0.55);
  assert.equal(option.gamma, 0.04);
  assert.equal(option.theta, -0.08);
  assert.equal(option.vega, 0.22);
  assert.equal(option.rho, 0.07);
  assert.equal(option.spreadPercentage, 9.52);
  assert.equal(option.quoteStatus, "valid");
  assert.equal(option.displayCategory, "Quoted");
  assert.equal(option.executable, false);
  assert.equal(option.rejectionReason, null);
  assert.equal(option.quoteAgeMs, 1000);
  assert.equal(option.snapshotTimestamp, "2026-07-23T14:59:01.000Z");
  assert.equal(option.source, "alpaca");
  assert.equal(option.sourceFeed, "opra");
  assert.equal(option.normalizationPath, "current");
  assert.equal(option.daysToExpiration, 29);
  assert.equal(option.greekAvailability, "available");
  assert.equal(option.decisionSnapshot.greeks.delta, 0.55);

  const hedge = normalized.hedge.data;
  assert.equal(hedge.effectiveStatus, "blocked");
});

test("normalizes a PostgreSQL option row without quote evidence as unavailable", () => {
  const normalized = normalizeDashboardBridgeSummary({
    optionContracts: [{
      underlying_symbol: "AMD",
      option_symbol: "AMD260821C00200000",
      type: "call",
      expiration_date: "2026-08-21",
      strike: "200",
      tradable: true
    }]
  });

  const option = normalized.optionContracts[0];
  assert.equal(option.quoteStatus, "missing");
  assert.equal(option.displayCategory, "Discovered");
  assert.equal(option.executable, false);
  assert.equal(option.executablePrice, null);
  assert.equal(option.multiplier, null);
  assert.equal(option.quoteAgeMs, null);
  assert.equal(option.snapshotTimestamp, null);
  assert.equal(option.source, null);
  assert.equal(option.sourceFeed, null);
  assert.equal(option.normalizationPath, null);
  assert.equal(option.daysToExpiration, null);
  assert.equal(option.volume, null);
  assert.equal(option.openInterest, null);
  assert.equal(option.impliedVolatility, null);
  assert.equal(option.delta, null);
  assert.equal(option.gamma, null);
  assert.equal(option.theta, null);
  assert.equal(option.vega, null);
  assert.equal(option.rho, null);
  assert.equal(option.spreadPercentage, null);
});
