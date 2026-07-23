import type { Pool, PoolClient } from "pg";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { DatabaseConfig } from "../lib/database/config.js";
import { withPostgresTransaction } from "../lib/database/postgresTransaction.js";
import type {
  BrokerReconciliationTarget,
  BrokerResultInput,
  ExecutionAccountProjection,
  ExecutionEvidenceInput,
  ExecutionReservationIntentInput,
  ExecutionStateRepository
} from "../repositories/contracts/executionStateRepository.js";
import type { JsonValue } from "../repositories/contracts/common.js";
import { PostgresExecutionStateRepository } from "../repositories/postgres/postgresExecutionStateRepository.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import {
  AlpacaApiError,
  getPaperOrder,
  getPaperOrderByClientOrderId,
  type AlpacaApiResponse,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import { canonicalizePostgresNumeric } from "../lib/database/postgresNumeric.js";
import {
  currentControlPlaneRuntimeContext,
  type ControlPlaneRuntimeContext
} from "./controlPlaneRuntimeContext.js";
import type {
  PaperSubmitReservationState,
  PaperSubmitStateAttestation
} from "./paperSubmitStateService.js";
import { parseOptionSymbol } from "./optionSymbolService.js";
import type { PaperExecutionLedgerEntry } from "./paperExecutionLedgerService.js";
import type { PaperReviewArtifact } from "./paperReviewArtifactService.js";
import type { HedgeExecutionReview } from "./hedgeExecutionReviewService.js";
import type { ZeroDteSubmitAttestation } from "./zeroDte/zeroDteSubmitAttestationService.js";
import {
  buildZeroDteActivityEvidence,
  type ZeroDteActivityEvidence,
  type ZeroDteActivityEvidenceInput
} from "./zeroDte/zeroDteActivityEvidenceService.js";

export class ExecutionStateProjectionError extends Error {
  readonly code: string;

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "ExecutionStateProjectionError";
    this.code = code;
  }
}

const money = (value: number | string | null) =>
  canonicalizePostgresNumeric(value, 28, 8);

const quantity = (value: number | string | null) =>
  canonicalizePostgresNumeric(value, 28, 12);

const ratioFromPercent = (value: number) =>
  canonicalizePostgresNumeric(String(value / 100), 12, 10);

const fixedDecimalUnits = (value: string) => BigInt(value.replace(".", ""));

const jsonRecord = (value: string | null): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const numeric = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizedTimestamp = (value: unknown, fallback: string) => {
  const candidate = text(value);
  if (!candidate) return fallback;
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    throw new ExecutionStateProjectionError("BROKER_ORDER_TIMESTAMP_INVALID");
  }
  return new Date(parsed).toISOString();
};

const jsonValue = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const ledgerAssetClass = (value: string) => {
  if (value === "option") return "option" as const;
  if (value === "equity") return "equity" as const;
  throw new ExecutionStateProjectionError("EXECUTION_ASSET_CLASS_INVALID");
};

const ledgerSide = (value: string | null) => {
  if (value === "buy" || value === "sell" || value === "buy_to_open" || value === "sell_to_close") {
    return value;
  }
  throw new ExecutionStateProjectionError("EXECUTION_SIDE_INVALID");
};

const ledgerOrderType = (value: string | null) => {
  if (value === "market" || value === "limit" || value === "stop" || value === "stop_limit") {
    return value;
  }
  throw new ExecutionStateProjectionError("EXECUTION_ORDER_TYPE_INVALID");
};

const ledgerTimeInForce = (value: string | null) => {
  if (value === "day" || value === "gtc" || value === "opg" || value === "cls" || value === "ioc" || value === "fok") {
    return value;
  }
  throw new ExecutionStateProjectionError("EXECUTION_TIME_IN_FORCE_INVALID");
};

const ledgerIdentity = (ledger: PaperExecutionLedgerEntry, accountId: string) =>
  canonicalJsonHash({ accountId, clientOrderId: ledger.clientOrderId });

const evidenceIdentity = (
  ledger: PaperExecutionLedgerEntry,
  accountId: string,
  reviewType: "entry" | "exit"
) => {
  if (!ledger.sourcePlanId) {
    return { executionReviewId: null, confirmationEvidenceId: null };
  }
  const executionReviewId = `review_${canonicalJsonHash({
    accountId,
    sourcePlanId: ledger.sourcePlanId,
    clientOrderId: ledger.clientOrderId,
    reviewType
  })}`;
  return {
    executionReviewId,
    confirmationEvidenceId: `confirmation_${canonicalJsonHash({ executionReviewId })}`
  };
};

const buildExecutionEvidence = (input: {
  ledger: PaperExecutionLedgerEntry;
  accountId: string;
  reviewType: "entry" | "exit";
  accountFingerprint: string;
  sourceRecommendationId: string;
  sourceSnapshotId: string | null;
  configurationFingerprint: string;
  payloadFingerprint: string;
  signatureAlgorithm: string;
  signature: string;
  orderIntent: unknown;
  marketEvidence: unknown;
  portfolioEvidence: unknown;
  warnings: readonly string[];
  blockers: readonly string[];
  requestId: string | null;
  correlationId: string | null;
  createdAt: string;
  expiresAt: string;
  confirmationMethod: string;
  confirmationEvidence: unknown;
}): ExecutionEvidenceInput => {
  const ids = evidenceIdentity(input.ledger, input.accountId, input.reviewType);
  if (!ids.executionReviewId || !ids.confirmationEvidenceId) {
    throw new ExecutionStateProjectionError("EXECUTION_REVIEW_SOURCE_REQUIRED");
  }
  const lifecycleFingerprint = canonicalJsonHash({
    executionReviewId: ids.executionReviewId,
    payloadFingerprint: input.payloadFingerprint,
    confirmationMethod: input.confirmationMethod
  });
  return {
    accountId: input.accountId,
    candidateId: input.ledger.sourceCandidateId,
    review: {
      id: ids.executionReviewId,
      reviewType: input.reviewType,
      status: "valid",
      clientOrderId: input.ledger.clientOrderId,
      accountFingerprint: input.accountFingerprint,
      sourceRecommendationId: input.sourceRecommendationId,
      sourceSnapshotId: input.sourceSnapshotId,
      configurationFingerprint: input.configurationFingerprint,
      payloadFingerprint: input.payloadFingerprint,
      signatureAlgorithm: input.signatureAlgorithm,
      signature: input.signature,
      orderIntent: jsonValue(input.orderIntent),
      marketEvidence: jsonValue(input.marketEvidence),
      portfolioEvidence: jsonValue(input.portfolioEvidence),
      warnings: jsonValue([...input.warnings]),
      blockers: jsonValue([...input.blockers]),
      requestId: input.requestId,
      correlationId: input.correlationId,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt
    },
    confirmation: {
      id: ids.confirmationEvidenceId,
      evidenceType: "paper_execution_confirmation",
      confirmationMethod: input.confirmationMethod,
      status: "valid",
      payloadFingerprint: canonicalJsonHash({
        reviewId: ids.executionReviewId,
        clientOrderId: input.ledger.clientOrderId,
        evidence: input.confirmationEvidence
      }),
      signatureAlgorithm: input.signatureAlgorithm,
      signature: input.signature,
      evidence: jsonValue(input.confirmationEvidence),
      confirmedAt: input.ledger.createdAt,
      expiresAt: input.expiresAt
    },
    lifecycleFingerprint: {
      id: `fingerprint_${lifecycleFingerprint}`,
      entityType: "execution_review",
      entityId: ids.executionReviewId,
      lifecycleStage: "confirmed",
      fingerprint: lifecycleFingerprint,
      payloadVersion: 1,
      evidence: { confirmationMethod: input.confirmationMethod },
      requestId: input.requestId,
      correlationId: input.correlationId,
      capturedAt: input.ledger.createdAt
    }
  };
};

