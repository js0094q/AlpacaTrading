import assert from "node:assert/strict";
import test from "node:test";

import { evaluateOptionGreekUtilization } from "../src/services/optionGreekUtilizationPolicy.js";

const completeGreeks = {
  impliedVolatility: 0.25,
  delta: 0.65,
  gamma: 0.01,
  theta: -0.04,
  vega: 0.2,
  rho: 0.08
};

test("0DTE treats provider Greeks as not expected and does not penalize their absence", () => {
  assert.deepEqual(evaluateOptionGreekUtilization({
    lane: "options_0dte",
    impliedVolatility: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    rho: null
  }), {
    availability: "provider_not_calculated_for_zero_dte",
    completeness: 0,
    eligibilityBlockers: [],
    selectionGreekCoverageCredit: 0,
    requiredFields: [],
    strategyUse: "audit_only"
  });
});

test("managed LEAPS requires IV and every paid Greek for decision eligibility", () => {
  assert.deepEqual(evaluateOptionGreekUtilization({
    lane: "options_leaps",
    ...completeGreeks,
    gamma: null,
    rho: null
  }), {
    availability: "partial",
    completeness: 4 / 6,
    eligibilityBlockers: ["leaps_gamma_missing", "leaps_rho_missing"],
    selectionGreekCoverageCredit: 4 / 6,
    requiredFields: ["impliedVolatility", "delta", "gamma", "theta", "vega", "rho"],
    strategyUse: "eligibility_evidence"
  });
});

test("managed LEAPS records complete paid Greek evidence when every field is finite", () => {
  assert.deepEqual(evaluateOptionGreekUtilization({
    lane: "options_leaps",
    ...completeGreeks
  }), {
    availability: "complete",
    completeness: 1,
    eligibilityBlockers: [],
    selectionGreekCoverageCredit: 1,
    requiredFields: ["impliedVolatility", "delta", "gamma", "theta", "vega", "rho"],
    strategyUse: "eligibility_evidence"
  });
});

test("standard options preserve partial Greek decision support without a new hard gate", () => {
  assert.deepEqual(evaluateOptionGreekUtilization({
    lane: "options_standard",
    ...completeGreeks,
    theta: null
  }), {
    availability: "partial",
    completeness: 5 / 6,
    eligibilityBlockers: [],
    selectionGreekCoverageCredit: 4 / 5,
    requiredFields: [],
    strategyUse: "decision_support"
  });
});
