import { canonicalJsonHash } from "../lib/canonicalJson.js";
import {
  cancelPaperOrder,
  getAccount,
  getPaperOrder,
  replacePaperOrder,
  submitPaperOrder,
  type AlpacaAccountRaw,
  type AlpacaApiResponse,
  type AlpacaPaperOrderRequest,
  type AlpacaPositionRaw,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import { fetchOptionQuotes, fetchOptionSnapshots } from "./providers/alpaca.js";
import { normalizeOptionSnapshot } from "./optionSnapshotNormalizer.js";
import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint
} from "./hedgeConfigService.js";
import {
  buildHedgeCapitalEvidence,
  type HedgeCapitalEvidence,
  type HedgeCapitalOrderInput
} from "./hedgeCapitalEvidenceService.js";
import {
  reconcileHedgeAccountState,
  type HedgeAccountReconciliationResult
} from "./hedgeAccountReconciliationService.js";
import {
  readHedgeExecutionReview
} from "./hedgePersistenceService.js";
import type {
  HedgeExecutionReview,
  HedgeExecutionReviewVerification
} from "./hedgeExecutionReviewService.js";
import { verifyHedgeExecutionReview } from "./hedgeExecutionReviewService.js";
import {
  applyPaperExecutionLedgerUpdate,
  buildPaperExecutionLedgerEntry,
  listActivePaperNewRiskReservations,
  findPaperExecutionById,
  listPaperExecutionLedgerEntries,
  paperNewRiskLedgerMutationFingerprint,
  releaseExpiredHedgeReservations,
  reservePaperExecutionAttempt,
  updatePaperExecutionLedgerEntry,
  type PaperExecutionLedgerEntry,
  type PaperExecutionLedgerUpdate
} from "./paperExecutionLedgerService.js";
import { executionStateProjectionService } from "./executionStateProjectionService.js";
import {
  normalizePaperSubmitReservations,
  paperSubmitReservationFingerprint
} from "./paperSubmitStateService.js";
import {
  validatePaperHedgeOptionOrder,
  type PaperHedgeOptionOrderValidation
} from "./paperOptionOrderValidationService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export type HedgeExecutionStatus =
  | "filled"
  | "partial"
  | "submitted"
  | "canceled"
  | "rejected"
  | "blocked"
  | "no_op";

export interface HedgeExecutionReport {
  paperOnly: true;
  environment: "paper" | "live";
  status: HedgeExecutionStatus;
  reviewId: string;
  clientOrderId: string | null;
  brokerOrderId: string | null;
  symbol: string | null;
  requestId: string | null;
  correlationId: string | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  attempts: number;
  reservationId: number | null;
  blockers: string[];
  warnings: string[];
  verification?: HedgeExecutionReviewVerification;
  reconciliation?: HedgeAccountReconciliationResult;
  validation?: PaperHedgeOptionOrderValidation;
  capitalEvidence?: HedgeCapitalEvidence;
}

export interface HedgeQuoteRefresh {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  delta: number | null;
  quoteTimestamp: string | null;
}

export interface HedgeExecutionDeps {
  getAccount?: typeof getAccount;
  listPositions?: () => Promise<{ positions: AlpacaPositionRaw[]; requestId?: string }>;
  listOrders?: () => Promise<{ orders: HedgeCapitalOrderInput[]; requestId?: string }>;
  listLedger?: (limit?: number) => PaperExecutionLedgerEntry[];
  submitPaperOrder?: typeof submitPaperOrder;
  getPaperOrder?: typeof getPaperOrder;
  replacePaperOrder?: typeof replacePaperOrder;
  cancelPaperOrder?: typeof cancelPaperOrder;
  refreshQuote?: (symbol: string) => Promise<HedgeQuoteRefresh>;
  readReview?: typeof readHedgeExecutionReview;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRepriceAttempts?: number;
  authorizeExecution?: typeof executionStateProjectionService.reserveOrderIntent;
  authorizeBrokerMutation?: typeof executionStateProjectionService.authorizeBrokerMutation;
  recordExecutionResult?: typeof executionStateProjectionService.recordBrokerResult;
  storeExecutionEvidence?: typeof executionStateProjectionService.storeHedgeReviewEvidence;
}