export const mapPaperReviewArtifactToExecutionEvidence = (
  artifact: PaperReviewArtifact,
  ledger: PaperExecutionLedgerEntry,
  accountId: string
) => {
  const body = artifact.artifact;
  const submitState = body.submitState;
  const raw = jsonRecord(ledger.rawPayloadJson);
  const intent = text(raw.position_intent ?? raw.positionIntent);
  const reviewType = intent === "sell_to_close" || ledger.side === "sell"
    ? "exit" as const
    : "entry" as const;
  return buildExecutionEvidence({
    ledger,
    accountId,
    reviewType,
    accountFingerprint: submitState?.accountIdentityHash ?? accountId,
    sourceRecommendationId: artifact.id,
    sourceSnapshotId: submitState?.portfolioFingerprint ?? null,
    configurationFingerprint:
      submitState?.configurationFingerprint ?? body.artifactHash,
    payloadFingerprint: canonicalJsonHash({
      artifactHash: body.artifactHash,
      clientOrderId: ledger.clientOrderId
    }),
    signatureAlgorithm: body.signatureAlgorithm,
    signature: body.signature,
    orderIntent: raw,
    marketEvidence: {
      fingerprint: submitState?.marketEvidenceFingerprint ?? null
    },
    portfolioEvidence: {
      fingerprint: submitState?.portfolioFingerprint ?? null,
      structuralFingerprint: submitState?.structuralPortfolioFingerprint ?? null
    },
    warnings: body.warnings,
    blockers: body.blockers,
    requestId: ledger.requestId,
    correlationId: null,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    confirmationMethod: "reviewed_confirm_paper",
    confirmationEvidence: {
      artifactId: artifact.id,
      payloadSignature: artifact.payloadSignature,
      confirmPaper: true
    }
  });
};

export const mapHedgeReviewToExecutionEvidence = (
  review: HedgeExecutionReview,
  ledger: PaperExecutionLedgerEntry,
  accountId: string
) => buildExecutionEvidence({
  ledger,
  accountId,
  reviewType: review.reviewType,
  accountFingerprint: review.accountHash,
  sourceRecommendationId: review.sourceRecommendationId,
  sourceSnapshotId: review.sourceSnapshotId,
  configurationFingerprint: review.configurationFingerprint,
  payloadFingerprint: review.payloadHash,
  signatureAlgorithm: review.signatureAlgorithm,
  signature: review.signature,
  orderIntent: review.orderIntent,
  marketEvidence: review.marketEvidence,
  portfolioEvidence: review.portfolioEvidence,
  warnings: review.warnings,
  blockers: review.blockers,
  requestId: review.requestId,
  correlationId: review.correlationId,
  createdAt: review.createdAt,
  expiresAt: review.expiresAt,
  confirmationMethod: "reviewed_confirm_paper",
  confirmationEvidence: {
    reviewId: review.reviewId,
    clientOrderId: review.clientOrderId,
    confirmPaper: true
  }
});

export const mapZeroDteAttestationToExecutionEvidence = (
  attestation: ZeroDteSubmitAttestation,
  ledger: PaperExecutionLedgerEntry,
  accountId: string
) => buildExecutionEvidence({
  ledger,
  accountId,
  reviewType: "entry",
  accountFingerprint: attestation.accountIdentityHash,
  sourceRecommendationId: attestation.attestationId,
  sourceSnapshotId: attestation.accountStateFingerprint,
  configurationFingerprint: attestation.configurationVersionId,
  payloadFingerprint: attestation.payloadHash,
  signatureAlgorithm: attestation.signatureAlgorithm,
  signature: attestation.signature,
  orderIntent: attestation.orderIntent,
  marketEvidence: {
    marketTimestamp: attestation.orderIntent.quoteTimestamp,
    activityEvidenceFingerprint: attestation.activityEvidenceFingerprint
  },
  portfolioEvidence: {
    accountStateFingerprint: attestation.accountStateFingerprint,
    allocationIdentity: attestation.allocationIdentity
  },
  warnings: [],
  blockers: [],
  requestId: ledger.requestId,
  correlationId: null,
  createdAt: attestation.createdAt,
  expiresAt: attestation.expiresAt,
  confirmationMethod: "signed_zero_dte_attestation",
  confirmationEvidence: {
    attestationId: attestation.attestationId,
    decisionId: attestation.decisionId,
    confirmPaper: true
  }
});

