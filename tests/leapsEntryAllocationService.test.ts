import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LEAPS_MAX_ENTRY_CAPITAL_USD,
  LEAPS_CONTRACT_MULTIPLIER,
  resolveLeapsEntryAllocation,
  sizeLeapsEntry
} from "../src/services/leapsEntryAllocationService.js";

const paperEnvironment = (
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv => ({
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false",
  ...overrides
});

test("defaults the independent paper LEAPS per-position allocation to $5,000", () => {
  const result = resolveLeapsEntryAllocation(paperEnvironment());

  assert.deepEqual(result, {
    ok: true,
    maxEntryCapitalUsd: DEFAULT_LEAPS_MAX_ENTRY_CAPITAL_USD,
    source: "paper_default",
    reason: null
  });
  assert.equal(DEFAULT_LEAPS_MAX_ENTRY_CAPITAL_USD, 5_000);
});

test("accepts an explicit paper LEAPS allocation at or below the phase ceiling", () => {
  assert.deepEqual(
    resolveLeapsEntryAllocation(
      paperEnvironment({ LEAPS_MAX_ENTRY_CAPITAL_USD: "4500" })
    ),
    {
      ok: true,
      maxEntryCapitalUsd: 4_500,
      source: "environment",
      reason: null
    }
  );
  assert.equal(
    resolveLeapsEntryAllocation(
      paperEnvironment({ LEAPS_MAX_ENTRY_CAPITAL_USD: "5000" })
    ).ok,
    true
  );
});

test("fails closed for explicit invalid, nonpositive, or over-boundary allocations", () => {
  for (const value of ["", "not-a-number", "0", "-1", "5000.01"]) {
    const result = resolveLeapsEntryAllocation(
      paperEnvironment({ LEAPS_MAX_ENTRY_CAPITAL_USD: value })
    );

    assert.equal(result.ok, false, value);
    assert.equal(result.maxEntryCapitalUsd, null, value);
    assert.equal(result.reason, "LEAPS_ENTRY_ALLOCATION_INVALID", value);
  }
});

test("fails closed unless every execution gate is explicitly paper-only", () => {
  const unsafeEnvironments = [
    paperEnvironment({ ALPACA_ENV: "live" }),
    paperEnvironment({ TRADING_MODE: "live" }),
    paperEnvironment({ ALPACA_LIVE_TRADE: "true" }),
    paperEnvironment({ LIVE_TRADING_ENABLED: "true" }),
    {
      ALPACA_ENV: "paper",
      TRADING_MODE: "paper",
      ALPACA_LIVE_TRADE: "false"
    }
  ];

  for (const env of unsafeEnvironments) {
    const result = resolveLeapsEntryAllocation(env);

    assert.equal(result.ok, false);
    assert.equal(result.maxEntryCapitalUsd, null);
    assert.equal(result.reason, "LEAPS_PAPER_ONLY_REQUIRED");
  }
});

test("sizes each LEAPS position from the $5,000 ceiling without an artificial contract cap", () => {
  for (const [executablePremium, expectedQuantity] of [
    [10, 5],
    [15, 3],
    [24, 2],
    [30, 1],
    [50, 1]
  ] as const) {
    const result = sizeLeapsEntry({
      executablePremium,
      contractMultiplier: LEAPS_CONTRACT_MULTIPLIER,
      maxEntryCapitalUsd: 5_000,
      independentlyValidatedAvailableCapitalUsd: 10_000
    });

    assert.equal(result.contractCostUsd, executablePremium * 100);
    assert.equal(result.quantity, expectedQuantity);
    assert.equal(
      result.positionCostUsd,
      executablePremium * 100 * expectedQuantity
    );
    assert.equal(result.reason, null);
  }
});

test("applies the standard multiplier exactly once and returns an integer quantity", () => {
  const result = sizeLeapsEntry({
    executablePremium: 10,
    contractMultiplier: LEAPS_CONTRACT_MULTIPLIER,
    maxEntryCapitalUsd: 5_000,
    independentlyValidatedAvailableCapitalUsd: 100_000
  });

  assert.equal(LEAPS_CONTRACT_MULTIPLIER, 100);
  assert.equal(result.contractCostUsd, 1_000);
  assert.equal(result.quantity, 5);
  assert.equal(Number.isInteger(result.quantity), true);
});

test("fails closed when a positive premium would produce an unsafe integer quantity", () => {
  const result = sizeLeapsEntry({
    executablePremium: 1e-320,
    contractMultiplier: LEAPS_CONTRACT_MULTIPLIER,
    maxEntryCapitalUsd: 5_000,
    independentlyValidatedAvailableCapitalUsd: 100_000
  });

  assert.equal(result.positionCostUsd, 0);
  assert.equal(result.quantity, 0);
  assert.equal(result.reason, "LEAPS_ENTRY_QUANTITY_INVALID");
});

test("classifies a contract over the LEAPS allocation explicitly", () => {
  const result = sizeLeapsEntry({
    executablePremium: 50.01,
    contractMultiplier: LEAPS_CONTRACT_MULTIPLIER,
    maxEntryCapitalUsd: 5_000,
    independentlyValidatedAvailableCapitalUsd: 100_000
  });

  assert.equal(result.contractCostUsd, 5_001);
  assert.equal(result.positionCostUsd, 0);
  assert.equal(result.quantity, 0);
  assert.equal(result.reason, "LEAPS_CONTRACT_COST_EXCEEDS_ALLOCATION");
});

test("validated available capital can reduce a LEAPS position below the allocation ceiling", () => {
  const result = sizeLeapsEntry({
    executablePremium: 10,
    contractMultiplier: LEAPS_CONTRACT_MULTIPLIER,
    maxEntryCapitalUsd: 5_000,
    independentlyValidatedAvailableCapitalUsd: 2_500
  });

  assert.equal(result.contractCostUsd, 1_000);
  assert.equal(result.positionCostUsd, 2_000);
  assert.equal(result.quantity, 2);
  assert.equal(result.reason, null);
});

test("keeps the existing validated capital boundary independently binding", () => {
  const result = sizeLeapsEntry({
    executablePremium: 30,
    contractMultiplier: LEAPS_CONTRACT_MULTIPLIER,
    maxEntryCapitalUsd: 5_000,
    independentlyValidatedAvailableCapitalUsd: 2_999.99
  });

  assert.equal(result.contractCostUsd, 3_000);
  assert.equal(result.positionCostUsd, 0);
  assert.equal(result.quantity, 0);
  assert.equal(
    result.reason,
    "LEAPS_VALIDATED_AVAILABLE_CAPITAL_INSUFFICIENT"
  );
});

test("rejects nonstandard multipliers and invalid sizing inputs without a quantity", () => {
  const invalidCases = [
    {
      executablePremium: 30,
      contractMultiplier: 50,
      maxEntryCapitalUsd: 5_000,
      independentlyValidatedAvailableCapitalUsd: 5_000,
      reason: "LEAPS_CONTRACT_MULTIPLIER_INVALID"
    },
    {
      executablePremium: 0,
      contractMultiplier: 100,
      maxEntryCapitalUsd: 5_000,
      independentlyValidatedAvailableCapitalUsd: 5_000,
      reason: "LEAPS_EXECUTABLE_PREMIUM_INVALID"
    },
    {
      executablePremium: Number.MAX_VALUE,
      contractMultiplier: 100,
      maxEntryCapitalUsd: 5_000,
      independentlyValidatedAvailableCapitalUsd: 5_000,
      reason: "LEAPS_EXECUTABLE_PREMIUM_INVALID"
    },
    {
      executablePremium: 30,
      contractMultiplier: 100,
      maxEntryCapitalUsd: 0,
      independentlyValidatedAvailableCapitalUsd: 5_000,
      reason: "LEAPS_ENTRY_ALLOCATION_INVALID"
    },
    {
      executablePremium: 30,
      contractMultiplier: 100,
      maxEntryCapitalUsd: 5_000,
      independentlyValidatedAvailableCapitalUsd: -1,
      reason: "LEAPS_VALIDATED_AVAILABLE_CAPITAL_INVALID"
    }
  ] as const;

  for (const input of invalidCases) {
    const result = sizeLeapsEntry(input);

    assert.equal(result.positionCostUsd, 0);
    assert.equal(result.quantity, 0);
    assert.equal(result.reason, input.reason);
  }
});
