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
  persistHedgeExecutionReview,
  readHedgeExecutionReview,
  readCompatibleBetaCache,
  writeBetaCache
} from "../src/services/hedgePersistenceService.js";
import { createHedgeExecutionReview } from "../src/services/hedgeExecutionReviewService.js";
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

const marketValueCoverageBasis = {
  total: 10_000,
  measured: 10_000,
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

const completeGroup = {
  positionCount: 1,
  absoluteContracts: 1,
  absoluteMarketValue: 10_000,
  deltaShares: 60,
  deltaDollars: 36_000,
  gammaSharesPerDollar: 2,
  thetaDollarsPerDay: -20,
  vegaDollarsPerVolPoint: 80,
  rhoDollarsPerRatePoint: 10,
  impliedVolatility: {
    weightedByAbsoluteContracts: 0.3,
    weightedByAbsoluteMarketValue: 0.3,
    weightedByAbsoluteVega: 0.3
  },
  quality: "complete" as const,
  missingMetrics: []
};

const optionPosition = (): PortfolioRiskSnapshot["positions"][number] => ({
  symbol: "SPY260918C00600000",
  underlying: "SPY",
  assetClass: "option",
  optionType: "call",
  quantity: 1,
  marketValue: 10_000,
  currentPrice: 100,
  underlyingPrice: 600,
  costBasis: 8_000,
  unrealizedPl: 2_000,
  unrealizedPlPct: 0.25,
  sector: "unknown",
  beta: 1,
  betaStatus: "calculated",
  multiplier: 100,
  delta: 0.6,
  gamma: 0.02,
  theta: -0.2,
  vega: 0.8,
  rho: 0.1,
  expirationDate: "2026-09-18",
  strikePrice: 600,
  daysToExpiration: 70,
  moneynessPct: 0,
  deltaEquivalentShares: 60,
  deltaAdjustedExposure: 36_000,
  deltaShares: 60,
  deltaDollars: 36_000,
  betaExposure: 36_000,
  gammaExposure: 2,
  thetaExposure: -20,
  vegaExposure: 80,
  rhoExposure: 10,
  gammaSharesPerDollar: 2,
  thetaDollarsPerDay: -20,
  vegaDollarsPerVolPoint: 80,
  rhoDollarsPerRatePoint: 10,
  impliedVolatility: 0.3,
  greekObservationTimestamp: "2026-07-10T14:04:30.000Z",
  greekObservationFreshness: "current",
  underlyingPriceTimestamp: "2026-07-10T14:04:30.000Z",
  bid: 99,
  ask: 101,
  midpoint: 100,
  bidSize: 10,
  askSize: 12,
  bidAskSpreadPct: 0.02,
  quoteTimestamp: "2026-07-10T14:04:30.000Z",
  inverseExposure: false,
  warnings: [],
  blockers: []
});

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
  positions: [optionPosition()],
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
          absoluteMarketValue: { ...marketValueCoverageBasis },
          freshness: { ...currentFreshness }
        }
      ])
    ) as PortfolioRiskSnapshot["options"]["coverage"],
    freshness: { ...currentFreshness },
    groupings: {
      byUnderlying: { SPY: { ...completeGroup } },
      byExpiration: { "2026-09-18": { ...completeGroup } },
      byOptionType: { call: { ...completeGroup } },
      byDteBucket: { "61-90": { ...completeGroup } }
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
    asOf: "2026-07-10T14:05:00.000Z",
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
      "HEDGE_PLAN_REQUIRES_EXECUTION_REVIEW"
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

test("non-paper persisted recommendations are not relabeled as paper-safe", () => {
  const record = recommendation() as unknown as { environment: string };
  record.environment = "live";
  persistHedgeRecommendation(record as unknown as HedgeRecommendationRecord);

  const result = latestHedgeRecommendation({
    asOf: "2026-07-10T14:05:00.000Z",
    freshnessMinutes: 15,
    configurationFingerprint: "config_hash",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1"
  });

  assert.equal(result?.effectiveStatus, "blocked");
  assert.equal(result?.environment, "live");
  assert.equal(result?.paperOnly, false);
  assert.equal(result?.liveTradingEnabled, true);
  assert.ok(result?.integrityWarnings.includes("HEDGE_RECOMMENDATION_ENVIRONMENT_INVALID"));
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

test("nested risk model mismatch fails closed", () => {
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

  assert.equal(result?.effectiveStatus, "blocked");
  assert.equal(result?.risk, null);
  assert.ok(result?.integrityWarnings.includes("HEDGE_RISK_PAYLOAD_MODEL_MISMATCH"));
});

test("stored freshness counters cannot make current position evidence stale", () => {
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

  assert.equal(result?.effectiveStatus, "current");
  assert.deepEqual(result?.risk?.options.freshness, currentFreshness);
  assert.ok(!result?.integrityWarnings.includes("HEDGE_RISK_EVIDENCE_STALE"));
});

test("persisted Greek freshness is recomputed from position timestamps and current policy", () => {
  const previousCurrentAge = process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS;
  const previousStaleAge = process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS;
  process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS = "60";
  process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS = "900";
  try {
    const risk = validRiskSnapshot();
    risk.positions[0].greekObservationTimestamp = "2026-07-10T14:00:00.000Z";
    persistHedgeRecommendation({
      ...recommendation(),
      recommendationId: "hedge_rec_recomputed_freshness",
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
    assert.equal(result?.risk?.positions[0].greekObservationFreshness, "stale");
    assert.deepEqual(result?.risk?.options.freshness, {
      current: 0,
      stale: 1,
      expired: 0,
      malformed: 0,
      total: 1
    });
    assert.deepEqual(result?.risk?.options.coverage?.impliedVolatility.freshness, {
      current: 0,
      stale: 1,
      expired: 0,
      malformed: 0,
      total: 1
    });
  } finally {
    if (previousCurrentAge === undefined) delete process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS;
    else process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS = previousCurrentAge;
    if (previousStaleAge === undefined) delete process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS;
    else process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS = previousStaleAge;
  }
});

test("expired and malformed position timestamps cannot remain current", () => {
  for (const [suffix, timestamp, expected] of [
    ["expired", "2026-07-10T13:00:00.000Z", "expired"],
    ["malformed", "not-an-iso-time", "malformed"]
  ] as const) {
    const risk = validRiskSnapshot();
    risk.positions[0].greekObservationTimestamp = timestamp;
    persistHedgeRecommendation({
      ...recommendation(),
      recommendationId: `hedge_rec_${suffix}_timestamp`,
      generatedAt: suffix === "expired" ? now : "2026-07-10T14:00:01.000Z",
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
    assert.equal(result?.risk?.positions[0].greekObservationFreshness, expected);
  }
});

test("runtime decoder rejects incomplete, inconsistent, or mismatched risk snapshots", () => {
  const invalidRisks: Array<[string, (risk: PortfolioRiskSnapshot) => void]> = [
    ["paper identity", (risk) => { (risk as { paperOnly: boolean }).paperOnly = false; }],
    ["environment", (risk) => { (risk as { environment: string }).environment = "live"; }],
    ["source identity", (risk) => { risk.snapshotId = "different_snapshot"; }],
    ["model identity", (risk) => { risk.riskModelVersion = "portfolio-risk-v0"; }],
    ["config identity", (risk) => { risk.configurationFingerprint = "different_config"; }],
    ["account structure", (risk) => { delete (risk as { account?: unknown }).account; }],
    ["finite numeric", (risk) => { (risk.account as { equity: unknown }).equity = "NaN"; }],
    ["position enum", (risk) => { (risk.positions[0] as { assetClass: string }).assetClass = "crypto"; }],
    ["coverage arithmetic", (risk) => { risk.options.coverage!.delta.positions.unmeasured = 1; }],
    ["coverage ratio", (risk) => { risk.options.coverage!.delta.absoluteContracts.coverageRatio = 0.5; }],
    ["group consistency", (risk) => { risk.options.groupings!.byUnderlying.SPY.positionCount = 2; }],
    ["scenario enum", (risk) => { risk.scenarios = [{ benchmarkDeclinePct: 7 } as never]; }],
    ["quality enum", (risk) => { (risk as { dataQualityStatus: string }).dataQualityStatus = "unknown"; }]
  ];

  for (const [label, corrupt] of invalidRisks) {
    const risk = validRiskSnapshot();
    corrupt(risk);
    persistHedgeRecommendation({
      ...recommendation(),
      recommendationId: `invalid_${label.replace(/\s+/g, "_")}`,
      generatedAt: new Date(Date.parse(now) + invalidRisks.indexOf(invalidRisks.find((entry) => entry[0] === label)!) * 1000).toISOString(),
      risk
    });
    const result = latestHedgeRecommendation({
      asOf: "2026-07-10T14:05:00.000Z",
      freshnessMinutes: 15,
      configurationFingerprint: "config_hash",
      riskModelVersion: "portfolio-risk-v1",
      regimeModelVersion: "market-regime-v1"
    });
    assert.equal(result?.effectiveStatus, "blocked", label);
    assert.equal(result?.risk, null, label);
    assert.ok(result?.integrityWarnings.includes("HEDGE_RISK_PAYLOAD_INVALID"), label);
  }
});

test("persists and verifies an HMAC hedge review on every read", () => {
  const review = createHedgeExecutionReview({
    accountHash: "account-hash",
    sourceRecommendationId: "recommendation-1",
    sourceSnapshotId: "snapshot-1",
    sourceRegimeId: "regime-1",
    riskModelVersion: "portfolio-risk-v1",
    regimeModelVersion: "market-regime-v1",
    configurationFingerprint: "config_hash",
    generatedAt: now,
    signingKey: "persistence-test-key",
    candidate: {
      candidateId: "candidate-1",
      rank: 1,
      instrumentType: "protective_put",
      symbol: "SPY260918P00500000",
      underlying: "SPY",
      executable: true,
      expectedProtection: 1_000,
      estimatedCost: 500,
      units: 1,
      rationale: [],
      warnings: [],
      blockers: [],
      details: { midpoint: 5, multiplier: 100 }
    }
  });
  persistHedgeExecutionReview(review);

  const valid = readHedgeExecutionReview({
    reviewId: review.reviewId,
    signingKey: "persistence-test-key",
    accountHash: "account-hash",
    configurationFingerprint: "config_hash",
    sourceSnapshotId: "snapshot-1",
    asOf: "2026-07-10T14:00:01.000Z"
  });
  assert.equal(valid.verification.valid, true);
  assert.equal(valid.review?.clientOrderId, review.clientOrderId);

  const invalid = readHedgeExecutionReview({
    reviewId: review.reviewId,
    signingKey: "wrong-key",
    asOf: "2026-07-10T14:00:01.000Z"
  });
  assert.equal(invalid.verification.valid, false);
  assert.ok(invalid.verification.blockers.includes("HEDGE_REVIEW_SIGNATURE_INVALID"));
});
