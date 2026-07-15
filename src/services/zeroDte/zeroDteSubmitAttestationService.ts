import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { paperReviewArtifactSigningKey } from "../paperReviewArtifactService.js";

export interface ZeroDteSubmitOrderIntent extends Record<string, unknown> {
  symbol: string;
  underlying: string;
  direction: string;
  side: string;
  positionIntent: string;
  quantity: number;
  limitPrice: number;
  estimatedPremium: number;
  quoteTimestamp: string;
  quoteFingerprint: string;
  clientOrderId: string;
}

export interface ZeroDteSubmitAttestation {
  recordType: "zero_dte_submit_attestation";
  version: "zero-dte-submit-attestation-v1";
  attestationId: string;
  environment: "paper";
  paperOnly: true;
  liveTradingEnabled: false;
  decisionId: string;
  candidateId: string;
  tradingDate: string;
  strategyVersion: string;
  configurationVersionId: string;
  accountIdentityHash: string;
  accountStateFingerprint: string;
  activityEvidenceFingerprint: string;
  allocationIdentity: "baseline-v1";
  submitPriceDriftLimitPct: number;
  orderIntent: ZeroDteSubmitOrderIntent;
  createdAt: string;
  expiresAt: string;
  payloadHash: string;
  signature: string;
  signatureAlgorithm: "hmac-sha256";
}

export interface ZeroDteSubmitAttestationExpected {
  decisionId: string;
  candidateId: string;
  tradingDate: string;
  strategyVersion: string;
  configurationVersionId: string;
  accountIdentityHash: string;
  accountStateFingerprint: string;
  activityEvidenceFingerprint: string;
  allocationIdentity: "baseline-v1";
  submitPriceDriftLimitPct: number;
  orderIntent: ZeroDteSubmitOrderIntent;
}

export interface ZeroDteSubmitAttestationVerification {
  valid: boolean;
  blockers: string[];
  calculatedPayloadHash: string;
}

export interface CreateZeroDteSubmitAttestationInput
  extends ZeroDteSubmitAttestationExpected {
  createdAt: string;
  ttlSeconds?: number;
  signingKey?: string;
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

const required = (value: string, code: string) => {
  if (!value.trim()) throw new Error(code);
  return value.trim();
};

const signingKeyFor = (value?: string) => value?.trim() || paperReviewArtifactSigningKey();

const signPayloadHash = (payloadHash: string, signingKey: string) =>
  createHmac("sha256", signingKey).update(payloadHash).digest("hex");

const signaturesEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const unsignedAttestation = (attestation: ZeroDteSubmitAttestation) => {
  const {
    attestationId: _attestationId,
    payloadHash: _payloadHash,
    signature: _signature,
    ...unsigned
  } = attestation;
  return unsigned;
};

const exactIntent = (value: ZeroDteSubmitOrderIntent) => ({ ...value });

export const createZeroDteSubmitAttestation = (
  input: CreateZeroDteSubmitAttestationInput
): ZeroDteSubmitAttestation => {
  const signingKey = signingKeyFor(input.signingKey);
  if (!signingKey) throw new Error("PAPER_REVIEW_SIGNING_KEY_REQUIRED");
  const createdAtMs = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAtMs)) throw new Error("ZERO_DTE_ATTESTATION_TIMESTAMP_INVALID");
  const ttlSeconds = Math.floor(input.ttlSeconds ?? 300);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("ZERO_DTE_ATTESTATION_TTL_INVALID");
  }
  const base = {
    recordType: "zero_dte_submit_attestation" as const,
    version: "zero-dte-submit-attestation-v1" as const,
    environment: "paper" as const,
    paperOnly: true as const,
    liveTradingEnabled: false as const,
    decisionId: required(input.decisionId, "ZERO_DTE_DECISION_ID_REQUIRED"),
    candidateId: required(input.candidateId, "ZERO_DTE_CANDIDATE_ID_REQUIRED"),
    tradingDate: required(input.tradingDate, "ZERO_DTE_TRADING_DATE_REQUIRED"),
    strategyVersion: required(input.strategyVersion, "ZERO_DTE_STRATEGY_VERSION_REQUIRED"),
    configurationVersionId: required(
      input.configurationVersionId,
      "ZERO_DTE_CONFIGURATION_VERSION_REQUIRED"
    ),
    accountIdentityHash: required(
      input.accountIdentityHash,
      "ZERO_DTE_ACCOUNT_IDENTITY_REQUIRED"
    ),
    accountStateFingerprint: required(
      input.accountStateFingerprint,
      "ZERO_DTE_ACCOUNT_STATE_REQUIRED"
    ),
    activityEvidenceFingerprint: required(
      input.activityEvidenceFingerprint,
      "ZERO_DTE_ACTIVITY_EVIDENCE_REQUIRED"
    ),
    allocationIdentity: input.allocationIdentity,
    submitPriceDriftLimitPct: input.submitPriceDriftLimitPct,
    orderIntent: exactIntent(input.orderIntent),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + ttlSeconds * 1000).toISOString(),
    signatureAlgorithm: "hmac-sha256" as const
  };
  if (base.allocationIdentity !== "baseline-v1") {
    throw new Error("ZERO_DTE_ALLOCATION_IDENTITY_INVALID");
  }
  const payloadHash = canonicalJsonHash(base);
  return {
    ...base,
    attestationId: `zero_dte_attest_${payloadHash.slice(0, 24)}`,
    payloadHash,
    signature: signPayloadHash(payloadHash, signingKey)
  };
};

