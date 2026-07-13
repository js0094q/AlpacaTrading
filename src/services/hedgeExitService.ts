import {
  cancelPaperOrder,
  getPaperOrder,
  submitPaperOrder,
  type AlpacaAccountRaw,
  type AlpacaApiResponse,
  type AlpacaPaperOrderRequest,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import {
  createHedgeExecutionReview,
  verifyHedgeExecutionReview,
  type HedgeExecutionReview
} from "./hedgeExecutionReviewService.js";
import {
  markHedgeExecutionReviewConsumed,
  persistHedgeExecutionReview,
  readHedgeExecutionReview
} from "./hedgePersistenceService.js";
import {
  releaseExpiredHedgeReservations,
  reservePaperExecutionAttempt,
  updatePaperExecutionLedgerEntry
} from "./paperExecutionLedgerService.js";
import { recordHedgeLearningEvent } from "./hedgeLearningLifecycleService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export interface HedgeExitPositionInput {
  symbol: string;
  underlying: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  expirationDate: string;
  entryAt: string;
  asOf: string;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;
  accountHash: string;
  sourceRecommendationId: string;
  sourceSnapshotId: string;
  sourceRegimeId: string;
  riskModelVersion: string;
  regimeModelVersion: string;
  configurationFingerprint: string;
  staleThesis?: boolean;
  riskNormalizationObservations?: number;
}

export interface HedgeExitPolicyResult {
  shouldExit: boolean;
  reasons: string[];
  warnings: string[];
  riskNormalizationConfirmations: number;
  profitPct: number;
  lossPct: number;
  dte: number;
}

export interface HedgeExitReviewResult {
  paperOnly: true;
  environment: "paper";
  status: "reviewed" | "hold" | "blocked";
  review: HedgeExecutionReview | null;
  reasons: string[];
  warnings: string[];
}

export interface HedgeExitExecutionDeps {
  review?: HedgeExecutionReview;
  account?: AlpacaAccountRaw;
  currentPositionQuantity?: number;
  refreshQuote?: (symbol: string) => Promise<{ bid: number | null; ask: number | null; midpoint: number | null; quoteTimestamp?: string | null }>;
  submitPaperOrder?: (payload: Record<string, unknown>) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  getPaperOrder?: typeof getPaperOrder;
  cancelPaperOrder?: typeof cancelPaperOrder;
  now?: () => string;
};

const boolFlag = (name: string) => process.env[name] === "true" || process.env[name] === "1";
const finite = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const policyNumber = (name: string, fallback: number) => finite(process.env[name], fallback);
const daysBetween = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);

export const evaluateHedgeExitPolicy = (
  input: HedgeExitPositionInput
): HedgeExitPolicyResult => {
  const profitPct = input.entryPrice > 0 ? ((input.currentPrice - input.entryPrice) / input.entryPrice) * 100 : 0;
  const lossPct = profitPct;
  const dte = daysBetween(input.asOf.slice(0, 10), input.expirationDate);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const riskNormalizationConfirmations = Math.max(0, Math.floor(input.riskNormalizationObservations ?? 0));
  if (profitPct >= policyNumber("HEDGE_EXIT_PROFIT_TARGET_PCT", 50)) reasons.push("HEDGE_PROFIT_TARGET");
  if (lossPct <= -policyNumber("HEDGE_EXIT_LOSS_LIMIT_PCT", 50)) reasons.push("HEDGE_LOSS_CONTAINMENT");
  if (dte <= policyNumber("HEDGE_EXIT_MIN_DTE", 14)) reasons.push("HEDGE_TIME_TO_EXPIRATION");
  if (input.staleThesis === true) reasons.push("HEDGE_STALE_THESIS");
  if (riskNormalizationConfirmations >= Math.max(1, Math.floor(policyNumber("HEDGE_EXIT_RISK_NORMALIZATION_CONFIRMATIONS", 2)))) {
    reasons.push("HEDGE_PORTFOLIO_RISK_NORMALIZED");
  }
  const holdMinutes = (Date.parse(input.asOf) - Date.parse(input.entryAt)) / 60_000;
  if (holdMinutes < policyNumber("HEDGE_EXIT_MIN_HOLD_MINUTES", 15)) {
    warnings.push("HEDGE_EXIT_MIN_HOLD_NOT_REACHED");
  }
  return {
    shouldExit: reasons.length > 0 && warnings.length === 0,
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    riskNormalizationConfirmations,
    profitPct: Number(profitPct.toFixed(4)),
    lossPct: Number(lossPct.toFixed(4)),
    dte
  };
};

