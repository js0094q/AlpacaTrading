import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-hedge-plan-test-")),
  "research.db"
);
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.HEDGE_PAPER_EXECUTION_ENABLED = "false";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint
} from "../src/services/hedgeConfigService.js";
import { evaluateHedgeExecutionGate } from "../src/services/hedgeExecutionGateService.js";
import {
  buildAndPersistHedgePlan,
  buildAndPersistHedgeReview,
  type HedgeReviewReport
} from "../src/services/hedgeLearningService.js";
import type { HedgeRecommendation } from "../src/services/hedgeRecommendationService.js";
import {
  attachReviewedPayloadHash,
  latestHedgePlan,
  latestHedgeRecommendation,
  persistHedgePlanRecord,
  persistHedgeRecommendation
} from "../src/services/hedgePersistenceService.js";
import {
  createHedgePlan,
  verifyHedgePlan
} from "../src/services/hedgePlanService.js";

const now = "2026-07-10T14:00:00.000Z";
const config = buildHedgeConfig();
const fingerprint = hedgeConfigurationFingerprint(config);

const recommendation = (): HedgeRecommendation => ({
  recordType: "hedge_recommendation",
  recommendationId: "hedge_rec_plan_test",
  generatedAt: now,
  expiresAt: "2026-07-10T14:30:00.000Z",
  environment: "paper",
  sourceSnapshotId: "portfolio_snapshot_plan_test",
  riskModelVersion: config.riskModelVersion,
  regimeModelVersion: config.regimeModelVersion,
  configurationFingerprint: fingerprint,
  dataQualityStatus: "complete",
  recommendationStatus: "current",
  reviewedPayloadHash: null,
  decision: "buy_protection",
  benchmark: "SPY",
  risk: { snapshotId: "portfolio_snapshot_plan_test" } as HedgeRecommendation["risk"],
  regime: { regime: "risk-off" } as HedgeRecommendation["regime"],
  score: { total: 70, band: "high" } as HedgeRecommendation["score"],
  sizing: {
    targetScenarioDeclinePct: 10,
    targetProtectionPct: 0.5,
    grossModeledLoss: 100000,
    grossProtectionTarget: 50000,
    existingMeasuredProtection: 10000,
    netProtectionTarget: 40000,
    premiumBudget: 10000,
    residualUnprotectedLoss: 30000
  },
  leaps: {
    trimRecommendations: [],
    observedUnrealizedGain: 0,
    profitFundedPremiumBudget: 0,
    unrealizedGainFundingProxy: true,
    existingExitRecommendations: [],
    warnings: []
  },
  candidates: [
    {
      candidateId: "put-1",
      rank: 1,
      instrumentType: "protective_put",
      symbol: "SPY260918P00500000",
      underlying: "SPY",
      executable: false,
      expectedProtection: 10000,
      estimatedCost: 5000,
      units: 1,
      rationale: ["test"],
      warnings: [],
      blockers: []
    }
  ],
  warnings: [],
  blockers: [],
  requestId: "request-plan-test",
  correlationId: "correlation-plan-test"
});

