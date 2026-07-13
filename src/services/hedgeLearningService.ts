import {
  buildHedgeConfig,
  type HedgeConfig
} from "./hedgeConfigService.js";
import {
  buildHedgeRecommendation,
  type HedgeRecommendation
} from "./hedgeRecommendationService.js";
import {
  attachReviewedPayloadHash,
  persistHedgePlanRecord,
  persistHedgeRecommendation,
  persistHedgeExecutionReview
} from "./hedgePersistenceService.js";
import { createHedgeExecutionReview } from "./hedgeExecutionReviewService.js";
import { canonicalJsonHash } from "../lib/canonicalJson.js";
import {
  createHedgePlan,
  verifyHedgePlan,
  type HedgePlanArtifact,
  type HedgePlanVerification
} from "./hedgePlanService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export interface HedgeReviewReport {
  paperOnly: true;
  environment: "paper";
  generatedAt: string;
  status: "current" | "monitoring" | "blocked";
  recommendation: HedgeRecommendation;
  risk: HedgeRecommendation["risk"];
  regime: HedgeRecommendation["regime"];
  score: HedgeRecommendation["score"];
  warnings: string[];
  blockers: string[];
  executionReviewId: string | null;
}

export interface HedgePlanReport {
  paperOnly: true;
  environment: "paper";
  generatedAt: string;
  status: "planned" | "monitoring" | "blocked";
  artifact: HedgePlanArtifact | null;
  verification: HedgePlanVerification | null;
  recommendation: HedgeRecommendation | null;
  warnings: string[];
  blockers: string[];
}

export interface HedgeLearningDeps {
  buildRecommendation?: typeof buildHedgeRecommendation;
  buildReview?: typeof buildAndPersistHedgeReview;
}

export const buildAndPersistHedgeReview = async (
  input: {
    config?: HedgeConfig;
    asOf?: string;
    requestId?: string;
    correlationId?: string | null;
    triggerSource?: string;
  } = {},
  deps: Pick<HedgeLearningDeps, "buildRecommendation"> = {}
): Promise<HedgeReviewReport> => {
  const config = input.config ?? buildHedgeConfig();
  const generatedAt = input.asOf ?? new Date().toISOString();
  const recommendation = await (deps.buildRecommendation ?? buildHedgeRecommendation)({
    config,
    asOf: generatedAt,
    requestId: input.requestId,
    correlationId: input.correlationId
  });
  persistHedgeRecommendation(recommendation);
  const executableCandidate = recommendation.candidates.find(
    (candidate) =>
      candidate.instrumentType === "protective_put" &&
      candidate.executable === true &&
      candidate.blockers.length === 0
  );
  const signingKey = process.env.HEDGE_REVIEW_SIGNING_KEY?.trim() ?? "";
  const executionReview = executableCandidate && signingKey && recommendation.risk.accountIdentityHash
    ? createHedgeExecutionReview({
        accountHash: recommendation.risk.accountIdentityHash,
        sourceRecommendationId: recommendation.recommendationId,
        sourceSnapshotId: recommendation.sourceSnapshotId,
        sourceRegimeId: `hedge_regime_${canonicalJsonHash({
          generatedAt: recommendation.generatedAt,
          modelVersion: recommendation.regimeModelVersion,
          regime: recommendation.regime
        }).slice(0, 24)}`,
        riskModelVersion: recommendation.riskModelVersion,
        regimeModelVersion: recommendation.regimeModelVersion,
        configurationFingerprint: recommendation.configurationFingerprint,
        generatedAt,
        signingKey,
        candidate: executableCandidate,
        reviewType: "entry",
        orderSide: "buy_to_open",
        requestId: `hedge_execution_review_${recommendation.recommendationId}`,
        correlationId: input.correlationId
      })
    : null;
  if (executionReview) {
    persistHedgeExecutionReview(executionReview);
  }
  return {
    paperOnly: true,
    environment: "paper",
    generatedAt,
    status: recommendation.recommendationStatus,
    recommendation,
    risk: recommendation.risk,
    regime: recommendation.regime,
    score: recommendation.score,
    warnings: recommendation.warnings,
    blockers: recommendation.blockers,
    executionReviewId: executionReview?.reviewId ?? null
  };
};

const blockedPlan = (
  generatedAt: string,
  blockers: string[],
  warnings: string[] = [],
  recommendation: HedgeRecommendation | null = null
): HedgePlanReport => ({
  paperOnly: true,
  environment: "paper",
  generatedAt,
  status: "blocked",
  artifact: null,
  verification: null,
  recommendation,
  warnings,
  blockers: [...new Set(blockers)]
});

export const buildAndPersistHedgePlan = async (
  input: {
    paperOnly: boolean;
    config?: HedgeConfig;
    asOf?: string;
    requestId?: string;
    correlationId?: string | null;
    triggerSource?: string;
  },
  deps: Pick<HedgeLearningDeps, "buildReview"> = {}
): Promise<HedgePlanReport> => {
  const generatedAt = input.asOf ?? new Date().toISOString();
  const config = input.config ?? buildHedgeConfig();
  if (!input.paperOnly) {
    return blockedPlan(generatedAt, ["HEDGE_PAPER_ONLY_CONFIRMATION_REQUIRED"]);
  }
  const safety = getTradingSafetyState();
  if (safety.alpacaEnv !== "paper" || safety.liveTradingEnabled) {
    return blockedPlan(generatedAt, ["HEDGE_PAPER_ENVIRONMENT_REQUIRED"]);
  }

  const review = await (deps.buildReview ?? buildAndPersistHedgeReview)({
    config,
    asOf: generatedAt,
    requestId: input.requestId,
    correlationId: input.correlationId,
    triggerSource: input.triggerSource
  });
  if (review.status === "blocked") {
    return blockedPlan(
      generatedAt,
      review.blockers.length ? review.blockers : ["HEDGE_RECOMMENDATION_BLOCKED"],
      review.warnings,
      review.recommendation
    );
  }
  const artifact = createHedgePlan({
    recommendation: review.recommendation,
    paperOnly: true,
    createdAt: generatedAt,
    config
  });
  const verification = verifyHedgePlan({
    artifact,
    asOf: generatedAt,
    sourceSnapshotId: review.recommendation.sourceSnapshotId,
    configurationFingerprint: review.recommendation.configurationFingerprint
  });
  if (!verification.valid) {
    return blockedPlan(
      generatedAt,
      verification.blockers,
      artifact.warnings,
      review.recommendation
    );
  }
  persistHedgePlanRecord(artifact);
  attachReviewedPayloadHash(
    review.recommendation.recommendationId,
    artifact.reviewedPayloadHash,
    generatedAt
  );
  return {
    paperOnly: true,
    environment: "paper",
    generatedAt,
    status: artifact.status === "monitoring" ? "monitoring" : "planned",
    artifact,
    verification,
    recommendation: review.recommendation,
    warnings: artifact.warnings,
    blockers: artifact.blockers
  };
};
