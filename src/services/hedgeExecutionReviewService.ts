import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { HedgeCandidate } from "./hedgeTypes.js";

export interface HedgeExecutionOrderIntent {
  structure: "long_put";
  symbol: string;
  underlying: string;
  side: "buy_to_open" | "sell_to_close";
  orderType: "limit";
  timeInForce: "day";
  quantity: number;
  limitPrice: number;
  multiplier: number;
  maxPremium: number;
  maxNotional: number;
}

export interface HedgeExecutionReview {
  recordType: "hedge_execution_review";
  reviewType: "entry" | "exit";
  reviewId: string;
  createdAt: string;
  expiresAt: string;
  environment: "paper";
  paperOnly: true;
  liveTradingEnabled: false;
  accountHash: string;
  sourceRecommendationId: string;
  sourceSnapshotId: string;
  sourceRegimeId: string;
  riskModelVersion: string;
  regimeModelVersion: string;
  configurationFingerprint: string;
  orderIntent: HedgeExecutionOrderIntent;
  marketEvidence: Record<string, unknown>;
  portfolioEvidence: Record<string, unknown>;
  caps: Record<string, number>;
  warnings: string[];
  blockers: string[];
  candidateId: string;
  clientOrderId: string;
  payloadHash: string;
  signature: string;
  signatureAlgorithm: "hmac-sha256";
  requestId: string;
  correlationId: string | null;
}

export interface HedgeExecutionReviewInput {
  accountHash: string;
  sourceRecommendationId: string;
  sourceSnapshotId: string;
  sourceRegimeId: string;
  riskModelVersion: string;
  regimeModelVersion: string;
  configurationFingerprint: string;
  generatedAt: string;
  signingKey: string;
  candidate: HedgeCandidate;
  reviewType?: "entry" | "exit";
  orderSide?: "buy_to_open" | "sell_to_close";
  reviewTtlSeconds?: number;
  requestId?: string;
  correlationId?: string | null;
}

export interface HedgeExecutionReviewVerification {
  valid: boolean;
  blockers: string[];
  calculatedPayloadHash: string;
}

const unique = (values: string[]) => [...new Set(values)];

