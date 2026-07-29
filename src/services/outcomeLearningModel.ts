import { canonicalJsonHash } from "../lib/canonicalJson.js";

export const OUTCOME_LEARNING_SCHEMA_VERSION = 1;

export type OutcomeEnvironment = "paper" | "live" | "unknown";
export type OutcomeLane =
  | "equity"
  | "options_0dte"
  | "options_leaps"
  | "unknown";
export type OutcomeJoinStatus =
  | "exact"
  | "partial"
  | "missing"
  | "ambiguous"
  | "unsupported";

export const PAPER_OUTCOME_LIMITATIONS = [
  "MARKET_IMPACT_NOT_FULLY_MODELED",
  "QUEUE_POSITION_NOT_FULLY_MODELED",
  "INFORMATION_LEAKAGE_NOT_MODELED",
  "LATENCY_SLIPPAGE_MAY_NOT_BE_REALISTIC",
  "PRICE_IMPROVEMENT_MAY_NOT_BE_REALISTIC",
  "ACTUAL_LIQUIDITY_CONSTRAINTS_MAY_NOT_BE_FULLY_REPRESENTED",
  "REGULATORY_FEES_MAY_BE_ABSENT_OR_INCOMPLETE",
  "DIVIDENDS_MAY_BE_ABSENT_OR_INCOMPLETE",
  "EXERCISE_ASSIGNMENT_AND_SETTLEMENT_MAY_DIFFER",
  "PARTIAL_FILL_BEHAVIOR_MAY_DIFFER",
  "SHORT_AVAILABILITY_AND_BORROW_COSTS_MAY_DIFFER"
] as const;

export type OutcomeCandidateInput = {
  id: string;
  cycleId?: string;
  symbol: string;
  underlyingSymbol: string;
  optionContractId?: string;
  strategyFamily?: string;
  timeHorizon?: string;
  score?: number | null;
  confidence?: number | null;
  decision?: string;
  lifecycleStatus?: string;
  asOf: string;
  reasonCodes?: string[];
  researchSignalIds?: string[];
  researchHorizons?: string[];
  catalysts?: string[];
  spreadBps?: number | null;
  liquidityScore?: number | null;
};

export type OutcomeArbitrationInput = {
  id: string;
  proposalId: string;
  cycleId?: string;
  schedulerRunId?: string;
  lane?: string;
  action?: string;
  reasonCodes?: string[];
  createdAt: string;
};

export type OutcomeReviewInput = {
  id: string;
  candidateId: string;
  reviewType?: "entry" | "exit";
  environment?: string;
  status?: string;
  createdAt: string;
  marketEvidenceIds?: string[];
  reasonCodes?: string[];
};

export type OutcomeIntentInput = {
  id: string;
  candidateId: string;
  reviewId?: string;
  clientOrderId?: string;
  status?: string;
  quantity?: number | null;
  parentPositionId?: string;
  createdAt: string;
  submittedAt?: string;
};

export type OutcomeOrderInput = {
  id: string;
  intentId: string;
  clientOrderId?: string;
  brokerOrderId?: string;
  status?: string;
  side?: "buy" | "sell";
  requestedQuantity?: number | null;
  filledQuantity?: number | null;
  averageFillPrice?: number | null;
  submittedAt?: string;
  filledAt?: string;
};

export type OutcomeBrokerEventInput = {
  id: string;
  brokerEventId?: string;
  orderId?: string;
  intentId?: string;
  status?: string;
  filledQuantity?: number | null;
  occurredAt: string;
};

export type OutcomePositionInput = {
  id: string;
  candidateId?: string;
  openingOrderId?: string;
  closingOrderId?: string;
  status?: string;
  assetClass?: string;
  quantity?: number | null;
  averageEntryPrice?: number | null;
  currentPrice?: number | null;
  unrealizedPnl?: number | null;
  realizedPnl?: number | null;
  costBasis?: number | null;
  contractMultiplier?: number | null;
  openedAt?: string;
  closedAt?: string;
  lastReconciledAt?: string;
  sourceAccountSnapshotId?: string;
};

export type MarketObservationInput = {
  id: string;
  instrument: string;
  observedAt: string;
  receivedAt?: string | null;
  persistedAt?: string | null;
  provider: string;
  feed?: string | null;
  bid?: number | null;
  ask?: number | null;
  midpoint?: number | null;
  last?: number | null;
  requestId?: string | null;
};

export type ExcursionObservationInput = {
  id: string;
  instrument: string;
  observedAt: string;
  high?: number | null;
  low?: number | null;
  price?: number | null;
  source: string;
  granularity?: string;
};

export type OutcomeLearningInput = {
  calculatedAt: string;
  refreshRunId: string;
  environment: OutcomeEnvironment;
  sourceLimitations?: string[];
  candidate: OutcomeCandidateInput;
  arbitrations: OutcomeArbitrationInput[];
  reviews: OutcomeReviewInput[];
  intents: OutcomeIntentInput[];
  orders: OutcomeOrderInput[];
  brokerEvents: OutcomeBrokerEventInput[];
  positions: OutcomePositionInput[];
  marketObservations: MarketObservationInput[];
  excursionObservations: ExcursionObservationInput[];
  referenceToleranceMs?: number;
};

export type UnrealizedReturnCheckpoint = {
  at: string;
  markSource: "position_reconciliation";
  markPrice: number | null;
  unrealizedPnl: number;
  unrealizedReturn: number;
  sourceAccountSnapshotId: string | null;
};