beforeEach(() => {
  getDb().exec("DELETE FROM paper_learning_records;");
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

test("creates and verifies a signed expiring paper-only plan", () => {
  const artifact = createHedgePlan({
    recommendation: recommendation(),
    paperOnly: true,
    createdAt: now,
    config
  });
  const verification = verifyHedgePlan({
    artifact,
    asOf: now,
    sourceSnapshotId: recommendation().sourceSnapshotId,
    configurationFingerprint: fingerprint
  });

  assert.equal(verification.valid, true);
  assert.equal(artifact.reviewedPayloadHash, artifact.payloadSignature);
  assert.equal(artifact.signatureAlgorithm, "sha256-canonical-json");
  assert.equal(artifact.environment, "paper");
  assert.equal(artifact.paperOnly, true);
  assert.equal("brokerOrderPayload" in artifact, false);
  assert.equal("clientOrderId" in artifact, false);
});

test("verification rejects tampering, expiry, source mismatch, and config mismatch", () => {
  const artifact = createHedgePlan({
    recommendation: recommendation(),
    paperOnly: true,
    createdAt: now,
    config
  });
  const tampered = {
    ...artifact,
    reviewedPayload: {
      ...artifact.reviewedPayload,
      decision: "tampered"
    }
  };
  const verification = verifyHedgePlan({
    artifact: tampered,
    asOf: "2026-07-10T15:00:00.000Z",
    sourceSnapshotId: "different_snapshot",
    configurationFingerprint: "different_config"
  });

  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes("HEDGE_PLAN_PAYLOAD_HASH_MISMATCH"));
  assert.ok(verification.blockers.includes("HEDGE_PLAN_EXPIRED"));
  assert.ok(verification.blockers.includes("HEDGE_PLAN_SOURCE_SNAPSHOT_MISMATCH"));
  assert.ok(verification.blockers.includes("HEDGE_PLAN_CONFIGURATION_MISMATCH"));
});

test("missing paper-only intent creates a blocked artifact", () => {
  const artifact = createHedgePlan({
    recommendation: recommendation(),
    paperOnly: false,
    createdAt: now,
    config
  });

  assert.equal(artifact.status, "blocked");
  assert.ok(artifact.blockers.includes("HEDGE_PAPER_ONLY_CONFIRMATION_REQUIRED"));
});

test("plan persistence writes reviewed hash back to recommendation", () => {
  const source = recommendation();
  persistHedgeRecommendation(source);
  const artifact = createHedgePlan({ recommendation: source, paperOnly: true, createdAt: now, config });
  persistHedgePlanRecord(artifact);
  attachReviewedPayloadHash(source.recommendationId, artifact.reviewedPayloadHash, now);

  const persistedRecommendation = latestHedgeRecommendation({
    asOf: now,
    freshnessMinutes: config.recommendationFreshnessMinutes,
    configurationFingerprint: fingerprint,
    riskModelVersion: config.riskModelVersion,
    regimeModelVersion: config.regimeModelVersion
  });
  assert.equal(persistedRecommendation?.reviewedPayloadHash, artifact.reviewedPayloadHash);
  assert.equal(latestHedgePlan()?.planId, artifact.planId);
});

test("future execution gate remains blocked when every future gate passes", () => {
  const result = evaluateHedgeExecutionGate({
    environment: "paper",
    paperOnlyIntent: true,
    executionEnabled: true,
    planValid: true,
    sourceSnapshotMatches: true,
    configurationMatches: true,
    reviewedPayloadHashMatches: true,
    duplicateDetected: false,
    instrumentSupported: true,
    runtimePreflightPassed: true
  });

  assert.equal(result.allowed, false);
  assert.ok(result.blockers.includes("HEDGE_EXECUTION_NOT_IMPLEMENTED"));
});

test("hedge gate source has no broker or order submission dependency", () => {
  const source = readFileSync(
    join(process.cwd(), "src/services/hedgeExecutionGateService.ts"),
    "utf8"
  );

  assert.doesNotMatch(source, /alpacaClient|submitPaperOrder|submitOrder|createOrder/);
});

test("hedge review orchestration persists one deterministic recommendation", async () => {
  const source = recommendation();
  const report = await buildAndPersistHedgeReview(
    { config, asOf: now, requestId: source.requestId },
    { buildRecommendation: async () => source }
  );

  assert.equal(report.status, "current");
  assert.equal(report.recommendation.recommendationId, source.recommendationId);
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM paper_learning_records WHERE id = ?")
      .get(source.recommendationId)?.count,
    1
  );
});

test("plan orchestration rejects missing paper-only intent before building a review", async () => {
  let reviewCalls = 0;
  const result = await buildAndPersistHedgePlan(
    { paperOnly: false, config, asOf: now },
    {
      buildReview: async () => {
        reviewCalls += 1;
        return {} as HedgeReviewReport;
      }
    }
  );

  assert.equal(reviewCalls, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.artifact, null);
  assert.ok(result.blockers.includes("HEDGE_PAPER_ONLY_CONFIRMATION_REQUIRED"));
});

test("plan orchestration persists the signed artifact and recommendation hash", async () => {
  const source = recommendation();
  const review = await buildAndPersistHedgeReview(
    { config, asOf: now },
    { buildRecommendation: async () => source }
  );
  const result = await buildAndPersistHedgePlan(
    { paperOnly: true, config, asOf: now },
    { buildReview: async () => review }
  );

  assert.equal(result.status, "planned");
  assert.ok(result.artifact);
  assert.equal(latestHedgePlan()?.planId, result.artifact?.planId);
  const persistedRecommendation = latestHedgeRecommendation({
    asOf: now,
    freshnessMinutes: config.recommendationFreshnessMinutes,
    configurationFingerprint: fingerprint,
    riskModelVersion: config.riskModelVersion,
    regimeModelVersion: config.regimeModelVersion
  });
  assert.equal(
    persistedRecommendation?.reviewedPayloadHash,
    result.artifact?.reviewedPayloadHash
  );
});
