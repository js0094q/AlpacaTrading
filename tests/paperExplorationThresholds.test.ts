import assert from "node:assert/strict";
import test from "node:test";

import { selectExpressionWithPolicy } from "../src/services/strategySelectionLogic.js";
import {
  BASELINE_DECISION_THRESHOLDS,
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

test("paper directional scoring is relaxed from 0.15 to 0.05 and remains reversible", () => {
  const exploration = paperExplorationThresholds(paperEnv);
  assert.equal(classifyDirectionalScore(0.1), "neutral");
  assert.equal(classifyDirectionalScore(0.1, exploration.directionScore), "long");
});

test("paper exploration v2 uses the supported lower decision bounds and retains $1,000 orders", () => {
  assert.deepEqual(paperExplorationThresholds(paperEnv), {
    directionScore: 0.05,
    minimumDirectionalConfidence: 0.1,
    minimumOptionLiquidityScore: 0.1,
    maximumOptionSpreadPct: 0.15,
    minimumLongOptionConfidence: 0.25,
    minimumAggressiveOptionConfidence: 0.4,
    minimumDefinedRiskConfidence: 0.5,
    minimumOptionExpectedReturnPct: 0.25,
    minimumDefinedRiskExpectedReturnPct: 0.5,
    maxCandidates: 25,
    maxOrderNotional: 1_000
  });
});

test("paper exploration v2 admits a marginal observed option signal without changing baseline policy", () => {
  const signal = {
    ...borderlineSignal,
    confidence: 0.45,
    expectedReturn: 0.003,
    iv: 0.3,
    liquidityScore: 0.15,
    spreadPct: 0.14,
    hasOptionsData: true
  };

  assert.equal(selectExpressionWithPolicy(signal, true).preferredExpression, "shares");
  assert.equal(
    selectExpressionWithPolicy(signal, true, paperExplorationThresholds(paperEnv)).preferredExpression,
    "long_call"
  );
});

test("paper exploration v2 records the exact prior deployed value for every changed gate", () => {
  assert.deepEqual(paperExplorationProfile(paperExplorationThresholds(paperEnv)), {
    scope: "paper_only",
    profile: "exploration_v2",
    thresholds: {
      directionScore: { previous: 0.15, current: 0.05 },
      directionalConfidence: { previous: 0.25, current: 0.1 },
      optionLiquidityScore: { previous: 0.35, current: 0.1 },
      maxOptionSpreadPct: { previous: 0.12, current: 0.15 },
      longOptionConfidence: { previous: 0.4, current: 0.25 },
      aggressiveOptionConfidence: { previous: 0.6, current: 0.4 },
      definedRiskConfidence: { previous: 0.7, current: 0.5 },
      optionExpectedReturnPct: { previous: 0.75, current: 0.25 },
      definedRiskExpectedReturnPct: { previous: 1, current: 0.5 },
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
