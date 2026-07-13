import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { loadZeroDteConfig } from "../src/services/zeroDte/zeroDteConfigService.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

test("0DTE Level 2 configuration uses paper-safe specification defaults", () => {
  const config = loadZeroDteConfig({});

  assert.equal(config.enabled, true);
  assert.equal(config.paperExecutionEnabled, true);
  assert.equal(config.shadowEnabled, true);
  assert.equal(config.shadowSlippage, 0.05);
  assert.equal(config.shadowFeePerContract, 0.65);
  assert.equal(config.shadowMaxQuoteAgeMs, 60_000);
  assert.deepEqual(config.underlyings, ["SPY", "QQQ", "IWM"]);
  assert.equal(config.discoveryStartEt, "09:35");
  assert.equal(config.newEntryCutoffEt, "15:15");
  assert.equal(config.forceExitEt, "15:50");
  assert.equal(config.engineIntervalSeconds, 60);
  assert.equal(config.queueMaxActive, 100);
  assert.equal(config.queueTopN, 20);
  assert.equal(config.executionTopN, 3);
  assert.equal(config.maxStrikesEachSide, 5);
  assert.equal(config.minOptionVolume, 100);
  assert.equal(config.minOpenInterest, 250);
  assert.equal(config.maxSpreadPct, 15);
  assert.equal(config.minPremium, 0.1);
  assert.equal(config.maxPremium, 5);
  assert.equal(config.minScoreMovement, 5);
  assert.equal(config.signalShortWindow, 3);
  assert.equal(config.signalMediumWindow, 5);
  assert.equal(config.minConfirmationObservations, 2);
  assert.equal(config.maxContractsPerTrade, 1);
  assert.equal(config.maxOpenPositions, 3);
  assert.equal(config.maxTradesPerDay, 3);
  assert.equal(config.maxPremiumPerTrade, 250);
  assert.equal(config.maxDailyPremium, 750);
  assert.equal(config.maxDailyRealizedLoss, 250);
  assert.deepEqual(config.outcomeHorizonsMinutes, [5, 15, 30, 60]);
  assert.equal(config.strategyVersion, "zero-dte-level-2-v1");
  assert.match(config.configurationVersionId, /^[a-f0-9]{64}$/);
});

test("underlyings are trimmed, deduplicated, and uppercased", () => {
  const config = loadZeroDteConfig({
    ZERO_DTE_UNDERLYINGS: " spy, QQQ, SPY, , iwm,qqq "
  });

  assert.deepEqual(config.underlyings, ["SPY", "QQQ", "IWM"]);
});

test("invalid non-negative values fall back to their defaults", () => {
  const config = loadZeroDteConfig({
    ZERO_DTE_ENGINE_INTERVAL_SECONDS: "-1",
    ZERO_DTE_QUEUE_TOP_N: "not-a-number",
    ZERO_DTE_MIN_OPTION_VOLUME: "-100",
    ZERO_DTE_MIN_PREMIUM: "NaN",
    ZERO_DTE_MAX_OPEN_POSITIONS: "2.5"
  });

  assert.equal(config.engineIntervalSeconds, 60);
  assert.equal(config.queueTopN, 20);
  assert.equal(config.minOptionVolume, 100);
  assert.equal(config.minPremium, 0.1);
  assert.equal(config.maxOpenPositions, 3);
});

test("parses a positive minimum score movement and includes it in the configuration hash", () => {
  const configured = loadZeroDteConfig({
    ZERO_DTE_MIN_SCORE_MOVEMENT: "7.5"
  });

  assert.equal(configured.minScoreMovement, 7.5);
  assert.notEqual(configured.configurationVersionId, loadZeroDteConfig({}).configurationVersionId);
});

test("zero or invalid minimum score movement falls back to the paper-safe default", () => {
  for (const value of ["0", "-1", "not-a-number"]) {
    assert.equal(
      loadZeroDteConfig({ ZERO_DTE_MIN_SCORE_MOVEMENT: value }).minScoreMovement,
      5
    );
  }
});

