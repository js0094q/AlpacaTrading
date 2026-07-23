import assert from "node:assert/strict";
import test from "node:test";

import { selectExpressionWithPolicy } from "../src/services/strategySelectionLogic.js";
import {
  classifyDirectionalScore,
  paperExplorationThresholds
} from "../src/services/paperExplorationConfig.js";

const borderlineSignal = {
  symbol: "SPY",
  asOf: "2026-07-23T14:00:00.000Z",
  direction: "long" as const,
  confidence: 0.3,
  expectedReturn: 0.01,
  atr: 2,
  trend: "bullish",
  iv: null,
  liquidityScore: 0,
  spreadPct: null,
  hasOptionsData: false
};

test("paper exploration admits a genuine borderline directional signal without changing the baseline", () => {
  const baseline = selectExpressionWithPolicy(borderlineSignal, true);
  const exploration = selectExpressionWithPolicy(borderlineSignal, true, {
    minimumDirectionalConfidence: 0.25,
    minimumOptionLiquidityScore: 0.35,
    maximumOptionSpreadPct: 0.12
  });

  assert.equal(baseline.preferredExpression, "none");
  assert.equal(exploration.preferredExpression, "shares");
});

test("paper directional scoring is relaxed from 0.25 to 0.15 and remains reversible", () => {
  const exploration = paperExplorationThresholds({});
  assert.equal(classifyDirectionalScore(0.2), "neutral");
  assert.equal(classifyDirectionalScore(0.2, exploration.directionScore), "long");
});

test("explicit live-mode flags disable every relaxed exploration threshold", () => {
  const thresholds = paperExplorationThresholds({
    ALPACA_ENV: "live",
    TRADING_MODE: "live",
    ALPACA_LIVE_TRADE: "true",
    LIVE_TRADING_ENABLED: "true"
  });

  assert.deepEqual(thresholds, {
    directionScore: 0.25,
    minimumDirectionalConfidence: 0.35,
    minimumOptionLiquidityScore: 0.5,
    maximumOptionSpreadPct: 0.08,
    minimumLongOptionConfidence: 0.5,
    minimumAggressiveOptionConfidence: 0.7,
    minimumDefinedRiskConfidence: 0.8,
    minimumOptionExpectedReturnPct: 1,
    minimumDefinedRiskExpectedReturnPct: 1.5,
    maxCandidates: 10,
    maxOrderNotional: 1_000
  });
});