export type OutcomeLearningRecord = {
  outcomeId: string;
  refreshRunId: string;
  environment: OutcomeEnvironment;
  cycleId: string | null;
  schedulerRunId: string | null;
  lane: OutcomeLane;
  candidateId: string;
  proposalId: string;
  arbitrationDecisionId: string | null;
  reviewId: string | null;
  intentId: string | null;
  orderRecordId: string | null;
  clientOrderId: string | null;
  alpacaOrderId: string | null;
  positionId: string | null;
  exitReviewId: string | null;
  exitIntentId: string | null;
  exitOrderId: string | null;
  reconciliationIdentity: string | null;
  symbol: string;
  underlyingSymbol: string;
  optionContractId: string | null;
  timeHorizon: string | null;
  brokerEventIds: string[];
  fillActivityIds: string[];
  researchSignalIds: string[];
  researchHorizons: string[];
  catalysts: string[];
  marketEvidenceIds: string[];
  entryReasonCodes: string[];
  arbitrationReasonCodes: string[];
  exitReasonCodes: string[];
  proposalScore: number | null;
  proposalConfidence: number | null;
  scoreBucket: string | null;
  confidenceBucket: string | null;
  spreadBucket: string | null;
  liquidityBucket: string | null;
  arbitrationAction: string | null;
  proposedAt: string;
  reviewedAt: string | null;
  intentCreatedAt: string | null;
  submittedAt: string | null;
  firstFillAt: string | null;
  fullFillAt: string | null;
  closedAt: string | null;
  submittedStatus: string | null;
  finalOrderStatus: string | null;
  fillStatus:
    | "not_submitted"
    | "unfilled"
    | "terminal_unfilled"
    | "partially_filled"
    | "fully_filled";
  requestedQuantity: number | null;
  filledQuantity: number | null;
  averageFillPrice: number | null;
  referenceBid: number | null;
  referenceAsk: number | null;
  referenceMidpoint: number | null;
  referenceLast: number | null;
  referenceTimestamp: string | null;
  referenceReceivedAt: string | null;
  referencePersistedAt: string | null;
  referenceSource: string | null;
  referenceFeed: string | null;
  referenceLookupMethod:
    | "exact_evidence"
    | "nearest_prior_quote"
    | "nearest_prior_trade"
    | "unavailable";
  referenceLookupDistanceMs: number | null;
  referenceToleranceMs: number;
  referenceFreshnessStatus: "fresh" | "unavailable";
  fillVsBid: number | null;
  fillVsAsk: number | null;
  fillVsMidpoint: number | null;
  fillVsLast: number | null;
  spreadAtReferenceValue: number | null;
  spreadAtReferenceBps: number | null;
  slippageValue: number | null;
  slippageBps: number | null;
  slippageBasis: "midpoint" | "last" | null;
  timeIntentToSubmissionMs: number | null;
  timeProposalToSubmissionMs: number | null;
  timeToFirstFillMs: number | null;
  timeToFullFillMs: number | null;
  timeFirstFillToCloseMs: number | null;
  realizedPnl: number | null;
  realizedReturn: number | null;
  unrealizedReturnCheckpoints: UnrealizedReturnCheckpoint[];
  maximumFavorableExcursion: number | null;
  maximumAdverseExcursion: number | null;
  excursionSource: string | null;
  excursionStart: string | null;
  excursionEnd: string | null;
  holdingPeriodMs: number | null;
  joinStatus: OutcomeJoinStatus;
  joinMethods: Record<string, OutcomeJoinStatus | string>;
  partialJoinReasons: string[];
  missingJoinReasons: string[];
  ambiguousJoinReasons: string[];
  unsupportedJoinReasons: string[];
  metricLimitations: string[];
  paperLimitations: string[];
  sourceWatermark: string;
  calculatedAt: string;
  schemaVersion: number;
  contentHash: string;
};

const uniqueText = (values: readonly (string | null | undefined)[]) =>
  [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];

const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const isoTime = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const elapsed = (start: string | null, end: string | null): number | null => {
  const startMs = start ? isoTime(start) : null;
  const endMs = end ? isoTime(end) : null;
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return endMs - startMs;
};

const laneFor = (
  candidate: OutcomeCandidateInput,
  arbitration: OutcomeArbitrationInput | null
): OutcomeLane => {
  const value = arbitration?.lane ?? candidate.strategyFamily ?? "";
  if (value === "equity") return "equity";
  if (["options_0dte", "zero_dte", "0dte"].includes(value)) return "options_0dte";
  if (["options_leaps", "leaps"].includes(value)) return "options_leaps";
  return candidate.optionContractId ? "unknown" : "equity";
};

const scoreBucket = (score: number | null) => {
  if (score === null) return null;
  if (score < 20) return "0-20";
  if (score < 40) return "20-40";
  if (score < 60) return "40-60";
  if (score < 80) return "60-80";
  return "80-100";
};

const confidenceBucket = (confidence: number | null) => {
  if (confidence === null) return null;
  if (confidence < 0.25) return "0.00-0.25";
  if (confidence < 0.5) return "0.25-0.50";
  if (confidence < 0.75) return "0.50-0.75";
  return "0.75-1.00";
};

const spreadBucket = (spreadBps: number | null) => {
  if (spreadBps === null) return null;
  if (spreadBps <= 25) return "0-25bps";
  if (spreadBps <= 50) return "25-50bps";
  if (spreadBps <= 100) return "50-100bps";
  return ">100bps";
};

const liquidityBucket = (score: number | null) => {
  if (score === null) return null;
  if (score >= 0.75) return "high";
  if (score >= 0.4) return "medium";
  return "low";
};

const holdingPeriodBucket = (holdingPeriodMs: number | null) => {
  if (holdingPeriodMs === null) return null;
  const day = 86_400_000;
  if (holdingPeriodMs < day) return "<1d";
  if (holdingPeriodMs < day * 7) return "1-7d";
  if (holdingPeriodMs < day * 30) return "7-30d";
  return ">=30d";
};

const selectSingle = <T>(
  rows: T[],
  missingCode: string,
  ambiguousCode: string,
  missing: string[],
  ambiguous: string[]
) => {
  if (rows.length === 0) {
    missing.push(missingCode);
    return null;
  }
  if (rows.length > 1) {
    ambiguous.push(ambiguousCode);
    return null;
  }
  return rows[0]!;
};