export const buildHedgeExitReview = (
  input: HedgeExitPositionInput & { signingKey?: string }
): HedgeExitReviewResult => {
  const policy = evaluateHedgeExitPolicy(input);
  if (!policy.shouldExit) {
    return { paperOnly: true, environment: "paper", status: "hold", review: null, reasons: policy.reasons, warnings: policy.warnings };
  }
  const signingKey = input.signingKey ?? process.env.HEDGE_REVIEW_SIGNING_KEY ?? "";
  if (!signingKey.trim()) {
    return { paperOnly: true, environment: "paper", status: "blocked", review: null, reasons: policy.reasons, warnings: ["HEDGE_REVIEW_SIGNING_KEY_REQUIRED"] };
  }
  const quantity = Math.max(1, Math.floor(input.quantity));
  const candidate = {
    candidateId: `hedge-exit-${input.symbol}`,
    rank: 1,
    instrumentType: "protective_put" as const,
    symbol: input.symbol,
    underlying: input.underlying,
    executable: true,
    expectedProtection: null,
    estimatedCost: input.currentPrice * quantity * 100,
    units: quantity,
    rationale: policy.reasons,
    warnings: policy.warnings,
    blockers: [],
    details: {
      midpoint: input.currentPrice,
      bid: input.bid ?? input.currentPrice,
      ask: input.ask ?? input.currentPrice,
      delta: input.delta ?? null,
      daysToExpiration: policy.dte,
      multiplier: 100,
      exitProfitPct: policy.profitPct,
      exitLossPct: policy.lossPct,
      exitReasons: policy.reasons
    }
  };
  try {
    const review = createHedgeExecutionReview({
      accountHash: input.accountHash,
      sourceRecommendationId: input.sourceRecommendationId,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceRegimeId: input.sourceRegimeId,
      riskModelVersion: input.riskModelVersion,
      regimeModelVersion: input.regimeModelVersion,
      configurationFingerprint: input.configurationFingerprint,
      generatedAt: input.asOf,
      signingKey,
      candidate,
      reviewType: "exit",
      orderSide: "sell_to_close",
      requestId: `hedge_exit_review_${input.symbol}_${input.asOf}`
    });
    persistHedgeExecutionReview(review);
    return { paperOnly: true, environment: "paper", status: "reviewed", review, reasons: policy.reasons, warnings: policy.warnings };
  } catch (error) {
    return {
      paperOnly: true,
      environment: "paper",
      status: "blocked",
      review: null,
      reasons: policy.reasons,
      warnings: [error instanceof Error ? error.message : "HEDGE_EXIT_REVIEW_FAILED"]
    };
  }
};

const executionBlocked = (reviewId: string, blockers: string[]) => ({
  paperOnly: true as const,
  environment: "paper" as const,
  status: "blocked" as const,
  reviewId,
  clientOrderId: null,
  brokerOrderId: null,
  filledQuantity: 0,
  averageFillPrice: null,
  blockers: [...new Set(blockers)],
  warnings: [] as string[]
});

