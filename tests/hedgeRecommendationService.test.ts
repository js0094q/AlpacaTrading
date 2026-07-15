import assert from "node:assert/strict";
import test from "node:test";

import { buildHedgeConfig } from "../src/services/hedgeConfigService.js";
import {
  recommendHedgeFromEvidence,
  type HedgeRecommendationEvidence
} from "../src/services/hedgeRecommendationService.js";
import type { MarketRegimeSnapshot } from "../src/services/marketRegimeService.js";
import type { PortfolioRiskScore } from "../src/services/portfolioRiskScoreService.js";
import type { PortfolioRiskSnapshot } from "../src/services/portfolioRiskService.js";
import { buildHedgeCapitalEvidence } from "../src/services/hedgeCapitalEvidenceService.js";

const now = "2026-07-10T14:00:00.000Z";

const regime = (name: MarketRegimeSnapshot["regime"]): MarketRegimeSnapshot => ({
  paperOnly: true,
  generatedAt: now,
  regime: name,
  selectedRule: `TEST_${name}`,
  modelVersion: "market-regime-v1",
  dataQualityStatus: "complete",
  indicators: {
    requiredDataAvailable: true,
    spyAboveSma50: true,
    spyAboveSma200: true,
    qqqAboveSma50: true,
    qqqAboveSma200: true,
    spyBelowSma50Pct: 0,
    spyDrawdown20Pct: 0,
    realizedVolatility20: 0.15,
    volatilityProxyLevel: 20,
    volatilityProxyTrend: "falling"
  },
  warnings: [],
  blockers: []
});

const score = (band: PortfolioRiskScore["band"], total: number): PortfolioRiskScore => ({
  total,
  band,
  measurementStatus: "measured",
  effectiveBand: band,
  modelVersion: "portfolio-risk-v1",
  components: []
});

const risk = (overrides: Partial<PortfolioRiskSnapshot> = {}): PortfolioRiskSnapshot => ({
  paperOnly: true,
  environment: "paper",
  generatedAt: now,
  snapshotId: "snapshot-1",
  sourceAccountSnapshotId: "account-snapshot-1",
  riskModelVersion: "portfolio-risk-v1",
  configurationFingerprint: "config-fingerprint",
  account: {
    equity: 1_000_000,
    cash: 100_000,
    buyingPower: 500_000,
    highWaterMark: 1_000_000,
    drawdownPct: 0
  },
  positions: [],
  exposures: {
    grossExposure: 1_200_000,
    netExposure: 1_100_000,
    longExposure: 1_200_000,
    shortOrInverseExposure: 100_000,
    grossExposurePct: 1.2,
    netExposurePct: 1.1
  },
  options: {
    deltaExposure: 400_000,
    absoluteDeltaExposure: 400_000,
    absoluteDeltaExposurePct: 0.4,
    positiveDeltaExposure: 400_000,
    positiveDeltaExposurePct: 0.4,
    gammaExposure: 10,
    thetaExposure: -100,
    vegaExposure: 500,
    rhoExposure: 100,
    nearTermExposurePct: 0.1
  },
  concentration: {
    largestUnderlyingWeight: 0.4,
    topFiveUnderlyingWeight: 0.8,
    byUnderlying: { AAPL: 0.4, SPY: 0.3 },
    bySector: { technology: 0.4 },
    unknownSectorWeight: 0.3
  },
  portfolioBeta: 1.2,
  betaCoverage: 1,
  optionDataCoverage: {
    totalOptionContracts: 4,
    contractsWithDelta: 4,
    contractsWithoutDelta: 0,
    contractDeltaCoveragePct: 1,
    totalOptionMarketValue: 400000,
    optionMarketValueWithDelta: 400000,
    optionMarketValueWithoutDelta: 0,
    marketValueDeltaCoveragePct: 1,
    materialCoverageMissing: false
  },
  scenarios: [
    { benchmarkDeclinePct: 5, grossModeledLoss: 60_000, existingProtection: 5_000, netModeledLoss: 55_000, netModeledLossPct: 0.055, coverage: 1, warnings: [] },
    { benchmarkDeclinePct: 8, grossModeledLoss: 96_000, existingProtection: 8_000, netModeledLoss: 88_000, netModeledLossPct: 0.088, coverage: 1, warnings: [] },
    { benchmarkDeclinePct: 10, grossModeledLoss: 120_000, existingProtection: 10_000, netModeledLoss: 110_000, netModeledLossPct: 0.11, coverage: 1, warnings: [] },
    { benchmarkDeclinePct: 15, grossModeledLoss: 180_000, existingProtection: 15_000, netModeledLoss: 165_000, netModeledLossPct: 0.165, coverage: 1, warnings: [] }
  ],
  dataQualityStatus: "complete",
  dataQuality: {
    positionPriceCoverage: 1,
    optionDeltaCoverage: 1,
    optionGammaCoverage: 1,
    optionThetaCoverage: 1,
    optionVegaCoverage: 1,
    betaCoverage: 1,
    sectorCoverage: 0.7
  },
  warnings: [],
  blockers: [],
  ...overrides
});

