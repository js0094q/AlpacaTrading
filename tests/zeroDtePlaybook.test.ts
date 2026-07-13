import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyZeroDteRegime,
  type ZeroDteIndicators
} from "../src/services/zeroDte/zeroDteRegimeService.js";
import {
  evaluateZeroDtePlaybooks,
  type ZeroDteBar,
  type ZeroDteDirection,
  type ZeroDteOptionQuote,
  type ZeroDtePlaybookContext
} from "../src/services/zeroDte/zeroDtePlaybookService.js";

const makeBars = (direction: "bullish" | "bearish"): ZeroDteBar[] => {
  const sign = direction === "bullish" ? 1 : -1;
  return Array.from({ length: 40 }, (_, index) => {
    const close = 100 + sign * index * 0.35;
    return {
      timestamp: `2026-07-13T13:${String(index).padStart(2, "0")}:00.000Z`,
      open: close - sign * 0.1,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: index === 39 ? 2_000 : 1_000
    };
  });
};

const makeOption = (side: "call" | "put"): ZeroDteOptionQuote => ({
  symbol: side === "call" ? "SPY260713C00600000" : "SPY260713P00600000",
  side,
  bid: 1.2,
  ask: 1.4,
  volume: 1_200,
  openInterest: 5_000,
  gamma: 0.04,
  impliedVolatility: 0.28
});

const makeIndicators = (direction: "bullish" | "bearish"): ZeroDteIndicators => {
  const sign = direction === "bullish" ? 1 : -1;
  return {
    vwap: 100,
    emaFast: 100 + sign * 8,
    emaSlow: 100 + sign * 4,
    atr: 1.5,
    relativeVolume: 1.8,
    multiTimeframeDirection: {
      "1Min": direction,
      "5Min": direction,
      "15Min": direction
    },
    realizedVolatility: 0.35,
    realizedVolatilityBaseline: 0.15,
    atrBaseline: 0.9,
    atrAcceleration: 1.7,
    rangeBreak: true,
    volatilityIndexChangePct: 8,
    impliedVolatility: 0.4,
    velocity: 0.8,
    breadth: 0.75,
    crossIndexConfirmation: true,
    compression: true,
    retestConfirmed: true,
    falseBreakRisk: 0.1,
    liquidityScore: 85
  };
};

const makeContext = (
  direction: "bullish" | "bearish",
  overrides: Partial<ZeroDtePlaybookContext> = {}
): ZeroDtePlaybookContext => {
  const bars = makeBars(direction);
  const sign = direction === "bullish" ? 1 : -1;
  return {
    underlying: "SPY",
    price: bars.at(-1)!.close,
    barsByTimeframe: {
      "1Min": bars,
      "5Min": bars.filter((_, index) => index % 5 === 4),
      "15Min": bars.filter((_, index) => index % 15 === 14)
    },
    option: makeOption(direction === "bullish" ? "call" : "put"),
    indicators: makeIndicators(direction),
    regime: "trend",
    asOf: "2026-07-13T13:39:00.000Z",
    eventCalendarEvidence: [],
    direction,
    openingRange: {
      high: sign > 0 ? 106 : 100.5,
      low: sign > 0 ? 99.5 : 94,
      minutes: 15,
      source: "deterministic-opening-range"
    },
    ...overrides
  };
};

const findEvaluation = (
  context: ZeroDtePlaybookContext,
  playbook: string
) => {
  const evaluation = evaluateZeroDtePlaybooks(context).find(
    (entry) => entry.playbook === playbook && entry.direction === context.direction
  );
  assert.ok(evaluation, `missing ${playbook} evaluation`);
  return evaluation;
};

test("event-risk is classified only when verified event evidence is supplied", () => {
  const indicators: ZeroDteIndicators = {
    realizedVolatility: 0.8,
    atrAcceleration: 2.2,
    trendDirection: "bullish",
    trendStrength: 0.9
  };

  const unverified = classifyZeroDteRegime({
    indicators,
    verifiedEventRisk: false
  });
  assert.notEqual(unverified.regime, "event-risk");
  assert.ok(unverified.evidence.every((entry) => entry.code !== "VERIFIED_EVENT_RISK"));

  const verified = classifyZeroDteRegime({
    indicators,
    verifiedEventRisk: true
  });
  assert.equal(verified.regime, "event-risk");
  assert.ok(verified.evidence.some((entry) => entry.code === "VERIFIED_EVENT_RISK"));
  assert.deepEqual(verified.blockers, []);
});