export const executeReviewedPaperHedgeExit = async (
  input: { reviewId: string; confirmPaper: boolean },
  deps: HedgeExitExecutionDeps = {}
) => {
  const state = getTradingSafetyState();
  const blockers = [
    ...(input.confirmPaper !== true ? ["CONFIRM_PAPER_REQUIRED"] : []),
    ...(state.paperOnly ? [] : ["HEDGE_ENVIRONMENT_NOT_PAPER"]),
    ...(!boolFlag("PAPER_ORDER_EXECUTION_ENABLED") ? ["PAPER_EXECUTION_FLAG_REQUIRED"] : []),
    ...(!boolFlag("PAPER_OPTIONS_EXECUTION_ENABLED") ? ["HEDGE_OPTIONS_EXECUTION_DISABLED"] : []),
    ...(!boolFlag("HEDGE_EXIT_MANAGEMENT_ENABLED") ? ["HEDGE_EXIT_MANAGEMENT_DISABLED"] : []),
    ...(boolFlag("HEDGE_LIVE_EXECUTION_ENABLED") ? ["HEDGE_LIVE_EXECUTION_ENABLED"] : []),
    ...(boolFlag("MULTI_LEG_HEDGE_EXECUTION_ENABLED") ? ["MULTI_LEG_EXECUTION_UNSUPPORTED"] : []),
    ...(!process.env.HEDGE_REVIEW_SIGNING_KEY?.trim() ? ["HEDGE_REVIEW_SIGNING_KEY_REQUIRED"] : [])
  ];
  if (blockers.length > 0) return executionBlocked(input.reviewId, blockers);
  const asOf = deps.now?.() ?? new Date().toISOString();
  const review = deps.review ?? readHedgeExecutionReview({ reviewId: input.reviewId, signingKey: process.env.HEDGE_REVIEW_SIGNING_KEY!, asOf }).review;
  if (!review) return executionBlocked(input.reviewId, ["HEDGE_REVIEW_NOT_FOUND"]);
  const verification = verifyHedgeExecutionReview({ review, signingKey: process.env.HEDGE_REVIEW_SIGNING_KEY!, asOf });
  if (!verification.valid || review.reviewType !== "exit" || review.orderIntent.side !== "sell_to_close") {
    return { ...executionBlocked(input.reviewId, [...verification.blockers, "HEDGE_EXIT_REVIEW_INVALID"]), verification };
  }
  const account = deps.account;
  if (!account || account.status !== "ACTIVE" || !account.id) {
    return executionBlocked(input.reviewId, ["HEDGE_ACCOUNT_NOT_VERIFIED"]);
  }
  const currentQuantity = finite(deps.currentPositionQuantity, 0);
  if (currentQuantity <= 0 || currentQuantity < review.orderIntent.quantity) {
    return executionBlocked(input.reviewId, ["HEDGE_EXIT_QUANTITY_UNAVAILABLE"]);
  }
  const quote = await (deps.refreshQuote ?? (async () => ({ bid: review.orderIntent.limitPrice, ask: review.orderIntent.limitPrice, midpoint: review.orderIntent.limitPrice, quoteTimestamp: null })))(review.orderIntent.symbol);
  const limitPrice = quote.bid && quote.bid > 0 ? quote.bid : review.orderIntent.limitPrice;
  releaseExpiredHedgeReservations();
  const reservation = reservePaperExecutionAttempt({
    reviewId: review.reviewId,
    clientOrderId: review.clientOrderId,
    symbol: review.orderIntent.symbol,
    underlyingSymbol: review.orderIntent.underlying,
    quantity: review.orderIntent.quantity,
    limitPrice,
    estimatedPremium: limitPrice * review.orderIntent.quantity * review.orderIntent.multiplier,
    expiresAt: review.expiresAt,
    requestId: review.requestId,
    mode: "hedge-exit",
    side: "sell",
    positionIntent: "sell_to_close"
  });
  if (!reservation.reserved) return executionBlocked(input.reviewId, reservation.blockers);
  const payload: AlpacaPaperOrderRequest = {
    symbol: review.orderIntent.symbol,
    qty: String(review.orderIntent.quantity),
    side: "sell",
    type: "limit",
    time_in_force: "day",
    limit_price: String(limitPrice),
    client_order_id: review.clientOrderId,
    position_intent: "sell_to_close"
  };
  try {
    const submit = deps.submitPaperOrder ?? ((order: Record<string, unknown>) => submitPaperOrder(order as unknown as AlpacaPaperOrderRequest));
    const response = await submit(payload as unknown as Record<string, unknown>);
    const brokerOrderId = response.data.id ?? null;
    updatePaperExecutionLedgerEntry(reservation.entry.id, { status: "submitted", alpacaOrderId: brokerOrderId, alpacaStatus: response.data.status ?? "submitted", requestId: response.requestId });
    recordHedgeLearningEvent({ eventId: `${review.reviewId}:submit`, reviewId: review.reviewId, eventType: "submit", evidence: { symbol: review.orderIntent.symbol, clientOrderId: review.clientOrderId, brokerOrderId } });
    if (!brokerOrderId) return executionBlocked(input.reviewId, ["HEDGE_BROKER_ORDER_ID_MISSING"]);
    const orderResponse = await (deps.getPaperOrder ?? getPaperOrder)(brokerOrderId);
    const filledQuantity = finite(orderResponse.data.filled_qty, 0);
    const status = String(orderResponse.data.status ?? "").toLowerCase();
    if (status === "filled") {
      updatePaperExecutionLedgerEntry(reservation.entry.id, { status: "filled", alpacaOrderId: brokerOrderId, alpacaStatus: status, requestId: orderResponse.requestId });
      markHedgeExecutionReviewConsumed(review.reviewId);
      recordHedgeLearningEvent({ eventId: `${review.reviewId}:fill`, reviewId: review.reviewId, eventType: "fill", evidence: { symbol: review.orderIntent.symbol, filledQuantity, filledAveragePrice: orderResponse.data.filled_avg_price } });
      return { paperOnly: true as const, environment: "paper" as const, status: "filled" as const, reviewId: review.reviewId, clientOrderId: review.clientOrderId, brokerOrderId, filledQuantity, averageFillPrice: finite(orderResponse.data.filled_avg_price, 0), blockers: [], warnings: [], reservationId: reservation.entry.id, verification };
    }
    await (deps.cancelPaperOrder ?? cancelPaperOrder)(brokerOrderId);
    updatePaperExecutionLedgerEntry(reservation.entry.id, { status: filledQuantity > 0 ? "partial" : "canceled", alpacaOrderId: brokerOrderId, alpacaStatus: "canceled" });
    markHedgeExecutionReviewConsumed(review.reviewId);
    return { paperOnly: true as const, environment: "paper" as const, status: filledQuantity > 0 ? "partial" as const : "canceled" as const, reviewId: review.reviewId, clientOrderId: review.clientOrderId, brokerOrderId, filledQuantity, averageFillPrice: finite(orderResponse.data.filled_avg_price, 0), blockers: [], warnings: [], reservationId: reservation.entry.id, verification };
  } catch (error) {
    updatePaperExecutionLedgerEntry(reservation.entry.id, { status: "failed", reason: "HEDGE_EXIT_ORDER_SUBMISSION_FAILED", errorMessage: error instanceof Error ? error.message : "Paper hedge exit submission failed." });
    return executionBlocked(input.reviewId, ["HEDGE_EXIT_ORDER_SUBMISSION_FAILED"]);
  }
};