const evidence = (): HedgeRecommendationEvidence => ({
  optionCandidates: [
    {
      optionSymbol: "SPY260918P00500000",
      underlying: "SPY",
      expirationDate: "2026-09-18",
      daysToExpiration: 70,
      strikePrice: 500,
      underlyingPrice: 520,
      bid: 19,
      ask: 21,
      midpoint: 20,
      delta: -0.4,
      openInterest: 5000,
      volume: 1000
    },
    {
      optionSymbol: "SPY260918P00470000",
      underlying: "SPY",
      expirationDate: "2026-09-18",
      daysToExpiration: 70,
      strikePrice: 470,
      underlyingPrice: 520,
      bid: 9,
      ask: 11,
      midpoint: 10,
      delta: -0.2,
      openInterest: 4000,
      volume: 800
    }
  ],
  inversePrices: { SH: 40, PSQ: 35 },
  existingLeapsExitRecommendations: [],
  capitalEvidence: buildHedgeCapitalEvidence({
    asOf: now,
    allowedUnderlyings: ["SPY", "QQQ"],
    positions: [],
    orders: [],
    ledger: []
  })
});

test("blocks before selecting an instrument when the risk snapshot is blocked", () => {
  const result = recommendHedgeFromEvidence(
    risk({ dataQualityStatus: "blocked", blockers: ["PORTFOLIO_EQUITY_UNAVAILABLE"] }),
    regime("neutral"),
    score("moderate", 30),
    evidence(),
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.recommendationStatus, "blocked");
  assert.equal(result.decision, "blocked");
  assert.equal(result.candidates.length, 0);
});

test("material missing option delta forces monitoring before hedge sizing", () => {
  const incompleteRisk = risk({
    dataQualityStatus: "partial",
    optionDataCoverage: {
      totalOptionContracts: 20,
      contractsWithDelta: 2,
      contractsWithoutDelta: 18,
      contractDeltaCoveragePct: 0.1,
      totalOptionMarketValue: 300000,
      optionMarketValueWithDelta: 30000,
      optionMarketValueWithoutDelta: 270000,
      marketValueDeltaCoveragePct: 0.1,
      materialCoverageMissing: true
    },
    warnings: ["MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT"]
  });
  const incompleteScore: PortfolioRiskScore = {
    ...score("high", 70),
    measurementStatus: "indeterminate",
    effectiveBand: "indeterminate"
  };

  const result = recommendHedgeFromEvidence(
    incompleteRisk,
    regime("risk-off"),
    incompleteScore,
    evidence(),
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.recommendationStatus, "monitoring");
  assert.equal(result.decision, "monitor");
  assert.equal(result.sizing.netProtectionTarget, 0);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.warnings.includes("MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT"));
  assert.ok(result.warnings.includes("HEDGE_SIZING_EVIDENCE_INSUFFICIENT"));
});

test("incomplete hedge capital evidence forces monitoring with no executable candidate", () => {
  const incompleteEvidence = {
    ...evidence(),
    capitalEvidence: buildHedgeCapitalEvidence({
      asOf: now,
      allowedUnderlyings: ["SPY", "QQQ"],
      positions: [{
        symbol: "SPY260918P00500000",
        assetClass: "option",
        optionType: "put",
        quantity: 1,
        marketValue: null,
        costBasis: null
      }],
      orders: [],
      ledger: []
    })
  };

  const result = recommendHedgeFromEvidence(
    risk(),
    regime("risk-off"),
    score("high", 70),
    incompleteEvidence,
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.recommendationStatus, "monitoring");
  assert.equal(result.decision, "monitor");
  assert.equal(result.sizing.premiumBudget, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.capitalEvidence.complete, false);
  assert.ok(result.warnings.includes("HEDGE_CAPITAL_EVIDENCE_INCOMPLETE"));
});

test("premium budget subtracts real existing, reserved, and daily hedge usage", () => {
  const capitalEvidence = {
    ...evidence().capitalEvidence,
    existingHedgeExposure: 10_000,
    existingHedgePremium: 10_000,
    reservedHedgePremium: 2_000,
    dailyHedgePremiumUsed: 3_000,
    completedHedgePremium: 1_000,
    openHedgeOrderCount: 0,
    complete: true,
    blockers: [],
    fingerprint: "capital-evidence-test-fingerprint"
  };
  const result = recommendHedgeFromEvidence(
    risk(),
    regime("risk-off"),
    score("high", 70),
    { ...evidence(), capitalEvidence },
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.sizing.premiumBudget, 7_000);
});