const parseBoolean = (name: string) => process.env[name] === "true" || process.env[name] === "1";
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const hedgeCapitalCapBlockers = (input: {
  equity: number | null;
  newPremium: number;
  capitalEvidence: HedgeCapitalEvidence;
  config: ReturnType<typeof buildHedgeConfig>;
}) => {
  const blockers: string[] = [];
  if (input.equity === null || input.equity <= 0) {
    blockers.push("HEDGE_ACCOUNT_EQUITY_INVALID");
  } else {
    if (
      input.newPremium >
      input.equity * input.config.executionPolicy.maxNewHedgePremiumPctEquity
    ) {
      blockers.push("HEDGE_PREMIUM_CAP_EXCEEDED");
    }
    if (
      (input.capitalEvidence.existingHedgePremium ?? 0) +
        (input.capitalEvidence.reservedHedgePremium ?? 0) +
        input.newPremium >
      input.equity * input.config.executionPolicy.maxTotalHedgePremiumPctEquity
    ) {
      blockers.push("HEDGE_TOTAL_PREMIUM_CAP_EXCEEDED");
    }
    if (
      (input.capitalEvidence.dailyHedgePremiumUsed ?? 0) + input.newPremium >
      input.equity * input.config.executionPolicy.maxDailyHedgePremiumPctEquity
    ) {
      blockers.push("HEDGE_DAILY_PREMIUM_CAP_EXCEEDED");
    }
  }
  if (
    (input.capitalEvidence.openHedgeOrderCount ?? Number.POSITIVE_INFINITY) >=
    input.config.executionPolicy.maxOrdersPerRun
  ) {
    blockers.push("HEDGE_OPEN_ORDER_CAP_REACHED");
  }
  return [...new Set(blockers)];
};

export const paperAccountIdentityHash = (account: Partial<AlpacaAccountRaw>) =>
  canonicalJsonHash({
    id: account.id ?? null,
    status: account.status ?? null,
    equity: account.equity ?? null,
    buyingPower: account.buying_power ?? null,
    optionsApprovedLevel: account.options_approved_level ?? null
  });

const defaultListPositions = async () => {
  const { listPaperPositions } = await import("./alpacaClient.js");
  const response = await listPaperPositions();
  return { positions: response.data, requestId: response.requestId };
};

const defaultListOrders = async () => {
  const { listRecentPaperOrders } = await import("./alpacaClient.js");
  const response = await listRecentPaperOrders(500);
  return { orders: response.data, requestId: response.requestId };
};

const defaultRefreshQuote = async (symbol: string): Promise<HedgeQuoteRefresh> => {
  const [snapshots, quotes] = await Promise.all([
    fetchOptionSnapshots([symbol]),
    fetchOptionQuotes([symbol])
  ]);
  const normalized = normalizeOptionSnapshot(symbol, snapshots[0]?.raw ?? {}, {
    latestQuote: quotes[0]?.raw
  });
  return {
    bid: normalized.latestQuote?.bidPrice ?? null,
    ask: normalized.latestQuote?.askPrice ?? null,
    midpoint:
      normalized.latestQuote?.bidPrice !== null && normalized.latestQuote?.askPrice !== null &&
      normalized.latestQuote?.bidPrice !== undefined && normalized.latestQuote?.askPrice !== undefined
        ? (normalized.latestQuote.bidPrice + normalized.latestQuote.askPrice) / 2
        : null,
    delta: normalized.greeks.delta,
    quoteTimestamp: normalized.latestQuote?.timestamp ?? normalized.snapshotTimestamp ?? null
  };
};

const blockedReport = (input: {
  reviewId: string;
  environment?: "paper" | "live";
  blockers: string[];
  review?: HedgeExecutionReview | null;
  verification?: HedgeExecutionReviewVerification;
  capitalEvidence?: HedgeCapitalEvidence;
}) => ({
  paperOnly: true as const,
  environment: input.environment ?? "paper",
  status: "blocked" as const,
  reviewId: input.reviewId,
  clientOrderId: input.review?.clientOrderId ?? null,
  brokerOrderId: null,
  symbol: input.review?.orderIntent.symbol ?? null,
  requestId: input.review?.requestId ?? null,
  correlationId: input.review?.correlationId ?? null,
  filledQuantity: 0,
  averageFillPrice: null,
  attempts: 0,
  reservationId: null,
  blockers: [...new Set(input.blockers)],
  warnings: [],
  ...(input.capitalEvidence ? { capitalEvidence: input.capitalEvidence } : {}),
  ...(input.verification ? { verification: input.verification } : {})
});