export const verifyZeroDteSubmitAttestation = (input: {
  attestation: ZeroDteSubmitAttestation;
  signingKey?: string;
  asOf?: string;
  expected: ZeroDteSubmitAttestationExpected;
}): ZeroDteSubmitAttestationVerification => {
  const blockers: string[] = [];
  const attestation = input.attestation;
  const signingKey = signingKeyFor(input.signingKey);
  const calculatedPayloadHash = canonicalJsonHash(unsignedAttestation(attestation));
  const expectedAttestationId = `zero_dte_attest_${calculatedPayloadHash.slice(0, 24)}`;
  if (
    attestation.recordType !== "zero_dte_submit_attestation" ||
    attestation.version !== "zero-dte-submit-attestation-v1" ||
    attestation.environment !== "paper" ||
    attestation.paperOnly !== true ||
    attestation.liveTradingEnabled !== false ||
    attestation.signatureAlgorithm !== "hmac-sha256" ||
    attestation.allocationIdentity !== "baseline-v1" ||
    !signingKey ||
    attestation.payloadHash !== calculatedPayloadHash ||
    attestation.attestationId !== expectedAttestationId ||
    !attestation.signature ||
    (signingKey && !signaturesEqual(
      attestation.signature,
      signPayloadHash(attestation.payloadHash, signingKey)
    ))
  ) {
    blockers.push("ZERO_DTE_SUBMIT_ATTESTATION_INVALID");
  }

  const asOfMs = Date.parse(input.asOf ?? new Date().toISOString());
  const createdAtMs = Date.parse(attestation.createdAt);
  const expiresAtMs = Date.parse(attestation.expiresAt);
  if (
    !Number.isFinite(asOfMs) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs < createdAtMs
  ) {
    blockers.push("ZERO_DTE_SUBMIT_ATTESTATION_INVALID");
  } else if (asOfMs > expiresAtMs) {
    blockers.push("ZERO_DTE_SUBMIT_ATTESTATION_EXPIRED", "FRESH_REVIEW_REQUIRED");
  }

  const expected = input.expected;
  if (attestation.decisionId !== expected.decisionId) {
    blockers.push("ZERO_DTE_DECISION_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.candidateId !== expected.candidateId) {
    blockers.push("ZERO_DTE_CANDIDATE_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.tradingDate !== expected.tradingDate) {
    blockers.push("ZERO_DTE_TRADING_DATE_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.strategyVersion !== expected.strategyVersion) {
    blockers.push("ZERO_DTE_STRATEGY_VERSION_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.configurationVersionId !== expected.configurationVersionId) {
    blockers.push("ZERO_DTE_CONFIGURATION_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.accountIdentityHash !== expected.accountIdentityHash) {
    blockers.push("ZERO_DTE_ACCOUNT_IDENTITY_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.accountStateFingerprint !== expected.accountStateFingerprint) {
    blockers.push("ZERO_DTE_ACCOUNT_STATE_DRIFT", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.activityEvidenceFingerprint !== expected.activityEvidenceFingerprint) {
    blockers.push("ZERO_DTE_ACTIVITY_EVIDENCE_DRIFT", "FRESH_REVIEW_REQUIRED");
  }
  if (attestation.allocationIdentity !== expected.allocationIdentity) {
    blockers.push("ZERO_DTE_ALLOCATION_IDENTITY_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (
    attestation.submitPriceDriftLimitPct !==
    expected.submitPriceDriftLimitPct
  ) {
    blockers.push("ZERO_DTE_CONFIGURATION_MISMATCH", "FRESH_REVIEW_REQUIRED");
  }
  if (canonicalJsonHash(attestation.orderIntent) !== canonicalJsonHash(expected.orderIntent)) {
    blockers.push("ZERO_DTE_ORDER_INTENT_DRIFT", "FRESH_REVIEW_REQUIRED");
  }

  const resolvedBlockers = unique(blockers);
  return {
    valid: resolvedBlockers.length === 0,
    blockers: resolvedBlockers,
    calculatedPayloadHash
  };
};