export const selectReferenceMarketObservation = (input: {
  instrument: string;
  eventAt: string;
  toleranceMs: number;
  exactEvidenceIds: readonly string[];
  observations: readonly MarketObservationInput[];
}) => {
  const eventMs = isoTime(input.eventAt);
  const candidates = input.observations.filter(
    (observation) => observation.instrument === input.instrument
  );
  if (eventMs === null) {
    return {
      observation: null,
      method: "unavailable" as const,
      distanceMs: null,
      candidates
    };
  }
  const eligible = candidates
    .map((observation) => ({
      observation,
      at: isoTime(observation.observedAt)
    }))
    .filter(
      (entry): entry is { observation: MarketObservationInput; at: number } =>
        entry.at !== null &&
        entry.at <= eventMs &&
        eventMs - entry.at <= input.toleranceMs
    );
  const exact = eligible
    .filter((entry) => input.exactEvidenceIds.includes(entry.observation.id))
    .sort((left, right) => right.at - left.at)[0];
  if (exact) {
    return {
      observation: exact.observation,
      method: "exact_evidence" as const,
      distanceMs: eventMs - exact.at,
      candidates
    };
  }
  const nearest = eligible.sort((left, right) => right.at - left.at)[0];
  if (!nearest) {
    return {
      observation: null,
      method: "unavailable" as const,
      distanceMs: null,
      candidates
    };
  }
  const hasQuote = finite(nearest.observation.bid) !== null ||
    finite(nearest.observation.ask) !== null ||
    finite(nearest.observation.midpoint) !== null;
  return {
    observation: nearest.observation,
    method: hasQuote
      ? "nearest_prior_quote" as const
      : "nearest_prior_trade" as const,
    distanceMs: eventMs - nearest.at,
    candidates
  };
};

const excursionFor = (input: {
  candidate: OutcomeCandidateInput;
  position: OutcomePositionInput | null;
  order: OutcomeOrderInput | null;
  firstFillAt: string | null;
  closedAt: string | null;
  observations: OutcomeLearningInput["excursionObservations"];
  metricLimitations: string[];
}) => {
  const entryPrice = finite(input.position?.averageEntryPrice) ??
    finite(input.order?.averageFillPrice);
  const start = input.firstFillAt ?? input.position?.openedAt ?? null;
  const end = input.closedAt ?? input.position?.lastReconciledAt ?? null;
  if (entryPrice === null || entryPrice <= 0 || !start || !end) {
    return {
      maximumFavorableExcursion: null,
      maximumAdverseExcursion: null,
      excursionSource: null,
      excursionStart: start,
      excursionEnd: end
    };
  }
  const startMs = isoTime(start);
  const endMs = isoTime(end);
  const maximumEnd = startMs === null ? null : startMs + 31 * 86_400_000;
  if (startMs === null || endMs === null) {
    return {
      maximumFavorableExcursion: null,
      maximumAdverseExcursion: null,
      excursionSource: null,
      excursionStart: start,
      excursionEnd: end
    };
  }
  const points = input.observations
    .filter((observation) => {
      const at = isoTime(observation.observedAt);
      return observation.instrument === input.candidate.symbol &&
        at !== null &&
        at >= startMs &&
        at <= Math.min(endMs, maximumEnd!);
    })
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .slice(0, 500);
  if (points.length === 0) {
    input.metricLimitations.push(
      input.candidate.optionContractId
        ? "OPTION_CONTRACT_EXCURSION_EVIDENCE_UNAVAILABLE"
        : "EQUITY_EXCURSION_EVIDENCE_UNAVAILABLE"
    );
    return {
      maximumFavorableExcursion: null,
      maximumAdverseExcursion: null,
      excursionSource: null,
      excursionStart: start,
      excursionEnd: end
    };
  }
  const highs = points
    .map((point) => finite(point.high) ?? finite(point.price))
    .filter((value): value is number => value !== null);
  const lows = points
    .map((point) => finite(point.low) ?? finite(point.price))
    .filter((value): value is number => value !== null);
  if (highs.length === 0 || lows.length === 0) {
    input.metricLimitations.push("EXCURSION_PRICE_FIELDS_UNAVAILABLE");
    return {
      maximumFavorableExcursion: null,
      maximumAdverseExcursion: null,
      excursionSource: null,
      excursionStart: start,
      excursionEnd: end
    };
  }
  const side = input.order?.side ?? "buy";
  const favorablePrice = side === "buy" ? Math.max(...highs) : Math.min(...lows);
  const adversePrice = side === "buy" ? Math.min(...lows) : Math.max(...highs);
  const signedReturn = (price: number) =>
    side === "buy"
      ? (price - entryPrice) / entryPrice
      : (entryPrice - price) / entryPrice;
  const first = points[0]!;
  return {
    maximumFavorableExcursion: signedReturn(favorablePrice),
    maximumAdverseExcursion: signedReturn(adversePrice),
    excursionSource: input.candidate.optionContractId
      ? `${first.source}:${first.granularity ?? "snapshot"}:contract_mark_to_market`
      : `${first.source}:${first.granularity ?? "snapshot"}:mark_to_market`,
    excursionStart: start,
    excursionEnd: end
  };
};

