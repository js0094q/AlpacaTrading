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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
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

test("uses explicit Greek units and preserves long/short call/put signs", () => {
  const symbols = {
    longCall: "SPY260918C00600000",
    longPut: "SPY260918P00600000",
    shortCall: "QQQ260918C00500000",
    shortPut: "QQQ260918P00500000"
  };
  const result = normalizePortfolioEvidence(
    account,
    [
      { symbol: symbols.longCall, assetClass: "us_option", qty: "2", marketValue: "2000", side: "long" },
      { symbol: symbols.longPut, assetClass: "us_option", qty: "1", marketValue: "1000", side: "long" },
      { symbol: symbols.shortCall, assetClass: "us_option", qty: "3", marketValue: "-1500", side: "short" },
      { symbol: symbols.shortPut, assetClass: "us_option", qty: "4", marketValue: "-1200", side: "short" }
    ],
    {
      optionEvidence: Object.fromEntries(Object.values(symbols).map((symbol) => [symbol, {
        multiplier: symbol === symbols.longCall ? 50 : 100,
        delta: symbol.includes("C") ? 0.5 : -0.4,
        gamma: 0.01,
        theta: -0.05,
        vega: 0.2,
        rho: symbol.includes("C") ? 0.1 : -0.1,
        impliedVolatility: 0.25,
        bid: 9,
        ask: 11,
        midpoint: 10,
        quoteTimestamp: "2026-07-10T13:59:30.000Z",
        snapshotTimestamp: "2026-07-10T13:59:30.000Z"
      }])),
      underlyingPrices: { SPY: 600, QQQ: 500 },
      betas: {
        SPY: { beta: 1, status: "calculated", warnings: [] },
        QQQ: { beta: 1, status: "calculated", warnings: [] }
      },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  const bySymbol = Object.fromEntries(result.positions.map((position) => [position.symbol, position]));
  assert.equal(bySymbol[symbols.longCall]?.deltaShares, 50);
  assert.equal(bySymbol[symbols.longCall]?.deltaDollars, 30000);
  assert.equal(bySymbol[symbols.longPut]?.deltaShares, -40);
  assert.equal(bySymbol[symbols.shortCall]?.deltaShares, -150);
  assert.equal(bySymbol[symbols.shortPut]?.deltaShares, 160);
  assert.equal(bySymbol[symbols.shortCall]?.gammaSharesPerDollar, -3);
  assert.equal(bySymbol[symbols.shortCall]?.thetaDollarsPerDay, 15);
  assert.equal(bySymbol[symbols.shortCall]?.vegaDollarsPerVolPoint, -60);
  assert.equal(bySymbol[symbols.shortPut]?.rhoDollarsPerRatePoint, 40);
});

test("reports complete metric coverage, weighted IV, totals, and groupings", () => {
  const call = "SPY260918C00600000";
  const put = "SPY261218P00550000";
  const result = normalizePortfolioEvidence(
    account,
    [
      { symbol: call, assetClass: "us_option", qty: "2", marketValue: "2000", side: "long" },
      { symbol: put, assetClass: "us_option", qty: "1", marketValue: "3000", side: "long" }
    ],
    {
      optionEvidence: {
        [call]: {
          multiplier: 100, delta: 0.5, gamma: 0, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.2, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: "2026-07-10T13:59:30.000Z", snapshotTimestamp: "2026-07-10T13:59:30.000Z"
        },
        [put]: {
          multiplier: 100, delta: -0.4, gamma: 0.02, theta: -0.1, vega: 0.4, rho: -0.2,
          impliedVolatility: 0.5, bid: 29, ask: 31, midpoint: 30,
          quoteTimestamp: "2026-07-10T13:59:30.000Z", snapshotTimestamp: "2026-07-10T13:59:30.000Z"
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.equal(result.options.deltaShares, 60);
  assert.equal(result.options.deltaDollars, 36000);
  assert.equal(result.options.gammaSharesPerDollar, 2);
  assert.equal(result.options.absoluteGammaSharesPerDollar, 2);
  assert.equal(result.options.thetaDollarsPerDay, -20);
  assert.equal(result.options.absoluteThetaDollarsPerDay, 20);
  assert.equal(result.options.positiveThetaDollarsPerDay, 0);
  assert.equal(result.options.negativeThetaDollarsPerDay, -20);
  assert.equal(result.options.vegaDollarsPerVolPoint, 80);
  assert.equal(result.options.absoluteVegaDollarsPerVolPoint, 80);
  assert.equal(result.options.rhoDollarsPerRatePoint, 0);
  assert.equal(result.options.absoluteRhoDollarsPerRatePoint, 40);
  const { coverage, impliedVolatility, groupings } = result.options;
  assert.ok(coverage && impliedVolatility && groupings);
  assert.equal(coverage.delta.positions.coverageRatio, 1);
  assert.equal(coverage.gamma.absoluteContracts.coverageRatio, 1);
  assert.equal(coverage.rho.absoluteMarketValue.coverageRatio, 1);
  assert.equal(coverage.impliedVolatility.freshness.current, 2);
  assert.equal(impliedVolatility.weightedByAbsoluteContracts, 0.3);
  assert.equal(impliedVolatility.weightedByAbsoluteMarketValue, 0.38);
  assert.equal(impliedVolatility.weightedByAbsoluteVega, 0.35);
  assert.equal(groupings.byUnderlying.SPY?.quality, "complete");
  assert.equal(groupings.byOptionType.call?.deltaDollars, 60000);
  assert.equal(groupings.byOptionType.put?.deltaDollars, -24000);
  assert.equal(groupings.byExpiration["2026-09-18"]?.positionCount, 1);
  assert.equal(groupings.byDteBucket["61-90"]?.positionCount, 1);
});

test("preserves observed zero Greeks and no-option denominator semantics", () => {
  const symbol = "SPY260918C00600000";
  const withZero = normalizePortfolioEvidence(
    account,
    [{ symbol, assetClass: "us_option", qty: "1", marketValue: "1000" }],
    {
      optionEvidence: {
        [symbol]: {
          multiplier: 100, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0,
          impliedVolatility: 0, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );
  assert.equal(withZero.positions[0]?.deltaShares, 0);
  assert.ok(withZero.options.coverage && withZero.options.impliedVolatility);
  assert.equal(withZero.options.coverage.delta.positions.measured, 1);
  assert.equal(withZero.options.impliedVolatility.weightedByAbsoluteContracts, 0);

  const withoutOptions = normalizePortfolioEvidence(
    account,
    [],
    { optionEvidence: {}, underlyingPrices: {}, betas: {}, highWaterMark: 100000 },
    buildHedgeConfig(),
    asOf
  );
  assert.equal(withoutOptions.options.deltaShares, 0);
  assert.ok(
    withoutOptions.options.coverage &&
      withoutOptions.options.impliedVolatility &&
      withoutOptions.options.groupings
  );
  assert.equal(withoutOptions.options.coverage.delta.positions.total, 0);
  assert.equal(withoutOptions.options.coverage.delta.positions.coverageRatio, null);
  assert.equal(withoutOptions.options.impliedVolatility.weightedByAbsoluteContracts, null);
  assert.deepEqual(withoutOptions.options.groupings.byUnderlying, {});
});

test("classifies current, stale boundary, expired, future, and malformed evidence", () => {
  const symbols = [
    "SPY260918C00600000",
    "SPY260918P00600000",
    "QQQ260918C00500000",
    "QQQ260918P00500000",
    "AAPL260918C00200000"
  ];
  const timestamps = [
    "2026-07-10T13:59:00.000Z",
    "2026-07-10T13:45:00.000Z",
    "2026-07-10T13:44:59.999Z",
    "2026-07-10T14:00:00.001Z",
    "not-a-timestamp"
  ];
  const result = normalizePortfolioEvidence(
    account,
    symbols.map((symbol) => ({ symbol, assetClass: "us_option", qty: "1", marketValue: "3000" })),
    {
      optionEvidence: Object.fromEntries(symbols.map((symbol, index) => [symbol, {
        multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
        impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
        quoteTimestamp: timestamps[index], snapshotTimestamp: timestamps[index]
      }])),
      underlyingPrices: { SPY: 600, QQQ: 500, AAPL: 200 },
      betas: {
        SPY: { beta: 1, status: "calculated", warnings: [] },
        QQQ: { beta: 1, status: "calculated", warnings: [] },
        AAPL: { beta: 1, status: "calculated", warnings: [] }
      },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.deepEqual(result.options.freshness, {
    current: 1,
    stale: 1,
    expired: 1,
    malformed: 2,
    total: 5
  });
  assert.ok(result.options.coverage);
  assert.equal(result.options.coverage.delta.freshness.expired, 1);
  assert.equal(result.options.coverage.delta.freshness.malformed, 2);
  assert.equal(result.optionDataCoverage.materialCoverageMissing, true);
  assert.equal(result.options.executionEligible, false);
  assert.equal(result.portfolioBeta, null);
  assert.ok(result.warnings.includes("HEDGE_GREEKS_STALE"));
  assert.ok(result.scenarios.every((scenario) => scenario.netModeledLoss === null));
});

test("stale delta evidence fails closed even below exposure materiality", () => {
  const symbol = "SPY260918C00600000";
  const result = normalizePortfolioEvidence(
    account,
    [{ symbol, assetClass: "us_option", qty: "1", marketValue: "1000" }],
    {
      optionEvidence: {
        [symbol]: {
          multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: "2026-07-10T13:58:59.000Z",
          snapshotTimestamp: "2026-07-10T13:58:59.000Z"
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.equal(result.options.freshness?.stale, 1);
  assert.equal(result.optionDataCoverage.materialCoverageMissing, true);
  assert.equal(result.options.deltaDollars, null);
  assert.equal(result.options.executionEligible, false);
});

test("missing market value and partial Greeks make group quality incomplete without false totals", () => {
  const complete = "SPY260918C00600000";
  const incomplete = "SPY260918P00600000";
  const result = normalizePortfolioEvidence(
    account,
    [
      { symbol: complete, assetClass: "us_option", qty: "1", marketValue: "1000" },
      { symbol: incomplete, assetClass: "us_option", qty: "1", currentPrice: "10" }
    ],
    {
      optionEvidence: {
        [complete]: {
          multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        },
        [incomplete]: {
          multiplier: 100, delta: null, gamma: null, theta: null, vega: null, rho: null,
          impliedVolatility: null, bid: null, ask: null, midpoint: null,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.ok(result.options.coverage && result.options.groupings);
  assert.equal(result.options.coverage.delta.absoluteMarketValue.total, null);
  assert.equal(result.options.coverage.delta.absoluteMarketValue.coverageRatio, null);
  assert.equal(result.options.groupings.byUnderlying.SPY?.quality, "incomplete");
  assert.equal(result.options.groupings.byUnderlying.SPY?.deltaDollars, null);
  assert.ok(result.options.groupings.byUnderlying.SPY?.missingMetrics.includes("delta"));
});

test("missing multiplier keeps raw Greeks visible but group totals incomplete", () => {
  const symbol = "SPY260918C00600000";
  const result = normalizePortfolioEvidence(
    account,
    [{ symbol, assetClass: "us_option", qty: "1", marketValue: "1000" }],
    {
      optionEvidence: {
        [symbol]: {
          multiplier: null, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.equal(result.positions[0]?.delta, 0.5);
  assert.equal(result.positions[0]?.deltaShares, null);
  assert.equal(result.options.executionEligible, false);
  assert.ok(result.options.groupings);
  assert.equal(result.options.groupings.byUnderlying.SPY?.quality, "incomplete");
  assert.ok(result.options.groupings.byUnderlying.SPY?.missingMetrics.includes("delta"));
});

test("fresh quote timestamp cannot rescue a missing Greek snapshot timestamp", () => {
  const symbol = "SPY260918C00600000";
  const result = normalizePortfolioEvidence(
    account,
    [{ symbol, assetClass: "us_option", qty: "1", marketValue: "10000" }],
    {
      optionEvidence: {
        [symbol]: {
          multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: null
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.equal(result.positions[0]?.quoteTimestamp, asOf);
  assert.equal(result.positions[0]?.greekObservationTimestamp, null);
  assert.equal(result.positions[0]?.greekObservationFreshness, "malformed");
  assert.equal(result.options.executionEligible, false);
});

test("fresh quote timestamp cannot rescue a stale Greek snapshot timestamp", () => {
  const symbol = "SPY260918C00600000";
  const staleTimestamp = "2026-07-10T13:58:59.000Z";
  const result = normalizePortfolioEvidence(
    account,
    [{ symbol, assetClass: "us_option", qty: "1", marketValue: "10000" }],
    {
      optionEvidence: {
        [symbol]: {
          multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: staleTimestamp
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.equal(result.positions[0]?.quoteTimestamp, asOf);
  assert.equal(result.positions[0]?.greekObservationTimestamp, staleTimestamp);
  assert.equal(result.positions[0]?.greekObservationFreshness, "stale");
  assert.equal(result.options.executionEligible, false);
});

test("non-finite injected numeric evidence normalizes to null and fails closed", () => {
  const symbol = "SPY260918C00600000";
  const result = normalizePortfolioEvidence(
    account,
    [{ symbol, assetClass: "us_option", qty: "1", marketValue: "10000" }],
    {
      optionEvidence: {
        [symbol]: {
          multiplier: Number.NaN,
          delta: Number.POSITIVE_INFINITY,
          gamma: Number.NEGATIVE_INFINITY,
          theta: Number.NaN,
          vega: Number.POSITIVE_INFINITY,
          rho: Number.NEGATIVE_INFINITY,
          impliedVolatility: Number.NaN,
          bid: Number.POSITIVE_INFINITY,
          ask: Number.NEGATIVE_INFINITY,
          midpoint: Number.NaN,
          bidSize: Number.POSITIVE_INFINITY,
          askSize: Number.NaN,
          quoteTimestamp: asOf,
          snapshotTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: Number.POSITIVE_INFINITY },
      betas: {
        SPY: { beta: Number.NaN, status: "calculated", warnings: [] }
      },
      highWaterMark: Number.POSITIVE_INFINITY
    },
    buildHedgeConfig(),
    asOf
  );

  const position = result.positions[0];
  assert.ok(position);
  assert.equal(position.multiplier, null);
  assert.equal(position.delta, null);
  assert.equal(position.gamma, null);
  assert.equal(position.theta, null);
  assert.equal(position.vega, null);
  assert.equal(position.rho, null);
  assert.equal(position.impliedVolatility, null);
  assert.equal(position.bid, null);
  assert.equal(position.ask, null);
  assert.equal(position.midpoint, null);
  assert.equal(position.bidSize, null);
  assert.equal(position.askSize, null);
  assert.equal(position.underlyingPrice, null);
  assert.equal(position.beta, null);
  assert.equal(result.account.highWaterMark, 100000);
  assert.equal(result.options.coverage?.delta.positions.measured, 0);
  assert.equal(result.options.groupings?.byUnderlying.SPY?.quality, "incomplete");
  assert.equal(result.options.executionEligible, false);
});

test("delta execution coverage passes exactly at signed 90 percent contracts and 95 percent market value", () => {
  const measured = "SPY260918C00600000";
  const unmeasured = "SPY260918P00600000";
  const result = normalizePortfolioEvidence(
    account,
    [
      { symbol: measured, assetClass: "us_option", qty: "9", marketValue: "9500", side: "long" },
      { symbol: unmeasured, assetClass: "us_option", qty: "1", marketValue: "-500", side: "short" }
    ],
    {
      optionEvidence: {
        [measured]: {
          multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        },
        [unmeasured]: {
          multiplier: 100, delta: null, gamma: null, theta: null, vega: null, rho: null,
          impliedVolatility: null, bid: 4, ask: 6, midpoint: 5,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.equal(result.optionDataCoverage.contractDeltaCoveragePct, 0.9);
  assert.equal(result.optionDataCoverage.marketValueDeltaCoveragePct, 0.95);
  assert.equal(result.options.executionEligible, true);
});

test("delta execution coverage fails when signed absolute contracts are just below 90 percent", () => {
  const measured = "SPY260918C00600000";
  const unmeasured = "SPY260918P00600000";
  const result = normalizePortfolioEvidence(
    account,
    [
      { symbol: measured, assetClass: "us_option", qty: "8.999", marketValue: "9500", side: "long" },
      { symbol: unmeasured, assetClass: "us_option", qty: "1.001", marketValue: "-500", side: "short" }
    ],
    {
      optionEvidence: {
        [measured]: {
          multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        },
        [unmeasured]: {
          multiplier: 100, delta: null, gamma: null, theta: null, vega: null, rho: null,
          impliedVolatility: null, bid: 4, ask: 6, midpoint: 5,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.ok((result.optionDataCoverage.contractDeltaCoveragePct ?? 1) < 0.9);
  assert.equal(result.optionDataCoverage.marketValueDeltaCoveragePct, 0.95);
  assert.equal(result.options.executionEligible, false);
});

test("delta execution coverage fails when signed absolute market value is just below 95 percent", () => {
  const measured = "SPY260918C00600000";
  const unmeasured = "SPY260918P00600000";
  const result = normalizePortfolioEvidence(
    account,
    [
      { symbol: measured, assetClass: "us_option", qty: "9", marketValue: "9499", side: "long" },
      { symbol: unmeasured, assetClass: "us_option", qty: "1", marketValue: "-501", side: "short" }
    ],
    {
      optionEvidence: {
        [measured]: {
          multiplier: 100, delta: 0.5, gamma: 0.01, theta: -0.05, vega: 0.2, rho: 0.1,
          impliedVolatility: 0.3, bid: 9, ask: 11, midpoint: 10,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        },
        [unmeasured]: {
          multiplier: 100, delta: null, gamma: null, theta: null, vega: null, rho: null,
          impliedVolatility: null, bid: 4, ask: 6, midpoint: 5,
          quoteTimestamp: asOf, snapshotTimestamp: asOf
        }
      },
      underlyingPrices: { SPY: 600 },
      betas: { SPY: { beta: 1, status: "calculated", warnings: [] } },
      highWaterMark: 100000
    },
    buildHedgeConfig(),
    asOf
  );

  assert.equal(result.optionDataCoverage.contractDeltaCoveragePct, 0.9);
  assert.ok((result.optionDataCoverage.marketValueDeltaCoveragePct ?? 1) < 0.95);
  assert.equal(result.options.executionEligible, false);
});
