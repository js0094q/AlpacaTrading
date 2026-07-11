import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-hedge-persistence-test-")),
  "research.db"
);
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.HEDGE_PAPER_EXECUTION_ENABLED = "false";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  attachReviewedPayloadHash,
  latestHedgeRecommendation,
  observePortfolioHighWaterMark,
  persistHedgeRecommendation,
  readCompatibleBetaCache,
  writeBetaCache
} from "../src/services/hedgePersistenceService.js";
import type { HedgeRecommendationRecord } from "../src/services/hedgeTypes.js";
import type { PortfolioRiskSnapshot } from "../src/services/portfolioRiskService.js";

const now = "2026-07-10T14:00:00.000Z";
const later = "2026-07-10T16:00:00.000Z";

const identity = {
  symbol: "AAPL",
  benchmark: "SPY",
  lookbackDays: 252,
  observationInterval: "1Day",
  minimumObservations: 60,
  calculationVersion: "beta-v1",
  latestMarketDataDate: "2026-07-09"
};

const coverageBasis = {
  total: 1,
  measured: 1,
  unmeasured: 0,
  coverageRatio: 1
};

const currentFreshness = {
  current: 1,
  stale: 0,
  expired: 0,
  malformed: 0,
  total: 1
};

const validRiskSnapshot = (): PortfolioRiskSnapshot => ({
  paperOnly: true,
  environment: "paper",
  generatedAt: now,
  snapshotId: "portfolio_snapshot_hash",
  sourceAccountSnapshotId: "account_snapshot_hash",
  riskModelVersion: "portfolio-risk-v1",
  configurationFingerprint: "config_hash",
  account: {
    equity: 100_000,
    cash: 10_000,
    buyingPower: 20_000,
    highWaterMark: 105_000,
    drawdownPct: 0.0476
  },
  positions: [],
  exposures: {
    grossExposure: 120_000,
    netExposure: 90_000,
    longExposure: 105_000,
    shortOrInverseExposure: 15_000,
    grossExposurePct: 1.2,
    netExposurePct: 0.9
  },
  options: {
    deltaExposure: 36_000,
    absoluteDeltaExposure: 36_000,
    absoluteDeltaExposurePct: 0.36,
    positiveDeltaExposure: 36_000,
    positiveDeltaExposurePct: 0.36,
    gammaExposure: 2,
    thetaExposure: -20,
    vegaExposure: 80,
    rhoExposure: 10,
    nearTermExposurePct: 0,
    deltaShares: 60,
    deltaDollars: 36_000,
    absoluteDeltaShares: 60,
    absoluteDeltaDollars: 36_000,
    gammaSharesPerDollar: 2,
    absoluteGammaSharesPerDollar: 2,
    thetaDollarsPerDay: -20,
    absoluteThetaDollarsPerDay: 20,
    positiveThetaDollarsPerDay: 0,
    negativeThetaDollarsPerDay: -20,
    vegaDollarsPerVolPoint: 80,
    absoluteVegaDollarsPerVolPoint: 80,
    rhoDollarsPerRatePoint: 10,
    absoluteRhoDollarsPerRatePoint: 10,
    impliedVolatility: {
      weightedByAbsoluteContracts: 0.3,
      weightedByAbsoluteMarketValue: 0.32,
      weightedByAbsoluteVega: 0.35
    },
    coverage: Object.fromEntries(
      ["delta", "gamma", "theta", "vega", "rho", "impliedVolatility"].map((metric) => [
        metric,
        {
          positions: { ...coverageBasis },
          absoluteContracts: { ...coverageBasis },
          absoluteMarketValue: { ...coverageBasis },
          freshness: { ...currentFreshness }
        }
      ])
    ) as PortfolioRiskSnapshot["options"]["coverage"],
    freshness: { ...currentFreshness },
    groupings: {
      byUnderlying: {},
      byExpiration: {},
      byOptionType: {},
      byDteBucket: {}
    },
    executionEligible: true
  },
  concentration: {
    largestUnderlyingWeight: 0.4,
    topFiveUnderlyingWeight: 0.8,
    byUnderlying: { SPY: 0.4 },
    bySector: { unknown: 0.4 },
    unknownSectorWeight: 0.4
  },
  portfolioBeta: 1.1,
  betaCoverage: 1,
  optionDataCoverage: {
    totalOptionContracts: 1,
    contractsWithDelta: 1,
    contractsWithoutDelta: 0,
    contractDeltaCoveragePct: 1,
    totalOptionMarketValue: 10_000,
    optionMarketValueWithDelta: 10_000,
    optionMarketValueWithoutDelta: 0,
    marketValueDeltaCoveragePct: 1,
    materialCoverageMissing: false
  },
  scenarios: [],
  dataQualityStatus: "complete",
  dataQuality: {
    positionPriceCoverage: 1,
    optionDeltaCoverage: 1,
    optionGammaCoverage: 1,
    optionThetaCoverage: 1,
    optionVegaCoverage: 1,
    betaCoverage: 1,
    sectorCoverage: 1
  },
  warnings: ["NESTED_RISK_WARNING"],
  blockers: []
});