const orderStatus = (order: AlpacaSubmittedOrder | null) => String(order?.status || "").toLowerCase();

export const executeReviewedPaperHedge = async (
  input: { reviewId: string; confirmPaper: boolean },
  deps: HedgeExecutionDeps = {}
): Promise<HedgeExecutionReport> => {
  if (input.confirmPaper !== true) return blockedReport({ reviewId: input.reviewId, blockers: ["CONFIRM_PAPER_REQUIRED"] });
  const state = getTradingSafetyState();
  const environment = state.alpacaEnv === "paper" ? "paper" : "live";
  const unsafeBlockers = [
    ...(environment !== "paper" ? ["HEDGE_ENVIRONMENT_NOT_PAPER"] : []),
    ...(state.liveTradingEnabled || parseBoolean("ALPACA_LIVE_TRADE") || parseBoolean("LIVE_TRADING_ENABLED") ? ["HEDGE_LIVE_TRADING_ENABLED"] : []),
    ...(!parseBoolean("PAPER_ORDER_EXECUTION_ENABLED") ? ["PAPER_EXECUTION_FLAG_REQUIRED"] : []),
    ...(!parseBoolean("PAPER_OPTIONS_EXECUTION_ENABLED") ? ["HEDGE_OPTIONS_EXECUTION_DISABLED"] : []),
    ...(!parseBoolean("HEDGE_PAPER_EXECUTION_ENABLED") ? ["HEDGE_EXECUTION_DISABLED"] : []),
    ...(parseBoolean("HEDGE_LIVE_EXECUTION_ENABLED") ? ["HEDGE_LIVE_EXECUTION_ENABLED"] : []),
    ...(parseBoolean("MULTI_LEG_HEDGE_EXECUTION_ENABLED") ? ["MULTI_LEG_EXECUTION_UNSUPPORTED"] : []),
    ...(!process.env.HEDGE_REVIEW_SIGNING_KEY?.trim() ? ["HEDGE_REVIEW_SIGNING_KEY_REQUIRED"] : [])
  ];
  if (unsafeBlockers.length) return blockedReport({ reviewId: input.reviewId, environment, blockers: unsafeBlockers });

  const now = deps.now?.() ?? new Date().toISOString();
  const postgresAuthority = executionStateProjectionService.isAuthorityActive();
  if (!postgresAuthority) releaseExpiredHedgeReservations(now);
  const expectedReservationFingerprint = postgresAuthority
    ? ""
    : paperSubmitReservationFingerprint(
        normalizePaperSubmitReservations(listActivePaperNewRiskReservations())
      );
  const expectedNewRiskLedgerFingerprint = postgresAuthority
    ? ""
    : paperNewRiskLedgerMutationFingerprint();
  const signingKey = process.env.HEDGE_REVIEW_SIGNING_KEY!.trim();
  const stored = (deps.readReview ?? readHedgeExecutionReview)({
    reviewId: input.reviewId,
    signingKey,
    asOf: now,
    requireReviewedStatus: !postgresAuthority
  });
  if (!stored.review || !stored.verification.valid) {
    return blockedReport({
      reviewId: input.reviewId,
      blockers: stored.verification.blockers,
      review: stored.review,
      verification: stored.verification
    });
  }
  const review = stored.review;
  if (review.orderIntent.structure !== "long_put" || review.orderIntent.side !== "buy_to_open") {
    return blockedReport({ reviewId: input.reviewId, blockers: ["MULTI_LEG_EXECUTION_UNSUPPORTED"], review });
  }

  const config = buildHedgeConfig();
  let accountResponse: Awaited<ReturnType<typeof getAccount>>;
  let positionsResponse: Awaited<ReturnType<NonNullable<HedgeExecutionDeps["listPositions"]>>>;
  let ordersResponse: Awaited<ReturnType<NonNullable<HedgeExecutionDeps["listOrders"]>>>;
  let ledgerEntries: PaperExecutionLedgerEntry[];
  try {
    [accountResponse, positionsResponse, ordersResponse] = await Promise.all([
      (deps.getAccount ?? getAccount)(),
      (deps.listPositions ?? defaultListPositions)(),
      (deps.listOrders ?? defaultListOrders)()
    ]);
    ledgerEntries = postgresAuthority
      ? []
      : (deps.listLedger ?? listPaperExecutionLedgerEntries)(500);
  } catch {
    return blockedReport({
      reviewId: input.reviewId,
      blockers: [
        "HEDGE_CAPITAL_SOURCE_UNAVAILABLE",
        "HEDGE_CAPITAL_EVIDENCE_INCOMPLETE",
        "FRESH_REVIEW_REQUIRED"
      ],
      review
    });
  }
  const account = accountResponse.data;
  const accountHash = paperAccountIdentityHash(account);
  const capitalEvidence = buildHedgeCapitalEvidence({
    asOf: now,
    allowedUnderlyings: config.executionPolicy.allowedUnderlyings,
    positions: positionsResponse.positions,
    orders: ordersResponse.orders,
    ledger: ledgerEntries.map((entry) => ({
      ledgerId: entry.id,
      mode: entry.mode,
      strategy: entry.strategy,
      symbol: entry.symbol,
      side: entry.side,
      status: entry.status,
      quantity: entry.qty,
      limitPrice: entry.limitPrice,
      estimatedPremium: entry.estimatedPremium,
      clientOrderId: entry.clientOrderId,
      brokerOrderId: entry.alpacaOrderId,
      createdAt: entry.createdAt,
      rawResponseJson: entry.rawResponseJson
    }))
  });
  const freshVerification = verifyHedgeExecutionReview({
    review,
    signingKey,
    asOf: now,
    accountHash,
    configurationFingerprint: hedgeConfigurationFingerprint(config),
    capitalEvidenceFingerprint: capitalEvidence.fingerprint
  });
  const verificationBlockers = [...freshVerification.blockers];
  if (
    verificationBlockers.some((blocker) =>
      [
        "HEDGE_ACCOUNT_IDENTITY_MISMATCH",
        "HEDGE_CONFIGURATION_MISMATCH",
        "HEDGE_CAPITAL_EVIDENCE_CHANGED"
      ].includes(blocker)
    )
  ) {
    verificationBlockers.push("FRESH_REVIEW_REQUIRED");
  }
  if (!capitalEvidence.complete) {
    verificationBlockers.push(
      ...capitalEvidence.blockers,
      "HEDGE_CAPITAL_EVIDENCE_INCOMPLETE",
      "FRESH_REVIEW_REQUIRED"
    );
  }
  if (verificationBlockers.length) {
    return blockedReport({
      reviewId: input.reviewId,
      blockers: verificationBlockers,
      review,
      verification: {
        ...freshVerification,
        valid: false,
        blockers: [...new Set(verificationBlockers)]
      },
      capitalEvidence
    });
  }
  const equity = numberValue(account.equity);
  const newPremium = review.orderIntent.maxPremium;
  const capitalCapBlockers = hedgeCapitalCapBlockers({
    equity,
    newPremium,
    capitalEvidence,
    config
  });
  if (capitalCapBlockers.length) {
    return blockedReport({
      reviewId: input.reviewId,
      blockers: capitalCapBlockers,
      review,
      verification: freshVerification,
      capitalEvidence
    });
  }
  const reconciliation = reconcileHedgeAccountState({
    review,
    currentAccountHash: accountHash,
    accountStatus: String(account.status || ""),
    accountEnvironment: environment,
    buyingPower: numberValue(account.buying_power) ?? 0,
    requiredPremium: review.orderIntent.maxPremium,
    optionApprovalLevel: numberValue(account.options_approved_level) ?? 0,
    positions: positionsResponse.positions.map((position) => ({
      symbol: String(position.symbol || ""),
      quantity: numberValue(position.qty) ?? 0
    })),
    openOrders: ordersResponse.orders.map((order) => ({
      symbol: String(order.symbol || ""),
      clientOrderId: order.client_order_id ?? undefined,
      status: order.status ?? undefined
    })),
    ledger: ledgerEntries.map((entry) => ({
      clientOrderId: entry.clientOrderId,
      status: entry.status
    }))
  });
  if (!reconciliation.valid) {
    return {
      ...blockedReport({
        reviewId: input.reviewId,
        blockers: reconciliation.blockers,
        review,
        capitalEvidence
      }),
      reconciliation
    };
  }

  const quote = await (deps.refreshQuote ?? defaultRefreshQuote)(review.orderIntent.symbol);
  const validation = validatePaperHedgeOptionOrder({
    environment,
    liveTradingEnabled: state.liveTradingEnabled,
    optionsExecutionEnabled: parseBoolean("PAPER_OPTIONS_EXECUTION_ENABLED"),
    symbol: review.orderIntent.symbol,
    underlying: review.orderIntent.underlying,
    quantity: review.orderIntent.quantity,
    limitPrice: review.orderIntent.limitPrice,
    bid: quote.bid,
    ask: quote.ask,
    delta: quote.delta,
    dte: Number(review.marketEvidence.daysToExpiration ?? 0),
    quoteTimestamp: quote.quoteTimestamp,
    asOf: now,
    maxQuoteAgeSeconds: config.executionPolicy.limitPriceMaxAgeSeconds,
    maxSpreadPct: config.executionPolicy.maxBidAskSpreadPct,
    maxQuantity: review.caps.maxQuantity,
    maxPremium: review.caps.maxPremium,
    maxPortfolioAllocation: config.executionPolicy.maxNewHedgePremiumPctEquity,
    portfolioEquity: numberValue(account.equity) ?? 0,
    buyingPower: numberValue(account.buying_power) ?? 0,
    optionApprovalLevel: numberValue(account.options_approved_level) ?? 0,
    structure: review.orderIntent.structure,
    targetAbsDeltaMin: config.executionPolicy.targetAbsDeltaMin,
    targetAbsDeltaMax: config.executionPolicy.targetAbsDeltaMax,
    minDte: config.executionPolicy.minDte,
    maxDte: config.executionPolicy.maxDte
  });
  if (!validation.valid) {
    return {
      ...blockedReport({
        reviewId: input.reviewId,
        blockers: validation.blockers,
        review,
        capitalEvidence
      }),
      reconciliation,
      validation
    };
  }
  const freshReferencePrice =
    quote.midpoint ??
    (quote.bid !== null && quote.ask !== null
      ? (quote.bid + quote.ask) / 2
      : null);
  const priceDriftPct =
    freshReferencePrice !== null && review.orderIntent.limitPrice > 0
      ? (Math.abs(freshReferencePrice - review.orderIntent.limitPrice) /
          review.orderIntent.limitPrice) *
        100
      : null;
  if (
    priceDriftPct === null ||
    priceDriftPct / 100 > config.executionPolicy.limitPriceMaxDriftPct
  ) {
    return {
      ...blockedReport({
        reviewId: input.reviewId,
        blockers: ["HEDGE_PRICE_DRIFT", "FRESH_REVIEW_REQUIRED"],
        review,
        capitalEvidence
      }),
      reconciliation,
      validation
    };
  }

  let executionEntry: PaperExecutionLedgerEntry;
  let reservationId: number | null = null;
  if (postgresAuthority) {
    executionEntry = buildPaperExecutionLedgerEntry({
      mode: "hedge-entry",
      assetClass: "option",
      symbol: review.orderIntent.symbol,
      underlyingSymbol: review.orderIntent.underlying,
      strategy: "portfolio_hedge",
      side: "buy",
      orderType: "limit",
      timeInForce: "day",
      qty: String(review.orderIntent.quantity),
      limitPrice: String(review.orderIntent.limitPrice),
      estimatedPremium: review.orderIntent.maxPremium,
      maxRisk: review.orderIntent.maxPremium,
      dedupeKey: `hedge-review:${review.reviewId}`,
      clientOrderId: review.clientOrderId,
      status: "reserved",
      requestId: review.requestId,
      sourcePlanId: review.reviewId,
      payload: {
        reviewId: review.reviewId,
        clientOrderId: review.clientOrderId,
        symbol: review.orderIntent.symbol,
        quantity: review.orderIntent.quantity,
        limitPrice: review.orderIntent.limitPrice,
        estimatedPremium: review.orderIntent.maxPremium,
        expiresAt: review.expiresAt,
        mode: "hedge-entry",
        side: "buy",
        positionIntent: "buy_to_open"
      }
    }, { createdAt: now });
  } else {
    const reservation = reservePaperExecutionAttempt({
      reviewId: review.reviewId,
      clientOrderId: review.clientOrderId,
      symbol: review.orderIntent.symbol,
      underlyingSymbol: review.orderIntent.underlying,
      quantity: review.orderIntent.quantity,
      limitPrice: review.orderIntent.limitPrice,
      estimatedPremium: review.orderIntent.maxPremium,
      expiresAt: review.expiresAt,
      requestId: review.requestId,
      consumeReview: true,
      validateBeforeInsert: () => {
        const currentReservations = normalizePaperSubmitReservations(
          listActivePaperNewRiskReservations()
        );
        if (
          paperNewRiskLedgerMutationFingerprint() !==
            expectedNewRiskLedgerFingerprint ||
          paperSubmitReservationFingerprint(currentReservations) !==
            expectedReservationFingerprint
        ) {
          return [
            "HEDGE_RESERVATION_STATE_DRIFT",
            "FRESH_REVIEW_REQUIRED"
          ];
        }
        const currentCapBlockers = hedgeCapitalCapBlockers({
          equity,
          newPremium,
          capitalEvidence,
          config
        });
        return currentCapBlockers.length
          ? [...currentCapBlockers, "FRESH_REVIEW_REQUIRED"]
          : [];
      }
    });
    if (!reservation.reserved) {
      return {
        ...blockedReport({
          reviewId: input.reviewId,
          blockers: reservation.blockers,
          review,
          capitalEvidence
        }),
        reconciliation,
        validation,
        reservationId: reservation.entry?.id ?? null
      } as HedgeExecutionReport;
    }
    executionEntry = reservation.entry;
    reservationId = reservation.entry.id;
  }

  const payload: AlpacaPaperOrderRequest = {
    symbol: review.orderIntent.symbol,
    qty: String(review.orderIntent.quantity),
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: String(review.orderIntent.limitPrice),
    client_order_id: review.clientOrderId,
    position_intent: "buy_to_open"
  };
  const authorizeExecution = deps.authorizeExecution ??
    executionStateProjectionService.reserveOrderIntent;
  const recordExecutionResult = deps.recordExecutionResult ??
    executionStateProjectionService.recordBrokerResult;
  const authorizeBrokerMutation = deps.authorizeBrokerMutation ??
    executionStateProjectionService.authorizeBrokerMutation;
  const storeExecutionEvidence = deps.storeExecutionEvidence ??
    executionStateProjectionService.storeHedgeReviewEvidence;
  const updateCurrentExecution = (update: PaperExecutionLedgerUpdate) => {
    if (postgresAuthority) {
      executionEntry = applyPaperExecutionLedgerUpdate(executionEntry, update);
      return;
    }
    updatePaperExecutionLedgerEntry(executionEntry.id, update);
    executionEntry = findPaperExecutionById(executionEntry.id) ?? executionEntry;
  };
  const recordCurrentExecution = async () => recordExecutionResult(executionEntry);
  await storeExecutionEvidence(review, executionEntry);
  const postgresAuthorization = await authorizeExecution(executionEntry);
  if (!postgresAuthorization.brokerAllowed) {
    const blockers = [...(postgresAuthorization.blockers ?? [
      "POSTGRES_EXECUTION_RESERVATION_BLOCKED"
    ])];
    updateCurrentExecution({
      status: "released",
      reason: blockers[0],
      blockedReason: blockers[0]
    });
    return {
      ...blockedReport({ reviewId: input.reviewId, blockers, review, capitalEvidence }),
      reconciliation,
      validation,
      reservationId
    } as HedgeExecutionReport;
  }
  let response: AlpacaApiResponse<AlpacaSubmittedOrder>;
  try {
    response = await (deps.submitPaperOrder ?? submitPaperOrder)(payload);
  } catch (error) {
    updateCurrentExecution({
      status: "failed",
      reason: "HEDGE_ORDER_SUBMISSION_FAILED",
      errorMessage: error instanceof Error ? error.message : "Paper hedge submission failed."
    });
    await recordCurrentExecution();
    return {
      ...blockedReport({
        reviewId: input.reviewId,
        blockers: ["HEDGE_ORDER_SUBMISSION_FAILED"],
        review,
        capitalEvidence
      }),
      reconciliation,
      validation,
      reservationId
    } as HedgeExecutionReport;
  }
  let brokerOrderId = response.data.id ?? null;
  updateCurrentExecution({
    status: "submitted",
    alpacaOrderId: brokerOrderId,
    alpacaStatus: response.data.status ?? "submitted",
    requestId: response.requestId,
    rawResponse: response.data
  });
  await recordCurrentExecution();
  if (!brokerOrderId) {
    updateCurrentExecution({
      status: "failed",
      reason: "HEDGE_BROKER_ORDER_ID_MISSING",
      blockedReason: "HEDGE_BROKER_ORDER_ID_MISSING",
      requestId: response.requestId,
      rawResponse: response.data
    });
    await recordCurrentExecution();
    return {
      ...blockedReport({
        reviewId: input.reviewId,
        blockers: ["HEDGE_BROKER_ORDER_ID_MISSING"],
        review,
        capitalEvidence
      }),
      reconciliation,
      validation,
      reservationId
    } as HedgeExecutionReport;
  }

  const getOrder = deps.getPaperOrder ?? getPaperOrder;
  const replaceOrder = deps.replacePaperOrder ?? replacePaperOrder;
  const cancelOrder = deps.cancelPaperOrder ?? cancelPaperOrder;
  const maxRepriceAttempts = Math.max(0, Math.floor(deps.maxRepriceAttempts ?? config.executionPolicy.maxRepriceAttempts));
  let attempts = 0;
  let latest: AlpacaSubmittedOrder | null = null;
  for (let reprice = 0; reprice <= maxRepriceAttempts; reprice += 1) {
    attempts += 1;
    const orderResponse = await getOrder(brokerOrderId);
    latest = orderResponse.data;
    const status = orderStatus(latest);
    const filledQuantity = numberValue(latest.filled_qty) ?? 0;
    if (status === "filled") {
      updateCurrentExecution({ status: "filled", alpacaStatus: status, requestId: orderResponse.requestId, rawResponse: latest });
      await recordCurrentExecution();
      return {
        paperOnly: true,
        environment: "paper",
        status: "filled",
        reviewId: review.reviewId,
        clientOrderId: review.clientOrderId,
        brokerOrderId,
        symbol: review.orderIntent.symbol,
        requestId: orderResponse.requestId ?? response.requestId ?? null,
        correlationId: review.correlationId,
        filledQuantity,
        averageFillPrice: numberValue(latest.filled_avg_price),
        attempts,
        reservationId,
        blockers: [],
        warnings: [],
        capitalEvidence,
        reconciliation,
        validation
      };
    }
    if (["rejected", "canceled", "expired"].includes(status)) {
      const terminal = status === "rejected" ? "rejected" : "canceled";
      updateCurrentExecution({ status: terminal, alpacaStatus: status, requestId: orderResponse.requestId, rawResponse: latest });
      await recordCurrentExecution();
      return {
        paperOnly: true,
        environment: "paper",
        status: terminal,
        reviewId: review.reviewId,
        clientOrderId: review.clientOrderId,
        brokerOrderId,
        symbol: review.orderIntent.symbol,
        requestId: orderResponse.requestId ?? response.requestId ?? null,
        correlationId: review.correlationId,
        filledQuantity,
        averageFillPrice: numberValue(latest.filled_avg_price),
        attempts,
        reservationId,
        blockers: terminal === "rejected" ? ["HEDGE_ORDER_REJECTED"] : [],
        warnings: [],
        capitalEvidence,
        reconciliation,
        validation
      };
    }
    if (reprice < maxRepriceAttempts) {
      const nextQuote = await (deps.refreshQuote ?? defaultRefreshQuote)(review.orderIntent.symbol);
      if (!nextQuote.ask || nextQuote.ask <= 0 || nextQuote.ask > review.orderIntent.limitPrice) break;
      const authorization = await authorizeBrokerMutation(executionEntry, "replace");
      if (!authorization.brokerAllowed) {
        return {
          ...blockedReport({
            reviewId: input.reviewId,
            blockers: [...(authorization.blockers ?? ["EXECUTION_BROKER_MUTATION_BLOCKED"])],
            review,
            capitalEvidence
          }),
          reconciliation,
          validation,
          reservationId
        } as HedgeExecutionReport;
      }
      const replacement = await replaceOrder(brokerOrderId, {
        limit_price: String(Math.min(nextQuote.ask, review.orderIntent.limitPrice))
      });
      const replacementOrderId = replacement.data.id ?? null;
      const replacementClientOrderId = replacement.data.client_order_id ?? null;
      const replacedOrderId = replacement.data.replaces ?? null;
      if (
        postgresAuthority &&
        (
          !replacementOrderId ||
          !replacementClientOrderId ||
          replacedOrderId !== brokerOrderId
        )
      ) {
        updateCurrentExecution({
          status: "failed",
          reason: "HEDGE_REPLACEMENT_IDENTITY_MISSING",
          blockedReason: "HEDGE_REPLACEMENT_IDENTITY_MISSING",
          errorMessage: "Broker replacement network result was ambiguous.",
          requestId: replacement.requestId,
          rawResponse: replacement.data
        });
        await recordCurrentExecution();
        return {
          ...blockedReport({
            reviewId: input.reviewId,
            blockers: ["HEDGE_REPLACEMENT_RECONCILIATION_REQUIRED"],
            review,
            capitalEvidence
          }),
          reconciliation,
          validation,
          reservationId
        } as HedgeExecutionReport;
      }
      if (replacementOrderId && replacementOrderId !== brokerOrderId) {
        brokerOrderId = replacementOrderId;
        updateCurrentExecution({
          status: "submitted",
          alpacaOrderId: brokerOrderId,
          alpacaStatus: replacement.data.status ?? "submitted",
          requestId: replacement.requestId,
          rawResponse: replacement.data
        });
        await recordCurrentExecution();
      }
      await (deps.sleep ?? (async () => undefined))(0);
    }
  }

  const cancelAuthorization = await authorizeBrokerMutation(executionEntry, "cancel");
  if (!cancelAuthorization.brokerAllowed) {
    return {
      ...blockedReport({
        reviewId: input.reviewId,
        blockers: [...(cancelAuthorization.blockers ?? ["EXECUTION_BROKER_MUTATION_BLOCKED"])],
        review,
        capitalEvidence
      }),
      reconciliation,
      validation,
      reservationId
    } as HedgeExecutionReport;
  }
  const canceled = await cancelOrder(brokerOrderId);
  const filledQuantity = numberValue(latest?.filled_qty) ?? 0;
  const status: HedgeExecutionStatus = filledQuantity > 0 ? "partial" : "canceled";
  updateCurrentExecution({
    status,
    alpacaStatus: "canceled",
    requestId: canceled.requestId,
    rawResponse: latest
  });
  await recordCurrentExecution();
  return {
    paperOnly: true,
    environment: "paper",
    status,
    reviewId: review.reviewId,
    clientOrderId: review.clientOrderId,
    brokerOrderId,
    symbol: review.orderIntent.symbol,
    requestId: canceled.requestId ?? response.requestId ?? null,
    correlationId: review.correlationId,
    filledQuantity,
    averageFillPrice: numberValue(latest?.filled_avg_price),
    attempts,
    reservationId,
    blockers: [],
    warnings: status === "partial" ? ["HEDGE_PARTIAL_FILL_CANCELED_REMAINDER"] : [],
    capitalEvidence,
    reconciliation,
    validation
  };
};
