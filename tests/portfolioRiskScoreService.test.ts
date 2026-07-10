import assert from "node:assert/strict";
import test from "node:test";

import type { MarketRegimeSnapshot } from "../src/services/marketRegimeService.js";
import { scorePortfolioRisk } from "../src/services/portfolioRiskScoreService.js";
import type { PortfolioRiskSnapshot } from "../src/services/portfolioRiskService.js";

const snapshot = (overrides: Partial<PortfolioRiskSnapshot> = {}): PortfolioRiskSnapshot => ({
  paperOnly: true,
  environment: "paper",
  generatedAt: "2026-07-10T14:00:00Z",
  snapshotId: "snapshot",
  sourceAccountSnapshotId: "account-snapshot",
  riskModelVersion: "portfolio-risk-v1",
  configurationFingerprint: "config",
  account: {
    equity: 100000,
    cash: 10000,
    buyingPower: 100000,
    highWaterMark: 115000,
    drawdownPct: 0.12
  },
  positions: [],
  exposures: {
    grossExposure: 200000,
    netExposure: 180000,
    longExposure: 200000,
    shortOrInverseExposure: 0,
    grossExposurePct: 2,
    netExposurePct: 1.8
  },
  options: {
    deltaExposure: 60000,
    absoluteDeltaExposure: 60000,
    absoluteDeltaExposurePct: 0.6,
    positiveDeltaExposure: 50000,
    positiveDeltaExposurePct: 0.5,
    gammaExposure: 100,
    thetaExposure: -50,
    vegaExposure: 200,
    rhoExposure: 25,
    nearTermExposurePct: 0.5
  },
  concentration: {
    largestUnderlyingWeight: 0.3,
    topFiveUnderlyingWeight: 0.8,
    byUnderlying: { AAPL: 0.3 },
    bySector: { technology: 0.3 },
    unknownSectorWeight: 0
  },
  portfolioBeta: 1.5,
  betaCoverage: 1,
  optionDataCoverage: {
    totalOptionContracts: 1,
    contractsWithDelta: 1,
    contractsWithoutDelta: 0,
    contractDeltaCoveragePct: 1,
    totalOptionMarketValue: 10000,
    optionMarketValueWithDelta: 10000,
    optionMarketValueWithoutDelta: 0,
    marketValueDeltaCoveragePct: 1,
    materialCoverageMissing: false
  },
  scenarios: [],
  dataQualityStatus: "blocked",
  dataQuality: {
    positionPriceCoverage: 1,
    optionDeltaCoverage: 1,
    optionGammaCoverage: 1,
    optionThetaCoverage: 1,
    optionVegaCoverage: 1,
    betaCoverage: 1,
    sectorCoverage: 1
  },
  warnings: [],
  blockers: [],
  ...overrides
});

const regime = (name: MarketRegimeSnapshot["regime"]): MarketRegimeSnapshot => ({
  paperOnly: true,
  generatedAt: "2026-07-10T14:00:00Z",
  regime: name,
  selectedRule: "test",
  modelVersion: "market-regime-v1",
  dataQualityStatus: "complete",
  indicators: {
    requiredDataAvailable: true,
    spyAboveSma50: false,
    spyAboveSma200: false,
    qqqAboveSma50: false,
    qqqAboveSma200: false,
    spyBelowSma50Pct: 0,
    spyDrawdown20Pct: 0,
    realizedVolatility20: 0.1,
    volatilityProxyLevel: null,
    volatilityProxyTrend: null
  },
  warnings: [],
  blockers: []
});

test("caps the ten score components at 100", () => {
  const score = scorePortfolioRisk(snapshot(), regime("crisis"));

  assert.equal(score.total, 100);
  assert.deepEqual(
    score.components.map((component) => component.maximum),
    [15, 15, 15, 10, 10, 8, 7, 8, 7, 5]
  );
  assert.equal(score.band, "critical");
  assert.equal(score.components.reduce((sum, component) => sum + component.points, 0), 100);
});

test("missing beta adds quality risk without fabricating beta points", () => {
  const input = snapshot({
    portfolioBeta: null,
    dataQualityStatus: "partial",
    account: {
      equity: 100000,
      cash: 10000,
      buyingPower: 100000,
      highWaterMark: 100000,
      drawdownPct: 0
    }
  });
  const score = scorePortfolioRisk(input, regime("neutral"));

  assert.equal(
    score.components.find((component) => component.key === "betaAdjustedExposure")?.points,
    0
  );
  assert.equal(
    score.components.find((component) => component.key === "dataQuality")?.points,
    2
  );
});

test("maps score totals to stable risk bands", () => {
  const low = scorePortfolioRisk(
    snapshot({
      exposures: {
        grossExposure: 0,
        netExposure: 0,
        longExposure: 0,
        shortOrInverseExposure: 0,
        grossExposurePct: 0,
        netExposurePct: 0
      },
      options: {
        deltaExposure: 0,
        absoluteDeltaExposure: 0,
        absoluteDeltaExposurePct: 0,
        positiveDeltaExposure: 0,
        positiveDeltaExposurePct: 0,
        gammaExposure: 0,
        thetaExposure: 0,
        vegaExposure: 0,
        rhoExposure: 0,
        nearTermExposurePct: 0
      },
      concentration: {
        largestUnderlyingWeight: 0,
        topFiveUnderlyingWeight: 0,
        byUnderlying: {},
        bySector: {},
        unknownSectorWeight: 0
      },
      portfolioBeta: 0.5,
      dataQualityStatus: "complete",
      account: {
        equity: 100000,
        cash: 100000,
        buyingPower: 100000,
        highWaterMark: 100000,
        drawdownPct: 0
      }
    }),
    regime("risk-on")
  );

  assert.equal(low.total, 0);
  assert.equal(low.band, "low");
  assert.equal(low.measurementStatus, "measured");
  assert.equal(low.effectiveBand, "low");
});

test("keeps a low calculated score but marks material missing option coverage indeterminate", () => {
  const input = snapshot({
    portfolioBeta: null,
    dataQualityStatus: "monitoring",
    optionDataCoverage: {
      totalOptionContracts: 20,
      contractsWithDelta: 2,
      contractsWithoutDelta: 18,
      contractDeltaCoveragePct: 0.1,
      totalOptionMarketValue: 30000,
      optionMarketValueWithDelta: 3000,
      optionMarketValueWithoutDelta: 27000,
      marketValueDeltaCoveragePct: 0.1,
      materialCoverageMissing: true
    },
    exposures: {
      grossExposure: 0,
      netExposure: 0,
      longExposure: 0,
      shortOrInverseExposure: 0,
      grossExposurePct: 0,
      netExposurePct: 0
    },
    options: {
      deltaExposure: null,
      absoluteDeltaExposure: null,
      absoluteDeltaExposurePct: null,
      positiveDeltaExposure: null,
      positiveDeltaExposurePct: null,
      gammaExposure: null,
      thetaExposure: null,
      vegaExposure: null,
      rhoExposure: null,
      nearTermExposurePct: null
    },
    concentration: {
      largestUnderlyingWeight: 0,
      topFiveUnderlyingWeight: 0,
      byUnderlying: {},
      bySector: {},
      unknownSectorWeight: 0
    },
    account: {
      equity: 100000,
      cash: 100000,
      buyingPower: 100000,
      highWaterMark: 100000,
      drawdownPct: 0
    }
  });

  const result = scorePortfolioRisk(input, regime("risk-on"));

  assert.equal(result.band, "low");
  assert.equal(result.measurementStatus, "indeterminate");
  assert.equal(result.effectiveBand, "indeterminate");
});