export const buildOutcomeLearningRecord = (
  input: OutcomeLearningInput
): OutcomeLearningRecord => {
  const partial: string[] = [...(input.sourceLimitations ?? [])];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const unsupported: string[] = [];
  const limitations = ["FILL_ACTIVITY_ID_NOT_PERSISTED"];
  const candidateId = input.candidate.id;
  const arbitrations = input.arbitrations.filter(
    (entry) => entry.proposalId === candidateId
  );
  const arbitration = selectSingle(
    arbitrations,
    "ARBITRATION_DECISION_MISSING",
    "ARBITRATION_DECISION_AMBIGUOUS",
    missing,
    ambiguous
  );
  const reviews = input.reviews.filter(
    (entry) =>
      entry.candidateId === candidateId &&
      (entry.reviewType ?? "entry") === "entry"
  );
  const entryIntents = input.intents.filter(
    (entry) => entry.candidateId === candidateId && !entry.parentPositionId
  );
  const entryIntentIds = new Set(entryIntents.map((entry) => entry.id));
  const entryOrders = input.orders.filter((entry) =>
    entryIntentIds.has(entry.intentId)
  );
  const entryOrderIds = new Set(entryOrders.map((entry) => entry.id));
  const candidatePositions = input.positions.filter(
    (entry) =>
      entry.candidateId === candidateId ||
      (entry.openingOrderId ? entryOrderIds.has(entry.openingOrderId) : false)
  );
  let review: OutcomeReviewInput | null = null;
  let intent: OutcomeIntentInput | null = null;
  let order: OutcomeOrderInput | null = null;
  let position: OutcomePositionInput | null = null;

  const reviewForIntent = (
    selectedIntent: OutcomeIntentInput | null
  ): OutcomeReviewInput | null => {
    if (!selectedIntent) {
      return selectSingle(
        reviews,
        "REVIEW_MISSING",
        "REVIEW_AMBIGUOUS",
        missing,
        ambiguous
      );
    }
    if (selectedIntent.reviewId) {
      const linked = reviews.filter(
        (entry) => entry.id === selectedIntent.reviewId
      );
      if (linked.length === 1) return linked[0]!;
      if (linked.length > 1) {
        ambiguous.push("INTENT_REVIEW_AMBIGUOUS");
        return null;
      }
      missing.push("INTENT_REVIEW_MISSING");
      return null;
    }
    if (reviews.length === 1) {
      partial.push("REVIEW_JOIN_BY_CANDIDATE_ONLY");
      return reviews[0]!;
    }
    return selectSingle(
      reviews,
      "REVIEW_MISSING",
      "REVIEW_AMBIGUOUS",
      missing,
      ambiguous
    );
  };

  const positionLinkedChains = candidatePositions.flatMap((entry) => {
    if (!entry.openingOrderId) return [];
    const linkedOrder = entryOrders.find(
      (candidateOrder) => candidateOrder.id === entry.openingOrderId
    );
    if (!linkedOrder) return [];
    const linkedIntent = entryIntents.find(
      (candidateIntent) => candidateIntent.id === linkedOrder.intentId
    );
    return linkedIntent
      ? [{ position: entry, order: linkedOrder, intent: linkedIntent }]
      : [];
  });

  if (positionLinkedChains.length > 1) {
    ambiguous.push("MULTIPLE_POSITION_LINKED_ENTRY_ORDERS");
  } else if (positionLinkedChains.length === 1) {
    const chain = positionLinkedChains[0]!;
    position = chain.position;
    order = chain.order;
    intent = chain.intent;
    review = reviewForIntent(intent);
    if (entryOrders.some((entry) => entry.id !== order!.id)) {
      partial.push("ADDITIONAL_ENTRY_ORDERS_NOT_SELECTED");
    }
    if (entryIntents.some((entry) => entry.id !== intent!.id)) {
      partial.push("ADDITIONAL_ENTRY_INTENTS_NOT_SELECTED");
    }
    if (reviews.some((entry) => entry.id !== review?.id)) {
      partial.push("ADDITIONAL_ENTRY_REVIEWS_NOT_SELECTED");
    }
  } else if (entryOrders.length > 1) {
    ambiguous.push("ENTRY_ORDER_AMBIGUOUS");
  } else if (entryOrders.length === 1) {
    order = entryOrders[0]!;
    intent = entryIntents.find((entry) => entry.id === order!.intentId) ?? null;
    if (!intent) {
      missing.push("ORDER_INTENT_MISSING");
    }
    review = reviewForIntent(intent);
    if (entryIntents.some((entry) => entry.id !== intent?.id)) {
      partial.push("ADDITIONAL_ENTRY_INTENTS_NOT_SELECTED");
    }
    if (reviews.some((entry) => entry.id !== review?.id)) {
      partial.push("ADDITIONAL_ENTRY_REVIEWS_NOT_SELECTED");
    }
    const hasFill = (finite(order.filledQuantity) ?? 0) > 0 ||
      ["partially_filled", "filled"].includes(order.status ?? "");
    if (hasFill) {
      const exactlyLinked = candidatePositions.filter(
        (entry) => entry.openingOrderId === order!.id
      );
      if (exactlyLinked.length === 1) {
        position = exactlyLinked[0]!;
      } else if (exactlyLinked.length > 1) {
        ambiguous.push("POSITION_AMBIGUOUS");
      } else {
        const candidateOnly = candidatePositions.filter(
          (entry) => !entry.openingOrderId
        );
        if (candidateOnly.length === 1) {
          position = candidateOnly[0]!;
          partial.push("POSITION_JOIN_BY_CANDIDATE_ONLY");
        } else if (candidateOnly.length > 1) {
          ambiguous.push("POSITION_AMBIGUOUS");
        } else {
          missing.push("POSITION_MISSING");
        }
      }
    }
  } else if (entryIntents.length === 1) {
    intent = entryIntents[0]!;
    review = reviewForIntent(intent);
    missing.push("ORDER_MISSING");
  } else if (entryIntents.length > 1) {
    ambiguous.push("ENTRY_INTENT_AMBIGUOUS");
    review = reviewForIntent(null);
  } else {
    missing.push("ENTRY_INTENT_MISSING");
    review = reviewForIntent(null);
  }

  const terminalUnfilled = order &&
    ["rejected", "canceled", "cancelled", "expired"].includes(
      order.status ?? ""
    ) &&
    (finite(order.filledQuantity) ?? 0) === 0;
  const supportedFillStatus = order &&
    ["partially_filled", "filled"].includes(order.status ?? "");
  if (terminalUnfilled) {
    limitations.push("TERMINAL_ORDER_WITHOUT_FILL");
  } else if (
    order &&
    (
      (finite(order.filledQuantity) ?? 0) === 0 ||
      (!supportedFillStatus && (finite(order.filledQuantity) ?? 0) === 0)
    )
  ) {
    missing.push("FILL_MISSING");
  }
  if (order?.status === "replaced") {
    unsupported.push("REPLACEMENT_LINEAGE_NOT_PERSISTED_IN_OUTCOME");
  }
  const filledQuantity = finite(order?.filledQuantity);
  const fillStatus: OutcomeLearningRecord["fillStatus"] =
    order?.status === "filled"
      ? "fully_filled"
      : order?.status === "partially_filled" ||
          (filledQuantity !== null && filledQuantity > 0)
        ? "partially_filled"
        : terminalUnfilled
          ? "terminal_unfilled"
          : order
            ? "unfilled"
            : "not_submitted";

  const exitIntents = position
    ? input.intents.filter((entry) => entry.parentPositionId === position.id)
    : [];
  const shouldHaveExit = position?.status === "closed";
  const exitIntentIds = new Set(exitIntents.map((entry) => entry.id));
  const exitOrders = input.orders.filter((entry) =>
    exitIntentIds.has(entry.intentId)
  );
  let exitIntent: OutcomeIntentInput | null = null;
  let exitOrder: OutcomeOrderInput | null = null;
  if (position?.closingOrderId) {
    const exactExitOrders = input.orders.filter(
      (entry) => entry.id === position!.closingOrderId
    );
    exitOrder = selectSingle(
      exactExitOrders,
      "EXIT_ORDER_MISSING",
      "EXIT_ORDER_AMBIGUOUS",
      missing,
      ambiguous
    );
    if (exitOrder) {
      exitIntent = input.intents.find(
        (entry) => entry.id === exitOrder!.intentId
      ) ?? null;
      if (!exitIntent) {
        missing.push("EXIT_INTENT_MISSING");
      } else if (exitIntent.parentPositionId !== position.id) {
        partial.push("EXIT_INTENT_POSITION_LINK_MISSING");
      }
    }
  } else if (shouldHaveExit) {
    if (exitOrders.length === 1) {
      exitOrder = exitOrders[0]!;
      exitIntent = exitIntents.find(
        (entry) => entry.id === exitOrder!.intentId
      ) ?? null;
      partial.push("EXIT_ORDER_JOIN_BY_PARENT_POSITION");
    } else if (exitOrders.length > 1) {
      ambiguous.push("EXIT_ORDER_AMBIGUOUS");
    } else if (exitIntents.length === 1) {
      exitIntent = exitIntents[0]!;
      missing.push("EXIT_ORDER_MISSING");
    } else if (exitIntents.length > 1) {
      ambiguous.push("EXIT_INTENT_AMBIGUOUS");
    } else {
      missing.push("EXIT_INTENT_MISSING", "EXIT_ORDER_MISSING");
    }
  } else if (exitOrders.length === 1) {
    exitOrder = exitOrders[0]!;
    exitIntent = exitIntents.find(
      (entry) => entry.id === exitOrder!.intentId
    ) ?? null;
  }
  const exitReviews = input.reviews.filter(
    (entry) =>
      entry.candidateId === candidateId &&
      entry.reviewType === "exit"
  );
  let exitReview: OutcomeReviewInput | null = null;
  if (exitIntent?.reviewId) {
    const linked = exitReviews.filter(
      (entry) => entry.id === exitIntent!.reviewId
    );
    if (linked.length === 1) {
      exitReview = linked[0]!;
    } else if (linked.length > 1) {
      ambiguous.push("EXIT_REVIEW_AMBIGUOUS");
    } else if (shouldHaveExit) {
      missing.push("EXIT_REVIEW_MISSING");
    }
  } else if (shouldHaveExit && exitIntent) {
    if (exitReviews.length === 1) {
      exitReview = exitReviews[0]!;
      partial.push("EXIT_REVIEW_JOIN_BY_CANDIDATE_ONLY");
    } else if (exitReviews.length > 1) {
      ambiguous.push("EXIT_REVIEW_AMBIGUOUS");
    } else {
      missing.push("EXIT_REVIEW_MISSING");
    }
  }

  const selectedOrderIds = new Set(
    [order?.id, exitOrder?.id].filter(
      (value): value is string => Boolean(value)
    )
  );
  const selectedIntentIds = new Set(
    [intent?.id, exitIntent?.id].filter(
      (value): value is string => Boolean(value)
    )
  );
  const lifecycleEvents = input.brokerEvents.filter((event) =>
    event.orderId
      ? selectedOrderIds.has(event.orderId)
      : Boolean(event.intentId && selectedIntentIds.has(event.intentId))
  );
  if (lifecycleEvents.length < input.brokerEvents.length) {
    partial.push("ADDITIONAL_BROKER_EVENTS_NOT_SELECTED");
  }
  const orderEvents = order
    ? lifecycleEvents
        .filter(
          (event) =>
            event.orderId === order.id ||
            (intent !== null && event.intentId === intent.id)
        )
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    : [];
  const firstFillEvent = orderEvents.find(
    (event) =>
      ["partially_filled", "filled"].includes(event.status ?? "") &&
      (finite(event.filledQuantity) ?? 0) > 0
  );
  const fullFillEvent = orderEvents.find(
    (event) => event.status === "filled"
  );
  const submittedAt = order?.submittedAt ?? intent?.submittedAt ?? null;
  const firstFillAt = firstFillEvent?.occurredAt ??
    (order?.status === "filled" ? order.filledAt ?? null : null);
  const fullFillAt = order?.status === "filled"
    ? fullFillEvent?.occurredAt ?? order.filledAt ?? null
    : null;
  if (order && ["partially_filled", "filled"].includes(order.status ?? "") && !firstFillAt) {
    missing.push("AUTHORITATIVE_FILL_TIMESTAMP_MISSING");
  }

  const toleranceMs = Math.max(
    0,
    Math.min(900_000, input.referenceToleranceMs ?? 60_000)
  );
  const referenceEventAt = submittedAt ?? firstFillAt;
  const selectedReference = referenceEventAt
    ? selectReferenceMarketObservation({
        instrument: input.candidate.symbol,
        eventAt: referenceEventAt,
        toleranceMs,
        exactEvidenceIds: review?.marketEvidenceIds ?? [],
        observations: input.marketObservations
      })
    : {
        observation: null,
        method: "unavailable" as const,
        distanceMs: null,
        candidates: [] as MarketObservationInput[]
      };
  if (!selectedReference.observation) {
    missing.push("CONTEMPORANEOUS_MARKET_REFERENCE_MISSING");
  }
  const reference = selectedReference.observation;
  const midpoint = finite(reference?.midpoint) ??
    (
      finite(reference?.bid) !== null && finite(reference?.ask) !== null
        ? (Number(reference!.bid) + Number(reference!.ask)) / 2
        : null
    );
  const last = finite(reference?.last);
  const fillPrice = finite(order?.averageFillPrice);
  const relativeTo = (value: number | null) =>
    fillPrice !== null && value !== null
      ? Number((fillPrice - value).toFixed(12))
      : null;
  const referenceBid = finite(reference?.bid);
  const referenceAsk = finite(reference?.ask);
  const spreadAtReferenceValue =
    referenceBid !== null &&
    referenceAsk !== null &&
    referenceAsk >= referenceBid
      ? Number((referenceAsk - referenceBid).toFixed(12))
      : null;
  const spreadAtReferenceBps =
    spreadAtReferenceValue !== null && midpoint !== null && midpoint > 0
      ? spreadAtReferenceValue / midpoint * 10_000
      : null;
  const slippageReference = midpoint ?? last;
  const slippageBasis = midpoint !== null
    ? "midpoint" as const
    : last !== null
      ? "last" as const
      : null;
  const slippageValue =
    fillPrice !== null && slippageReference !== null && slippageReference > 0
      ? order?.side === "sell"
        ? slippageReference - fillPrice
        : fillPrice - slippageReference
      : null;
  const slippageBps = slippageValue !== null && slippageReference !== null
    ? slippageValue / slippageReference * 10_000
    : null;
  if (slippageValue === null) limitations.push("SLIPPAGE_UNSUPPORTED");
  if (reference && !reference.receivedAt) {
    limitations.push("REFERENCE_RECEIPT_TIMESTAMP_UNAVAILABLE");
  }
  if (reference && !reference.persistedAt) {
    limitations.push("REFERENCE_PERSISTENCE_TIMESTAMP_UNAVAILABLE");
  }

  let realizedPnl: number | null = null;
  let realizedReturn: number | null = null;
  const entryQuantity = finite(order?.filledQuantity);
  const exitQuantity = finite(exitOrder?.filledQuantity);
  const exitPrice = finite(exitOrder?.averageFillPrice);
  const multiplier = position?.assetClass === "option"
    ? finite(position.contractMultiplier)
    : 1;
  if (position?.assetClass === "option" && multiplier === null) {
    limitations.push("OPTION_CONTRACT_MULTIPLIER_UNAVAILABLE");
  }
  if (
    position?.status === "closed" &&
    position.openingOrderId === order?.id &&
    position.closingOrderId === exitOrder?.id &&
    entryQuantity !== null &&
    exitQuantity !== null &&
    entryQuantity > 0 &&
    entryQuantity === exitQuantity &&
    fillPrice !== null &&
    fillPrice > 0 &&
    exitPrice !== null &&
    multiplier !== null &&
    multiplier > 0
  ) {
    const signedMove = order?.side === "sell"
      ? fillPrice - exitPrice
      : exitPrice - fillPrice;
    realizedPnl = signedMove * entryQuantity * multiplier;
    realizedReturn = realizedPnl / (fillPrice * entryQuantity * multiplier);
  } else if (position?.status === "closed") {
    const positionRealizedPnl = finite(position.realizedPnl);
    if (positionRealizedPnl !== null) {
      realizedPnl = positionRealizedPnl;
      limitations.push("POSITION_LEVEL_REALIZED_PNL_ONLY");
    }
    limitations.push("REALIZED_RETURN_ATTRIBUTION_UNSUPPORTED");
  }

  const unrealizedReturnCheckpoints: UnrealizedReturnCheckpoint[] = [];
  const unrealizedPnl = finite(position?.unrealizedPnl);
  const costBasis = finite(position?.costBasis);
  if (
    position?.status !== "closed" &&
    unrealizedPnl !== null &&
    costBasis !== null &&
    costBasis > 0 &&
    position?.lastReconciledAt
  ) {
    unrealizedReturnCheckpoints.push({
      at: position.lastReconciledAt,
      markSource: "position_reconciliation",
      markPrice: finite(position.currentPrice),
      unrealizedPnl,
      unrealizedReturn: unrealizedPnl / costBasis,
      sourceAccountSnapshotId: position.sourceAccountSnapshotId ?? null
    });
  }

  const closedAt = position?.closedAt ?? null;
  const excursion = excursionFor({
    candidate: input.candidate,
    position,
    order,
    firstFillAt,
    closedAt,
    observations: input.excursionObservations,
    metricLimitations: limitations
  });
  const holdingPeriodMs = elapsed(position?.openedAt ?? firstFillAt, closedAt);
  const status: OutcomeJoinStatus = ambiguous.length > 0
    ? "ambiguous"
    : missing.length > 0
      ? "missing"
      : unsupported.length > 0
        ? "unsupported"
        : partial.length > 0
          ? "partial"
          : "exact";
  if (position?.sourceAccountSnapshotId) {
    limitations.push("RECONCILIATION_CHECKPOINT_ID_NOT_LINKED");
  }
  const sourceTimes = [
    input.candidate.asOf,
    arbitration?.createdAt,
    review?.createdAt,
    intent?.createdAt,
    submittedAt,
    firstFillAt,
    fullFillAt,
    position?.lastReconciledAt,
    closedAt,
    ...lifecycleEvents.map((event) => event.occurredAt),
    ...input.marketObservations.map((observation) => observation.observedAt),
    ...input.marketObservations.flatMap((observation) => [
      observation.receivedAt,
      observation.persistedAt
    ])
  ].filter((value): value is string => Boolean(value));
  const sourceWatermark = sourceTimes.sort().at(-1) ?? input.candidate.asOf;
  const base = {
    outcomeId: `outcome:v${OUTCOME_LEARNING_SCHEMA_VERSION}:${input.environment}:${candidateId}`,
    refreshRunId: input.refreshRunId,
    environment: input.environment,
    cycleId: arbitration?.cycleId ?? input.candidate.cycleId ?? null,
    schedulerRunId: arbitration?.schedulerRunId ?? null,
    lane: laneFor(input.candidate, arbitration),
    candidateId,
    proposalId: candidateId,
    arbitrationDecisionId: arbitration?.id ?? null,
    reviewId: review?.id ?? null,
    intentId: intent?.id ?? null,
    orderRecordId: order?.id ?? null,
    clientOrderId: order?.clientOrderId ?? intent?.clientOrderId ?? null,
    alpacaOrderId: order?.brokerOrderId ?? null,
    positionId: position?.id ?? null,
    exitReviewId: exitReview?.id ?? null,
    exitIntentId: exitIntent?.id ?? null,
    exitOrderId: exitOrder?.id ?? null,
    reconciliationIdentity: position?.sourceAccountSnapshotId
      ? `account_snapshot:${position.sourceAccountSnapshotId}`
      : null,
    symbol: input.candidate.symbol,
    underlyingSymbol: input.candidate.underlyingSymbol,
    optionContractId: input.candidate.optionContractId ?? null,
    timeHorizon: input.candidate.timeHorizon?.trim() || null,
    brokerEventIds: uniqueText(lifecycleEvents.map((event) => event.id)),
    fillActivityIds: [],
    researchSignalIds: uniqueText(input.candidate.researchSignalIds ?? []),
    researchHorizons: uniqueText(input.candidate.researchHorizons ?? []),
    catalysts: uniqueText(input.candidate.catalysts ?? []),
    marketEvidenceIds: uniqueText([
      ...(review?.marketEvidenceIds ?? []),
      reference?.id
    ]),
    entryReasonCodes: uniqueText([
      ...(input.candidate.reasonCodes ?? []),
      ...(review?.reasonCodes ?? [])
    ]),
    arbitrationReasonCodes: uniqueText(arbitration?.reasonCodes ?? []),
    exitReasonCodes: uniqueText(exitReview?.reasonCodes ?? []),
    proposalScore: finite(input.candidate.score),
    proposalConfidence: finite(input.candidate.confidence),
    scoreBucket: scoreBucket(finite(input.candidate.score)),
    confidenceBucket: confidenceBucket(finite(input.candidate.confidence)),
    spreadBucket: spreadBucket(finite(input.candidate.spreadBps)),
    liquidityBucket: liquidityBucket(finite(input.candidate.liquidityScore)),
    arbitrationAction: arbitration?.action ?? null,
    proposedAt: input.candidate.asOf,
    reviewedAt: review?.createdAt ?? null,
    intentCreatedAt: intent?.createdAt ?? null,
    submittedAt,
    firstFillAt,
    fullFillAt,
    closedAt,
    submittedStatus: intent?.status ?? null,
    finalOrderStatus: order?.status ?? null,
    fillStatus,
    requestedQuantity: finite(order?.requestedQuantity) ?? finite(intent?.quantity),
    filledQuantity: finite(order?.filledQuantity),
    averageFillPrice: fillPrice,
    referenceBid,
    referenceAsk,
    referenceMidpoint: midpoint,
    referenceLast: last,
    referenceTimestamp: reference?.observedAt ?? null,
    referenceReceivedAt: reference?.receivedAt ?? null,
    referencePersistedAt: reference?.persistedAt ?? null,
    referenceSource: reference?.provider ?? null,
    referenceFeed: reference?.feed ?? null,
    referenceLookupMethod: selectedReference.method,
    referenceLookupDistanceMs: selectedReference.distanceMs,
    referenceToleranceMs: toleranceMs,
    referenceFreshnessStatus: reference ? "fresh" as const : "unavailable" as const,
    fillVsBid: relativeTo(referenceBid),
    fillVsAsk: relativeTo(referenceAsk),
    fillVsMidpoint: relativeTo(midpoint),
    fillVsLast: relativeTo(last),
    spreadAtReferenceValue,
    spreadAtReferenceBps,
    slippageValue,
    slippageBps,
    slippageBasis,
    timeIntentToSubmissionMs: elapsed(intent?.createdAt ?? null, submittedAt),
    timeProposalToSubmissionMs: elapsed(input.candidate.asOf, submittedAt),
    timeToFirstFillMs: elapsed(submittedAt, firstFillAt),
    timeToFullFillMs: elapsed(submittedAt, fullFillAt),
    timeFirstFillToCloseMs: elapsed(firstFillAt, closedAt),
    realizedPnl,
    realizedReturn,
    unrealizedReturnCheckpoints,
    ...excursion,
    holdingPeriodMs,
    joinStatus: status,
    joinMethods: {
      candidateToProposal: "exact",
      proposalToArbitration: arbitration ? "exact" : "missing",
      candidateToReview: review ? "exact" : "missing",
      reviewToIntent: intent && review && intent.reviewId === review.id
        ? "exact"
        : intent
          ? "partial"
          : "missing",
      intentToOrder: order ? "exact" : "missing",
      orderToPosition: position
        ? position.openingOrderId === order?.id
          ? "exact"
          : "partial"
        : order && supportedFillStatus
          ? "missing"
          : "unsupported",
      positionToExitIntent: exitIntent
        ? exitIntent.parentPositionId === position?.id
          ? "exact"
          : "partial"
        : shouldHaveExit
          ? "missing"
          : "unsupported",
      exitIntentToOrder: exitOrder
        ? "exact"
        : shouldHaveExit
          ? "missing"
          : "unsupported",
      marketReference: selectedReference.method
    },
    partialJoinReasons: uniqueText(partial),
    missingJoinReasons: uniqueText(missing),
    ambiguousJoinReasons: uniqueText(ambiguous),
    unsupportedJoinReasons: uniqueText(unsupported),
    metricLimitations: uniqueText(limitations),
    paperLimitations: input.environment === "paper"
      ? [...PAPER_OUTCOME_LIMITATIONS]
      : [],
    sourceWatermark,
    calculatedAt: input.calculatedAt,
    schemaVersion: OUTCOME_LEARNING_SCHEMA_VERSION
  };
  const contentHash = canonicalJsonHash({
    ...base,
    refreshRunId: undefined,
    calculatedAt: undefined
  });
  return { ...base, contentHash };
};

