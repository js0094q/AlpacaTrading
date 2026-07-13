import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { HedgeConfig } from "./hedgeConfigService.js";
import type { HedgeRecommendation } from "./hedgeRecommendationService.js";

export interface HedgePlanReviewedPayload {
  recommendationId: string;
  sourceSnapshotId: string;
  riskModelVersion: string;
  regimeModelVersion: string;
  planVersion: string;
  configurationFingerprint: string;
  dataQualityStatus: string;
  recommendationStatus: string;
  decision: string;
  sizing: object;
  candidates: HedgeRecommendation["candidates"];
  blockers: string[];
}

export interface HedgePlanArtifact {
  recordType: "hedge_plan";
  planId: string;
  createdAt: string;
  expiresAt: string;
  environment: "paper";
  paperOnly: boolean;
  sourceRecommendationId: string;
  sourceSnapshotId: string;
  riskModelVersion: string;
  regimeModelVersion: string;
  planVersion: string;
  configurationFingerprint: string;
  dataQualityStatus: string;
  recommendationStatus: string;
  reviewedPayload: HedgePlanReviewedPayload;
  reviewedPayloadHash: string;
  payloadSignature: string;
  signatureAlgorithm: "sha256-canonical-json";
  status: "planned" | "monitoring" | "blocked";
  warnings: string[];
  blockers: string[];
  requestId: string;
  correlationId: string | null;
}

export interface HedgePlanVerification {
  valid: boolean;
  blockers: string[];
  calculatedPayloadHash: string;
}

const unique = (values: string[]) => [...new Set(values)];

export const createHedgePlan = (input: {
  recommendation: HedgeRecommendation;
  paperOnly: boolean;
  createdAt?: string;
  config: HedgeConfig;
}): HedgePlanArtifact => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const blockers = unique([
    ...input.recommendation.blockers,
    ...(!input.paperOnly ? ["HEDGE_PAPER_ONLY_CONFIRMATION_REQUIRED"] : []),
    ...(input.recommendation.environment !== "paper"
      ? ["HEDGE_PAPER_ENVIRONMENT_REQUIRED"]
      : [])
  ]);
  const reviewedPayload: HedgePlanReviewedPayload = {
    recommendationId: input.recommendation.recommendationId,
    sourceSnapshotId: input.recommendation.sourceSnapshotId,
    riskModelVersion: input.recommendation.riskModelVersion,
    regimeModelVersion: input.recommendation.regimeModelVersion,
    planVersion: input.config.planVersion,
    configurationFingerprint: input.recommendation.configurationFingerprint,
    dataQualityStatus: input.recommendation.dataQualityStatus,
    recommendationStatus: input.recommendation.recommendationStatus,
    decision: input.recommendation.decision,
    sizing: input.recommendation.sizing,
    candidates: input.recommendation.candidates,
    blockers
  };
  const reviewedPayloadHash = canonicalJsonHash(reviewedPayload);
  const status = blockers.length || input.recommendation.recommendationStatus === "blocked"
    ? "blocked"
    : input.recommendation.recommendationStatus === "monitoring"
      ? "monitoring"
      : "planned";
  return {
    recordType: "hedge_plan",
    planId: `hedge_plan_${canonicalJsonHash({
      recommendationId: input.recommendation.recommendationId,
      createdAt,
      reviewedPayloadHash
    }).slice(0, 24)}`,
    createdAt,
    expiresAt: new Date(
      Date.parse(createdAt) + input.config.planTtlMinutes * 60_000
    ).toISOString(),
    environment: "paper",
    paperOnly: input.paperOnly,
    sourceRecommendationId: input.recommendation.recommendationId,
    sourceSnapshotId: input.recommendation.sourceSnapshotId,
    riskModelVersion: input.recommendation.riskModelVersion,
    regimeModelVersion: input.recommendation.regimeModelVersion,
    planVersion: input.config.planVersion,
    configurationFingerprint: input.recommendation.configurationFingerprint,
    dataQualityStatus: input.recommendation.dataQualityStatus,
    recommendationStatus: input.recommendation.recommendationStatus,
    reviewedPayload,
    reviewedPayloadHash,
    payloadSignature: reviewedPayloadHash,
    signatureAlgorithm: "sha256-canonical-json",
    status,
    warnings: unique([
      ...input.recommendation.warnings,
      "HEDGE_PLAN_NON_EXECUTABLE",
      "HEDGE_PLAN_REQUIRES_EXECUTION_REVIEW"
    ]),
    blockers,
    requestId: input.recommendation.requestId,
    correlationId: input.recommendation.correlationId
  };
};

export const verifyHedgePlan = (input: {
  artifact: HedgePlanArtifact;
  asOf?: string;
  sourceSnapshotId: string;
  configurationFingerprint: string;
}): HedgePlanVerification => {
  const asOf = input.asOf ?? new Date().toISOString();
  const blockers: string[] = [];
  const calculatedPayloadHash = canonicalJsonHash(input.artifact.reviewedPayload);
  if (input.artifact.environment !== "paper") blockers.push("HEDGE_PLAN_ENVIRONMENT_INVALID");
  if (!input.artifact.paperOnly) blockers.push("HEDGE_PAPER_ONLY_CONFIRMATION_REQUIRED");
  if (Date.parse(asOf) > Date.parse(input.artifact.expiresAt)) blockers.push("HEDGE_PLAN_EXPIRED");
  if (input.artifact.sourceSnapshotId !== input.sourceSnapshotId) {
    blockers.push("HEDGE_PLAN_SOURCE_SNAPSHOT_MISMATCH");
  }
  if (input.artifact.configurationFingerprint !== input.configurationFingerprint) {
    blockers.push("HEDGE_PLAN_CONFIGURATION_MISMATCH");
  }
  if (calculatedPayloadHash !== input.artifact.reviewedPayloadHash) {
    blockers.push("HEDGE_PLAN_PAYLOAD_HASH_MISMATCH");
  }
  if (input.artifact.payloadSignature !== input.artifact.reviewedPayloadHash) {
    blockers.push("HEDGE_PLAN_SIGNATURE_MISMATCH");
  }
  if (input.artifact.reviewedPayload.sourceSnapshotId !== input.artifact.sourceSnapshotId) {
    blockers.push("HEDGE_PLAN_REVIEWED_SOURCE_MISMATCH");
  }
  if (
    input.artifact.reviewedPayload.configurationFingerprint !==
    input.artifact.configurationFingerprint
  ) {
    blockers.push("HEDGE_PLAN_REVIEWED_CONFIGURATION_MISMATCH");
  }
  if (input.artifact.status === "blocked") blockers.push("HEDGE_PLAN_BLOCKED");
  return {
    valid: blockers.length === 0,
    blockers: unique(blockers),
    calculatedPayloadHash
  };
};