const recommendation = (): HedgeRecommendationRecord => ({
  recordType: "hedge_recommendation",
  recommendationId: "hedge_rec_1",
  generatedAt: now,
  expiresAt: "2026-07-10T14:30:00.000Z",
  environment: "paper",
  sourceSnapshotId: "portfolio_snapshot_hash",
  riskModelVersion: "portfolio-risk-v1",
  regimeModelVersion: "market-regime-v1",
  configurationFingerprint: "config_hash",
  dataQualityStatus: "complete",
  recommendationStatus: "current",
  reviewedPayloadHash: null,
  decision: "monitor",
  benchmark: "SPY",
  risk: validRiskSnapshot(),
  regime: { regime: "neutral" },
  score: { total: 20, band: "low" },
  sizing: { netProtectionTarget: 0 },
  leaps: { trimRecommendations: [] },
  candidates: [],
  warnings: [],
  blockers: [],
  requestId: "request-1",
  correlationId: "correlation-1"
});

beforeEach(() => {
  getDb().exec(`
    DELETE FROM portfolio_high_water_marks;
    DELETE FROM portfolio_beta_cache;
    DELETE FROM paper_learning_records;
  `);
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

test("portfolio high-water mark never decreases", () => {
  assert.equal(
    observePortfolioHighWaterMark({ environment: "paper", equity: 100_000, observedAt: now }).equity,
    100_000
  );
  assert.equal(
    observePortfolioHighWaterMark({ environment: "paper", equity: 90_000, observedAt: later }).equity,
    100_000
  );
  assert.equal(
    observePortfolioHighWaterMark({ environment: "paper", equity: 110_000, observedAt: later }).equity,
    110_000
  );
});

test("beta cache reuses only a fully compatible unexpired row", () => {
  writeBetaCache({
    ...identity,
    beta: 1.2,
    observations: 80,
    dataStartDate: "2025-07-01",
    dataEndDate: "2026-07-09",
    status: "calculated",
    computedAt: now,
    expiresAt: later
  });

  assert.equal(readCompatibleBetaCache(identity, now)?.beta, 1.2);
  assert.equal(readCompatibleBetaCache({ ...identity, benchmark: "QQQ" }, now), null);
  assert.equal(readCompatibleBetaCache({ ...identity, lookbackDays: 126 }, now), null);
  assert.equal(readCompatibleBetaCache({ ...identity, observationInterval: "1Hour" }, now), null);
  assert.equal(readCompatibleBetaCache({ ...identity, minimumObservations: 81 }, now), null);
  assert.equal(readCompatibleBetaCache({ ...identity, calculationVersion: "beta-v2" }, now), null);
  assert.equal(readCompatibleBetaCache({ ...identity, latestMarketDataDate: "2026-07-10" }, now), null);
  assert.equal(readCompatibleBetaCache(identity, "2026-07-10T16:00:00.001Z"), null);
});

test("beta cache ignores incomplete and non-finite estimates", () => {
  writeBetaCache({
    ...identity,
    beta: null,
    observations: 40,
    dataStartDate: null,
    dataEndDate: "2026-07-09",
    status: "unavailable",
    computedAt: now,
    expiresAt: later
  });

  assert.equal(readCompatibleBetaCache(identity, now), null);
});

test("persisted recommendation retains integrity fields and derives freshness", () => {
  persistHedgeRecommendation(recommendation());

  const current = latestHedgeRecommendation({
    asOf: "2026-07-10T14:10:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });
  assert.equal(current?.effectiveStatus, "current");
  assert.equal(current?.sourceSnapshotId, "portfolio_snapshot_hash");
  assert.equal(current?.expiresAt, "2026-07-10T14:30:00.000Z");

  const stale = latestHedgeRecommendation({
    asOf: "2026-07-10T14:20:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });
  assert.equal(stale?.effectiveStatus, "stale");

  const expired = latestHedgeRecommendation({
    asOf: "2026-07-10T14:30:00.001Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });
  assert.equal(expired?.effectiveStatus, "expired");
});

test("configuration and model mismatches are never current", () => {
  persistHedgeRecommendation(recommendation());

  const result = latestHedgeRecommendation({
    asOf: "2026-07-10T14:05:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "different_config",
    riskModelVersion: "portfolio-risk-v2",
    regimeModelVersion: "market-regime-v2"
  });

  assert.equal(result?.effectiveStatus, "stale");
  assert.deepEqual(result?.integrityWarnings.sort(), [
    "HEDGE_CONFIGURATION_FINGERPRINT_MISMATCH",
    "HEDGE_REGIME_MODEL_VERSION_MISMATCH",
    "HEDGE_RISK_MODEL_VERSION_MISMATCH"
  ]);
});

test("planning writes the reviewed payload hash back to the recommendation", () => {
  persistHedgeRecommendation(recommendation());
  attachReviewedPayloadHash("hedge_rec_1", "reviewed_hash", later);

  const result = latestHedgeRecommendation({
    asOf: "2026-07-10T14:05:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });
  assert.equal(result?.reviewedPayloadHash, "reviewed_hash");
});

test("malformed persisted records fail closed", () => {
  getDb()
    .prepare(`
      INSERT INTO paper_learning_records(
        id, created_at, updated_at, strategy_family, symbol, decision,
        hypothesis, signal_inputs_json, learning_status, promotion_eligible,
        promotion_block_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "malformed",
      now,
      now,
      "portfolio_hedge",
      "SPY",
      "no_op",
      "malformed hedge record",
      JSON.stringify({ recordType: "hedge_recommendation", generatedAt: now }),
      "pending",
      0,
      "HEDGE_EXECUTION_NOT_IMPLEMENTED"
    );

  const result = latestHedgeRecommendation({
    asOf: now,
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });
  assert.equal(result?.effectiveStatus, "blocked");
  assert.ok(result?.integrityWarnings.includes("HEDGE_RECOMMENDATION_INTEGRITY_INVALID"));
});

test("missing or malformed persisted Greek payloads fail closed", () => {
  const record = recommendation();
  const risk = validRiskSnapshot();
  delete (risk.options as { coverage?: unknown }).coverage;
  persistHedgeRecommendation({
    ...record,
    recommendationId: "hedge_rec_missing_greeks",
    risk
  });

  const result = latestHedgeRecommendation({
    asOf: "2026-07-10T14:05:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });

  assert.equal(result?.effectiveStatus, "blocked");
  assert.ok(result?.integrityWarnings.includes("HEDGE_RISK_PAYLOAD_INVALID"));
});

test("nested risk model mismatch is never treated as current", () => {
  const risk = validRiskSnapshot();
  risk.riskModelVersion = "portfolio-risk-v0";
  persistHedgeRecommendation({
    ...recommendation(),
    recommendationId: "hedge_rec_nested_model_mismatch",
    risk
  });

  const result = latestHedgeRecommendation({
    asOf: "2026-07-10T14:05:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });

  assert.equal(result?.effectiveStatus, "stale");
  assert.ok(result?.integrityWarnings.includes("HEDGE_RISK_PAYLOAD_MODEL_MISMATCH"));
});

test("fresh recommendation with stale nested Greek evidence is stale", () => {
  const risk = validRiskSnapshot();
  risk.options.freshness = {
    current: 0,
    stale: 1,
    expired: 0,
    malformed: 0,
    total: 1
  };
  persistHedgeRecommendation({
    ...recommendation(),
    recommendationId: "hedge_rec_stale_nested_evidence",
    risk
  });

  const result = latestHedgeRecommendation({
    asOf: "2026-07-10T14:05:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });

  assert.equal(result?.effectiveStatus, "stale");
  assert.ok(result?.integrityWarnings.includes("HEDGE_RISK_EVIDENCE_STALE"));
});
