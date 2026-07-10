import assert from "node:assert/strict";
import test from "node:test";

import { buildHedgeConfig } from "../src/services/hedgeConfigService.js";
import {
  classifyMarketRegimeFromBars,
  classifyMarketRegimeFromIndicators,
  type MarketRegimeIndicators
} from "../src/services/marketRegimeService.js";

const base: MarketRegimeIndicators = {
  requiredDataAvailable: true,
  spyAboveSma50: true,
  spyAboveSma200: true,
  qqqAboveSma50: true,
  qqqAboveSma200: true,
  spyBelowSma50Pct: 0,
  spyDrawdown20Pct: 0.02,
  realizedVolatility20: 0.15,
  volatilityProxyLevel: 20,
  volatilityProxyTrend: "falling"
};

test("insufficient required benchmark data has first priority", () => {
  const result = classifyMarketRegimeFromIndicators(
    { ...base, requiredDataAvailable: false, spyBelowSma50Pct: 0.2 },
    buildHedgeConfig()
  );

  assert.equal(result.regime, "insufficient-data");
  assert.equal(result.selectedRule, "INSUFFICIENT_REQUIRED_BENCHMARK_DATA");
});

test("crisis wins before risk-off", () => {
  const result = classifyMarketRegimeFromIndicators(
    {
      ...base,
      spyAboveSma50: false,
      spyAboveSma200: false,
      qqqAboveSma50: false,
      qqqAboveSma200: false,
      spyBelowSma50Pct: 0.11
    },
    buildHedgeConfig()
  );

  assert.equal(result.regime, "crisis");
  assert.equal(result.selectedRule, "CRISIS_SPY_BELOW_SMA50");
});

test("classifies risk-off when both benchmarks are below SMA200", () => {
  const result = classifyMarketRegimeFromIndicators(
    {
      ...base,
      spyAboveSma50: false,
      spyAboveSma200: false,
      qqqAboveSma50: false,
      qqqAboveSma200: false
    },
    buildHedgeConfig()
  );

  assert.equal(result.regime, "risk-off");
  assert.equal(result.selectedRule, "RISK_OFF_LONG_TREND_BREAK");
});

test("classifies transition when benchmark trends disagree", () => {
  const result = classifyMarketRegimeFromIndicators(
    { ...base, qqqAboveSma50: false, qqqAboveSma200: false },
    buildHedgeConfig()
  );

  assert.equal(result.regime, "transition");
  assert.equal(result.selectedRule, "TRANSITION_BENCHMARK_DIVERGENCE");
});

test("classifies risk-on when both benchmarks are above SMA50 and SMA200", () => {
  const result = classifyMarketRegimeFromIndicators(base, buildHedgeConfig());

  assert.equal(result.regime, "risk-on");
  assert.equal(result.selectedRule, "RISK_ON_CONFIRMED_TREND");
});

test("classifies neutral when sufficient evidence matches no earlier rule", () => {
  const result = classifyMarketRegimeFromIndicators(
    {
      ...base,
      spyAboveSma50: false,
      spyAboveSma200: true,
      qqqAboveSma50: false,
      qqqAboveSma200: true,
      realizedVolatility20: 0.1
    },
    buildHedgeConfig()
  );

  assert.equal(result.regime, "neutral");
  assert.equal(result.selectedRule, "NEUTRAL_NO_PRIORITY_RULE");
});

test("derives a risk-on regime from sufficient rising bars", () => {
  const bars = (symbol: string) =>
    Array.from({ length: 220 }, (_, index) => ({
      symbol,
      timeframe: "1Day",
      timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 1_000_000
    }));
  const result = classifyMarketRegimeFromBars(
    { SPY: bars("SPY"), QQQ: bars("QQQ"), VIXY: [] },
    buildHedgeConfig(),
    "2026-07-10T14:00:00Z"
  );

  assert.equal(result.regime, "risk-on");
  assert.ok(result.warnings.includes("REGIME_VOLATILITY_PROXY_UNAVAILABLE"));
});