test("open hedge order cap suppresses new executable candidates", () => {
  const capitalEvidence = {
    ...evidence().capitalEvidence,
    openHedgeOrderCount: buildHedgeConfig().executionPolicy.maxOrdersPerRun,
    fingerprint: "capital-evidence-open-order-cap"
  };
  const result = recommendHedgeFromEvidence(
    risk(),
    regime("risk-off"),
    score("high", 70),
    { ...evidence(), capitalEvidence },
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.candidates.length, 0);
  assert.equal(result.decision, "monitor");
  assert.ok(result.warnings.includes("HEDGE_OPEN_ORDER_CAP_REACHED"));
});

test("subtracts existing measured protection from the target", () => {
  const protectedRisk = risk({
    scenarios: risk().scenarios.map((scenario) =>
      scenario.benchmarkDeclinePct === 10
        ? { ...scenario, existingProtection: 70_000, netModeledLoss: 50_000 }
        : scenario
    )
  });
  const result = recommendHedgeFromEvidence(
    protectedRisk,
    regime("risk-off"),
    score("high", 70),
    evidence(),
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.sizing.grossProtectionTarget, 60_000);
  assert.equal(result.sizing.netProtectionTarget, 0);
  assert.equal(result.decision, "existing_protection_sufficient");
});

test("prefers a profitable concentrated LEAPS trim before paid protection", () => {
  const leapsRisk = risk({
    positions: [
      {
        symbol: "AAPL280120C00150000",
        underlying: "AAPL",
        assetClass: "option",
        optionType: "call",
        quantity: 5,
        marketValue: 80_000,
        currentPrice: 160,
        underlyingPrice: 200,
        costBasis: 50_000,
        unrealizedPl: 10_000,
        unrealizedPlPct: 0.2,
        sector: "technology",
        beta: 1.2,
        betaStatus: "calculated",
        multiplier: 100,
        delta: 0.7,
        gamma: 0.01,
        theta: -0.05,
        vega: 0.2,
        rho: 0.1,
        expirationDate: "2028-01-20",
        strikePrice: 150,
        daysToExpiration: 559,
        moneynessPct: -0.25,
        deltaEquivalentShares: 350,
        deltaAdjustedExposure: 70_000,
        betaExposure: 84_000,
        gammaExposure: 5,
        thetaExposure: -25,
        vegaExposure: 100,
        rhoExposure: 50,
        bid: 158,
        ask: 162,
        midpoint: 160,
        bidAskSpreadPct: 0.025,
        quoteTimestamp: now,
        inverseExposure: false,
        warnings: [],
        blockers: []
      }
    ],
    options: {
      ...risk().options,
      positiveDeltaExposure: 100_000,
      positiveDeltaExposurePct: 0.1
    }
  });
  const result = recommendHedgeFromEvidence(
    leapsRisk,
    regime("transition"),
    score("elevated", 55),
    evidence(),
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.decision, "trim_leaps_then_protect");
  assert.equal(result.leaps.profitFundedPremiumBudget, 2_500);
  assert.equal(result.leaps.trimRecommendations.length, 1);
  assert.equal(result.leaps.unrealizedGainFundingProxy, true);
});

test("sizes protection against modeled loss rather than NAV allocation", () => {
  const result = recommendHedgeFromEvidence(
    risk(),
    regime("risk-off"),
    score("high", 70),
    evidence(),
    buildHedgeConfig(),
    { generatedAt: now }
  );

  assert.equal(result.sizing.targetScenarioDeclinePct, 10);
  assert.equal(result.sizing.grossProtectionTarget, 60_000);
  assert.equal(result.sizing.netProtectionTarget, 50_000);
  const put = result.candidates.find((candidate) => candidate.instrumentType === "protective_put");
  assert.ok(put);
  assert.equal(put.executable, true);
  assert.ok((put.units ?? 0) > 0);
});

test("put spreads are always blocked from execution", () => {
  const result = recommendHedgeFromEvidence(
    risk(),
    regime("risk-off"),
    score("high", 70),
    evidence(),
    buildHedgeConfig(),
    { generatedAt: now }
  );
  const spread = result.candidates.find((candidate) => candidate.instrumentType === "put_spread");

  assert.ok(spread);
  assert.equal(spread.executable, false);
  assert.ok(spread.blockers.includes("MULTI_LEG_EXECUTION_UNSUPPORTED"));
});

test("SH and PSQ remain secondary alternatives with daily-reset warnings", () => {
  const result = recommendHedgeFromEvidence(
    risk(),
    regime("crisis"),
    score("critical", 85),
    evidence(),
    buildHedgeConfig(),
    { generatedAt: now }
  );
  const inverse = result.candidates.filter((candidate) => candidate.instrumentType === "inverse_etf");

  assert.deepEqual(inverse.map((candidate) => candidate.symbol).sort(), ["PSQ", "SH"]);
  assert.ok(inverse.every((candidate) => candidate.warnings.includes("INVERSE_ETF_DAILY_RESET_TRACKING_RISK")));
  assert.ok(inverse.every((candidate) => candidate.rank > 1));
});
