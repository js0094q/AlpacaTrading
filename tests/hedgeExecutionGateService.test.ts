import assert from "node:assert/strict";
import test from "node:test";

import { evaluateHedgeExecutionGate } from "../src/services/hedgeExecutionGateService.js";

const validInput = () => ({
  environment: "paper",
  paperOnlyIntent: true,
  executionEnabled: true,
  planValid: true,
  sourceSnapshotMatches: true,
  configurationMatches: true,
  reviewedPayloadHashMatches: true,
  duplicateDetected: false,
  instrumentSupported: true,
  runtimePreflightPassed: true,
  liveTradingEnabled: false,
  liveHedgeExecutionEnabled: false,
  multiLegExecution: false
});

test("allows a fully validated single-leg paper hedge", () => {
  const result = evaluateHedgeExecutionGate(validInput());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockers, []);
});

test("fails closed for live, multi-leg, duplicate, or invalid runtime state", () => {
  for (const [key, value] of [
    ["liveTradingEnabled", true],
    ["liveHedgeExecutionEnabled", true],
    ["multiLegExecution", true],
    ["duplicateDetected", true],
    ["runtimePreflightPassed", false]
  ] as const) {
    const result = evaluateHedgeExecutionGate({ ...validInput(), [key]: value });
    assert.equal(result.allowed, false, key);
    assert.ok(result.blockers.length > 0, key);
  }
});