const numberDetail = (candidate: HedgeCandidate, key: string, fallback: number | null = null) => {
  const value = candidate.details?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const unsignedPayload = (review: HedgeExecutionReview) => {
  const {
    reviewId: _reviewId,
    clientOrderId: _clientOrderId,
    payloadHash: _payloadHash,
    signature: _signature,
    ...payload
  } = review;
  return payload;
};

const signPayload = (payloadHash: string, signingKey: string) =>
  createHmac("sha256", signingKey).update(payloadHash).digest("hex");

const signaturesEqual = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const createHedgeExecutionReview = (
  input: HedgeExecutionReviewInput
): HedgeExecutionReview => {
  if (!input.signingKey.trim()) {
    throw new Error("HEDGE_REVIEW_SIGNING_KEY_REQUIRED");
  }
  if (
    input.candidate.instrumentType !== "protective_put" ||
    input.candidate.executable !== true ||
    input.candidate.blockers.length > 0 ||
    !input.candidate.units ||
    input.candidate.units <= 0
  ) {
    throw new Error("HEDGE_NO_EXECUTABLE_LONG_PUT");
  }

  const details = input.candidate.details ?? {};
  const quantity = Math.max(1, Math.floor(input.candidate.units));
  const multiplier = Math.max(1, Math.floor(numberDetail(input.candidate, "multiplier", 100) ?? 100));
  const limitPrice = numberDetail(input.candidate, "midpoint");
  const estimatedCost = input.candidate.estimatedCost;
  if (limitPrice === null || limitPrice <= 0 || estimatedCost === null || estimatedCost <= 0) {
    throw new Error("HEDGE_REVIEW_PRICE_REQUIRED");
  }
  const createdAt = input.generatedAt;
  const reviewType = input.reviewType ?? "entry";
  const orderSide = input.orderSide ?? (reviewType === "exit" ? "sell_to_close" : "buy_to_open");
  const ttlSeconds = Math.max(1, Math.floor(input.reviewTtlSeconds ?? 300));
  const expiresAt = new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString();
  const maxPremium = Math.round(estimatedCost * 100) / 100;
  const orderIntent: HedgeExecutionOrderIntent = {
    structure: "long_put",
    symbol: input.candidate.symbol,
    underlying: input.candidate.underlying,
    side: orderSide,
    orderType: "limit",
    timeInForce: "day",
    quantity,
    limitPrice,
    multiplier,
    maxPremium,
    maxNotional: maxPremium
  };
  const reviewBase = {
    recordType: "hedge_execution_review" as const,
    reviewType,
    createdAt,
    expiresAt,
    environment: "paper" as const,
    paperOnly: true as const,
    liveTradingEnabled: false as const,
    accountHash: input.accountHash,
    sourceRecommendationId: input.sourceRecommendationId,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceRegimeId: input.sourceRegimeId,
    riskModelVersion: input.riskModelVersion,
    regimeModelVersion: input.regimeModelVersion,
    configurationFingerprint: input.configurationFingerprint,
    orderIntent,
    marketEvidence: {
      ...details,
      candidateRank: input.candidate.rank,
      expectedProtection: input.candidate.expectedProtection,
      estimatedCost: input.candidate.estimatedCost
    },
    portfolioEvidence: {
      contractDeltaCoveragePct: details.contractDeltaCoveragePct ?? null,
      marketValueDeltaCoveragePct: details.marketValueDeltaCoveragePct ?? null,
      portfolioBeta: details.portfolioBeta ?? null,
      grossExposure: details.grossExposure ?? null,
      netExposure: details.netExposure ?? null
    },
    caps: {
      maxQuantity: quantity,
      maxPremium,
      maxNotional: maxPremium
    },
    warnings: unique(input.candidate.warnings),
    blockers: unique(input.candidate.blockers),
    candidateId: input.candidate.candidateId,
    signatureAlgorithm: "hmac-sha256" as const,
    requestId: input.requestId ?? `hedge_review_${canonicalJsonHash({ input: input.sourceRecommendationId, createdAt }).slice(0, 20)}`,
    correlationId: input.correlationId ?? null
  };
  const payloadHash = canonicalJsonHash(reviewBase);
  const clientOrderId = `hedge-${reviewType}-${payloadHash.slice(0, 24)}`;
  const review = {
    ...reviewBase,
    clientOrderId,
    payloadHash,
    signature: signPayload(payloadHash, input.signingKey),
    signatureAlgorithm: "hmac-sha256" as const
  } satisfies Omit<HedgeExecutionReview, "reviewId">;
  return {
    ...review,
    reviewId: `hedge_review_${canonicalJsonHash({ payloadHash, clientOrderId }).slice(0, 24)}`
  };
};

export const verifyHedgeExecutionReview = (input: {
  review: HedgeExecutionReview;
  signingKey: string;
  asOf?: string;
  accountHash?: string;
  configurationFingerprint?: string;
  sourceSnapshotId?: string;
}): HedgeExecutionReviewVerification => {
  const blockers: string[] = [];
  const calculatedPayloadHash = canonicalJsonHash(unsignedPayload(input.review));
  if (input.review.recordType !== "hedge_execution_review") blockers.push("HEDGE_REVIEW_SCHEMA_INVALID");
  if (!["entry", "exit"].includes(input.review.reviewType)) blockers.push("HEDGE_REVIEW_TYPE_INVALID");
  if (input.review.environment !== "paper" || input.review.paperOnly !== true) blockers.push("HEDGE_ENVIRONMENT_NOT_PAPER");
  if (input.review.liveTradingEnabled !== false) blockers.push("HEDGE_LIVE_TRADING_ENABLED");
  if (calculatedPayloadHash !== input.review.payloadHash) blockers.push("HEDGE_PAYLOAD_CHANGED");
  if (!input.signingKey.trim() || !signaturesEqual(input.review.signature, signPayload(input.review.payloadHash, input.signingKey))) {
    blockers.push("HEDGE_REVIEW_SIGNATURE_INVALID");
  }
  const asOf = input.asOf ?? new Date().toISOString();
  if (Date.parse(asOf) > Date.parse(input.review.expiresAt)) blockers.push("HEDGE_REVIEW_EXPIRED");
  if (input.accountHash !== undefined && input.accountHash !== input.review.accountHash) blockers.push("HEDGE_ACCOUNT_IDENTITY_MISMATCH");
  if (input.configurationFingerprint !== undefined && input.configurationFingerprint !== input.review.configurationFingerprint) blockers.push("HEDGE_CONFIGURATION_MISMATCH");
  if (input.sourceSnapshotId !== undefined && input.sourceSnapshotId !== input.review.sourceSnapshotId) blockers.push("HEDGE_SOURCE_SNAPSHOT_MISMATCH");
  const expectedSide = input.review.reviewType === "exit" ? "sell_to_close" : "buy_to_open";
  if (input.review.orderIntent.structure !== "long_put" || input.review.orderIntent.side !== expectedSide) blockers.push("MULTI_LEG_EXECUTION_UNSUPPORTED");
  if (input.review.orderIntent.quantity < 1 || input.review.orderIntent.quantity > input.review.caps.maxQuantity) blockers.push("HEDGE_QUANTITY_CAP_EXCEEDED");
  if (input.review.orderIntent.maxPremium > input.review.caps.maxPremium) blockers.push("HEDGE_PREMIUM_CAP_EXCEEDED");
  return { valid: blockers.length === 0, blockers: unique(blockers), calculatedPayloadHash };
};

export const hedgeExecutionReviewPayload = unsignedPayload;