test("invalid session strings fall back to their documented defaults", () => {
  const config = loadZeroDteConfig({
    ZERO_DTE_DISCOVERY_START_ET: "9:35",
    ZERO_DTE_NEW_ENTRY_CUTOFF_ET: "25:15",
    ZERO_DTE_FORCE_EXIT_ET: "15:5"
  });

  assert.equal(config.discoveryStartEt, "09:35");
  assert.equal(config.newEntryCutoffEt, "15:15");
  assert.equal(config.forceExitEt, "15:50");
});

test("invalid session ordering fails closed to the complete default session", () => {
  const config = loadZeroDteConfig({
    ZERO_DTE_DISCOVERY_START_ET: "15:15",
    ZERO_DTE_NEW_ENTRY_CUTOFF_ET: "09:35",
    ZERO_DTE_FORCE_EXIT_ET: "15:50"
  });

  assert.deepEqual(
    {
      discoveryStartEt: config.discoveryStartEt,
      newEntryCutoffEt: config.newEntryCutoffEt,
      forceExitEt: config.forceExitEt
    },
    {
      discoveryStartEt: "09:35",
      newEntryCutoffEt: "15:15",
      forceExitEt: "15:50"
    }
  );
});

test("zero or invalid engine intervals fall back to a strictly positive default", () => {
  for (const value of ["0", "-1", "1.5", "not-a-number"]) {
    assert.equal(
      loadZeroDteConfig({ ZERO_DTE_ENGINE_INTERVAL_SECONDS: value }).engineIntervalSeconds,
      60
    );
  }
});

test("underlying freshness uses a positive paper-safe default and rejects invalid values", () => {
  assert.equal(loadZeroDteConfig().underlyingMaxAgeMs, 60_000);
  for (const value of ["0", "-1", "1.5", "not-a-number"]) {
    assert.equal(
      loadZeroDteConfig({ ZERO_DTE_UNDERLYING_MAX_AGE_MS: value }).underlyingMaxAgeMs,
      60_000
    );
  }
});

test("shadow fill assumptions are configurable and included in the configuration hash", () => {
  const configured = loadZeroDteConfig({
    ZERO_DTE_SHADOW_SLIPPAGE: "0.08",
    ZERO_DTE_SHADOW_FEE_PER_CONTRACT: "0.7",
    ZERO_DTE_SHADOW_MAX_QUOTE_AGE_MS: "90000"
  });

  assert.equal(configured.shadowSlippage, 0.08);
  assert.equal(configured.shadowFeePerContract, 0.7);
  assert.equal(configured.shadowMaxQuoteAgeMs, 90_000);
  assert.notEqual(configured.configurationVersionId, loadZeroDteConfig({}).configurationVersionId);
});

test("a minimum premium above the maximum fails closed to the premium defaults", () => {
  const config = loadZeroDteConfig({
    ZERO_DTE_MIN_PREMIUM: "6",
    ZERO_DTE_MAX_PREMIUM: "5"
  });

  assert.equal(config.minPremium, 0.1);
  assert.equal(config.maxPremium, 5);
});

test("outcome horizons are numeric, sorted, and deduplicated", () => {
  const config = loadZeroDteConfig({
    ZERO_DTE_OUTCOME_HORIZONS_MINUTES: "60, 5, 15, 5, 30"
  });

  assert.deepEqual(config.outcomeHorizonsMinutes, [5, 15, 30, 60]);
});

test("configuration hash is stable when environment key order changes", () => {
  const first = loadZeroDteConfig({
    ZERO_DTE_UNDERLYINGS: "SPY,QQQ",
    ZERO_DTE_QUEUE_TOP_N: "8",
    ZERO_DTE_ENGINE_ENABLED: "false"
  });
  const second = loadZeroDteConfig({
    ZERO_DTE_ENGINE_ENABLED: "false",
    ZERO_DTE_QUEUE_TOP_N: "8",
    ZERO_DTE_UNDERLYINGS: "SPY,QQQ"
  });

  assert.equal(first.configurationVersionId, second.configurationVersionId);
  assert.notEqual(
    first.configurationVersionId,
    loadZeroDteConfig({
      ZERO_DTE_ENGINE_ENABLED: "false",
      ZERO_DTE_QUEUE_TOP_N: "9",
      ZERO_DTE_UNDERLYINGS: "SPY,QQQ"
    }).configurationVersionId
  );
});
