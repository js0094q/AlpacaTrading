import assert from "node:assert/strict";
import test from "node:test";

import { selectExpressionWithPolicy } from "../src/services/strategySelectionLogic.js";
import {
  BASELINE_DECISION_THRESHOLDS,
  PAPER_EXPLORATION_V2_THRESHOLDS,
  classifyDirectionalScore,
  paperExplorationProfile,
  paperExplorationThresholds
} from "../src/services/paperExplorationConfig.js";

const paperEnv = {
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false"
};

const borderlineSignal = {
  symbol: "SPY",
  asOf: "2026-07-23T14:00:00.000Z",
  direction: "long" as const,
  confidence: 0.12,
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
  const exploration = selectExpressionWithPolicy(
    borderlineSignal,
    true,
    paperExplorationThresholds(paperEnv)
  );

  assert.equal(baseline.preferredExpression, "none");
  assert.equal(exploration.preferredExpression, "shares");
});

test("paper directional scoring admits additional long and short signals without changing baseline policy", () => {
  const exploration = paperExplorationThresholds(paperEnv);
  assert.equal(classifyDirectionalScore(0.045), "neutral");
  assert.equal(
    classifyDirectionalScore(0.045, PAPER_EXPLORATION_V2_THRESHOLDS.directionScore),
    "neutral"
  );
  assert.equal(classifyDirectionalScore(0.045, exploration.directionScore), "long");
  assert.equal(classifyDirectionalScore(-0.045, exploration.directionScore), "short");
});

test("paper exploration v3 lowers only strategy qualification gates and retains safety bounds", () => {
  assert.deepEqual(paperExplorationThresholds(paperEnv), {
    directionScore: 0.04,
    minimumDirectionalConfidence: 0.05,
    minimumOptionLiquidityScore: 0.1,
    maximumOptionSpreadPct: 0.15,
    minimumLongOptionConfidence: 0.2,
    minimumAggressiveOptionConfidence: 0.35,
    minimumDefinedRiskConfidence: 0.45,
    minimumOptionExpectedReturnPct: 0.2,
    minimumDefinedRiskExpectedReturnPct: 0.4,
    maxCandidates: 25,
    maxOrderNotional: 1_000
  });
});

test("paper exploration v3 produces more paper candidates across equity and option directions", () => {
  const equityLong = {
    ...borderlineSignal,
    confidence: 0.075
  };
  const equityShort = {
    ...equityLong,
    direction: "short" as const,
    expectedReturn: -0.01,
    trend: "bearish"
  };
  const longCall = {
    ...borderlineSignal,
    confidence: 0.375,
    expectedReturn: 0.002,
    iv: 0.3,
    liquidityScore: 0.1,
    spreadPct: 0.15,
    hasOptionsData: true
  };
  const longPut = {
    ...longCall,
    direction: "short" as const,
    expectedReturn: -0.002,
    trend: "bearish"
  };
  const current = paperExplorationThresholds(paperEnv);

  assert.equal(
    selectExpressionWithPolicy(equityLong, true, PAPER_EXPLORATION_V2_THRESHOLDS)
      .preferredExpression,
    "none"
  );
  assert.equal(selectExpressionWithPolicy(equityLong, true, current).preferredExpression, "shares");
  assert.equal(selectExpressionWithPolicy(equityShort, true, current).preferredExpression, "shares");
  assert.equal(
    selectExpressionWithPolicy(longCall, true, PAPER_EXPLORATION_V2_THRESHOLDS)
      .preferredExpression,
    "shares"
  );
  assert.equal(
    selectExpressionWithPolicy(longCall, true, current).preferredExpression,
    "long_call"
  );
  assert.equal(
    selectExpressionWithPolicy(longPut, true, PAPER_EXPLORATION_V2_THRESHOLDS)
      .preferredExpression,
    "shares"
  );
  assert.equal(selectExpressionWithPolicy(longPut, true, current).preferredExpression, "long_put");
});

test("paper exploration v3 records v2 provenance and unchanged safety gates", () => {
  assert.deepEqual(paperExplorationProfile(paperExplorationThresholds(paperEnv)), {
    scope: "paper_only",
    profile: "exploration_v3",
    thresholds: {
      directionScore: { previous: 0.05, current: 0.04 },
      directionalConfidence: { previous: 0.1, current: 0.05 },
      optionLiquidityScore: { previous: 0.1, current: 0.1 },
      maxOptionSpreadPct: { previous: 0.15, current: 0.15 },
      longOptionConfidence: { previous: 0.25, current: 0.2 },
      aggressiveOptionConfidence: { previous: 0.4, current: 0.35 },
      definedRiskConfidence: { previous: 0.5, current: 0.45 },
      optionExpectedReturnPct: { previous: 0.25, current: 0.2 },
      definedRiskExpectedReturnPct: { previous: 0.5, current: 0.4 },
      maxCandidates: { previous: 25, current: 25 },
      maxOrderNotional: { previous: 1_000, current: 1_000 }
    }
  });
});

test("paper exploration requires all four explicit paper-only flags", () => {
  for (const key of Object.keys(paperEnv)) {
    const incomplete = { ...paperEnv };
    delete incomplete[key as keyof typeof incomplete];
    assert.deepEqual(
      paperExplorationThresholds(incomplete),
      BASELINE_DECISION_THRESHOLDS,
      `missing ${key} must disable exploration`
    );
  }
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
