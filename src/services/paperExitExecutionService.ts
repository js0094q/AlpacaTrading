import {
  submitPaperOrder,
  AlpacaApiError,
  type AlpacaPaperOrderRequest
} from "./alpacaClient.js";
import { canonicalJsonHash } from "../lib/canonicalJson.js";
import {
  buildPaperExitReviewResult,
  type PaperExitReviewInput
} from "./paperExitReviewService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";
import { executionStateProjectionService } from "./executionStateProjectionService.js";
import type { PaperExecutionLedgerEntry } from "./paperExecutionLedgerService.js";
import type {
  PaperExitExecutionResult,
  PaperExitOrderPayload,
  PaperExitReviewResult
} from "../types/paperExit.js";

export interface PaperExitExecutionInput extends PaperExitReviewInput {
  confirmPaper?: boolean;
}

interface PaperExitExecutionDeps {
  buildReview?: typeof buildPaperExitReviewResult;
  submitPaperOrder?: typeof submitPaperOrder;
  authorizeExecution?: typeof executionStateProjectionService.reserveOrderIntent;
  recordExecutionResult?: typeof executionStateProjectionService.recordBrokerResult;
  storeExecutionEvidence?: typeof executionStateProjectionService.storePaperExitEvidence;
}

const paperOrderExecutionEnabled = () =>
  process.env.PAPER_ORDER_EXECUTION_ENABLED === "true" ||
  process.env.PAPER_ORDER_EXECUTION_ENABLED === "1";

const blockedExecution = (
  review: PaperExitReviewResult,
  blockedReason: string,
  errors?: Array<Record<string, unknown>>
): PaperExitExecutionResult => ({
  status: "blocked",
  environment: review.environment,
  mutationAttempted: false,
  submittedOrders: [],
  skipped: review.skipped,
  blockedReason,
  errors,
  review
});

const toAlpacaPayload = (payload: PaperExitOrderPayload): AlpacaPaperOrderRequest => ({
  symbol: payload.symbol,
  qty: payload.qty,
  side: "sell",
  type: payload.orderType,
  time_in_force: payload.timeInForce,
  limit_price: payload.orderType === "limit" ? payload.limitPrice : undefined,
  client_order_id: payload.clientOrderId,
  position_intent: payload.assetClass === "us_option" ? "sell_to_close" : undefined
});

const executionProjectionSource = (
  candidate: PaperExitReviewResult["exitCandidates"][number],
  createdAt: string
): PaperExecutionLedgerEntry => ({
  id: -1,
  createdAt,
  updatedAt: createdAt,
  mode: "paper-exit",
  assetClass: candidate.assetClass === "us_option" ? "option" : "equity",
  symbol: candidate.symbol,
  underlyingSymbol: null,
  strategy: "paper-exit",
  side: "sell",
  orderType: candidate.orderPayload.orderType,
  timeInForce: candidate.orderPayload.timeInForce,
  qty: candidate.orderPayload.qty,
  notional: null,
  limitPrice: candidate.orderPayload.limitPrice ?? null,
  estimatedPremium: null,
  maxRisk: null,
  dedupeKey: candidate.orderPayload.clientOrderId,
  clientOrderId: candidate.orderPayload.clientOrderId,
  alpacaOrderId: null,
  alpacaStatus: null,
  requestId: null,
  sourcePlanId: `paper_exit_review_${canonicalJsonHash({
    generatedAt: createdAt,
    clientOrderId: candidate.orderPayload.clientOrderId
  })}`,
  sourceCandidateId: null,
  decisionId: null,
  positionLifecycleId: null,
  decisionLinkageStatus: "LEGACY_UNLINKED",
  status: "attempted",
  reason: null,
  blockedReason: null,
  errorMessage: null,
  payloadJson: JSON.stringify({ reason: candidate.reason }),
  rawPayloadJson: JSON.stringify(toAlpacaPayload(candidate.orderPayload)),
  rawResponseJson: null
});

