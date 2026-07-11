import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint
} from "../src/services/hedgeConfigService.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

test("hedge configuration defaults to disabled paper execution", () => {
  delete process.env.HEDGE_PAPER_EXECUTION_ENABLED;
  const config = buildHedgeConfig();

  assert.equal(config.executionEnabled, false);
  assert.equal(config.riskModelVersion, "portfolio-risk-v1");
  assert.equal(config.regimeModelVersion, "market-regime-v1");
  assert.equal(config.planVersion, "hedge-plan-v1");
  assert.equal(config.beta.lookbackDays, 252);
  assert.equal(config.beta.minimumObservations, 60);
  assert.equal(config.beta.observationInterval, "1Day");
  assert.equal(config.beta.cacheTtlHours, 24);
  assert.equal(config.recommendationTtlMinutes, 30);
  assert.equal(config.recommendationFreshnessMinutes, 15);
  assert.equal(config.planTtlMinutes, 30);
  assert.equal(config.leaps.minimumDte, 365);
  assert.equal(config.leaps.profitAllocation, 0.25);
  assert.equal(config.premiumNavCap, 0.01);
  assert.equal(config.optionDataCoverage.minimumContractDeltaCoveragePct, 0.9);
  assert.equal(config.optionDataCoverage.minimumMarketValueDeltaCoveragePct, 0.95);
  assert.equal(config.optionDataCoverage.materialUnmeasuredOptionExposurePct, 0.1);
  assert.deepEqual(config.optionGreeksFreshness, {
    currentMaxAgeSeconds: 60,
    staleMaxAgeSeconds: 900
  });
});

test("option delta coverage thresholds accept percentages and normalize to ratios", () => {
  process.env.HEDGE_MIN_OPTION_DELTA_CONTRACT_COVERAGE_PCT = "85";
  process.env.HEDGE_MIN_OPTION_DELTA_MARKET_VALUE_COVERAGE_PCT = "90";
  process.env.HEDGE_MATERIAL_UNMEASURED_OPTION_EXPOSURE_PCT = "12.5";

  const config = buildHedgeConfig();

  assert.equal(config.optionDataCoverage.minimumContractDeltaCoveragePct, 0.85);
  assert.equal(config.optionDataCoverage.minimumMarketValueDeltaCoveragePct, 0.9);
  assert.equal(config.optionDataCoverage.materialUnmeasuredOptionExposurePct, 0.125);
});

test("invalid option delta coverage thresholds fail safely to defaults", () => {
  process.env.HEDGE_MIN_OPTION_DELTA_CONTRACT_COVERAGE_PCT = "101";
  process.env.HEDGE_MIN_OPTION_DELTA_MARKET_VALUE_COVERAGE_PCT = "-1";
  process.env.HEDGE_MATERIAL_UNMEASURED_OPTION_EXPOSURE_PCT = "not-a-number";

  const config = buildHedgeConfig();

  assert.equal(config.optionDataCoverage.minimumContractDeltaCoveragePct, 0.9);
  assert.equal(config.optionDataCoverage.minimumMarketValueDeltaCoveragePct, 0.95);
  assert.equal(config.optionDataCoverage.materialUnmeasuredOptionExposurePct, 0.1);
  assert.ok(config.warnings.includes("HEDGE_CONFIGURATION_VALUE_INVALID"));
});

test("option Greek freshness accepts positive ordered ages", () => {
  process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS = "30";
  process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS = "300";

  const config = buildHedgeConfig();

  assert.deepEqual(config.optionGreeksFreshness, {
    currentMaxAgeSeconds: 30,
    staleMaxAgeSeconds: 300
  });
  assert.ok(!config.warnings.includes("HEDGE_CONFIGURATION_VALUE_INVALID"));
});

test("invalid or unordered Greek ages use conservative defaults", () => {
  process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS = "900";
  process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS = "60";

  const config = buildHedgeConfig();

  assert.deepEqual(config.optionGreeksFreshness, {
    currentMaxAgeSeconds: 60,
    staleMaxAgeSeconds: 900
  });
  assert.ok(config.warnings.includes("HEDGE_CONFIGURATION_VALUE_INVALID"));
});

test("one invalid Greek age resets the complete age policy", () => {
  process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS = "not-a-number";
  process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS = "300";

  const config = buildHedgeConfig();

  assert.deepEqual(config.optionGreeksFreshness, {
    currentMaxAgeSeconds: 60,
    staleMaxAgeSeconds: 900
  });
  assert.ok(config.warnings.includes("HEDGE_CONFIGURATION_VALUE_INVALID"));
});

test("invalid ratios fall back instead of widening risk limits", () => {
  process.env.HEDGE_PREMIUM_NAV_CAP = "4";
  process.env.HEDGE_PROFIT_ALLOCATION = "-1";
  process.env.HEDGE_TARGET_PROTECTION_CRITICAL = "2";

  const config = buildHedgeConfig();

  assert.equal(config.premiumNavCap, 0.01);
  assert.equal(config.leaps.profitAllocation, 0.25);
  assert.equal(config.targetProtection.critical, 0.65);
  assert.ok(config.warnings.includes("HEDGE_CONFIGURATION_VALUE_INVALID"));
});

test("invalid sector JSON becomes an explicit warning and empty map", () => {
  process.env.HEDGE_SECTOR_MAP_JSON = "not-json";

  const config = buildHedgeConfig();

  assert.deepEqual(config.sectorMap, {});
  assert.ok(config.warnings.includes("HEDGE_SECTOR_MAP_INVALID"));
});

test("sector map normalizes symbols and values", () => {
  process.env.HEDGE_SECTOR_MAP_JSON = JSON.stringify({ aapl: "Technology", xle: " ENERGY " });

  assert.deepEqual(buildHedgeConfig().sectorMap, {
    AAPL: "technology",
    XLE: "energy"
  });
});

test("configuration fingerprint excludes secret environment values", () => {
  const config = buildHedgeConfig();
  process.env.ALPACA_PAPER_SECRET_KEY = "first-secret";
  const first = hedgeConfigurationFingerprint(config);
  process.env.ALPACA_PAPER_SECRET_KEY = "different-secret";
  const second = hedgeConfigurationFingerprint(config);

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});
