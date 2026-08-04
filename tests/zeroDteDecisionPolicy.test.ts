import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateZeroDteDecision
} from "../src/services/zeroDteDecisionPolicy.js";

const eligible = (overrides: Record<string, unknown> = {}) => ({
  underlyingSymbol: "SPY",
  expirationDate: "2026-08-04",
  optionType: "call" as const,
  direction: "long" as const,
  observedAt: "2026-08-04T14:00:00.000Z",
  bid: 2.45,
  ask: 2.55,
  volume: 2_000,
  openInterest: 5_000,
  moneyness: 0.005,
  liquidityScore: 0.9,
  ...overrides
});

test("admits a liquid same-day SPY call without requiring provider Greeks", () => {
  const result = evaluateZeroDteDecision(eligible());

  assert.equal(result.eligible, true);
  assert.equal(result.action, "eligible");
  assert.equal(result.greeksRequired, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.score > 0.8, true);
});

test("blocks 0DTE entry outside the bounded New York entry window", () => {
  assert.deepEqual(
    evaluateZeroDteDecision(eligible({ observedAt: "2026-08-04T13:34:59.000Z" })).blockers,
    ["ZERO_DTE_ENTRY_WINDOW_CLOSED"]
  );
  assert.deepEqual(
    evaluateZeroDteDecision(eligible({ observedAt: "2026-08-04T19:15:00.000Z" })).blockers,
    ["ZERO_DTE_ENTRY_WINDOW_CLOSED"]
  );
});

test("blocks the wrong underlying, expiry, or directional option type", () => {
  assert.deepEqual(
    evaluateZeroDteDecision(eligible({ underlyingSymbol: "QQQ" })).blockers,
    ["ZERO_DTE_SPY_ONLY"]
  );
  assert.deepEqual(
    evaluateZeroDteDecision(eligible({ expirationDate: "2026-08-05" })).blockers,
    ["ZERO_DTE_EXPIRATION_MISMATCH"]
  );
  assert.deepEqual(
    evaluateZeroDteDecision(eligible({ optionType: "put" })).blockers,
    ["ZERO_DTE_DIRECTION_OPTION_MISMATCH"]
  );
});

test("blocks weak microstructure without consulting IV or Greeks", () => {
  const result = evaluateZeroDteDecision(eligible({
    bid: 2,
    ask: 2.4,
    volume: 10,
    openInterest: 20,
    moneyness: 0.05,
    liquidityScore: 0.1
  }));

  assert.equal(result.eligible, false);
  assert.deepEqual(result.blockers, [
    "ZERO_DTE_SPREAD_TOO_WIDE",
    "ZERO_DTE_LIQUIDITY_INSUFFICIENT",
    "ZERO_DTE_MONEYNESS_OUT_OF_RANGE",
    "ZERO_DTE_DECISION_SCORE_TOO_LOW"
  ]);
  assert.equal("delta" in result.inputsUsed, false);
  assert.equal("impliedVolatility" in result.inputsUsed, false);
});

test("fails closed for invalid timestamps and crossed quotes", () => {
  assert.deepEqual(
    evaluateZeroDteDecision(eligible({ observedAt: "invalid" })).blockers,
    ["ZERO_DTE_OBSERVATION_TIME_INVALID"]
  );
  assert.deepEqual(
    evaluateZeroDteDecision(eligible({ bid: 2.6, ask: 2.5 })).blockers,
    ["ZERO_DTE_QUOTE_INVALID"]
  );
});