export type HistoricalOutcomeAggregate = {
  id: string;
  refreshRunId: string;
  environment: OutcomeEnvironment;
  lane: OutcomeLane;
  dimension: string;
  groupingKey: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  sourceTruncated: boolean;
  sampleCount: number;
  proposedCount: number;
  approvedCount: number;
  resizedCount: number;
  skippedCount: number;
  submittedCount: number;
  filledCount: number;
  rejectedCount: number;
  canceledCount: number;
  closedCount: number;
  averageTimeToFirstFillMs: number | null;
  averageSlippageBps: number | null;
  medianSlippageBps: number | null;
  realizedReturnAverage: number | null;
  realizedReturnMedian: number | null;
  winRate: number | null;
  maximumFavorableExcursionAverage: number | null;
  maximumAdverseExcursionAverage: number | null;
  missingJoinCount: number;
  ambiguousJoinCount: number;
  unsupportedMetricCount: number;
  usableAsEvidence: boolean;
  paperLimitations: string[];
  bucketDefinitions: Record<string, string>;
  sourceWatermark: string;
  calculatedAt: string;
  schemaVersion: number;
  contentHash: string;
};

const average = (values: readonly (number | null)[]) => {
  const supported = values.filter((value): value is number => value !== null);
  return supported.length
    ? supported.reduce((sum, value) => sum + value, 0) / supported.length
    : null;
};

