import assert from "node:assert/strict";
import test from "node:test";

import { buildHedgeConfig } from "../src/services/hedgeConfigService.js";
import { normalizePortfolioEvidence } from "../src/services/portfolioRiskService.js";

const account = {
  id: "paper-account-id",
  equity: "100000",
  portfolioValue: "100000",
  cash: "20000",
  buyingPower: "120000",
  lastEquity: "99000",
  status: "ACTIVE"
};

const asOf = "2026-07-10T14:00:00.000Z";

test("uses observed option delta and multiplier for signed exposure", () => {
  const config = buildHedgeConfig();
  const result = normalizePortfolioEvidence(
    account,
    [
      {
        symbol: "AAPL260116C00150000",
        assetClass: "us_option",
        qty: "1",
        marketValue: "5000",
        costBasis: "3000",
        unrealizedPl: "2000",
        currentPrice: "50",
        side: "long"
      }
    ],
    {
      optionEvidence: {
        AAPL260116C00150000: {
          multiplier: 100,
          delta: 0.6,
          gamma: 0.01,
          theta: -0.05,
          vega: 0.2,
          rho: 0.1,
          bid: 49,
          ask: 51,
          midpoint: 50,
          quoteTimestamp: asOf
        }
      },
      underlyingPrices: { AAPL: 200 },
      betas: {
        AAPL: { beta: 1.2, status: "calculated", warnings: [] }
      },
      highWaterMark: 110000
    },
    config,
    asOf
  );

  assert.equal(result.positions[0]?.deltaEquivalentShares, 60);
  assert.equal(result.positions[0]?.deltaAdjustedExposure, 12_000);
  assert.equal(result.options.deltaExposure, 12_000);
  assert.equal(result.account.drawdownPct, 10_000 / 110_000);
  assert.deepEqual(result.optionDataCoverage, {
    totalOptionContracts: 1,
    contractsWithDelta: 1,
    contractsWithoutDelta: 0,
    contractDeltaCoveragePct: 1,
    totalOptionMarketValue: 5000,
    optionMarketValueWithDelta: 5000,
    optionMarketValueWithoutDelta: 0,
    marketValueDeltaCoveragePct: 1,
    materialCoverageMissing: false
  });
});

test("does not fabricate missing option Greeks", () => {
  const config = buildHedgeConfig();
  const result = normalizePortfolioEvidence(
    account,
    [
      {
        symbol: "AAPL260116C00150000",
        assetClass: "us_option",
        qty: "1",
        marketValue: "5000",
        currentPrice: "50"
      }
    ],
    {
      optionEvidence: {
        AAPL260116C00150000: {
          multiplier: 100,
          delta: null,
          gamma: null,
          theta: null,
          vega: null,
          rho: null,
          bid: 49,
          ask: 51,
          midpoint: 50,
          quoteTimestamp: asOf
        }
      },
      underlyingPrices: { AAPL: 200 },
      betas: {
        AAPL: { beta: 1.2, status: "calculated", warnings: [] }
      },
      highWaterMark: 100000
    },
    config,
    asOf
  );

  assert.equal(result.positions[0]?.deltaEquivalentShares, null);
  assert.equal(result.positions[0]?.deltaAdjustedExposure, null);
  assert.equal(result.options.deltaExposure, null);
  assert.ok(result.positions[0]?.warnings.includes("OPTION_DELTA_UNAVAILABLE"));
  assert.equal(result.dataQualityStatus, "monitoring");
  assert.equal(result.optionDataCoverage.materialCoverageMissing, false);
});