export const mapPaperExecutionLedgerToReservationIntent = (
  ledger: PaperExecutionLedgerEntry,
  account: {
    readonly accountId: string;
    readonly accountSnapshotId: string;
    readonly strategyKey: string;
  }
): ExecutionReservationIntentInput => {
  const payload = jsonRecord(ledger.payloadJson);
  const rawPayload = jsonRecord(ledger.rawPayloadJson);
  const positionIntent = text(
    rawPayload.position_intent ?? rawPayload.positionIntent ??
    payload.position_intent ?? payload.positionIntent
  );
  const side = positionIntent === "buy_to_open" || positionIntent === "sell_to_close"
    ? positionIntent
    : ledgerSide(ledger.side);
  const reservationRequired = side === "buy" || side === "buy_to_open";
  const reviewType = side === "sell" || side === "sell_to_close" ? "exit" : "entry";
  const evidence = evidenceIdentity(ledger, account.accountId, reviewType);
  const rawAmount = ledger.maxRisk ?? ledger.estimatedPremium ?? numeric(ledger.notional) ??
    ((numeric(ledger.qty) ?? 0) * (numeric(ledger.limitPrice) ?? 0));
  const amount = money(rawAmount ?? 0)!;
  if (reservationRequired && Number(amount) <= 0) {
    throw new ExecutionStateProjectionError("EXECUTION_RESERVATION_AMOUNT_INVALID");
  }
  const identity = ledgerIdentity(ledger, account.accountId);
  const requestPayload = {
    symbol: ledger.symbol,
    underlyingSymbol: ledger.underlyingSymbol,
    assetClass: ledger.assetClass,
    side: ledger.side,
    orderType: ledger.orderType,
    timeInForce: ledger.timeInForce,
    quantity: ledger.qty,
    notional: ledger.notional,
    limitPrice: ledger.limitPrice,
    sourceCandidateId: ledger.sourceCandidateId,
    sourcePlanId: ledger.sourcePlanId,
    positionIntent,
    sourceStrategy: ledger.strategy || ledger.mode
  };
  const intentFingerprint = canonicalJsonHash(requestPayload);
  const lifecycleFingerprint = canonicalJsonHash({
    intentFingerprint,
    dedupeKey: ledger.dedupeKey,
    decisionId: ledger.decisionId,
    positionLifecycleId: ledger.positionLifecycleId
  });
  return {
    reservationId: reservationRequired ? `reservation_${identity}` : null,
    reservationRequired,
    orderIntentId: `intent_${identity}`,
    accountId: account.accountId,
    accountSnapshotId: account.accountSnapshotId,
    candidateId: ledger.sourceCandidateId,
    strategyKey: account.strategyKey,
    symbol: ledger.symbol,
    underlyingSymbol: ledger.underlyingSymbol,
    assetClass: ledgerAssetClass(ledger.assetClass),
    amount,
    idempotencyKey: ledger.dedupeKey,
    reservationFingerprint: canonicalJsonHash({
      accountSnapshotId: account.accountSnapshotId,
      amount,
      intentFingerprint
    }),
    expiresAt: new Date(Date.parse(ledger.createdAt) + 15 * 60_000).toISOString(),
    clientOrderId: ledger.clientOrderId,
    side,
    orderType: ledgerOrderType(ledger.orderType),
    timeInForce: ledgerTimeInForce(ledger.timeInForce),
    quantity: quantity(ledger.qty),
    notional: money(ledger.notional),
    limitPrice: money(ledger.limitPrice),
    stopPrice: money(text(payload.stop_price ?? payload.stopPrice)),
    estimatedPremium: money(ledger.estimatedPremium),
    maxRisk: money(ledger.maxRisk),
    intentFingerprint,
    lifecycleFingerprint,
    executionReviewId: evidence.executionReviewId,
    confirmationEvidenceId: evidence.confirmationEvidenceId,
    requestPayload,
    requestId: ledger.requestId,
    correlationId: null,
    createdAt: ledger.createdAt
  };
};

export const mapPaperExecutionLedgerToBrokerResult = (
  ledger: PaperExecutionLedgerEntry,
  accountId: string
): BrokerResultInput => {
  const response = jsonRecord(ledger.rawResponseJson);
  const brokerStatus = ledger.alpacaStatus || ledger.status;
  const ambiguousNetworkResult = Boolean(
    ledger.errorMessage && /timeout|timed out|connection reset|network/i.test(ledger.errorMessage)
  );
  const ambiguousMissingIdentity = ledger.alpacaOrderId === null && Boolean(
    /ORDER_ID_MISSING|BROKER_ORDER_ID_MISSING/.test(
      `${ledger.reason ?? ""} ${ledger.blockedReason ?? ""}`
    ) || ["accepted", "submitted"].includes(brokerStatus)
  );
  const ambiguous = ambiguousNetworkResult || ambiguousMissingIdentity;
  const status = ambiguous ? "ambiguous" : brokerStatus;
  const filledQuantity = quantity(
    text(response.filled_qty ?? response.filledQuantity) ?? "0"
  )!;
  const filledAveragePrice = money(
    text(response.filled_avg_price ?? response.filledAveragePrice)
  );
  const brokerClientOrderId = text(response.client_order_id) ?? ledger.clientOrderId;
  const replacesBrokerOrderId = text(response.replaces);
  const brokerQuantity = quantity(text(response.qty) ?? ledger.qty);
  const brokerNotional = money(text(response.notional) ?? ledger.notional);
  const brokerLimitPrice = money(text(response.limit_price) ?? ledger.limitPrice);
  const brokerStopPrice = money(text(response.stop_price));
  const responsePayload = {
    brokerOrderId: ledger.alpacaOrderId,
    clientOrderId: brokerClientOrderId,
    filledAveragePrice,
    filledQuantity,
    replacesBrokerOrderId,
    requestId: ledger.requestId,
    status
  };
  const identity = ledgerIdentity(ledger, accountId);
  const orderIdentity = canonicalJsonHash({ accountId, clientOrderId: brokerClientOrderId });
  const errorClassification = ambiguousNetworkResult
    ? "ambiguous_network_result"
    : ambiguousMissingIdentity
      ? "ambiguous_broker_result"
    : ledger.status === "failed" || ledger.status === "rejected"
      ? "broker_rejection"
      : null;
  return {
    eventId: `broker_event_${canonicalJsonHash({
      identity,
      status,
      updatedAt: ledger.updatedAt,
      responsePayload
    })}`,
    orderId: `order_${orderIdentity}`,
    orderIntentId: `intent_${identity}`,
    brokerOrderId: ledger.alpacaOrderId,
    clientOrderId: ledger.clientOrderId,
    brokerClientOrderId,
    replacesBrokerOrderId,
    symbol: ledger.symbol,
    assetClass: ledgerAssetClass(ledger.assetClass),
    side: (() => {
      const payload = jsonRecord(ledger.rawPayloadJson);
      const intent = text(payload.position_intent ?? payload.positionIntent);
      return intent === "buy_to_open" || intent === "sell_to_close"
        ? intent
        : ledgerSide(ledger.side);
    })(),
    orderType: ledgerOrderType(ledger.orderType),
    timeInForce: ledgerTimeInForce(ledger.timeInForce),
    status,
    quantity: quantity(ledger.qty),
    notional: money(ledger.notional),
    limitPrice: money(ledger.limitPrice),
    stopPrice: null,
    brokerQuantity,
    brokerNotional,
    brokerLimitPrice,
    brokerStopPrice,
    filledQuantity,
    filledAveragePrice,
    requestId: ledger.requestId,
    httpStatus: null,
    errorClassification,
    retryable: errorClassification === null ? null : false,
    responsePayload,
    responseFingerprint: canonicalJsonHash(responsePayload),
    occurredAt: ledger.updatedAt,
    receivedAt: ledger.updatedAt
  };
};