const median = (values: readonly (number | null)[]) => {
  const supported = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (supported.length === 0) return null;
  const middle = Math.floor(supported.length / 2);
  return supported.length % 2
    ? supported[middle]!
    : (supported[middle - 1]! + supported[middle]!) / 2;
};

const aggregateDimensions = (record: OutcomeLearningRecord) => {
  const pairs: Array<[string, string | null]> = [
    ["lane", record.lane],
    ["time_horizon", record.timeHorizon],
    ["symbol", record.symbol],
    ["underlying", record.underlyingSymbol],
    ["arbitration_action", record.arbitrationAction],
    ["score_bucket", record.scoreBucket],
    ["confidence_bucket", record.confidenceBucket],
    ["spread_bucket", record.spreadBucket],
    ["liquidity_bucket", record.liquidityBucket],
    ["order_status", record.finalOrderStatus],
    ["fill_status", record.fillStatus],
    ["holding_period_bucket", holdingPeriodBucket(record.holdingPeriodMs)]
  ];
  for (const reason of record.entryReasonCodes) pairs.push(["entry_reason", reason]);
  for (const reason of record.arbitrationReasonCodes) {
    pairs.push(["arbitration_reason", reason]);
  }
  for (const signal of record.researchSignalIds) pairs.push(["research_signal", signal]);
  for (const horizon of record.researchHorizons) {
    pairs.push(["research_horizon", horizon]);
  }
  for (const catalyst of record.catalysts) pairs.push(["catalyst", catalyst]);
  return pairs.filter((entry): entry is [string, string] => Boolean(entry[1]));
};