test("material contract-count delta coverage makes beta and scenarios indeterminate", () => {
  const config = buildHedgeConfig();
  const measured = "SPY270115C00805000";
  const unmeasured = "SPY270115C00810000";
  const result = normalizePortfolioEvidence(
    account,
    [
      {
        symbol: measured,
        assetClass: "us_option",
        qty: "1",
        marketValue: "9000",
        currentPrice: "90"
      },
      {
        symbol: unmeasured,
        assetClass: "us_option",
        qty: "9",
        marketValue: "1000",
        currentPrice: "1.111111"
      }
    ],
    {
      optionEvidence: {
        [measured]: {
          multiplier: 100,
          delta: 0.5,
          gamma: 0.01,
          theta: -0.05,
          vega: 0.2,
          rho: 0.1,
          bid: 89,
          ask: 91,
          midpoint: 90,
          quoteTimestamp: asOf
        },
        [unmeasured]: {
          multiplier: 100,
          delta: null,
          gamma: null,
          theta: null,
          vega: null,
          rho: null,
          bid: 1,
          ask: 1.2,
          midpoint: 1.1,
          quoteTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: 750 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    config,
    asOf
  );

  assert.equal(result.optionDataCoverage.contractDeltaCoveragePct, 0.1);
  assert.equal(result.optionDataCoverage.marketValueDeltaCoveragePct, 0.9);
  assert.equal(result.optionDataCoverage.materialCoverageMissing, true);
  assert.equal(result.portfolioBeta, null);
  assert.equal(result.options.deltaExposure, null);
  assert.equal(result.options.positiveDeltaExposure, null);
  assert.ok(result.scenarios.every((scenario) => scenario.netModeledLoss === null));
  assert.ok(result.warnings.includes("MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT"));
});

test("material market-value delta coverage makes beta and sizing inputs indeterminate", () => {
  const config = buildHedgeConfig();
  const measured = "QQQ270115C00840000";
  const unmeasured = "QQQ270115C00845000";
  const result = normalizePortfolioEvidence(
    account,
    [
      {
        symbol: measured,
        assetClass: "us_option",
        qty: "9",
        marketValue: "1000",
        currentPrice: "1.111111"
      },
      {
        symbol: unmeasured,
        assetClass: "us_option",
        qty: "1",
        marketValue: "10000",
        currentPrice: "100"
      }
    ],
    {
      optionEvidence: {
        [measured]: {
          multiplier: 100,
          delta: 0.25,
          gamma: 0.01,
          theta: -0.05,
          vega: 0.2,
          rho: 0.1,
          bid: 1,
          ask: 1.2,
          midpoint: 1.1,
          quoteTimestamp: asOf
        },
        [unmeasured]: {
          multiplier: 100,
          delta: null,
          gamma: null,
          theta: null,
          vega: null,
          rho: null,
          bid: 99,
          ask: 101,
          midpoint: 100,
          quoteTimestamp: asOf
        }
      },
      underlyingPrices: { QQQ: 650 },
      betas: { QQQ: { beta: 1.1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    config,
    asOf
  );

  assert.equal(result.optionDataCoverage.contractDeltaCoveragePct, 0.9);
  assert.equal(result.optionDataCoverage.marketValueDeltaCoveragePct, 1 / 11);
  assert.equal(result.optionDataCoverage.optionMarketValueWithoutDelta, 10000);
  assert.equal(result.optionDataCoverage.materialCoverageMissing, true);
  assert.equal(result.portfolioBeta, null);
  assert.ok(result.scenarios.every((scenario) => scenario.netModeledLoss === null));
});

test("calculates signed portfolio beta and grouped concentration", () => {
  const config = buildHedgeConfig();
  const result = normalizePortfolioEvidence(
    account,
    [
      {
        symbol: "AAPL",
        assetClass: "us_equity",
        qty: "100",
        marketValue: "20000",
        currentPrice: "200"
      },
      {
        symbol: "AAPL260116C00150000",
        assetClass: "us_option",
        qty: "1",
        marketValue: "5000",
        currentPrice: "50"
      }
    ],
    {
      optionEvidence: {
        AAPL260116C00150000: {
          multiplier: 100,
          delta: 0.6,
          gamma: 0,
          theta: -0.05,
          vega: 0.2,
          rho: 0.1,
          bid: 49,
          ask: 51,
          midpoint: 50,
          quoteTimestamp: asOf
        }
      },
      underlyingPrices: { AAPL: 200 },
      betas: {
        AAPL: { beta: 1.2, status: "calculated", warnings: [] }
      },
      highWaterMark: 100000
    },
    config,
    asOf
  );

  assert.equal(result.portfolioBeta, 0.384);
  assert.equal(result.concentration.byUnderlying.AAPL, 0.32);
  assert.equal(result.concentration.largestUnderlyingWeight, 0.32);
});

test("long puts and inverse beta reduce modeled scenario loss", () => {
  const config = buildHedgeConfig();
  const result = normalizePortfolioEvidence(
    account,
    [
      {
        symbol: "AAPL",
        assetClass: "us_equity",
        qty: "500",
        marketValue: "100000",
        currentPrice: "200"
      },
      {
        symbol: "SPY260918P00500000",
        assetClass: "us_option",
        qty: "1",
        marketValue: "3000",
        currentPrice: "30"
      },
      {
        symbol: "SH",
        assetClass: "us_equity",
        qty: "100",
        marketValue: "5000",
        currentPrice: "50"
      }
    ],
    {
      optionEvidence: {
        SPY260918P00500000: {
          multiplier: 100,
          delta: -0.4,
          gamma: 0.005,
          theta: -0.03,
          vega: 0.15,
          rho: -0.05,
          bid: 29,
          ask: 31,
          midpoint: 30,
          quoteTimestamp: asOf
        }
      },
      underlyingPrices: { AAPL: 200, SPY: 500, SH: 50 },
      betas: {
        AAPL: { beta: 1.2, status: "calculated", warnings: [] },
        SPY: { beta: 1, status: "calculated", warnings: [] },
        SH: { beta: -1, status: "calculated", warnings: [] }
      },
      highWaterMark: 100000
    },
    config,
    asOf
  );

  const scenario = result.scenarios.find((row) => row.benchmarkDeclinePct === 10);
  assert.ok(scenario);
  assert.ok(scenario.existingProtection > 0);
  assert.ok(scenario.netModeledLoss !== null && scenario.netModeledLoss < scenario.grossModeledLoss);
  assert.equal(result.positions.find((position) => position.symbol === "SH")?.inverseExposure, true);
});

test("scenario set is fixed at 5, 8, 10, and 15 percent", () => {
  const result = normalizePortfolioEvidence(
    account,
    [],
    {
      optionEvidence: {},
      underlyingPrices: {},
      betas: {},
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.deepEqual(result.scenarios.map((row) => row.benchmarkDeclinePct), [5, 8, 10, 15]);
});
