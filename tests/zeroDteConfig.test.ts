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