export const buildHistoricalOutcomeAggregates = (input: {
  refreshRunId: string;
  records: readonly OutcomeLearningRecord[];
  dateRangeStart: string;
  dateRangeEnd: string;
  calculatedAt: string;
  minimumSample: number;
  maximumIncompleteJoinRatio: number;
  sourceTruncated: boolean;
}): HistoricalOutcomeAggregate[] => {
  const groups = new Map<string, {
    environment: OutcomeEnvironment;
    lane: OutcomeLane;
    dimension: string;
    groupingKey: string;
    records: OutcomeLearningRecord[];
  }>();
  for (const record of input.records) {
    for (const [dimension, groupingKey] of aggregateDimensions(record)) {
      const key = [
        record.environment,
        record.lane,
        dimension,
        groupingKey
      ].join("\u0000");
      const group = groups.get(key) ?? {
        environment: record.environment,
        lane: record.lane,
        dimension,
        groupingKey,
        records: []
      };
      group.records.push(record);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .sort((left, right) =>
      [
        left.environment,
        left.lane,
        left.dimension,
        left.groupingKey
      ].join("\u0000").localeCompare([
        right.environment,
        right.lane,
        right.dimension,
        right.groupingKey
      ].join("\u0000"))
    )
    .map((group) => {
      const rows = group.records;
      const sampleCount = rows.length;
      const missingJoinCount = rows.filter(
        (row) => row.joinStatus === "missing"
      ).length;
      const ambiguousJoinCount = rows.filter(
        (row) => row.joinStatus === "ambiguous"
      ).length;
      const incompleteRatio = (missingJoinCount + ambiguousJoinCount) / sampleCount;
      const realized = rows.map((row) => row.realizedReturn);
      const wins = realized.filter((value): value is number => value !== null);
      const base = {
        id: `historical-outcome:v${OUTCOME_LEARNING_SCHEMA_VERSION}:${
          canonicalJsonHash({
            environment: group.environment,
            lane: group.lane,
            dimension: group.dimension,
            groupingKey: group.groupingKey,
            dateRangeStart: input.dateRangeStart,
            dateRangeEnd: input.dateRangeEnd
          }).slice(0, 40)
        }`,
        refreshRunId: input.refreshRunId,
        environment: group.environment,
        lane: group.lane,
        dimension: group.dimension,
        groupingKey: group.groupingKey,
        dateRangeStart: input.dateRangeStart,
        dateRangeEnd: input.dateRangeEnd,
        sourceTruncated: input.sourceTruncated,
        sampleCount,
        proposedCount: sampleCount,
        approvedCount: rows.filter((row) => row.arbitrationAction === "approve").length,
        resizedCount: rows.filter((row) => row.arbitrationAction === "resize").length,
        skippedCount: rows.filter((row) => row.arbitrationAction === "skip").length,
        submittedCount: rows.filter((row) => row.submittedAt !== null).length,
        filledCount: rows.filter((row) => row.firstFillAt !== null).length,
        rejectedCount: rows.filter((row) => row.finalOrderStatus === "rejected").length,
        canceledCount: rows.filter((row) =>
          ["canceled", "cancelled"].includes(row.finalOrderStatus ?? "")
        ).length,
        closedCount: rows.filter((row) => row.closedAt !== null).length,
        averageTimeToFirstFillMs: average(
          rows.map((row) => row.timeToFirstFillMs)
        ),
        averageSlippageBps: average(rows.map((row) => row.slippageBps)),
        medianSlippageBps: median(rows.map((row) => row.slippageBps)),
        realizedReturnAverage: average(realized),
        realizedReturnMedian: median(realized),
        winRate: wins.length
          ? wins.filter((value) => value > 0).length / wins.length
          : null,
        maximumFavorableExcursionAverage: average(
          rows.map((row) => row.maximumFavorableExcursion)
        ),
        maximumAdverseExcursionAverage: average(
          rows.map((row) => row.maximumAdverseExcursion)
        ),
        missingJoinCount,
        ambiguousJoinCount,
        unsupportedMetricCount: rows.reduce(
          (sum, row) => sum + row.metricLimitations.length,
          0
        ),
        usableAsEvidence:
          !input.sourceTruncated &&
          sampleCount >= input.minimumSample &&
          incompleteRatio <= input.maximumIncompleteJoinRatio,
        paperLimitations: group.environment === "paper"
          ? [...PAPER_OUTCOME_LIMITATIONS]
          : [],
        bucketDefinitions: {
          score: "0-20|20-40|40-60|60-80|80-100",
          confidence: "0.00-0.25|0.25-0.50|0.50-0.75|0.75-1.00",
          spread: "0-25bps|25-50bps|50-100bps|>100bps",
          liquidity: "low:<0.40|medium:0.40-0.75|high:>=0.75",
          holdingPeriod: "<1d|1-7d|7-30d|>=30d"
        },
        sourceWatermark: rows
          .map((row) => row.sourceWatermark)
          .sort()
          .at(-1)!,
        calculatedAt: input.calculatedAt,
        schemaVersion: OUTCOME_LEARNING_SCHEMA_VERSION
      };
      const contentHash = canonicalJsonHash({
        ...base,
        refreshRunId: undefined,
        calculatedAt: undefined
      });
      return { ...base, contentHash };
    });
};