export const buildPaperExitExecutionResult = async (
  input: PaperExitExecutionInput = {},
  deps: PaperExitExecutionDeps = {}
): Promise<PaperExitExecutionResult> => {
  const reviewBuilder = deps.buildReview ?? buildPaperExitReviewResult;
  const review = await reviewBuilder(input);
  const state = getTradingSafetyState();

  if (review.status === "blocked") {
    return blockedExecution(review, review.blockReason || "REVIEW_BLOCKED");
  }
  if (input.confirmPaper !== true) {
    return blockedExecution(review, "CONFIRM_PAPER_REQUIRED");
  }
  if (state.alpacaEnv !== "paper" || state.liveTradingEnabled || review.environment !== "paper") {
    return blockedExecution(review, "LIVE_TRADING_BLOCKED");
  }
  if (!paperOrderExecutionEnabled()) {
    return blockedExecution(review, "PAPER_ORDER_EXECUTION_DISABLED");
  }
  if (!review.exitCandidates.length) {
    return blockedExecution(review, "NO_EXIT_CANDIDATES");
  }

  const submitOrder = deps.submitPaperOrder ?? submitPaperOrder;
  const authorizeExecution = deps.authorizeExecution ??
    executionStateProjectionService.reserveOrderIntent;
  const recordExecutionResult = deps.recordExecutionResult ??
    executionStateProjectionService.recordBrokerResult;
  const storeExecutionEvidence = deps.storeExecutionEvidence ??
    executionStateProjectionService.storePaperExitEvidence;
  const submittedOrders: PaperExitExecutionResult["submittedOrders"] = [];
  const errors: Array<Record<string, unknown>> = [];
  let mutationAttempted = false;

  for (const candidate of review.exitCandidates) {
    if (candidate.positionClass === "option_leaps" && input.includeLEAPS !== true) {
      errors.push({
        symbol: candidate.symbol,
        reason: "LEAPS_SKIPPED_BY_DEFAULT"
      });
      continue;
    }

    const projectionSource = executionProjectionSource(candidate, review.generatedAt);
    await storeExecutionEvidence(projectionSource, {
      generatedAt: review.generatedAt,
      orderIntent: toAlpacaPayload(candidate.orderPayload) as unknown as Record<string, unknown>,
      reason: candidate.reason
    });
    const postgresAuthorization = await authorizeExecution(projectionSource);
    if (!postgresAuthorization.brokerAllowed) {
      errors.push({
        symbol: candidate.symbol,
        reason: postgresAuthorization.blockers?.[0] ??
          "POSTGRES_EXECUTION_INTENT_BLOCKED"
      });
      continue;
    }
    let response: Awaited<ReturnType<typeof submitPaperOrder>>;
    try {
      mutationAttempted = true;
      response = await submitOrder(toAlpacaPayload(candidate.orderPayload));
    } catch (error) {
      await recordExecutionResult({
        ...projectionSource,
        updatedAt: new Date().toISOString(),
        status: "failed",
        requestId: error instanceof AlpacaApiError ? error.requestId ?? null : null,
        reason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        blockedReason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        errorMessage: error instanceof Error ? error.message : "Paper exit order submission failed."
      });
      errors.push({
        symbol: candidate.symbol,
        reason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        message: error instanceof Error ? error.message : "Paper exit order submission failed.",
        requestId: error instanceof AlpacaApiError ? error.requestId : undefined
      });
      continue;
    }
    await recordExecutionResult({
      ...projectionSource,
      updatedAt: new Date().toISOString(),
      status: response.data.status === "accepted" ? "accepted" : "submitted",
      alpacaOrderId: response.data.id ?? null,
      alpacaStatus: response.data.status ?? null,
      requestId: response.requestId ?? null,
      rawResponseJson: JSON.stringify(response.data)
    });
    submittedOrders.push({
      symbol: candidate.symbol,
      side: "sell",
      qty: candidate.orderPayload.qty,
      assetClass: candidate.assetClass,
      positionIntent: candidate.orderPayload.positionIntent,
      reason: candidate.reason,
      alpacaOrderId: response.data.id,
      clientOrderId: response.data.client_order_id || candidate.orderPayload.clientOrderId,
      alpacaRequestId: response.requestId,
      status: response.data.status
    });
  }

  return {
    status: submittedOrders.length > 0
      ? errors.length > 0
        ? "warning"
        : "ok"
      : "error",
    environment: "paper",
    mutationAttempted,
    submittedOrders,
    skipped: review.skipped,
    blockedReason: submittedOrders.length ? undefined : errors[0]?.reason as string | undefined,
    errors: errors.length ? errors : undefined,
    review
  };
};

export const formatPaperExitExecutionAsTable = (
  result: PaperExitExecutionResult
): string => {
  const lines: string[] = [];
  lines.push("Paper Exit Execution");
  lines.push(`Environment: ${result.environment}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Mutation attempted: ${String(result.mutationAttempted)}`);
  if (result.blockedReason) {
    lines.push(`Block reason: ${result.blockedReason}`);
  }
  lines.push(`Submitted orders: ${result.submittedOrders.length}`);
  if (!result.submittedOrders.length) {
    lines.push("- None");
  } else {
    for (const order of result.submittedOrders) {
      lines.push(
        `- ${order.assetClass} ${order.symbol} sell qty=${order.qty} status=${order.status || "unknown"} requestId=${order.alpacaRequestId || ""}`
      );
    }
  }
  if (result.errors?.length) {
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`- ${String(error.symbol || "unknown")}: ${String(error.reason || "error")}`);
    }
  }
  return lines.join("\n");
};
