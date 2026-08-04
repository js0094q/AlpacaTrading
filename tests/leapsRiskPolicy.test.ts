import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateManagedLeapsEntryRisk,
  evaluateManagedLeapsPositionReview
} from "../src/services/leapsRiskPolicy.js";

const entry = (overrides: Record<string, unknown> = {}) => ({
  optionType: "call" as const,
  premium: 12,
  impliedVolatility: 0.35,
  delta: 0.62,
  gamma: 0.004,
  theta: -0.08,
  vega: 1.8,
  rho: 0.9,
  ...overrides
});

test("admits managed LEAPS only when paid Greeks have coherent signs and carry", () => {
  const result = evaluateManagedLeapsEntryRisk(entry());

  assert.equal(result.eligible, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.score > 0.8, true);
  assert.notEqual(result.thetaPctOfPremium, null);
  assert.equal(result.thetaPctOfPremium! < 1, true);
});

test("blocks missing paid fields and non-finite values precisely", () => {
  const result = evaluateManagedLeapsEntryRisk(entry({
    impliedVolatility: null,
    gamma: Number.NaN,
    rho: null
  }));

  assert.deepEqual(result.blockers, [
    "LEAPS_IMPLIED_VOLATILITY_MISSING",
    "LEAPS_GAMMA_MISSING",
    "LEAPS_RHO_MISSING"
  ]);
});

test("blocks directionally incoherent delta and rho plus excessive theta carry", () => {
  const result = evaluateManagedLeapsEntryRisk(entry({
    delta: -0.62,
    theta: -0.3,
    rho: -0.9
  }));

  assert.deepEqual(result.blockers, [
    "LEAPS_DELTA_DIRECTION_INVALID",
    "LEAPS_RHO_DIRECTION_INVALID",
    "LEAPS_THETA_CARRY_EXCESSIVE"
  ]);
});

test("blocks delta outside the durable LEAPS entry band", () => {
  assert.deepEqual(
    evaluateManagedLeapsEntryRisk(entry({ delta: 0.3 })).blockers,
    ["LEAPS_DELTA_BELOW_ENTRY_MINIMUM"]
  );
  assert.deepEqual(
    evaluateManagedLeapsEntryRisk(entry({ delta: 0.9 })).blockers,
    ["LEAPS_DELTA_ABOVE_ENTRY_MAXIMUM"]
  );
});

const position = (overrides: Record<string, unknown> = {}) => ({
  optionType: "call" as const,
  quantity: 3,
  premium: 12,
  directionalReturnPct: 10,
  currentDte: 360,
  underlyingClose: 510,
  severeTrendSma: 500,
  severeTrendBarCount: 200,
  impliedVolatility: 0.35,
  delta: 0.62,
  gamma: 0.004,
  theta: -0.08,
  vega: 1.8,
  rho: 0.9,
  lastReviewedAt: "2026-07-20T14:00:00.000Z",
  now: "2026-08-04T14:00:00.000Z",
  ...overrides
});

test("preserves the existing managed LEAPS hard exits", () => {
  assert.equal(
    evaluateManagedLeapsPositionReview(position({ directionalReturnPct: -35 })).action,
    "full_exit"
  );
  assert.equal(
    evaluateManagedLeapsPositionReview(position({ directionalReturnPct: 125 })).action,
    "full_exit"
  );
  assert.equal(
    evaluateManagedLeapsPositionReview(position({ currentDte: 180 })).action,
    "full_exit"
  );
  assert.equal(
    evaluateManagedLeapsPositionReview(position({ underlyingClose: 490 })).action,
    "full_exit"
  );
});

test("surfaces partial-profit review without manufacturing an executable exit", () => {
  const result = evaluateManagedLeapsPositionReview(position({ directionalReturnPct: 75 }));

  assert.equal(result.action, "partial_exit_review");
  assert.equal(result.executable, false);
  assert.equal(result.suggestedQuantity, 1);
  assert.deepEqual(result.reasons, ["LEAPS_PARTIAL_PROFIT_REVIEW"]);
});

test("surfaces loss, delta, theta, Greek coverage, and periodic monitoring triggers", () => {
  const result = evaluateManagedLeapsPositionReview(position({
    directionalReturnPct: -20,
    delta: 0.4,
    theta: -0.25,
    gamma: null,
    lastReviewedAt: "2026-06-01T14:00:00.000Z"
  }));

  assert.equal(result.action, "review");
  assert.equal(result.executable, false);
  assert.deepEqual(result.reasons, [
    "LEAPS_REVIEW_LOSS_WARNING",
    "LEAPS_DELTA_DETERIORATION",
    "LEAPS_THETA_CARRY_REVIEW",
    "LEAPS_GREEK_COVERAGE_REVIEW",
    "LEAPS_PERIODIC_REVIEW_DUE"
  ]);
});

test("holds a healthy managed LEAPS position", () => {
  const result = evaluateManagedLeapsPositionReview(position());
  assert.equal(result.action, "hold");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.executable, false);
});