test("trend continuation scores bullish and bearish directions symmetrically", () => {
  const bullish = findEvaluation(makeContext("bullish"), "trend_continuation");
  const bearish = findEvaluation(makeContext("bearish"), "trend_continuation");

  assert.equal(bullish.direction, "bullish");
  assert.equal(bearish.direction, "bearish");
  assert.equal(bullish.score, bearish.score);
  assert.equal(bullish.confidence, bearish.confidence);
  assert.equal(bullish.eligible, true);
  assert.equal(bearish.eligible, true);
  assert.ok(bullish.supportingSignals.length > 0);
  assert.ok(bearish.supportingSignals.length > 0);
  assert.deepEqual(bullish.opposingSignals, []);
  assert.deepEqual(bearish.opposingSignals, []);
});

test("reversal requires stronger confirmation than a single extension signal", () => {
  const weakContext = makeContext("bearish", {
    regime: "range",
    indicators: {
      ...makeIndicators("bearish"),
      lastMoveDirection: "bullish",
      exhaustion: 0.9,
      failedBreak: false,
      reversalCandle: false,
      volumeClimax: false,
      supportedDivergence: false
    }
  });
  const strongContext = makeContext("bearish", {
    regime: "range",
    indicators: {
      ...weakContext.indicators,
      failedBreak: true,
      reversalCandle: true,
      volumeClimax: true,
      supportedDivergence: true
    }
  });

  const weak = findEvaluation(weakContext, "reversal");
  const strong = findEvaluation(strongContext, "reversal");

  assert.ok(strong.score > weak.score);
  assert.equal(weak.eligible, false);
  assert.ok(weak.blockers.includes("INSUFFICIENT_REVERSAL_CONFIRMATION"));
  assert.equal(strong.eligible, true);
});

test("breakout is ineligible without opening-range evidence", () => {
  const { openingRange: _openingRange, ...withoutOpeningRange } = makeContext("bullish");
  const missing = findEvaluation(withoutOpeningRange, "breakout");
  const present = findEvaluation(makeContext("bullish"), "breakout");

  assert.equal(missing.eligible, false);
  assert.ok(missing.missingInputs.includes("openingRange"));
  assert.ok(missing.blockers.includes("MISSING_OPENING_RANGE_EVIDENCE"));
  assert.equal(present.eligible, true);
});

test("gamma proxy is insufficient and ineligible when gamma or open interest is absent", () => {
  const missing = findEvaluation(
    makeContext("bullish", {
      option: {
        ...makeOption("call"),
        gamma: null,
        openInterest: null
      }
    }),
    "gamma_proxy"
  );

  assert.equal(missing.status, "insufficient_data");
  assert.equal(missing.eligible, false);
  assert.equal(missing.score, 0);
  assert.ok(missing.missingInputs.includes("gamma"));
  assert.ok(missing.missingInputs.includes("openInterest"));
  assert.ok(missing.blockers.includes("MISSING_GAMMA_PROXY_INPUTS"));
});

test("volatility expansion retains component contributions and does not mutate context", () => {
  const context = makeContext("bullish");
  const before = structuredClone(context);
  const evaluation = findEvaluation(context, "volatility_expansion");

  assert.equal(evaluation.eligible, true);
  assert.ok(evaluation.score >= 0 && evaluation.score <= 100);
  assert.ok(evaluation.confidence >= 0 && evaluation.confidence <= 100);
  for (const component of [
    "realizedVolatility",
    "atrAcceleration",
    "rangeBreak",
    "volatilityIndexMovement",
    "impliedVolatility",
    "velocity",
    "breadth",
    "crossIndexConfirmation",
    "liquidity"
  ]) {
    assert.equal(typeof evaluation.componentContributions[component], "number");
  }
  assert.ok(Object.values(evaluation.componentContributions).some((value) => value > 0));
  assert.deepEqual(context, before);
});

test("all playbook scores and confidence values remain clamped to 0 through 100", () => {
  const context = makeContext("bullish", {
    price: Number.MAX_SAFE_INTEGER,
    indicators: {
      ...makeIndicators("bullish"),
      vwap: Number.MIN_VALUE,
      emaFast: Number.MAX_SAFE_INTEGER,
      emaSlow: Number.MIN_VALUE,
      atr: Number.MIN_VALUE,
      relativeVolume: Number.MAX_SAFE_INTEGER,
      realizedVolatility: Number.MAX_SAFE_INTEGER,
      realizedVolatilityBaseline: Number.MIN_VALUE,
      atrAcceleration: Number.MAX_SAFE_INTEGER,
      impliedVolatility: Number.MAX_SAFE_INTEGER,
      velocity: Number.MAX_SAFE_INTEGER,
      breadth: Number.MAX_SAFE_INTEGER,
      exhaustion: Number.MAX_SAFE_INTEGER
    }
  });

  for (const evaluation of evaluateZeroDtePlaybooks(context)) {
    assert.ok(evaluation.score >= 0 && evaluation.score <= 100);
    assert.ok(evaluation.confidence >= 0 && evaluation.confidence <= 100);
  }
});

const _directionTypeCheck: ZeroDteDirection | null = null;
void _directionTypeCheck;