const mapReconciledBrokerOrder = (
  target: BrokerReconciliationTarget,
  response: AlpacaApiResponse<AlpacaSubmittedOrder>,
  receivedAt: string,
  expectedReplacesBrokerOrderId: string | null = null
): BrokerResultInput => {
  const order = response.data;
  const brokerOrderId = text(order.id);
  const clientOrderId = text(order.client_order_id);
  const expectedBrokerClientOrderId = target.brokerClientOrderId ?? target.clientOrderId;
  const replacement = expectedReplacesBrokerOrderId !== null;
  const symbol = text(order.symbol)?.toUpperCase() ?? null;
  const brokerSide = text(order.side)?.toLowerCase() ?? null;
  const brokerPositionIntent = text(order.position_intent)?.toLowerCase() ?? null;
  const expectedBrokerSide = target.side.startsWith("buy") ? "buy" : "sell";
  const status = text(order.status)?.toLowerCase() ?? null;
  if (
    !brokerOrderId ||
    !clientOrderId ||
    (
      replacement
        ? text(order.replaces) !== expectedReplacesBrokerOrderId
        : clientOrderId !== expectedBrokerClientOrderId
    )
  ) {
    throw new ExecutionStateProjectionError("BROKER_ORDER_IDENTITY_MISMATCH");
  }
  if (symbol !== target.symbol.toUpperCase() || brokerSide !== expectedBrokerSide) {
    throw new ExecutionStateProjectionError("BROKER_ORDER_INTENT_MISMATCH");
  }
  if (
    (target.side === "buy_to_open" || target.side === "sell_to_close") &&
    brokerPositionIntent !== target.side
  ) {
    throw new ExecutionStateProjectionError("BROKER_ORDER_POSITION_INTENT_MISMATCH");
  }
  if (
    text(order.type)?.toLowerCase() !== target.orderType ||
    text(order.time_in_force)?.toLowerCase() !== target.timeInForce ||
    !status
  ) {
    throw new ExecutionStateProjectionError("BROKER_ORDER_TERMS_MISMATCH");
  }
  const brokerQuantity = quantity(text(order.qty));
  const brokerNotional = money(text(order.notional));
  const brokerLimitPrice = money(text(order.limit_price));
  const brokerStopPrice = money(text(order.stop_price));
  const expectedBrokerLimitPrice = money(target.brokerLimitPrice ?? target.limitPrice);
  const limitPriceMatches = replacement && target.side.startsWith("buy")
    ? brokerLimitPrice !== null &&
      expectedBrokerLimitPrice !== null &&
      fixedDecimalUnits(brokerLimitPrice) <= fixedDecimalUnits(expectedBrokerLimitPrice)
    : brokerLimitPrice === expectedBrokerLimitPrice;
  if (
    ((target.brokerQuantity ?? target.quantity) !== null &&
      brokerQuantity !== quantity(target.brokerQuantity ?? target.quantity)) ||
    ((target.brokerNotional ?? target.notional) !== null &&
      brokerNotional !== money(target.brokerNotional ?? target.notional)) ||
    !limitPriceMatches ||
    ((target.brokerStopPrice ?? target.stopPrice) !== null &&
      brokerStopPrice !== money(target.brokerStopPrice ?? target.stopPrice))
  ) {
    throw new ExecutionStateProjectionError("BROKER_ORDER_SIZE_MISMATCH");
  }
  const filledQuantity = quantity(text(order.filled_qty) ?? "0")!;
  const filledAveragePrice = money(text(order.filled_avg_price));
  const occurredAt = normalizedTimestamp(
    order.updated_at ?? order.filled_at ?? order.submitted_at ?? order.created_at,
    target.createdAt
  );
  const responsePayload = {
    brokerOrderId,
    clientOrderId,
    intentClientOrderId: target.clientOrderId,
    filledAveragePrice,
    filledQuantity,
    replacesBrokerOrderId: text(order.replaces),
    status
  };
  const responseFingerprint = canonicalJsonHash(responsePayload);
  const identity = canonicalJsonHash({
    accountId: target.accountId,
    clientOrderId
  });
  const rejected = ["rejected", "cancelled", "canceled", "expired"].includes(status);
  return {
    eventId: `broker_event_${canonicalJsonHash({ identity, occurredAt, responsePayload })}`,
    orderId: replacement || !target.orderId ? `order_${identity}` : target.orderId,
    orderIntentId: target.orderIntentId,
    brokerOrderId,
    clientOrderId: target.clientOrderId,
    brokerClientOrderId: clientOrderId,
    replacesBrokerOrderId: text(order.replaces),
    symbol: target.symbol,
    assetClass: target.assetClass,
    side: target.side,
    orderType: target.orderType,
    timeInForce: target.timeInForce,
    status,
    quantity: target.quantity,
    notional: target.notional,
    limitPrice: target.limitPrice,
    stopPrice: target.stopPrice,
    brokerQuantity,
    brokerNotional,
    brokerLimitPrice,
    brokerStopPrice,
    filledQuantity,
    filledAveragePrice,
    requestId: response.requestId ?? null,
    httpStatus: response.status,
    errorClassification: rejected ? "broker_rejection" : null,
    retryable: rejected ? false : null,
    responsePayload,
    responseFingerprint,
    occurredAt,
    receivedAt
  };
};

const reconciliationErrorCode = (error: unknown) => {
  if (error instanceof ExecutionStateProjectionError) return error.code;
  if (error instanceof AlpacaApiError && error.status === 404) return "BROKER_ORDER_NOT_FOUND";
  return "POSTGRES_EXECUTION_RECONCILIATION_FAILED";
};

const finite = (value: number | null) =>
  value !== null && Number.isFinite(value) ? value : 0;

export const mapPaperSubmitStateToExecutionProjection = (
  state: PaperSubmitStateAttestation
): ExecutionAccountProjection => {
  if (
    !state.complete ||
    state.blockers.length > 0 ||
    !state.accountIdentityHash ||
    !state.accountState.status ||
    state.accountState.tradingBlocked === null ||
    state.accountState.accountBlocked === null
  ) {
    throw new ExecutionStateProjectionError("EXECUTION_ACCOUNT_EVIDENCE_INCOMPLETE");
  }
  const accountId = `account_${state.accountIdentityHash}`;
  const accountSnapshotId = `snapshot_${canonicalJsonHash({
    accountId,
    capturedAt: state.capturedAt,
    portfolioFingerprint: state.portfolioFingerprint
  })}`;
  const positions = state.positions.map((position) => {
    const parsedOption = position.assetClass === "option"
      ? parseOptionSymbol(position.symbol)
      : null;
    const signedQuantity = finite(position.quantity);
    const brokerPositionKey = `${position.assetClass}:${position.symbol}`;
    return {
      id: `position_${canonicalJsonHash({ accountId, brokerPositionKey })}`,
      brokerPositionKey,
      candidateId: null,
      openingOrderId: null,
      closingOrderId: null,
      symbol: position.assetClass === "option" && parsedOption?.ok
        ? parsedOption.underlying
        : position.symbol,
      underlyingSymbol: position.assetClass === "option" && parsedOption?.ok
        ? parsedOption.underlying
        : null,
      optionSymbol: position.assetClass === "option" ? position.symbol : null,
      assetClass: position.assetClass,
      side: signedQuantity < 0 ? "short" as const : "long" as const,
      quantity: quantity(Math.abs(signedQuantity))!,
      availableQuantity: null,
      averageEntryPrice: null,
      currentPrice: money(position.currentPrice),
      marketValue: money(position.marketValue),
      costBasis: null,
      unrealizedPnl: null,
      realizedPnl: null,
      openedAt: state.capturedAt
    };
  });
  const longExposure = state.positions.reduce(
    (sum, position) => sum + (finite(position.quantity) >= 0 ? Math.abs(finite(position.marketValue)) : 0),
    0
  );
  const shortExposure = state.positions.reduce(
    (sum, position) => sum + (finite(position.quantity) < 0 ? Math.abs(finite(position.marketValue)) : 0),
    0
  );
  const openOrderExposure = state.openOrders.reduce(
    (sum, order) => sum + Math.abs(
      finite(order.notional) || finite(order.quantity) * finite(order.limitPrice)
    ),
    0
  );
  const activeReservationAmount = state.reservations.reduce(
    (sum, reservation) => sum + Math.abs(
      finite(reservation.notional) ||
      finite(reservation.estimatedPremium) ||
      finite(reservation.quantity) * finite(reservation.limitPrice)
    ),
    0
  );
  const cashReserveAmount = finite(state.accountState.equity) *
    (state.configuration.equityMinCashReservePct / 100);
  const riskLimitId = `risk_${canonicalJsonHash({
    accountId,
    scope: "portfolio",
    config: state.configurationFingerprint
  })}`;
  const strategyAllocationId = `allocation_${canonicalJsonHash({
    accountId,
    strategy: state.allocationAttestation.identity,
    config: state.configurationFingerprint
  })}`;
  const exposureFingerprint = canonicalJsonHash({
    accountId,
    observedAt: state.capturedAt,
    portfolioFingerprint: state.portfolioFingerprint,
    structuralPortfolioFingerprint: state.structuralPortfolioFingerprint
  });

  return {
    accountId,
    brokerAccountId: state.accountIdentityHash,
    accountSnapshotId,
    observedAt: state.capturedAt,
    accountStatus: state.accountState.status,
    currency: "USD",
    cash: money(state.accountState.cash),
    portfolioValue: money(state.accountState.equity),
    equity: money(state.accountState.equity),
    buyingPower: money(state.accountState.buyingPower),
    optionsBuyingPower: money(state.accountState.optionsBuyingPower),
    optionsApprovedLevel: state.accountState.optionsApprovalLevel,
    tradingBlocked: state.accountState.tradingBlocked,
    accountBlocked: state.accountState.accountBlocked,
    snapshotFingerprint: state.portfolioFingerprint,
    evidence: {
      version: state.version,
      structuralPortfolioFingerprint: state.structuralPortfolioFingerprint,
      marketEvidenceFingerprint: state.marketEvidenceFingerprint
    },
    positions,
    riskLimit: {
      id: riskLimitId,
      cashReserveAmount: null,
      cashReserveRatio: ratioFromPercent(state.configuration.equityMinCashReservePct),
      maxDeploymentAmount: money(state.configuration.maxTotalPlanNotional),
      maxDeploymentRatio: ratioFromPercent(state.configuration.equityMaxPortfolioDeployPct),
      maxGrossExposure: money(state.configuration.maxTotalPlanNotional),
      maxNetExposure: money(state.configuration.maxTotalPlanNotional),
      maxOpenOrderExposure: money(state.configuration.maxTotalPlanNotional),
      maxPositionNotional: money(state.configuration.maxPositionNotional),
      maxSymbolNotional: money(state.configuration.maxPositionNotional),
      maxPositionCount: null,
      maxOrderCount: null,
      configVersion: state.version,
      configFingerprint: state.configurationFingerprint
    },
    strategyAllocation: {
      id: strategyAllocationId,
      strategyKey: state.allocationAttestation.identity,
      allocationAmount: money(state.configuration.maxTotalPlanNotional),
      allocationRatio: ratioFromPercent(state.configuration.equityMaxPortfolioDeployPct),
      configVersion: state.version,
      configFingerprint: state.configurationFingerprint
    },
    exposure: {
      id: `exposure_${exposureFingerprint}`,
      grossExposure: money(longExposure + shortExposure)!,
      netExposure: money(longExposure - shortExposure)!,
      longExposure: money(longExposure)!,
      shortExposure: money(shortExposure)!,
      openOrderExposure: money(openOrderExposure)!,
      activeReservationAmount: money(activeReservationAmount)!,
      deployedAmount: money(longExposure + shortExposure)!,
      cashReserveAmount: money(cashReserveAmount)!,
      availableBuyingPower: money(state.accountState.buyingPower),
      positionCount: positions.length,
      openOrderCount: state.openOrders.length,
      fingerprint: exposureFingerprint,
      evidence: {
        portfolioFingerprint: state.portfolioFingerprint,
        configurationFingerprint: state.configurationFingerprint
      }
    }
  };
};

const postgresContext = (
  runtime: ControlPlaneRuntimeContext,
  transaction: PoolClient
): FencedPostgresRepositoryContext => ({
  transaction,
  operationId: runtime.operationId,
  requestId: runtime.requestId,
  correlationId: runtime.correlationId,
  actorId: runtime.fence.ownerId,
  schedulerFence: runtime.fence
});

export interface ExecutionStateProjectionDependencies {
  readonly currentRuntime: () => ControlPlaneRuntimeContext | null;
  readonly repository: ExecutionStateRepository<PoolClient>;
  readonly transaction: <T>(
    pool: Pool,
    config: DatabaseConfig,
    operation: (client: PoolClient) => Promise<T>
  ) => Promise<T>;
  readonly reportDiscrepancy: (code: string) => void;
}

const defaultDependencies: ExecutionStateProjectionDependencies = {
  currentRuntime: currentControlPlaneRuntimeContext,
  repository: new PostgresExecutionStateRepository(),
  transaction: withPostgresTransaction,
  reportDiscrepancy: (code) => {
    process.stderr.write(`${JSON.stringify({ event: "execution_state_shadow_discrepancy", code })}\n`);
  }
};

export const createExecutionStateProjectionService = (
  dependencies: ExecutionStateProjectionDependencies = defaultDependencies
) => {
  const runtimeMode = () => {
    const runtime = dependencies.currentRuntime();
    if (!runtime) return null;
    if (runtime.config.features.executionStateAuthority) return { runtime, authority: true };
    if (runtime.config.features.executionStateShadow) return { runtime, authority: false };
    return null;
  };

  const storeEvidence = async (
    build: (accountId: string) => ExecutionEvidenceInput
  ) => {
    const mode = runtimeMode();
    if (!mode) return { status: "inactive" as const };
    try {
      const result = await dependencies.transaction(
        mode.runtime.pool,
        mode.runtime.config,
        async (client) => {
          const context = postgresContext(mode.runtime, client);
          const account = await dependencies.repository.findCurrentAccount(context);
          if (!account) {
            throw new ExecutionStateProjectionError("EXECUTION_ACCOUNT_SNAPSHOT_REQUIRED");
          }
          return dependencies.repository.upsertExecutionEvidence(
            build(account.accountId),
            context
          );
        }
      );
      if (result.status === "fence_rejected") {
        throw new ExecutionStateProjectionError("EXECUTION_EVIDENCE_FENCE_REJECTED");
      }
      return {
        status: mode.authority ? "authority_stored" as const : "shadow_stored" as const
      };
    } catch (error) {
      if (mode.authority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_EVIDENCE_SHADOW_WRITE_FAILED");
      return { status: "shadow_failed" as const };
    }
  };

  return {
  isAuthorityActive() {
    return runtimeMode()?.authority === true;
  },

  async storePaperReviewEvidence(
    artifact: PaperReviewArtifact,
    ledger: PaperExecutionLedgerEntry
  ) {
    return storeEvidence((accountId) =>
      mapPaperReviewArtifactToExecutionEvidence(artifact, ledger, accountId));
  },

  async storeHedgeReviewEvidence(
    review: HedgeExecutionReview,
    ledger: PaperExecutionLedgerEntry
  ) {
    return storeEvidence((accountId) =>
      mapHedgeReviewToExecutionEvidence(review, ledger, accountId));
  },

  async storeZeroDteEvidence(
    attestation: ZeroDteSubmitAttestation,
    ledger: PaperExecutionLedgerEntry
  ) {
    return storeEvidence((accountId) =>
      mapZeroDteAttestationToExecutionEvidence(attestation, ledger, accountId));
  },

  async storePaperExitEvidence(
    ledger: PaperExecutionLedgerEntry,
    input: {
      readonly generatedAt: string;
      readonly orderIntent: Record<string, unknown>;
      readonly reason: string;
    }
  ) {
    const expiresAt = new Date(Date.parse(input.generatedAt) + 5 * 60_000).toISOString();
    const payloadFingerprint = canonicalJsonHash({
      orderIntent: input.orderIntent,
      reason: input.reason,
      generatedAt: input.generatedAt
    });
    return storeEvidence((accountId) => buildExecutionEvidence({
      ledger,
      accountId,
      reviewType: "exit",
      accountFingerprint: accountId,
      sourceRecommendationId: ledger.sourcePlanId!,
      sourceSnapshotId: null,
      configurationFingerprint: "paper-exit-review-v1",
      payloadFingerprint,
      signatureAlgorithm: "sha256",
      signature: payloadFingerprint,
      orderIntent: input.orderIntent,
      marketEvidence: {},
      portfolioEvidence: { reason: input.reason },
      warnings: [],
      blockers: [],
      requestId: ledger.requestId,
      correlationId: null,
      createdAt: input.generatedAt,
      expiresAt,
      confirmationMethod: "paper_exit_confirm_paper",
      confirmationEvidence: { confirmPaper: true, reason: input.reason }
    }));
  },

  async resolveZeroDteActivityEvidence(
    input: ZeroDteActivityEvidenceInput,
    sqliteEvidence?: ZeroDteActivityEvidence
  ) {
    const mode = runtimeMode();
    if (!mode) return sqliteEvidence ?? buildZeroDteActivityEvidence(input);
    try {
      const state = await dependencies.transaction(
        mode.runtime.pool,
        mode.runtime.config,
        (client) => dependencies.repository.listZeroDteActivityState(
          { tradingDate: input.tradingDate },
          postgresContext(mode.runtime, client)
        )
      );
      if (state.status === "fence_rejected") {
        throw new ExecutionStateProjectionError("EXECUTION_ZERO_DTE_ACTIVITY_FENCE_REJECTED");
      }
      const postgresEvidence = buildZeroDteActivityEvidence(input, {
        listLedgerActivity: () => [...state.ledger],
        listLevel2Activity: () => [],
        listGenericPositionActivity: () => [...state.positions]
      });
      if (
        sqliteEvidence &&
        canonicalJsonHash(postgresEvidence) !== canonicalJsonHash(sqliteEvidence)
      ) {
        dependencies.reportDiscrepancy("EXECUTION_ZERO_DTE_ACTIVITY_SHADOW_MISMATCH");
      }
      return mode.authority ? postgresEvidence : sqliteEvidence ?? postgresEvidence;
    } catch (error) {
      if (mode.authority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_ZERO_DTE_ACTIVITY_SHADOW_READ_FAILED");
      return sqliteEvidence ?? buildZeroDteActivityEvidence(input);
    }
  },

  async resolveReservations(sqliteReservations: PaperSubmitReservationState[]) {
    const mode = runtimeMode();
    if (!mode) return sqliteReservations;
    try {
      const stored = await dependencies.transaction(
        mode.runtime.pool,
        mode.runtime.config,
        (client) => dependencies.repository.listActiveReservations(
          postgresContext(mode.runtime, client)
        )
      );
      const postgresReservations = stored.map((reservation) => ({
        symbol: reservation.symbol.toUpperCase(),
        assetClass: reservation.assetClass,
        side: reservation.side,
        status: reservation.status,
        quantity: numeric(reservation.quantity),
        notional: numeric(reservation.notional),
        estimatedPremium: numeric(reservation.estimatedPremium),
        limitPrice: numeric(reservation.limitPrice),
        clientOrderIdHash: canonicalJsonHash({
          clientOrderId: reservation.clientOrderId
        })
      })).sort((left, right) =>
        `${left.symbol}:${left.clientOrderIdHash}`.localeCompare(
          `${right.symbol}:${right.clientOrderIdHash}`
        )
      );
      if (canonicalJsonHash(postgresReservations) !== canonicalJsonHash(sqliteReservations)) {
        dependencies.reportDiscrepancy("EXECUTION_RESERVATION_SHADOW_MISMATCH");
      }
      return mode.authority ? postgresReservations : sqliteReservations;
    } catch (error) {
      if (mode.authority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_RESERVATION_SHADOW_READ_FAILED");
      return sqliteReservations;
    }
  },

  async syncAccountState(state: PaperSubmitStateAttestation) {
    const runtime = dependencies.currentRuntime();
    if (
      !runtime ||
      (!runtime.config.features.executionStateShadow &&
        !runtime.config.features.executionStateAuthority)
    ) {
      return { status: "inactive" as const };
    }
    if (!state.accountIdentityHash && state.payloadIntents.length === 0) {
      return { status: "inactive" as const };
    }
    let projection: ExecutionAccountProjection;
    try {
      projection = mapPaperSubmitStateToExecutionProjection(state);
    } catch (error) {
      if (runtime.config.features.executionStateAuthority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_ACCOUNT_SOURCE_INCOMPLETE");
      return { status: "shadow_failed" as const };
    }
    try {
      const result = await dependencies.transaction(
        runtime.pool,
        runtime.config,
        (client) => dependencies.repository.syncAccountState(
          projection,
          postgresContext(runtime, client)
        )
      );
      if (result.status === "fence_rejected") {
        throw new ExecutionStateProjectionError("EXECUTION_ACCOUNT_FENCE_REJECTED");
      }
      return {
        status: runtime.config.features.executionStateAuthority
          ? "authority_synced" as const
          : "shadow_synced" as const,
        accountId: result.accountId,
        snapshotId: result.snapshotId
      };
    } catch (error) {
      if (runtime.config.features.executionStateAuthority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_ACCOUNT_SHADOW_WRITE_FAILED");
      return { status: "shadow_failed" as const };
    }
  },

  async reserveOrderIntent(ledger: PaperExecutionLedgerEntry) {
    const mode = runtimeMode();
    if (!mode) return { status: "inactive" as const, brokerAllowed: true as const };
    try {
      const result = await dependencies.transaction(
        mode.runtime.pool,
        mode.runtime.config,
        async (client) => {
          const context = postgresContext(mode.runtime, client);
          const account = await dependencies.repository.findCurrentAccount(context);
          if (!account) {
            throw new ExecutionStateProjectionError("EXECUTION_ACCOUNT_SNAPSHOT_REQUIRED");
          }
          return dependencies.repository.reserveAndCreateOrderIntent(
            mapPaperExecutionLedgerToReservationIntent(ledger, account),
            context
          );
        }
      );
      if (result.status === "fence_rejected") {
        throw new ExecutionStateProjectionError("EXECUTION_RESERVATION_FENCE_REJECTED");
      }
      if (result.status === "blocked") {
        if (mode.authority) {
          return {
            status: "authority_blocked" as const,
            brokerAllowed: false as const,
            blockers: result.blockers
          };
        }
        dependencies.reportDiscrepancy("EXECUTION_RESERVATION_SHADOW_MISMATCH");
        return {
          status: "shadow_blocked" as const,
          brokerAllowed: true as const,
          blockers: result.blockers
        };
      }
      if (result.status === "duplicate" && mode.authority) {
        return {
          status: "authority_duplicate" as const,
          brokerAllowed: false as const,
          blockers: ["EXECUTION_INTENT_RECONCILIATION_REQUIRED"] as const,
          reservationId: result.reservationId,
          orderIntentId: result.orderIntentId
        };
      }
      return {
        status: mode.authority ? "authority_reserved" as const : "shadow_reserved" as const,
        brokerAllowed: true as const,
        reservationId: result.reservationId,
        orderIntentId: result.orderIntentId
      };
    } catch (error) {
      if (mode.authority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_RESERVATION_SHADOW_WRITE_FAILED");
      return { status: "shadow_failed" as const, brokerAllowed: true as const };
    }
  },

  async recordBrokerResult(ledger: PaperExecutionLedgerEntry) {
    const mode = runtimeMode();
    if (!mode) return { status: "inactive" as const };
    try {
      const result = await dependencies.transaction(
        mode.runtime.pool,
        mode.runtime.config,
        async (client) => {
          const context = postgresContext(mode.runtime, client);
          const account = await dependencies.repository.findCurrentAccount(context);
          if (!account) {
            throw new ExecutionStateProjectionError("EXECUTION_ACCOUNT_SNAPSHOT_REQUIRED");
          }
          return dependencies.repository.recordBrokerResult(
            mapPaperExecutionLedgerToBrokerResult(ledger, account.accountId),
            context
          );
        }
      );
      if (result.status === "fence_rejected") {
        throw new ExecutionStateProjectionError("EXECUTION_BROKER_RESULT_FENCE_REJECTED");
      }
      return {
        status: mode.authority ? "authority_recorded" as const : "shadow_recorded" as const,
        replay: result.status === "duplicate"
      };
    } catch (error) {
      if (mode.authority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_BROKER_RESULT_SHADOW_WRITE_FAILED");
      return { status: "shadow_failed" as const };
    }
  },

  async authorizeBrokerMutation(
    ledger: PaperExecutionLedgerEntry,
    mutation: "replace" | "cancel"
  ) {
    const mode = runtimeMode();
    if (!mode) return { status: "inactive" as const, brokerAllowed: true as const };
    if (!ledger.alpacaOrderId) {
      if (mode.authority) {
        return {
          status: "authority_blocked" as const,
          brokerAllowed: false as const,
          blockers: ["EXECUTION_BROKER_ORDER_ID_REQUIRED"] as const
        };
      }
      dependencies.reportDiscrepancy("EXECUTION_BROKER_MUTATION_IDENTITY_MISSING");
      return { status: "shadow_failed" as const, brokerAllowed: true as const };
    }
    try {
      const result = await dependencies.transaction(
        mode.runtime.pool,
        mode.runtime.config,
        async (client) => {
          const context = postgresContext(mode.runtime, client);
          const account = await dependencies.repository.findCurrentAccount(context);
          if (!account) {
            throw new ExecutionStateProjectionError("EXECUTION_ACCOUNT_SNAPSHOT_REQUIRED");
          }
          const identity = ledgerIdentity(ledger, account.accountId);
          return dependencies.repository.authorizeBrokerMutation(
            {
              accountId: account.accountId,
              orderIntentId: `intent_${identity}`,
              clientOrderId: ledger.clientOrderId,
              brokerOrderId: ledger.alpacaOrderId!,
              mutation
            },
            context
          );
        }
      );
      if (result.status === "fence_rejected") {
        if (mode.authority) {
          return {
            status: "authority_blocked" as const,
            brokerAllowed: false as const,
            blockers: ["EXECUTION_BROKER_MUTATION_FENCE_REJECTED"] as const
          };
        }
        dependencies.reportDiscrepancy("EXECUTION_BROKER_MUTATION_FENCE_REJECTED");
        return { status: "shadow_failed" as const, brokerAllowed: true as const };
      }
      if (result.status === "blocked") {
        if (mode.authority) {
          return {
            status: "authority_blocked" as const,
            brokerAllowed: false as const,
            blockers: result.blockers
          };
        }
        dependencies.reportDiscrepancy("EXECUTION_BROKER_MUTATION_SHADOW_MISMATCH");
        return { status: "shadow_blocked" as const, brokerAllowed: true as const };
      }
      return {
        status: mode.authority ? "authority_authorized" as const : "shadow_authorized" as const,
        brokerAllowed: true as const
      };
    } catch (error) {
      if (mode.authority) throw error;
      dependencies.reportDiscrepancy("EXECUTION_BROKER_MUTATION_SHADOW_READ_FAILED");
      return { status: "shadow_failed" as const, brokerAllowed: true as const };
    }
  },

  async reconcileBrokerOrders(input: {
    now?: string;
    getOrderByClientOrderId?: typeof getPaperOrderByClientOrderId;
    getOrderById?: typeof getPaperOrder;
  } = {}) {
    const mode = runtimeMode();
    if (!mode?.authority) {
      return {
        status: "inactive" as const,
        checked: 0,
        recorded: 0,
        replayed: 0,
        filled: 0,
        partial: 0,
        terminal: 0,
        errors: [] as Array<{ code: string }>
      };
    }
    const listed = await dependencies.transaction(
      mode.runtime.pool,
      mode.runtime.config,
      (client) => dependencies.repository.listBrokerReconciliationTargets(
        postgresContext(mode.runtime, client)
      )
    );
    if (listed.status === "fence_rejected") {
      throw new ExecutionStateProjectionError("EXECUTION_RECONCILIATION_FENCE_REJECTED");
    }
    const result = {
      status: "reconciled" as const,
      checked: 0,
      recorded: 0,
      replayed: 0,
      filled: 0,
      partial: 0,
      terminal: 0,
      errors: [] as Array<{ code: string }>
    };
    const lookup = input.getOrderByClientOrderId ?? getPaperOrderByClientOrderId;
    const lookupById = input.getOrderById ?? getPaperOrder;
    for (const target of listed.targets) {
      result.checked += 1;
      try {
        let response = await lookup(target.brokerClientOrderId ?? target.clientOrderId);
        if (
          (target.brokerOrderId && text(response.data.id) !== target.brokerOrderId) ||
          text(response.data.client_order_id) !==
            (target.brokerClientOrderId ?? target.clientOrderId)
        ) {
          throw new ExecutionStateProjectionError("BROKER_ORDER_IDENTITY_MISMATCH");
        }
        let expectedReplacesBrokerOrderId: string | null = null;
        const visited = new Set<string>();
        for (let depth = 0; depth < 8; depth += 1) {
          const replacementOrderId = text(response.data.replaced_by);
          if (!replacementOrderId) break;
          const currentOrderId = text(response.data.id);
          if (!currentOrderId || visited.has(replacementOrderId)) {
            throw new ExecutionStateProjectionError("BROKER_REPLACEMENT_CHAIN_INVALID");
          }
          visited.add(currentOrderId);
          const replacementResponse = await lookupById(replacementOrderId);
          if (text(replacementResponse.data.replaces) !== currentOrderId) {
            throw new ExecutionStateProjectionError("BROKER_REPLACEMENT_CHAIN_INVALID");
          }
          expectedReplacesBrokerOrderId = currentOrderId;
          response = replacementResponse;
        }
        if (text(response.data.replaced_by)) {
          throw new ExecutionStateProjectionError("BROKER_REPLACEMENT_CHAIN_LIMIT_EXCEEDED");
        }
        const brokerResult = mapReconciledBrokerOrder(
          target,
          response,
          new Date(input.now ?? Date.now()).toISOString(),
          expectedReplacesBrokerOrderId
        );
        const persisted = await dependencies.transaction(
          mode.runtime.pool,
          mode.runtime.config,
          (client) => dependencies.repository.recordBrokerResult(
            brokerResult,
            postgresContext(mode.runtime, client)
          )
        );
        if (persisted.status === "fence_rejected") {
          throw new ExecutionStateProjectionError("EXECUTION_BROKER_RESULT_FENCE_REJECTED");
        }
        if (persisted.status === "duplicate") result.replayed += 1;
        else {
          result.recorded += 1;
          if (brokerResult.status === "filled") result.filled += 1;
          else if (brokerResult.status === "partially_filled") result.partial += 1;
          else if (["rejected", "cancelled", "canceled", "expired"].includes(
            brokerResult.status
          )) result.terminal += 1;
        }
      } catch (error) {
        result.errors.push({ code: reconciliationErrorCode(error) });
      }
    }
    return result;
  }
};
};

export const executionStateProjectionService =
  createExecutionStateProjectionService();
