import { createHmac } from "node:crypto";
import type { QueryResult } from "pg";

import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { SchedulerFence } from "../repositories/contracts/common.js";
import { stableRecordId } from "../repositories/postgres/postgresRepositorySupport.js";
import type {
  AlpacaApiResponse,
  AlpacaPaperOrderRequest,
  AlpacaSubmittedOrder
} from "./alpacaClient.js";
import {
  checkAlpacaSymbolTradability,
  type AlpacaAssetTradabilityResult
} from "./alpacaAssetService.js";
import { AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS } from "./autonomousFreshnessPolicy.js";
import { optionsQuoteConfig } from "./optionQuoteNormalizer.js";
import {
  autonomousLifecycleContextFromRuntime,
  lifecycleStateForBrokerStatus,
  validateCloseOperation,
  type StrategyClassification,
  type TradeOperation
} from "./autonomousTradeLifecycleService.js";
import type { PostgresAuthorityBrokerSnapshot } from "./postgresAuthorityBrokerSnapshot.js";
import {
  portfolioStatePacketFingerprint,
  validatePostgresPortfolioStatePacket,
  type PortfolioStatePacket
} from "./postgresPortfolioStatePacketService.js";
import { evaluateTradingRuntimeAuthority } from "./tradingRuntimeAuthority.js";

export {
  autonomousLifecycleContextFromRuntime,
  lifecycleStateForBrokerStatus
} from "./autonomousTradeLifecycleService.js";

export type AutonomousExecutionIntentRow = {
  order_intent_id: string;
  candidate_id: string | null;
  account_id: string;
  broker_account_id: string;
  account_snapshot_fingerprint: string;
  review_account_fingerprint: string;
  reservation_id: string | null;
  execution_review_id: string;
  review_type: "entry" | "exit";
  max_risk?: string | null;
  authorization_snapshot_id?: string | null;
  current_account_snapshot_id?: string | null;
  confirmation_evidence_id: string;
  review_signature?: string | null;
  payload_fingerprint?: string | null;
  review_client_order_id?: string | null;
  review_order_intent?: unknown;
  client_order_id: string;
  strategy_key: string;
  symbol: string;
  underlying_symbol?: string | null;
  asset_class: "equity" | "option";
  side: "buy" | "sell" | "buy_to_open" | "sell_to_close";
  order_type: "market" | "limit";
  time_in_force: "day";
  quantity: string | null;
  notional: string | null;
  limit_price: string | null;
  stop_price: string | null;
  intent_version: string | number;
  market_evidence: unknown;
  review_portfolio_state_packet?: unknown;
  intent_portfolio_state_packet?: unknown;
  current_portfolio_state_packet?: unknown;
  operation?: TradeOperation | null;
  strategy_classification?: StrategyClassification | null;
  parent_position_id?: string | null;
  opening_intent_id?: string | null;
  contract_id?: string | null;
  position_side?: "long" | "short" | null;
  position_available_quantity?: string | null;
  position_option_symbol?: string | null;
  position_contract_id?: string | null;
};

export type AutonomousExecutionBrokerSnapshot = Pick<
  PostgresAuthorityBrokerSnapshot,
  "capturedAt" | "accountIdentityHash" | "portfolioFingerprint" | "structuralPortfolioFingerprint"
> & { readonly brokerAccountId?: string };

export type AutonomousExecutionSafety = {
  readonly environment: string;
  readonly tradingMode: string;
  readonly liveTradingEnabled: boolean;
  readonly paperOrderExecutionEnabled: boolean;
  readonly paperOptionsExecutionEnabled: boolean;
  readonly liveOrderExecutionEnabled?: boolean;
  readonly liveOptionsExecutionEnabled?: boolean;
  readonly killSwitchEngaged?: boolean;
  readonly brokerAccountId?: string;
  readonly authorizedBrokerAccountId?: string;
  readonly runningReleaseSha?: string;
  readonly authorizedReleaseSha?: string;
  readonly liveAuthorizationId?: string;
  readonly liveAuthorizationExpiresAt?: string;
  readonly liveCanaryEnabled?: boolean;
  readonly estimatedOrderNotionalUsd?: number;
  readonly maxOrderNotionalUsd?: number;
  readonly dailyRealizedPnlUsd?: number;
  readonly dailyLossLimitUsd?: number;
  readonly quoteMaxAgeSeconds: number;
};

export type AutonomousExecutionQuery = {
  query: (
    sql: string,
    values?: readonly unknown[]
  ) => Promise<Pick<QueryResult<Record<string, unknown>>, "rows" | "rowCount">>;
};

export type AutonomousExecutionTransaction = <T>(
  operation: (query: AutonomousExecutionQuery) => Promise<T>
) => Promise<T>;

export type AmbiguousSubmissionRecovery =
  | {
      readonly status: "recovered";
      readonly orderId: string;
      readonly brokerOrderId: string;
      readonly brokerStatus: string;
    }
  | {
      readonly status: "pending";
      readonly attempts: number;
      readonly code: "POSTGRES_BROKER_SUBMISSION_RECOVERY_PENDING";
    };

export type BrokerMutationOutcome =
  | "submission_attempted"
  | "submission_acknowledged"
  | "submission_rejected"
  | "submission_transport_unknown"
  | "submission_reconciled";

export type BrokerMutationReceipt = {
  readonly mutationReceiptId: string;
  readonly environment: "paper";
  readonly intentId: string;
  readonly cycleId: string;
  readonly workstream: string;
  readonly schedulerRunId: string;
  readonly fencingToken: string;
  readonly deterministicClientOrderId: string;
  readonly submissionAttemptSequence: number;
  readonly submissionAction: "opening" | "closing";
  readonly brokerOrderId: string | null;
  readonly requestFingerprint: string;
  readonly requestedSymbol: string;
  readonly requestedSide: string;
  readonly requestedQuantity: string | null;
  readonly requestedNotional: string | null;
  readonly requestedOrderType: string;
  readonly requestedLimitPrice: string | null;
  readonly requestedStopPrice: string | null;
  readonly requestedPositionIntent: string;
  readonly submissionAttemptTimestamp: string;
  readonly brokerAcknowledgementTimestamp: string | null;
  readonly outcomeClassification: BrokerMutationOutcome;
  readonly resultingLifecycleState: string;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const positive = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const decimalText = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return raw;
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const normalizedWhole = whole!.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${normalizedWhole}${
    normalizedFraction ? `.${normalizedFraction}` : ""
  }`;
};

const portfolioStatePacket = (value: unknown): PortfolioStatePacket | null => {
  if (typeof value === "string") {
    try {
      return portfolioStatePacket(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PortfolioStatePacket
    : null;
};

const executionRequiredCapital = (intent: AutonomousExecutionIntentRow) => {
  if (intent.review_type !== "entry") return undefined;
  const explicitRisk = positive(intent.max_risk);
  if (explicitRisk !== null) return explicitRisk;
  const notional = positive(intent.notional);
  if (notional !== null) return notional;
  const quantity = positive(intent.quantity);
  const limitPrice = positive(intent.limit_price);
  if (quantity === null || limitPrice === null) return Number.NaN;
  return quantity * limitPrice * (intent.asset_class === "option" ? 100 : 1);
};

const assertPortfolioStateExecutionAuthority = (
  intent: AutonomousExecutionIntentRow,
  now: Date
) => {
  const reviewPacket = portfolioStatePacket(
    intent.review_portfolio_state_packet
  );
  const intentPacket = portfolioStatePacket(
    intent.intent_portfolio_state_packet
  );
  const currentPacket = portfolioStatePacket(
    intent.current_portfolio_state_packet
  );
  if (!reviewPacket || !intentPacket || !currentPacket) {
    throw new Error("PORTFOLIO_STATE_PACKET_MISSING");
  }
  if (
    reviewPacket.packetFingerprint !== intentPacket.packetFingerprint ||
    reviewPacket.packetFingerprint !== portfolioStatePacketFingerprint(reviewPacket) ||
    intentPacket.packetFingerprint !== portfolioStatePacketFingerprint(intentPacket)
  ) {
    throw new Error("PORTFOLIO_STATE_PACKET_MISMATCH");
  }
  if (
    reviewPacket.lineage.candidateId !== intent.candidate_id ||
    reviewPacket.lineage.strategyReviewId !== intent.execution_review_id ||
    reviewPacket.lineage.executionIntentId !== intent.order_intent_id ||
    (
      intent.authorization_snapshot_id &&
      reviewPacket.lineage.accountSnapshotId !== intent.authorization_snapshot_id
    )
  ) {
    throw new Error("PORTFOLIO_STATE_LINEAGE_MISMATCH");
  }
  if (
    intent.current_account_snapshot_id &&
    currentPacket.lineage.accountSnapshotId !== intent.current_account_snapshot_id
  ) {
    throw new Error("PORTFOLIO_STATE_RECONCILIATION_MISMATCH");
  }
  const expectedContractIdentifier = intent.asset_class === "option"
    ? intent.symbol
    : null;
  const requiredCapital = executionRequiredCapital(intent);
  const reviewedValidation = validatePostgresPortfolioStatePacket({
    packet: reviewPacket,
    now: now.toISOString(),
    expectedAccountId: intent.broker_account_id,
    expectedCandidateId: intent.candidate_id ?? undefined,
    expectedContractIdentifier,
    expectedStructuralPortfolioFingerprint: intent.review_account_fingerprint,
    requiredCapital,
    requireMarketOpen: true,
    requireOpra: intent.asset_class === "option"
  });
  if (!reviewedValidation.valid) {
    throw new Error(
      reviewedValidation.blockers[0] ?? "PORTFOLIO_STATE_PACKET_INVALID"
    );
  }
  const currentValidation = validatePostgresPortfolioStatePacket({
    packet: currentPacket,
    now: now.toISOString(),
    expectedAccountId: intent.broker_account_id,
    expectedStructuralPortfolioFingerprint: intent.review_account_fingerprint,
    requiredCapital,
    requireMarketOpen: true,
    requireOpra: intent.asset_class === "option"
  });
  if (!currentValidation.valid) {
    throw new Error(
      currentValidation.blockers[0] ?? "PORTFOLIO_STATE_PACKET_INVALID"
    );
  }
  return {
    reviewPacketFingerprint: reviewPacket.packetFingerprint,
    currentPacketFingerprint: currentPacket.packetFingerprint
  };
};

const assertExactReviewAuthorization = (
  intent: AutonomousExecutionIntentRow
) => {
  if (!text(intent.order_intent_id)) {
    throw new Error("POSTGRES_EXECUTION_INTENT_ID_REQUIRED");
  }
  if (
    !text(intent.execution_review_id) ||
    !text(intent.confirmation_evidence_id)
  ) {
    throw new Error("POSTGRES_EXECUTION_REVIEW_LINEAGE_REQUIRED");
  }
  const reviewed = record(intent.review_order_intent);
  if (!reviewed) {
    throw new Error("POSTGRES_REVIEW_INTENT_AUTHORIZATION_MISMATCH");
  }
  const comparisons: ReadonlyArray<readonly [unknown, unknown]> = [
    [intent.review_client_order_id, intent.client_order_id],
    [reviewed.clientOrderId, intent.client_order_id],
    [reviewed.symbol, intent.symbol],
    [reviewed.assetClass, intent.asset_class],
    [reviewed.side, intent.side],
    [reviewed.operation, intent.operation],
    [reviewed.orderType, intent.order_type],
    [reviewed.timeInForce, intent.time_in_force],
    [reviewed.strategyKey, intent.strategy_key]
  ];
  const decimals: ReadonlyArray<readonly [unknown, unknown]> = [
    [reviewed.quantity, intent.quantity],
    [reviewed.notional, intent.notional],
    [reviewed.limitPrice, intent.limit_price],
    [reviewed.stopPrice, intent.stop_price]
  ];
  if (
    comparisons.some(([authorized, requested]) =>
      text(authorized) !== text(requested)
    ) ||
    decimals.some(([authorized, requested]) =>
      decimalText(authorized) !== decimalText(requested)
    )
  ) {
    throw new Error("POSTGRES_REVIEW_INTENT_AUTHORIZATION_MISMATCH");
  }
};

const marketEvidence = (
  value: unknown,
  symbol: string
): {
  referencePrice: number;
  timestamp: string;
  record: Record<string, unknown>;
} | null => {
  const visit = (entry: unknown): {
    referencePrice: number;
    timestamp: string;
    record: Record<string, unknown>;
  } | null => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const entrySymbol = text(record.symbol || record.optionSymbol || record.underlyingSymbol).toUpperCase();
    const price = positive(record.referencePrice ?? record.marketReferencePrice ?? record.price);
    const timestamp = text(
      record.timestamp ?? record.marketTimestamp ?? record.quoteTimestamp ??
      record.observedAt ?? record.capturedAt
    );
    if ((!entrySymbol || entrySymbol === symbol.toUpperCase()) && price && timestamp) {
      return { referencePrice: price, timestamp, record };
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  return visit(value);
};

const validateOptionUnderlyingSipEvidence = (
  intent: AutonomousExecutionIntentRow,
  record: Record<string, unknown>,
  now: Date
) => {
  const sip = record.underlyingSip;
  if (!sip || typeof sip !== "object" || Array.isArray(sip)) {
    throw new Error("POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_UNUSABLE");
  }
  const evidence = sip as Record<string, unknown>;
  const expectedUnderlying = text(intent.underlying_symbol).toUpperCase();
  const observedUnderlying = text(evidence.symbol).toUpperCase();
  const referencePrice = positive(evidence.referencePrice);
  const persistedUnderlyingPrice = positive(record.underlyingPrice);
  const timestamp = text(evidence.timestamp);
  const observedAt = Date.parse(timestamp);
  const requestedFeed = text(evidence.requestedFeed).toLowerCase();
  const effectiveFeed = text(evidence.effectiveFeed).toLowerCase();
  const provider = text(evidence.provider).toLowerCase();
  const source = text(evidence.source);
  if (
    !expectedUnderlying ||
    observedUnderlying !== expectedUnderlying ||
    !referencePrice ||
    persistedUnderlyingPrice !== referencePrice ||
    requestedFeed !== "sip" ||
    effectiveFeed !== "sip" ||
    provider !== "alpaca" ||
    source !== "postgres.stock_snapshots" ||
    !Number.isFinite(observedAt)
  ) {
    throw new Error("POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_UNUSABLE");
  }
  const ageSeconds = (now.getTime() - observedAt) / 1_000;
  if (
    ageSeconds < 0 ||
    ageSeconds > AUTONOMOUS_MARKET_DATA_FRESHNESS_SECONDS
  ) {
    throw new Error("POSTGRES_OPTION_UNDERLYING_SIP_EVIDENCE_STALE");
  }
  return referencePrice;
};

export const validateAutonomousExecutionEvidence = (
  intent: AutonomousExecutionIntentRow,
  broker: AutonomousExecutionBrokerSnapshot,
  now: Date,
  quoteMaxAgeSeconds: number
): AlpacaPaperOrderRequest => {
  if (intent.review_type === "entry") {
    assertPortfolioStateExecutionAuthority(intent, now);
  }
  const brokerAccountIdentity = broker.brokerAccountId ?? broker.accountIdentityHash;
  if (brokerAccountIdentity !== intent.broker_account_id) {
    throw new Error("POSTGRES_BROKER_ACCOUNT_IDENTITY_CONFLICT");
  }
  if (broker.structuralPortfolioFingerprint !== intent.review_account_fingerprint) {
    throw new Error("POSTGRES_REVIEW_ACCOUNT_EVIDENCE_CONFLICT");
  }
  const evidence = marketEvidence(intent.market_evidence, intent.symbol);
  if (!evidence) {
    const serialized = JSON.stringify(intent.market_evidence);
    if (!/timestamp|marketTimestamp|quoteTimestamp|observedAt|capturedAt/.test(serialized)) {
      throw new Error("POSTGRES_MARKET_EVIDENCE_TIMESTAMP_MISSING");
    }
    throw new Error("POSTGRES_MARKET_REFERENCE_PRICE_MISSING");
  }
  const observedAt = Date.parse(evidence.timestamp);
  const ageSeconds = (now.getTime() - observedAt) / 1_000;
  const effectiveMaxAgeSeconds = intent.asset_class === "option"
    ? Math.min(quoteMaxAgeSeconds, optionsQuoteConfig().maxAgeMs / 1_000)
    : quoteMaxAgeSeconds;
  if (
    !Number.isFinite(observedAt) || ageSeconds < 0 ||
    ageSeconds > effectiveMaxAgeSeconds
  ) {
    throw new Error("POSTGRES_MARKET_EVIDENCE_STALE");
  }
  if (intent.asset_class === "option") {
    const record = evidence.record;
    const underlyingPrice = validateOptionUnderlyingSipEvidence(
      intent,
      record,
      now
    );
    const bid = positive(record.bid);
    const ask = positive(record.ask);
    const spreadPct = Number(record.spreadPct);
    const maximumSpreadPct = Number(record.maximumSpreadPct);
    const volume = Number(record.volume);
    const openInterest = Number(record.openInterest);
    const requestedFeed = text(record.requestedFeed).toLowerCase();
    const effectiveFeed = text(record.effectiveFeed).toLowerCase();
    const source = text(record.source);
    const liquidityValid =
      Number.isFinite(volume) &&
      volume >= 0 &&
      Number.isFinite(openInterest) &&
      openInterest >= 0 &&
      volume + openInterest > 0;
    if (
      !bid ||
      !ask ||
      ask < bid ||
      !Number.isFinite(spreadPct) ||
      spreadPct < 0 ||
      !Number.isFinite(maximumSpreadPct) ||
      maximumSpreadPct < 0 ||
      spreadPct > maximumSpreadPct ||
      !underlyingPrice ||
      !liquidityValid ||
      requestedFeed !== "opra" ||
      effectiveFeed !== "opra" ||
      source !== "postgres.option_snapshots"
    ) {
      throw new Error("POSTGRES_OPTION_MARKET_EVIDENCE_UNUSABLE");
    }
  }
  if (!intent.quantity && !intent.notional) {
    throw new Error("POSTGRES_ORDER_INTENT_SIZE_MISSING");
  }
  if (intent.order_type === "limit" && !positive(intent.limit_price)) {
    throw new Error("POSTGRES_ORDER_INTENT_LIMIT_PRICE_MISSING");
  }
  if (intent.review_type === "exit") {
    if (
      !intent.parent_position_id ||
      !intent.position_side ||
      !intent.operation
    ) {
      throw new Error("POSTGRES_CLOSE_POSITION_LINEAGE_MISSING");
    }
    const closeValidation = validateCloseOperation({
      positionSide: intent.position_side,
      operation: intent.operation
    });
    if (!closeValidation.valid) {
      throw new Error(closeValidation.reason);
    }
    const closeQuantity = positive(intent.quantity);
    const availableQuantity = positive(intent.position_available_quantity);
    if (!closeQuantity || !availableQuantity) {
      throw new Error("POSTGRES_CLOSE_QUANTITY_MISSING");
    }
    if (closeQuantity > availableQuantity + 1e-12) {
      throw new Error("POSTGRES_CLOSE_QUANTITY_EXCEEDS_RECONCILED_POSITION");
    }
    if (
      intent.asset_class === "option" &&
      (
        !intent.contract_id ||
        intent.contract_id !== intent.position_contract_id ||
        intent.symbol !== intent.position_option_symbol
      )
    ) {
      throw new Error("POSTGRES_OPTION_CLOSE_CONTRACT_MISMATCH");
    }
  }
  const operation = intent.operation ?? (
    intent.side === "buy_to_open" || intent.side === "sell_to_close"
      ? intent.side
      : intent.review_type === "entry" && intent.side === "sell"
        ? "sell_to_open"
        : intent.review_type === "exit" && intent.side === "buy"
          ? "buy_to_cover"
          : "buy_to_open"
  );
  const positionIntent = intent.asset_class === "option" &&
    (operation === "buy_to_open" || operation === "sell_to_close")
    ? operation
    : undefined;
  const payload: AlpacaPaperOrderRequest = {
    symbol: intent.symbol,
    ...(intent.quantity ? { qty: intent.quantity } : {}),
    ...(intent.notional ? { notional: intent.notional } : {}),
    side: operation === "buy_to_open" || operation === "buy_to_cover"
      ? "buy"
      : "sell",
    type: intent.order_type,
    time_in_force: intent.time_in_force,
    ...(intent.limit_price ? { limit_price: intent.limit_price } : {}),
    client_order_id: intent.client_order_id,
    ...(positionIntent ? { position_intent: positionIntent } : {})
  };
  return payload;
};

const commandFilter = (command: string, strategyFamily?: string) => {
  const normalizedFamily = strategyFamily?.trim();
  if (strategyFamily !== undefined && normalizedFamily !== "leaps") {
    throw new Error("POSTGRES_EXECUTION_STRATEGY_FAMILY_UNSUPPORTED");
  }
  if (normalizedFamily === "leaps" && command !== "paper:execute:reviewed") {
    throw new Error("POSTGRES_EXECUTION_STRATEGY_FAMILY_COMMAND_INVALID");
  }
  if (command === "paper:execute:reviewed") {
    const entryFilter = "review.review_type = 'entry' AND intent.operation IN ('buy_to_open', 'sell_to_open')";
    return normalizedFamily === "leaps"
      ? `${entryFilter} AND intent.asset_class = 'option' AND intent.strategy_classification IN ('leaps_long_call', 'leaps_long_put')`
      : entryFilter;
  }
  if (command === "paper:exit:execute") {
    return "review.review_type = 'exit' AND intent.operation IN ('sell_to_close', 'buy_to_cover')";
  }
  if (command === "hedge:exit:execute") {
    return "review.review_type = 'exit' AND intent.operation = 'sell_to_close' AND intent.strategy_key ILIKE '%hedge%'";
  }
  if (command === "zero-dte:engine") {
    return "review.review_type = 'entry' AND intent.operation = 'buy_to_open' AND intent.strategy_classification IN ('zero_dte_long_call', 'zero_dte_long_put')";
  }
  throw new Error(`POSTGRES_EXECUTION_COMMAND_UNSUPPORTED: ${command}`);
};

const reviewedNumericMatchesIntentSql = (
  jsonField: string,
  intentColumn: string
) => `(
  (
    intent.${intentColumn} IS NULL
    AND NULLIF(review.order_intent->>'${jsonField}', '') IS NULL
  )
  OR (
    intent.${intentColumn} IS NOT NULL
    AND review.order_intent->>'${jsonField}' ~ '^[0-9]+([.][0-9]+)?$'
    AND (review.order_intent->>'${jsonField}')::numeric = intent.${intentColumn}
  )
)`;

const exactReviewAuthorizationSql = `
  review.client_order_id = intent.client_order_id
  AND review.order_intent->>'clientOrderId' = intent.client_order_id
  AND review.order_intent->>'symbol' = intent.symbol
  AND review.order_intent->>'assetClass' = intent.asset_class
  AND review.order_intent->>'side' = intent.side
  AND review.order_intent->>'operation' = intent.operation
  AND review.order_intent->>'orderType' = intent.order_type
  AND review.order_intent->>'timeInForce' = intent.time_in_force
  AND review.order_intent->>'strategyKey' = intent.strategy_key
  AND ${reviewedNumericMatchesIntentSql("quantity", "quantity")}
  AND ${reviewedNumericMatchesIntentSql("notional", "notional")}
  AND ${reviewedNumericMatchesIntentSql("limitPrice", "limit_price")}
  AND ${reviewedNumericMatchesIntentSql("stopPrice", "stop_price")}
  AND review.blockers = '[]'::jsonb`;

const noPriorBrokerAcknowledgementSql = `
  NOT EXISTS (
    SELECT 1
    FROM orders acknowledged_order
    WHERE acknowledged_order.account_id = intent.account_id
      AND (
        acknowledged_order.order_intent_id = intent.id
        OR acknowledged_order.client_order_id = intent.client_order_id
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM broker_events acknowledged_event
    WHERE acknowledged_event.account_id = intent.account_id
      AND (
        acknowledged_event.order_intent_id = intent.id
        OR acknowledged_event.client_order_id = intent.client_order_id
      )
      AND (
        acknowledged_event.broker_order_id IS NOT NULL
        OR acknowledged_event.event_status IN (
          'submission_acknowledged', 'submission_reconciled',
          'accepted', 'new', 'pending_new', 'partially_filled', 'filled'
        )
      )
  )`;

const fenceSql = (start: number) => `EXISTS (
  SELECT 1 FROM scheduler_leases lease
  WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
    AND lease.expires_at > now()
)`;

const fenceValues = (fence: SchedulerFence) => [
  fence.jobName,
  fence.workstream,
  fence.ownerId,
  fence.runId,
  fence.fencingToken
];

type ConfirmableIntentRow = {
  order_intent_id: string;
  candidate_id: string | null;
  account_id: string;
  broker_account_id: string;
  account_snapshot_id: string;
  authorization_snapshot_id: string | null;
  review_account_fingerprint: string;
  strategy_key: string;
  symbol: string;
  asset_class: "equity" | "option";
  side: "buy" | "sell" | "buy_to_open" | "sell_to_close";
  max_risk: string | number | null;
  execution_review_id: string;
  review_type: "entry" | "exit";
  review_payload_fingerprint: string;
  review_signature: string;
  review_expires_at: string | Date;
  review_portfolio_state_packet: unknown;
  intent_portfolio_state_packet: unknown;
  current_portfolio_state_packet: unknown;
};

const assertConfirmablePortfolioStateAuthority = (
  intent: ConfirmableIntentRow,
  now: Date
) => {
  const reviewPacket = portfolioStatePacket(
    intent.review_portfolio_state_packet
  );
  const intentPacket = portfolioStatePacket(
    intent.intent_portfolio_state_packet
  );
  const currentPacket = portfolioStatePacket(
    intent.current_portfolio_state_packet
  );
  if (!reviewPacket || !intentPacket || !currentPacket) {
    throw new Error("PORTFOLIO_STATE_PACKET_MISSING");
  }
  if (
    reviewPacket.packetFingerprint !== intentPacket.packetFingerprint ||
    reviewPacket.packetFingerprint !== portfolioStatePacketFingerprint(reviewPacket) ||
    intentPacket.packetFingerprint !== portfolioStatePacketFingerprint(intentPacket)
  ) {
    throw new Error("PORTFOLIO_STATE_PACKET_MISMATCH");
  }
  if (
    reviewPacket.lineage.candidateId !== intent.candidate_id ||
    reviewPacket.lineage.strategyReviewId !== intent.execution_review_id ||
    reviewPacket.lineage.executionIntentId !== intent.order_intent_id ||
    reviewPacket.lineage.accountSnapshotId !== intent.authorization_snapshot_id
  ) {
    throw new Error("PORTFOLIO_STATE_LINEAGE_MISMATCH");
  }
  if (currentPacket.lineage.accountSnapshotId !== intent.account_snapshot_id) {
    throw new Error("PORTFOLIO_STATE_RECONCILIATION_MISMATCH");
  }
  const expectedContractIdentifier = intent.asset_class === "option"
    ? intent.symbol
    : null;
  const requiredCapital = intent.review_type === "entry"
    ? positive(intent.max_risk) ?? Number.NaN
    : undefined;
  const reviewedValidation = validatePostgresPortfolioStatePacket({
    packet: reviewPacket,
    now: now.toISOString(),
    expectedAccountId: intent.broker_account_id,
    expectedCandidateId: intent.candidate_id ?? undefined,
    expectedContractIdentifier,
    expectedStructuralPortfolioFingerprint: intent.review_account_fingerprint,
    requiredCapital,
    requireMarketOpen: true,
    requireOpra: intent.asset_class === "option"
  });
  if (!reviewedValidation.valid) {
    throw new Error(
      reviewedValidation.blockers[0] ?? "PORTFOLIO_STATE_PACKET_INVALID"
    );
  }
  const currentValidation = validatePostgresPortfolioStatePacket({
    packet: currentPacket,
    now: now.toISOString(),
    expectedAccountId: intent.broker_account_id,
    expectedStructuralPortfolioFingerprint: intent.review_account_fingerprint,
    requiredCapital,
    requireMarketOpen: true,
    requireOpra: intent.asset_class === "option"
  });
  if (!currentValidation.valid) {
    throw new Error(
      currentValidation.blockers[0] ?? "PORTFOLIO_STATE_PACKET_INVALID"
    );
  }
  return {
    reviewPacketFingerprint: reviewPacket.packetFingerprint,
    currentPacketFingerprint: currentPacket.packetFingerprint
  };
};

const capacityAllowed = (row: Record<string, unknown> | undefined) =>
  Boolean(row) && [
    "buying_power_allowed",
    "deployment_allowed",
    "strategy_allowed",
    "symbol_allowed",
    "position_count_allowed",
    "order_count_allowed"
  ].every((field) => row?.[field] === true);

export const promoteNextConfirmedPostgresIntent = async (input: {
  readonly command: string;
  readonly strategyFamily?: string;
  readonly query: AutonomousExecutionQuery;
  readonly fence: SchedulerFence;
  readonly signingKey: string;
  readonly now: Date;
}) => {
  if (input.signingKey.trim().length < 16) {
    throw new Error("PAPER_REVIEW_SIGNING_KEY_REQUIRED");
  }
  const nowIso = input.now.toISOString();
  const selected = await input.query.query(
    `SELECT intent.id AS order_intent_id, intent.candidate_id, intent.account_id,
            account.broker_account_id,
            snapshot.id AS account_snapshot_id, intent.authorization_snapshot_id,
            review.account_fingerprint AS review_account_fingerprint,
            intent.strategy_key, intent.symbol,
            intent.asset_class, intent.side, intent.max_risk::text AS max_risk,
            intent.execution_review_id, review.review_type,
            review.payload_fingerprint AS review_payload_fingerprint,
            review.signature AS review_signature, review.expires_at AS review_expires_at,
            review.portfolio_evidence->'portfolioStatePacket'
              AS review_portfolio_state_packet,
            intent.request_payload->'portfolioStatePacket'
              AS intent_portfolio_state_packet,
            snapshot.evidence->'portfolioStatePacket'
              AS current_portfolio_state_packet
     FROM order_intents intent
     JOIN accounts account ON account.id = intent.account_id
     JOIN execution_reviews review ON review.id = intent.execution_review_id
     JOIN LATERAL (
       SELECT current_snapshot.id, current_snapshot.snapshot_fingerprint,
              current_snapshot.evidence
       FROM account_snapshots current_snapshot
       WHERE current_snapshot.account_id = intent.account_id
       ORDER BY current_snapshot.observed_at DESC, current_snapshot.id DESC
       LIMIT 1
     ) snapshot ON true
     JOIN strategy_allocations allocation
       ON allocation.account_id = intent.account_id
      AND allocation.strategy_key = intent.strategy_key
      AND allocation.status = 'active' AND allocation.effective_to IS NULL
     WHERE intent.status = 'created' AND intent.environment = 'paper'
       AND ${commandFilter(input.command, input.strategyFamily)}
       AND review.status = 'valid' AND review.environment = 'paper'
       AND review.paper_only AND NOT review.live_trading_enabled
       AND review.expires_at > $1
       AND snapshot.evidence->>'structuralPortfolioFingerprint' = review.account_fingerprint
       AND ${fenceSql(2)}
     ORDER BY intent.created_at, intent.id
     LIMIT 1
     FOR UPDATE OF intent, review, allocation SKIP LOCKED`,
    [nowIso, ...fenceValues(input.fence)]
  );
  const intent = selected.rows[0] as ConfirmableIntentRow | undefined;
  if (!intent) return { status: "none" as const };
  const portfolioStateAuthority = intent.review_type === "entry"
    ? assertConfirmablePortfolioStateAuthority(intent, input.now)
    : null;

  const reservationRequired = intent.review_type === "entry";
  const amount = positive(intent.max_risk);
  if (reservationRequired && amount === null) {
    throw new Error("POSTGRES_CONFIRMATION_RISK_AMOUNT_MISSING");
  }
  if (reservationRequired) {
    const capacity = await input.query.query(
      `WITH snapshot AS (
         SELECT buying_power, equity
         FROM account_snapshots
         WHERE id = $2 AND account_id = $1
       ), reservations AS (
         SELECT COALESCE(SUM(amount), 0) AS total,
                COALESCE(SUM(amount) FILTER (WHERE symbol = $4), 0) AS symbol_total
         FROM buying_power_reservations
         WHERE account_id = $1 AND status = 'active' AND expires_at > $5
       ), open_orders AS (
         SELECT COALESCE(SUM(COALESCE(
                  notional,
                  quantity * limit_price * CASE WHEN asset_class = 'option' THEN 100 ELSE 1 END
                )), 0) AS total,
                COALESCE(SUM(COALESCE(
                  notional,
                  quantity * limit_price * CASE WHEN asset_class = 'option' THEN 100 ELSE 1 END
                )) FILTER (WHERE symbol = $4), 0) AS symbol_total,
                COUNT(*) AS count
         FROM orders
         WHERE account_id = $1
           AND status IN ('new', 'accepted', 'pending_new', 'partially_filled', 'held', 'replaced')
       ), position_state AS (
         SELECT COALESCE(SUM(ABS(COALESCE(market_value, cost_basis, 0))), 0) AS total,
                COALESCE(SUM(ABS(COALESCE(market_value, cost_basis, 0)))
                  FILTER (WHERE symbol = $4), 0) AS symbol_total,
                COUNT(*) AS count
         FROM positions
         WHERE account_id = $1 AND status IN ('open', 'closing')
       ), limits AS (
         SELECT *
         FROM risk_limits
         WHERE account_id = $1 AND status = 'active' AND effective_to IS NULL
         ORDER BY CASE WHEN scope_type = 'portfolio' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1
       ), allocation AS (
         SELECT *
         FROM strategy_allocations
         WHERE account_id = $1 AND strategy_key = $3
           AND status = 'active' AND effective_to IS NULL
       )
       SELECT
         COALESCE(snapshot.buying_power, 0) - reservations.total - open_orders.total
           - GREATEST(
               COALESCE(limits.cash_reserve_amount, 0),
               COALESCE(snapshot.equity, 0) * COALESCE(limits.cash_reserve_ratio, 0)
             ) >= $6::numeric AS buying_power_allowed,
         (limits.max_deployment_amount IS NULL OR
            position_state.total + open_orders.total + reservations.total + $6::numeric
              <= limits.max_deployment_amount)
           AND (limits.max_deployment_ratio IS NULL OR
            position_state.total + open_orders.total + reservations.total + $6::numeric
              <= COALESCE(snapshot.equity, 0) * limits.max_deployment_ratio)
           AS deployment_allowed,
         (allocation.allocation_amount IS NULL OR
            allocation.deployed_amount + allocation.reserved_amount + $6::numeric
              <= allocation.allocation_amount)
           AND (allocation.allocation_ratio IS NULL OR
            allocation.deployed_amount + allocation.reserved_amount + $6::numeric
              <= COALESCE(snapshot.equity, 0) * allocation.allocation_ratio)
           AS strategy_allowed,
         limits.max_symbol_notional IS NULL OR
           position_state.symbol_total + open_orders.symbol_total +
             reservations.symbol_total + $6::numeric <= limits.max_symbol_notional
           AS symbol_allowed,
         limits.max_position_count IS NULL OR position_state.count < limits.max_position_count
           AS position_count_allowed,
         limits.max_order_count IS NULL OR open_orders.count < limits.max_order_count
           AS order_count_allowed
       FROM snapshot, reservations, open_orders, position_state, limits, allocation`,
      [
        intent.account_id,
        intent.account_snapshot_id,
        intent.strategy_key,
        intent.symbol,
        nowIso,
        amount
      ]
    );
    if (!capacityAllowed(capacity.rows[0])) {
      return {
        status: "blocked" as const,
        code: "POSTGRES_CONFIRMATION_CAPACITY_BLOCKED",
        orderIntentId: intent.order_intent_id
      };
    }
  }

  const reviewExpiryMs = Date.parse(String(intent.review_expires_at));
  const expiresAt = new Date(Math.min(reviewExpiryMs, input.now.getTime() + 15 * 60_000)).toISOString();
  if (!Number.isFinite(reviewExpiryMs) || Date.parse(expiresAt) <= input.now.getTime()) {
    throw new Error("POSTGRES_CONFIRMATION_EXPIRATION_INVALID");
  }
  const confirmationEvidence = {
    command: input.command,
    confirmPaper: true,
    ...(portfolioStateAuthority ? { portfolioState: portfolioStateAuthority } : {}),
    scheduler: {
      jobName: input.fence.jobName,
      workstream: input.fence.workstream,
      ownerId: input.fence.ownerId,
      runId: input.fence.runId,
      fencingToken: input.fence.fencingToken
    }
  };
  const confirmationFingerprint = canonicalJsonHash({
    executionReviewId: intent.execution_review_id,
    reviewPayloadFingerprint: intent.review_payload_fingerprint,
    evidence: confirmationEvidence
  });
  const confirmationId = `confirmation_${confirmationFingerprint}`;
  const confirmationSignature = createHmac("sha256", input.signingKey)
    .update(confirmationFingerprint)
    .digest("hex");
  const confirmationWrite = await input.query.query(
    `INSERT INTO confirmation_evidence(
       id, execution_review_id, account_id, candidate_id, evidence_type,
       confirmation_method, status, paper_only, payload_fingerprint,
       signature_algorithm, signature, evidence, confirmed_at, expires_at,
       created_at, updated_at
     ) SELECT $1, $2, $3, $4, $5, $6, 'valid', true, $7,
              'hmac-sha256', $8, $9::jsonb, $10, $11, $10, $10
       WHERE ${fenceSql(12)}
     ON CONFLICT (execution_review_id, payload_fingerprint) DO NOTHING`,
    [
      confirmationId,
      intent.execution_review_id,
      intent.account_id,
      intent.candidate_id,
      "paper_execution_confirmation",
      "autonomous_worker_confirm_paper",
      confirmationFingerprint,
      confirmationSignature,
      JSON.stringify(confirmationEvidence),
      nowIso,
      expiresAt,
      ...fenceValues(input.fence)
    ]
  );
  if (confirmationWrite.rowCount !== 1) {
    throw new Error("POSTGRES_CONFIRMATION_EVIDENCE_PERSISTENCE_FAILED");
  }

  const reservationId = reservationRequired
    ? `reservation_${canonicalJsonHash({
        accountId: intent.account_id,
        orderIntentId: intent.order_intent_id,
        confirmationId
      })}`
    : null;
  if (reservationRequired) {
    const reservationFingerprint = canonicalJsonHash({
      accountId: intent.account_id,
      accountSnapshotId: intent.account_snapshot_id,
      strategyKey: intent.strategy_key,
      symbol: intent.symbol,
      amount
    });
    const reservationWrite = await input.query.query(
      `INSERT INTO buying_power_reservations(
         id, account_id, candidate_id, strategy_key, symbol, asset_class,
         amount, status, idempotency_key, reservation_fingerprint,
         account_snapshot_id, scheduler_job_name, scheduler_fencing_token,
         expires_at, created_at, updated_at
       ) SELECT $1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12,
                $13, $14, $14
         WHERE ${fenceSql(15)}`,
      [
        reservationId,
        intent.account_id,
        intent.candidate_id,
        intent.strategy_key,
        intent.symbol,
        intent.asset_class,
        amount,
        `confirmation:${confirmationFingerprint}`,
        reservationFingerprint,
        intent.account_snapshot_id,
        input.fence.jobName,
        input.fence.fencingToken,
        expiresAt,
        nowIso,
        ...fenceValues(input.fence)
      ]
    );
    if (reservationWrite.rowCount !== 1) {
      throw new Error("POSTGRES_CONFIRMATION_RESERVATION_PERSISTENCE_FAILED");
    }
    const allocationWrite = await input.query.query(
      `UPDATE strategy_allocations
       SET reserved_amount = reserved_amount + $3::numeric,
           updated_at = $4, version = version + 1
       WHERE account_id = $1 AND strategy_key = $2
         AND status = 'active' AND effective_to IS NULL
         AND ${fenceSql(5)}`,
      [
        intent.account_id,
        intent.strategy_key,
        amount,
        nowIso,
        ...fenceValues(input.fence)
      ]
    );
    if (allocationWrite.rowCount !== 1) {
      throw new Error("POSTGRES_CONFIRMATION_ALLOCATION_PERSISTENCE_FAILED");
    }
  }

  const lifecycleFingerprint = canonicalJsonHash({
    orderIntentId: intent.order_intent_id,
    confirmationId,
    reservationId,
    status: "ready_for_submission",
    at: nowIso
  });
  const intentWrite = await input.query.query(
    `UPDATE order_intents
     SET confirmation_evidence_id = $2, reservation_id = $3,
         status = 'ready_for_submission', ready_at = $4, updated_at = $4,
         lifecycle_fingerprint = $5, version = version + 1
     WHERE id = $1 AND status = 'created' AND ${fenceSql(6)}`,
    [
      intent.order_intent_id,
      confirmationId,
      reservationId,
      nowIso,
      lifecycleFingerprint,
      ...fenceValues(input.fence)
    ]
  );
  if (intentWrite.rowCount !== 1) {
    throw new Error("POSTGRES_CONFIRMATION_PROMOTION_FAILED");
  }
  const lifecycleWrite = await input.query.query(
    `INSERT INTO lifecycle_fingerprints(
       id, account_id, candidate_id, order_intent_id, entity_type, entity_id,
       lifecycle_stage, fingerprint, payload_version, evidence, captured_at, created_at
     ) SELECT $1, $2, $3, $4, 'order_intent', $4, 'ready_for_submission',
              $5, 1, $6::jsonb, $7, $7
       WHERE ${fenceSql(8)}
     ON CONFLICT (entity_type, entity_id, lifecycle_stage, fingerprint) DO NOTHING`,
    [
      `${intent.order_intent_id}:ready:${confirmationFingerprint}`,
      intent.account_id,
      intent.candidate_id,
      intent.order_intent_id,
      lifecycleFingerprint,
      JSON.stringify({
        confirmationId,
        reservationId,
        command: input.command,
        ...(portfolioStateAuthority
          ? { portfolioState: portfolioStateAuthority }
          : {})
      }),
      nowIso,
      ...fenceValues(input.fence)
    ]
  );
  if (lifecycleWrite.rowCount !== 1) {
    throw new Error("POSTGRES_CONFIRMATION_LIFECYCLE_PERSISTENCE_FAILED");
  }
  if (intent.candidate_id) {
    const candidateWrite = await input.query.query(
      `UPDATE candidates
       SET lifecycle_status = 'confirmed',
           decision_reason = 'PAPER_ORDER_INTENT_CONFIRMED',
           updated_at = $2, version = version + 1
       WHERE id = $1 AND decision = 'selected' AND ${fenceSql(3)}`,
      [
        intent.candidate_id,
        nowIso,
        ...fenceValues(input.fence)
      ]
    );
    if (candidateWrite.rowCount !== 1) {
      throw new Error("POSTGRES_CONFIRMATION_CANDIDATE_PERSISTENCE_FAILED");
    }
  }
  return {
    status: "promoted" as const,
    orderIntentId: intent.order_intent_id,
    confirmationEvidenceId: confirmationId,
    reservationId
  };
};

const persistCandidateExecutionStage = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  fence: SchedulerFence,
  now: Date,
  status: "execution_deferred" | "execution_ambiguous" | "executed",
  reason: string
) => {
  if (!intent.candidate_id) return;
  const result = await query.query(
    `UPDATE candidates
     SET lifecycle_status = $2, decision_reason = $3, updated_at = $4,
         version = version + 1
     WHERE id = $1 AND decision = 'selected' AND ${fenceSql(5)}`,
    [
      intent.candidate_id,
      status,
      reason,
      now.toISOString(),
      ...fenceValues(fence)
    ]
  );
  if (result.rowCount !== 1) throw new Error("POSTGRES_CANDIDATE_STAGE_PERSISTENCE_FAILED");
};

const claimIntent = async (
  query: AutonomousExecutionQuery,
  command: string,
  fence: SchedulerFence,
  now: Date,
  expectedPayloadSignature?: string,
  strategyFamily?: string
) => {
  const selected = await query.query(
    `SELECT intent.id AS order_intent_id, intent.candidate_id, intent.account_id,
            account.broker_account_id,
            snapshot.snapshot_fingerprint AS account_snapshot_fingerprint,
            review.account_fingerprint AS review_account_fingerprint,
            intent.max_risk::text AS max_risk,
            intent.authorization_snapshot_id,
            snapshot.id AS current_account_snapshot_id,
            intent.reservation_id, intent.execution_review_id, review.review_type,
            intent.confirmation_evidence_id, review.signature AS review_signature,
            review.payload_fingerprint,
            review.client_order_id AS review_client_order_id,
            review.order_intent AS review_order_intent,
            intent.client_order_id,
            intent.strategy_key, intent.symbol, intent.asset_class,
            intent.underlying_symbol,
            intent.side, intent.order_type, intent.time_in_force,
            intent.quantity::text AS quantity, intent.notional::text AS notional,
            intent.limit_price::text AS limit_price,
            intent.stop_price::text AS stop_price, intent.version AS intent_version,
            review.market_evidence,
            review.portfolio_evidence->'portfolioStatePacket'
              AS review_portfolio_state_packet,
            intent.request_payload->'portfolioStatePacket'
              AS intent_portfolio_state_packet,
            snapshot.evidence->'portfolioStatePacket'
              AS current_portfolio_state_packet,
            intent.operation,
            intent.strategy_classification, intent.parent_position_id,
            intent.opening_intent_id, intent.contract_id,
            parent_position.side AS position_side,
            parent_position.available_quantity::text
              AS position_available_quantity,
            parent_position.option_symbol AS position_option_symbol,
            opening_intent.contract_id AS position_contract_id
     FROM order_intents intent
     JOIN accounts account ON account.id = intent.account_id
     LEFT JOIN positions parent_position
       ON parent_position.id = intent.parent_position_id
      AND parent_position.account_id = intent.account_id
      AND parent_position.status = 'open'
     LEFT JOIN order_intents opening_intent
       ON opening_intent.id = intent.opening_intent_id
     JOIN LATERAL (
       SELECT * FROM account_snapshots current_snapshot
       WHERE current_snapshot.account_id = intent.account_id
       ORDER BY current_snapshot.observed_at DESC, current_snapshot.id DESC LIMIT 1
     ) snapshot ON true
     JOIN execution_reviews review ON review.id = intent.execution_review_id
     JOIN confirmation_evidence confirmation
       ON confirmation.id = intent.confirmation_evidence_id
      AND confirmation.execution_review_id = review.id
     JOIN strategy_allocations allocation
       ON allocation.account_id = intent.account_id
      AND allocation.strategy_key = intent.strategy_key
      AND allocation.status = 'active' AND allocation.effective_to IS NULL
     JOIN LATERAL (
       SELECT *
       FROM risk_limits current_limits
       WHERE current_limits.account_id = intent.account_id
         AND current_limits.status = 'active' AND current_limits.effective_to IS NULL
       ORDER BY CASE WHEN current_limits.scope_type = 'portfolio' THEN 0 ELSE 1 END,
                current_limits.updated_at DESC
       LIMIT 1
     ) limits ON true
     JOIN LATERAL (
       SELECT id FROM portfolio_exposure exposure
       WHERE exposure.account_id = intent.account_id
       ORDER BY exposure.observed_at DESC, exposure.id DESC LIMIT 1
     ) exposure ON true
     LEFT JOIN buying_power_reservations reservation ON reservation.id = intent.reservation_id
     JOIN LATERAL (
       SELECT COALESCE(SUM(active_reservation.amount), 0) AS total,
              COALESCE(SUM(active_reservation.amount)
                FILTER (WHERE active_reservation.symbol = intent.symbol), 0) AS symbol_total
       FROM buying_power_reservations active_reservation
       WHERE active_reservation.account_id = intent.account_id
         AND active_reservation.status = 'active'
         AND active_reservation.expires_at > $1
     ) reservation_state ON true
     JOIN LATERAL (
       SELECT COALESCE(SUM(COALESCE(
                open_order.notional,
                open_order.quantity * open_order.limit_price *
                  CASE WHEN open_order.asset_class = 'option' THEN 100 ELSE 1 END
              )), 0) AS total,
              COALESCE(SUM(COALESCE(
                open_order.notional,
                open_order.quantity * open_order.limit_price *
                  CASE WHEN open_order.asset_class = 'option' THEN 100 ELSE 1 END
              )) FILTER (WHERE open_order.symbol = intent.symbol), 0) AS symbol_total,
              COUNT(*) AS count
       FROM orders open_order
       WHERE open_order.account_id = intent.account_id
         AND open_order.status IN (
           'new', 'accepted', 'pending_new', 'partially_filled', 'held', 'replaced'
         )
     ) open_order_state ON true
     JOIN LATERAL (
       SELECT COALESCE(SUM(ABS(COALESCE(
                current_position.market_value, current_position.cost_basis, 0
              ))), 0) AS total,
              COALESCE(SUM(ABS(COALESCE(
                current_position.market_value, current_position.cost_basis, 0
              ))) FILTER (WHERE current_position.symbol = intent.symbol), 0) AS symbol_total,
              COUNT(*) AS count
       FROM positions current_position
       WHERE current_position.account_id = intent.account_id
         AND current_position.status IN ('open', 'closing')
     ) position_state ON true
     WHERE intent.status = 'ready_for_submission' AND intent.environment = 'paper'
       AND ${commandFilter(command, strategyFamily)}
       AND review.status = 'valid' AND review.environment = 'paper'
       AND review.paper_only AND NOT review.live_trading_enabled
       AND review.expires_at > $1
       AND ${exactReviewAuthorizationSql}
       AND confirmation.status = 'valid' AND confirmation.paper_only
       AND confirmation.expires_at > $1
       AND ${noPriorBrokerAcknowledgementSql}
       AND snapshot.evidence->>'structuralPortfolioFingerprint' = review.account_fingerprint
       AND (
         intent.reservation_id IS NULL OR
         (reservation.status = 'active' AND reservation.expires_at > $1
          AND COALESCE(snapshot.buying_power, 0)
                - reservation_state.total
                - open_order_state.total
                - GREATEST(
                    COALESCE(limits.cash_reserve_amount, 0),
                    COALESCE(snapshot.equity, 0) *
                      COALESCE(limits.cash_reserve_ratio, 0)
                  ) >= 0
          AND (
            limits.max_deployment_amount IS NULL OR
            position_state.total + open_order_state.total + reservation_state.total
              <= limits.max_deployment_amount
          )
          AND (
            limits.max_deployment_ratio IS NULL OR
            position_state.total + open_order_state.total + reservation_state.total
              <= COALESCE(snapshot.equity, 0) * limits.max_deployment_ratio
          )
          AND (
            allocation.allocation_amount IS NULL OR
            allocation.deployed_amount + allocation.reserved_amount
              <= allocation.allocation_amount
          )
          AND (
            allocation.allocation_ratio IS NULL OR
            allocation.deployed_amount + allocation.reserved_amount
              <= COALESCE(snapshot.equity, 0) * allocation.allocation_ratio
          )
          AND (
            limits.max_symbol_notional IS NULL OR
            position_state.symbol_total + open_order_state.symbol_total +
              reservation_state.symbol_total <= limits.max_symbol_notional
          )
          AND (
            limits.max_position_count IS NULL OR
            position_state.count < limits.max_position_count
          )
          AND (
            limits.max_order_count IS NULL OR
            open_order_state.count < limits.max_order_count
          ))
       )
     ORDER BY intent.ready_at, intent.created_at, intent.id
     LIMIT 1
     FOR UPDATE OF intent, review, confirmation SKIP LOCKED`,
    [now.toISOString()]
  );
  const intent = selected.rows[0] as AutonomousExecutionIntentRow | undefined;
  if (!intent) throw new Error("POSTGRES_EXECUTION_EVIDENCE_GATE_FAILED");
  assertExactReviewAuthorization(intent);
  if (intent.review_type === "entry") {
    assertPortfolioStateExecutionAuthority(intent, now);
  }
  if (
    expectedPayloadSignature &&
    intent.review_signature !== expectedPayloadSignature &&
    intent.payload_fingerprint !== expectedPayloadSignature
  ) {
    throw new Error("PAPER_REVIEW_ARTIFACT_MISMATCH");
  }
  const claimed = await query.query(
    `UPDATE order_intents
     SET status = 'submission_pending', updated_at = $2, version = version + 1
     WHERE id = $1 AND version = $3 AND status = 'ready_for_submission'
       AND ${fenceSql(4)}`,
    [
      intent.order_intent_id,
      now.toISOString(),
      intent.intent_version,
      ...fenceValues(fence)
    ]
  );
  if (claimed.rowCount !== 1) throw new Error("POSTGRES_EXECUTION_INTENT_CLAIM_FAILED");
  return intent;
};

const releaseClaim = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  fence: SchedulerFence,
  now: Date,
  reason: string
) => {
  const released = await query.query(
    `UPDATE order_intents
     SET status = 'ready_for_submission', updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(3)}`,
    [intent.order_intent_id, now.toISOString(), ...fenceValues(fence)]
  );
  if (released.rowCount !== 1) {
    throw new Error("POSTGRES_EXECUTION_INTENT_RELEASE_FAILED");
  }
  await persistCandidateExecutionStage(
    query,
    intent,
    fence,
    now,
    "execution_deferred",
    reason
  );
};

const buildMutationReceipt = (input: {
  intent: AutonomousExecutionIntentRow;
  payload: AlpacaPaperOrderRequest;
  command: string;
  fence: SchedulerFence;
  lifecycleContext: {
    cycleId: string;
    workstreamExecutionId: string;
  };
  attemptedAt: Date;
}): BrokerMutationReceipt => {
  const cycleId = text(input.lifecycleContext.cycleId);
  const workstreamExecutionId = text(
    input.lifecycleContext.workstreamExecutionId
  );
  if (!cycleId) throw new Error("POSTGRES_MUTATION_CYCLE_ID_REQUIRED");
  if (!workstreamExecutionId) {
    throw new Error("POSTGRES_MUTATION_WORKSTREAM_EXECUTION_ID_REQUIRED");
  }
  if (workstreamExecutionId !== input.fence.runId) {
    throw new Error("POSTGRES_MUTATION_SCHEDULER_RUN_MISMATCH");
  }
  const intentId = text(input.intent.order_intent_id);
  if (!intentId) throw new Error("POSTGRES_EXECUTION_INTENT_ID_REQUIRED");
  const requestFingerprint = canonicalJsonHash(input.payload);
  return {
    mutationReceiptId: `mutation_receipt_${stableRecordId(
      "alpaca_order_submission",
      `${input.intent.account_id}:${intentId}:${input.intent.client_order_id}`
    )}`,
    environment: "paper",
    intentId,
    cycleId,
    workstream: input.command,
    schedulerRunId: input.fence.runId,
    fencingToken: input.fence.fencingToken,
    deterministicClientOrderId: input.intent.client_order_id,
    submissionAttemptSequence: 1,
    submissionAction: input.intent.review_type === "exit"
      ? "closing"
      : "opening",
    brokerOrderId: null,
    requestFingerprint,
    requestedSymbol: input.payload.symbol,
    requestedSide: input.payload.side,
    requestedQuantity: input.payload.qty ?? null,
    requestedNotional: input.payload.notional ?? null,
    requestedOrderType: input.payload.type,
    requestedLimitPrice: input.payload.limit_price ?? null,
    requestedStopPrice: input.intent.stop_price,
    requestedPositionIntent:
      input.intent.operation ??
      input.payload.position_intent ??
      input.payload.side,
    submissionAttemptTimestamp: input.attemptedAt.toISOString(),
    brokerAcknowledgementTimestamp: null,
    outcomeClassification: "submission_attempted",
    resultingLifecycleState: input.intent.review_type === "exit"
      ? "exit_submission_attempt_persisted"
      : "submission_attempt_persisted"
  };
};

const receiptWithOutcome = (
  receipt: BrokerMutationReceipt,
  input: {
    outcomeClassification: BrokerMutationOutcome;
    resultingLifecycleState: string;
    brokerOrderId?: string | null;
    brokerAcknowledgementTimestamp?: string | null;
  }
): BrokerMutationReceipt => ({
  ...receipt,
  brokerOrderId: input.brokerOrderId ?? receipt.brokerOrderId,
  brokerAcknowledgementTimestamp:
    input.brokerAcknowledgementTimestamp ??
    receipt.brokerAcknowledgementTimestamp,
  outcomeClassification: input.outcomeClassification,
  resultingLifecycleState: input.resultingLifecycleState
});

const recordSubmission = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  response: AlpacaApiResponse<AlpacaSubmittedOrder>,
  receipt: BrokerMutationReceipt,
  fence: SchedulerFence,
  receivedAt: Date
) => {
  const brokerOrderId = text(response.data.id);
  const brokerClientOrderId = text(response.data.client_order_id);
  const status = text(response.data.status).toLowerCase();
  if (!brokerOrderId || brokerClientOrderId !== intent.client_order_id || !status) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_IDENTITY_INCOMPLETE");
  }
  const orderId = `order_${stableRecordId("alpaca_order", `${intent.account_id}:${brokerOrderId}`)}`;
  const occurredAt = text(response.data.submitted_at || response.data.created_at) ||
    receivedAt.toISOString();
  const payload = response.data as unknown as Record<string, unknown>;
  const eventId = `broker_event_${stableRecordId("alpaca_broker_event", `${orderId}:${status}:${occurredAt}`)}`;
  const lifecycleState = lifecycleStateForBrokerStatus(intent.review_type, status);
  const acknowledgedReceipt = receiptWithOutcome(receipt, {
    outcomeClassification: status === "rejected"
      ? "submission_rejected"
      : "submission_acknowledged",
    resultingLifecycleState: lifecycleState,
    brokerOrderId,
    brokerAcknowledgementTimestamp: receivedAt.toISOString()
  });
  const values = fenceValues(fence);
  const storedOrder = await query.query(
    `INSERT INTO orders(
       id, account_id, order_intent_id, broker_order_id, client_order_id,
       environment, symbol, asset_class, side, order_type, time_in_force,
       status, quantity, notional, limit_price, stop_price, filled_quantity,
       filled_average_price, broker_request_id, submitted_at,
       last_broker_update_at, raw_status, created_at, updated_at
     ) SELECT $1, $2, $3, $4, $5, 'paper', $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $19,
              $20::jsonb, $19, $19
       WHERE ${fenceSql(21)}
     ON CONFLICT (account_id, client_order_id) DO NOTHING`,
    [
      orderId, intent.account_id, intent.order_intent_id, brokerOrderId,
      intent.client_order_id, intent.symbol, intent.asset_class, intent.side,
      intent.order_type, intent.time_in_force, status,
      response.data.qty ?? intent.quantity, response.data.notional ?? intent.notional,
      response.data.limit_price ?? intent.limit_price,
      response.data.stop_price ?? intent.stop_price,
      response.data.filled_qty ?? "0", response.data.filled_avg_price ?? null,
      response.requestId ?? null, occurredAt, JSON.stringify(payload), ...values
    ]
  );
  if (storedOrder.rowCount !== 1) {
    throw new Error("POSTGRES_BROKER_ORDER_LINEAGE_CONFLICT");
  }
  const storedEvent = await query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_id, order_intent_id, broker_order_id,
       client_order_id, event_type, event_status, request_id, http_status,
       response_payload, response_fingerprint, occurred_at, received_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'order_submission', $7, $8, $9,
               $10::jsonb, $11, $12,
               GREATEST($13::timestamptz, $12::timestamptz))
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId, intent.account_id, orderId, intent.order_intent_id, brokerOrderId,
      intent.client_order_id, acknowledgedReceipt.outcomeClassification,
      response.requestId ?? null, response.status,
      JSON.stringify(acknowledgedReceipt),
      canonicalJsonHash(acknowledgedReceipt),
      occurredAt, receivedAt.toISOString()
    ]
  );
  if (storedEvent.rowCount !== 1) {
    throw new Error("POSTGRES_MUTATION_RECEIPT_ACKNOWLEDGEMENT_PERSISTENCE_FAILED");
  }
  const terminalWithoutFill = ["cancelled", "rejected", "expired"].includes(lifecycleState);
  const reservationReleaseReason = lifecycleState === "cancelled"
    ? "broker_terminal_cancelled"
    : lifecycleState === "rejected"
      ? "broker_terminal_rejected"
      : lifecycleState === "expired"
        ? "broker_terminal_expired"
        : null;
  const intentStatus = terminalWithoutFill
    ? (lifecycleState === "cancelled" ? "cancelled" : "failed")
    : "submitted";
  const updated = await query.query(
    `UPDATE order_intents
     SET status = $3, lifecycle_state = $4,
         submitted_at = $2,
         terminal_at = CASE WHEN $5 THEN $2 ELSE terminal_at END,
         reservation_release_reason = COALESCE($6, reservation_release_reason),
         updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(7)}`,
    [
      intent.order_intent_id,
      receivedAt.toISOString(),
      intentStatus,
      lifecycleState,
      terminalWithoutFill,
      reservationReleaseReason,
      ...values
    ]
  );
  if (updated.rowCount !== 1) throw new Error("POSTGRES_EXECUTION_RESULT_PERSISTENCE_FAILED");
  if (intent.reservation_id && terminalWithoutFill && reservationReleaseReason) {
    const transitionId = `reservation_transition_${stableRecordId(
      "reservation_terminal",
      `${intent.reservation_id}:${lifecycleState}`
    )}`;
    const reservation = await query.query(
      `WITH released AS (
         UPDATE buying_power_reservations reservation
         SET status = 'released', released_at = $3, release_reason = $2,
             updated_at = $3, version = reservation.version + 1
         WHERE reservation.id = $1
           AND reservation.status IN ('active', 'committed')
           AND ${fenceSql(8)}
         RETURNING reservation.account_id, reservation.strategy_key,
                   reservation.amount
       ), adjusted AS (
         UPDATE strategy_allocations allocation
         SET reserved_amount = GREATEST(0, allocation.reserved_amount - released.amount),
             updated_at = $3, version = allocation.version + 1
         FROM released
         WHERE allocation.account_id = released.account_id
           AND allocation.strategy_key = released.strategy_key
           AND allocation.status = 'active' AND allocation.effective_to IS NULL
         RETURNING allocation.id
       ), terminal_transition AS (
         INSERT INTO reservation_terminal_transitions(
           id, reservation_id, order_intent_id, terminal_state,
           release_reason, idempotency_key, occurred_at
         )
         SELECT $6, $1, $4, $5, $2, $7, $3 FROM released
         ON CONFLICT (reservation_id) DO NOTHING
         RETURNING id
       )
       SELECT
         (SELECT COUNT(*) FROM released)::text AS released_reservation_count,
         (SELECT COUNT(*) FROM adjusted)::text AS adjusted_allocation_count,
         (SELECT COUNT(*) FROM terminal_transition)::text AS terminal_transition_count`,
      [
        intent.reservation_id,
        reservationReleaseReason,
        receivedAt.toISOString(),
        intent.order_intent_id,
        lifecycleState,
        transitionId,
        `${intent.order_intent_id}:${lifecycleState}`,
        ...values
      ]
    );
    if (
      Number(reservation.rows[0]?.released_reservation_count ?? 0) !== 1 ||
      Number(reservation.rows[0]?.adjusted_allocation_count ?? 0) !== 1 ||
      Number(reservation.rows[0]?.terminal_transition_count ?? 0) !== 1
    ) {
      throw new Error("POSTGRES_EXECUTION_TERMINAL_RESERVATION_RELEASE_FAILED");
    }
  } else if (intent.reservation_id) {
    const reservation = await query.query(
      `UPDATE buying_power_reservations
       SET status = 'committed', committed_at = $2, updated_at = $2, version = version + 1
       WHERE id = $1 AND status = 'active' AND ${fenceSql(3)}`,
      [intent.reservation_id, receivedAt.toISOString(), ...values]
    );
    if (reservation.rowCount !== 1) {
      throw new Error("POSTGRES_EXECUTION_RESERVATION_COMMIT_FAILED");
    }
  }
  const consumedReview = await query.query(
    `UPDATE execution_reviews
     SET status = 'consumed', consumed_at = $2, updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'valid' AND ${fenceSql(3)}`,
    [intent.execution_review_id, receivedAt.toISOString(), ...values]
  );
  if (consumedReview.rowCount !== 1) {
    throw new Error("POSTGRES_EXECUTION_REVIEW_CONSUMPTION_FAILED");
  }
  const consumedConfirmation = await query.query(
    `UPDATE confirmation_evidence
     SET status = 'consumed', consumed_at = $2, updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'valid' AND ${fenceSql(3)}`,
    [intent.confirmation_evidence_id, receivedAt.toISOString(), ...values]
  );
  if (consumedConfirmation.rowCount !== 1) {
    throw new Error("POSTGRES_EXECUTION_CONFIRMATION_CONSUMPTION_FAILED");
  }
  await persistCandidateExecutionStage(
    query,
    intent,
    fence,
    receivedAt,
    terminalWithoutFill ? "execution_deferred" : "executed",
    terminalWithoutFill ? `PAPER_ORDER_${status.toUpperCase()}` : "PAPER_ORDER_SUBMITTED"
  );
  return {
    orderId,
    brokerOrderId,
    status,
    mutationReceipt: acknowledgedReceipt
  };
};

const recordSubmissionAttempt = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  payload: AlpacaPaperOrderRequest,
  command: string,
  fence: SchedulerFence,
  now: Date,
  lifecycleContext: { cycleId: string; workstreamExecutionId: string }
) => {
  const receipt = buildMutationReceipt({
    intent,
    payload,
    command,
    fence,
    lifecycleContext,
    attemptedAt: now
  });
  const eventId = `broker_event_${stableRecordId(
    "alpaca_broker_submission_attempt",
    `${intent.account_id}:${intent.order_intent_id}:${intent.client_order_id}`
  )}`;
  const inserted = await query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_intent_id, client_order_id,
       event_type, event_status, retryable, response_payload,
       response_fingerprint, occurred_at, received_at
     ) SELECT $1, $2, $3, $4, 'order_submission_attempt',
              'submission_attempted', true,
              $5::jsonb, $6, $7, $7
       WHERE ${fenceSql(8)}
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      intent.account_id,
      intent.order_intent_id,
      intent.client_order_id,
      JSON.stringify(receipt),
      canonicalJsonHash(receipt),
      now.toISOString(),
      ...fenceValues(fence)
    ]
  );
  if (inserted.rowCount !== 1) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_ATTEMPT_PERSISTENCE_FAILED");
  }
  const lifecycleState = intent.review_type === "exit"
    ? "exit_submission_attempt_persisted"
    : "submission_attempt_persisted";
  const lifecycleUpdated = await query.query(
    `UPDATE order_intents
     SET lifecycle_state = $2,
         autonomous_cycle_id = COALESCE($4, autonomous_cycle_id),
         workstream_execution_id = COALESCE($5, workstream_execution_id),
         updated_at = $3, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(6)}`,
    [intent.order_intent_id, lifecycleState, now.toISOString(), lifecycleContext?.cycleId ?? null,
      lifecycleContext?.workstreamExecutionId ?? null, ...fenceValues(fence)]
  );
  if (lifecycleUpdated.rowCount !== 1) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_ATTEMPT_LIFECYCLE_PERSISTENCE_FAILED");
  }
  return receipt;
};

const recordAmbiguousSubmission = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  receipt: BrokerMutationReceipt,
  error: unknown,
  fence: SchedulerFence,
  now: Date,
  errorClassification = "ambiguous_network_result"
) => {
  const message = error instanceof Error
    ? error.message.slice(0, 500)
    : "Broker submission ended without a verified response.";
  const payload = {
    ...receipt,
    code: "POSTGRES_BROKER_SUBMISSION_AMBIGUOUS",
    message
  };
  const eventId = `broker_event_${stableRecordId(
    "alpaca_broker_submission_ambiguous",
    `${intent.account_id}:${intent.client_order_id}:${now.toISOString()}`
  )}`;
  const values = fenceValues(fence);
  const updated = await query.query(
    `UPDATE order_intents
     SET status = 'ambiguous', lifecycle_state = CASE WHEN $3 = 'exit' THEN 'exit_submission_ambiguous' ELSE 'submission_ambiguous' END,
         updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(4)}`,
    [intent.order_intent_id, now.toISOString(), intent.review_type, ...values]
  );
  if (updated.rowCount !== 1) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_AMBIGUITY_PERSISTENCE_FAILED");
  }
  const inserted = await query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_intent_id, client_order_id,
       event_type, event_status, error_classification, retryable,
       response_payload, response_fingerprint, occurred_at, received_at
     ) SELECT $1, $2, $3, $4, 'order_submission', $5,
              $6, true, $7::jsonb, $8, $9, $9
       WHERE ${fenceSql(10)}
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      intent.account_id,
      intent.order_intent_id,
      intent.client_order_id,
      receipt.outcomeClassification,
      errorClassification,
      JSON.stringify(payload),
      canonicalJsonHash(payload),
      now.toISOString(),
      ...values
    ]
  );
  if (inserted.rowCount !== 1) {
    throw new Error("POSTGRES_BROKER_SUBMISSION_AMBIGUITY_PERSISTENCE_FAILED");
  }
  await persistCandidateExecutionStage(
    query,
    intent,
    fence,
    now,
    "execution_ambiguous",
    "POSTGRES_BROKER_SUBMISSION_AMBIGUOUS"
  );
  return receipt;
};

const isAmbiguousSubmissionError = (error: unknown) => {
  const status = Number((error as { status?: unknown } | null)?.status);
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return !/invalid|rejected|not tradable|insufficient|forbidden|unauthorized|bad request/i.test(message);
};

const recordDeterministicSubmissionFailure = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  receipt: BrokerMutationReceipt,
  error: unknown,
  fence: SchedulerFence,
  now: Date
) => {
  const message = error instanceof Error ? error.message.slice(0, 500) : "Broker rejected the order.";
  const rejectedReceipt = receiptWithOutcome(receipt, {
    outcomeClassification: "submission_rejected",
    resultingLifecycleState: "failed_terminal"
  });
  const payload = {
    ...rejectedReceipt,
    code: "POSTGRES_BROKER_SUBMISSION_REJECTED",
    message
  };
  const values = fenceValues(fence);
  const updated = await query.query(
    `UPDATE order_intents
     SET status = 'failed', lifecycle_state = 'failed_terminal', terminal_at = $2,
         updated_at = $2, version = version + 1
     WHERE id = $1 AND status = 'submission_pending' AND ${fenceSql(3)}`,
    [intent.order_intent_id, now.toISOString(), ...values]
  );
  if (updated.rowCount !== 1) throw new Error("POSTGRES_BROKER_SUBMISSION_REJECTION_PERSISTENCE_FAILED");
  const inserted = await query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_intent_id, client_order_id,
       event_type, event_status, error_classification, retryable,
       response_payload, response_fingerprint, occurred_at, received_at
     ) SELECT $1, $2, $3, $4, 'order_submission', 'submission_rejected',
              'deterministic_broker_rejection', false, $5::jsonb, $6, $7, $7
       WHERE ${fenceSql(8)}
     ON CONFLICT (event_id) DO NOTHING`,
    [
      `broker_event_${stableRecordId("alpaca_broker_submission_rejected", `${intent.account_id}:${intent.client_order_id}:${now.toISOString()}`)}`,
      intent.account_id, intent.order_intent_id, intent.client_order_id,
      JSON.stringify(payload), canonicalJsonHash(payload), now.toISOString(), ...values
    ]
  );
  if (inserted.rowCount !== 1) {
    throw new Error("POSTGRES_MUTATION_RECEIPT_REJECTION_PERSISTENCE_FAILED");
  }
  return rejectedReceipt;
};

const recordReconciledSubmissionReceipt = async (
  query: AutonomousExecutionQuery,
  intent: AutonomousExecutionIntentRow,
  receipt: BrokerMutationReceipt,
  recovery: Extract<AmbiguousSubmissionRecovery, { status: "recovered" }>,
  fence: SchedulerFence,
  now: Date
) => {
  const reconciledReceipt = receiptWithOutcome(receipt, {
    outcomeClassification: "submission_reconciled",
    resultingLifecycleState: lifecycleStateForBrokerStatus(
      intent.review_type,
      recovery.brokerStatus
    ),
    brokerOrderId: recovery.brokerOrderId,
    brokerAcknowledgementTimestamp: now.toISOString()
  });
  const eventId = `broker_event_${stableRecordId(
    "alpaca_broker_submission_receipt_reconciled",
    `${intent.account_id}:${intent.client_order_id}:${recovery.brokerOrderId}`
  )}`;
  const inserted = await query.query(
    `INSERT INTO broker_events(
       event_id, account_id, order_id, order_intent_id, broker_order_id,
       client_order_id, event_type, event_status, retryable,
       response_payload, response_fingerprint, occurred_at, received_at
     ) SELECT $1, $2, $3, $4, $5, $6,
              'order_submission_receipt', 'submission_reconciled', false,
              $7::jsonb, $8, $9, $9
       WHERE ${fenceSql(10)}
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      intent.account_id,
      recovery.orderId,
      intent.order_intent_id,
      recovery.brokerOrderId,
      intent.client_order_id,
      JSON.stringify(reconciledReceipt),
      canonicalJsonHash(reconciledReceipt),
      now.toISOString(),
      ...fenceValues(fence)
    ]
  );
  if (inserted.rowCount !== 1) {
    throw new Error("POSTGRES_MUTATION_RECEIPT_RECONCILIATION_PERSISTENCE_FAILED");
  }
  const consumedReview = await query.query(
    `UPDATE execution_reviews
     SET status = 'consumed', consumed_at = $2, updated_at = $2,
         version = version + 1
     WHERE id = $1 AND status IN ('valid', 'expired')
       AND ${fenceSql(3)}`,
    [intent.execution_review_id, now.toISOString(), ...fenceValues(fence)]
  );
  if (consumedReview.rowCount !== 1) {
    throw new Error("POSTGRES_EXECUTION_REVIEW_CONSUMPTION_FAILED");
  }
  const consumedConfirmation = await query.query(
    `UPDATE confirmation_evidence
     SET status = 'consumed', consumed_at = $2, updated_at = $2,
         version = version + 1
     WHERE id = $1 AND status IN ('valid', 'expired')
       AND ${fenceSql(3)}`,
    [
      intent.confirmation_evidence_id,
      now.toISOString(),
      ...fenceValues(fence)
    ]
  );
  if (consumedConfirmation.rowCount !== 1) {
    throw new Error("POSTGRES_EXECUTION_CONFIRMATION_CONSUMPTION_FAILED");
  }
  return reconciledReceipt;
};

const assertSafety = (
  safety: AutonomousExecutionSafety,
  confirmPaper: boolean,
  confirmLive: boolean,
  now: Date
) => {
  const environment = safety.environment === "live" ? "live" : "paper";
  const decision = evaluateTradingRuntimeAuthority({
    environment: safety.environment,
    tradingMode: safety.tradingMode,
    liveTradingEnabled: safety.liveTradingEnabled,
    paperOrderExecutionEnabled: safety.paperOrderExecutionEnabled,
    paperOptionsExecutionEnabled: safety.paperOptionsExecutionEnabled,
    liveOrderExecutionEnabled: safety.liveOrderExecutionEnabled ?? false,
    liveOptionsExecutionEnabled: safety.liveOptionsExecutionEnabled ?? false,
    killSwitchEngaged: safety.killSwitchEngaged ?? (environment === "live"),
    confirmation: confirmLive ? "live" : confirmPaper ? "paper" : null,
    assetClass: "equity",
    brokerAccountId: safety.brokerAccountId,
    authorizedBrokerAccountId: safety.authorizedBrokerAccountId,
    runningReleaseSha: safety.runningReleaseSha,
    authorizedReleaseSha: safety.authorizedReleaseSha,
    liveAuthorizationId: safety.liveAuthorizationId,
    liveAuthorizationExpiresAt: safety.liveAuthorizationExpiresAt,
    liveCanaryEnabled: safety.liveCanaryEnabled,
    estimatedOrderNotionalUsd: safety.estimatedOrderNotionalUsd,
    maxOrderNotionalUsd: safety.maxOrderNotionalUsd,
    dailyRealizedPnlUsd: safety.dailyRealizedPnlUsd,
    dailyLossLimitUsd: safety.dailyLossLimitUsd,
    now
  });
  if (!decision.authorized) {
    const blocker = decision.blockers[0] ?? "TRADING_RUNTIME_AUTHORITY_BLOCKED";
    if (blocker === "PAPER_TRADING_MODE_REQUIRED") {
      throw new Error("PAPER_RUNTIME_REQUIRED");
    }
    if (
      blocker === "PAPER_LIVE_EXECUTION_MUST_BE_DISABLED" &&
      safety.liveTradingEnabled
    ) {
      throw new Error("LIVE_TRADING_MUST_BE_DISABLED");
    }
    throw new Error(blocker);
  }
  if (decision.environment === "live") {
    throw new Error("LIVE_EXECUTION_PATH_NOT_READY");
  }
};

export const runAutonomousPostgresExecutionCommand = async <
  BrokerSnapshot extends AutonomousExecutionBrokerSnapshot
>(input: {
  readonly command: string;
  readonly strategyFamily?: string;
  readonly query: AutonomousExecutionQuery;
  readonly transaction: AutonomousExecutionTransaction;
  readonly marketOpen?: () => Promise<boolean>;
  readonly captureBrokerSnapshot: () => Promise<BrokerSnapshot>;
  readonly persistBrokerSnapshot?: (
    snapshot: BrokerSnapshot
  ) => Promise<void>;
  readonly submitOrder: (
    payload: AlpacaPaperOrderRequest
  ) => Promise<AlpacaApiResponse<AlpacaSubmittedOrder>>;
  readonly recoverAmbiguousSubmission?: (
    clientOrderId: string
  ) => Promise<AmbiguousSubmissionRecovery>;
  readonly checkAsset?: (
    symbol: string
  ) => Promise<AlpacaAssetTradabilityResult>;
  readonly fence: SchedulerFence;
  readonly safety: AutonomousExecutionSafety;
  readonly confirmPaper: boolean;
  readonly confirmLive?: boolean;
  readonly confirmationSigningKey?: string;
  readonly expectedPayloadSignature?: string;
  readonly lifecycleContext?: {
    readonly cycleId: string;
    readonly workstreamExecutionId: string;
  };
  readonly now?: Date;
}) => {
  const now = input.now ?? new Date();
  assertSafety(input.safety, input.confirmPaper, input.confirmLive ?? false, now);
  const filter = commandFilter(input.command, input.strategyFamily);
  const countResult = await input.query.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE intent.status = 'ready_for_submission'
           AND review.status = 'valid' AND review.expires_at > now()
           AND ${exactReviewAuthorizationSql}
           AND ${noPriorBrokerAcknowledgementSql}
           AND EXISTS (
             SELECT 1
             FROM confirmation_evidence current_confirmation
             WHERE current_confirmation.id = intent.confirmation_evidence_id
               AND current_confirmation.execution_review_id = review.id
               AND current_confirmation.status = 'valid'
               AND current_confirmation.paper_only
               AND current_confirmation.expires_at > now()
           )
       ) AS ready_count,
       COUNT(*) FILTER (
         WHERE intent.status = 'created'
           AND review.status = 'valid' AND review.expires_at > now()
           AND ${exactReviewAuthorizationSql}
           AND ${noPriorBrokerAcknowledgementSql}
       ) AS confirmable_count
     FROM order_intents intent
     JOIN execution_reviews review ON review.id = intent.execution_review_id
     WHERE intent.status IN ('created', 'ready_for_submission')
       AND intent.environment = 'paper' AND ${filter}`
  );
  let readyCount = Number(countResult.rows[0]?.ready_count ?? 0);
  const confirmableCount = Number(countResult.rows[0]?.confirmable_count ?? 0);
  if (
    !Number.isSafeInteger(readyCount) || readyCount < 0 ||
    !Number.isSafeInteger(confirmableCount) || confirmableCount < 0
  ) {
    throw new Error("POSTGRES_READY_INTENT_COUNT_INVALID");
  }
  if (readyCount === 0 && confirmableCount === 0) {
    return {
      status: "no_op" as const,
      code: "NO_READY_POSTGRES_ORDER_INTENTS",
      submittedOrderCount: 0,
      evidence: { readyIntentCount: 0, confirmableIntentCount: 0 }
    };
  }

  if (input.marketOpen && !(await input.marketOpen())) {
    return {
      status: "no_op" as const,
      code: "PAPER_MARKET_CLOSED",
      submittedOrderCount: 0,
      evidence: {
        readyIntentCount: readyCount,
        confirmableIntentCount: confirmableCount,
        marketOpen: false
      }
    };
  }

  const broker = await input.captureBrokerSnapshot();
  await input.persistBrokerSnapshot?.(broker);
  let promotion: Awaited<ReturnType<typeof promoteNextConfirmedPostgresIntent>> | undefined;
  if (readyCount === 0 && confirmableCount > 0) {
    const signingKey = input.confirmationSigningKey ??
      process.env.PAPER_REVIEW_SIGNING_KEY?.trim() ??
      "";
    promotion = await input.transaction((query) =>
      promoteNextConfirmedPostgresIntent({
        command: input.command,
        strategyFamily: input.strategyFamily,
        query,
        fence: input.fence,
        signingKey,
        now
      })
    );
    if (promotion.status !== "promoted") {
      return {
        status: "no_op" as const,
        code: promotion.status === "blocked"
          ? promotion.code
          : "NO_READY_POSTGRES_ORDER_INTENTS",
        submittedOrderCount: 0,
        evidence: {
          readyIntentCount: 0,
          confirmableIntentCount: confirmableCount,
          confirmationPromotion: promotion.status
        }
      };
    }
    readyCount = 1;
  }
  const intent = await input.transaction((query) =>
    claimIntent(
      query,
      input.command,
      input.fence,
      now,
      input.expectedPayloadSignature,
      input.strategyFamily
    )
  );
  let payload: AlpacaPaperOrderRequest;
  try {
    if (intent.asset_class === "option" && !input.safety.paperOptionsExecutionEnabled) {
      throw new Error("PAPER_OPTIONS_EXECUTION_DISABLED");
    }
    if (
      intent.review_type === "entry" &&
      intent.asset_class === "equity" &&
      intent.operation === "sell_to_open"
    ) {
      const asset = await (
        input.checkAsset ?? checkAlpacaSymbolTradability
      )(intent.symbol);
      if (
        !asset.tradable ||
        asset.asset?.shortable !== true ||
        asset.asset.easyToBorrow !== true
      ) {
        throw new Error("POSTGRES_SHORT_ASSET_INELIGIBLE");
      }
    }
    payload = validateAutonomousExecutionEvidence(
      intent,
      broker,
      now,
      input.safety.quoteMaxAgeSeconds
    );
  } catch (error) {
    const reason = error instanceof Error
      ? error.message.slice(0, 240)
      : "POSTGRES_EXECUTION_EVIDENCE_GATE_FAILED";
    await input.transaction((query) =>
      releaseClaim(query, intent, input.fence, now, reason)
    );
    throw error;
  }
  const lifecycleContext = input.lifecycleContext ?? {
    cycleId: input.fence.runId,
    workstreamExecutionId: input.fence.runId
  };
  let mutationReceipt: BrokerMutationReceipt;
  try {
    mutationReceipt = await input.transaction((query) =>
      recordSubmissionAttempt(
        query,
        intent,
        payload,
        input.command,
        input.fence,
        now,
        lifecycleContext
      )
    );
  } catch (error) {
    const reason = error instanceof Error
      ? error.message.slice(0, 240)
      : "POSTGRES_BROKER_SUBMISSION_ATTEMPT_PERSISTENCE_FAILED";
    await input.transaction((query) =>
      releaseClaim(query, intent, input.fence, now, reason)
    );
    throw error;
  }

  const recoverSubmission = async (
    uncertainReceipt: BrokerMutationReceipt
  ) => {
    if (!input.recoverAmbiguousSubmission) {
      throw new Error("POSTGRES_BROKER_SUBMISSION_AMBIGUOUS");
    }
    const recovery = await input.recoverAmbiguousSubmission(
      intent.client_order_id
    );
    if (recovery.status === "pending") {
      return {
        status: "recovery_pending" as const,
        code: recovery.code,
        submittedOrderCount: 0,
        evidence: {
          readyIntentCount: readyCount,
          confirmableIntentCount: confirmableCount,
          confirmationPromoted: promotion?.status === "promoted",
          orderIntentId: intent.order_intent_id,
          clientOrderId: intent.client_order_id,
          recoveredFromAmbiguous: false,
          recoveryAttempts: recovery.attempts,
          mutationReceipt: uncertainReceipt
        }
      };
    }
    const reconciledAt = new Date(
      Math.max(Date.now(), now.getTime())
    );
    const reconciledReceipt = await input.transaction(async (query) => {
      const persistedReceipt = await recordReconciledSubmissionReceipt(
        query,
        intent,
        uncertainReceipt,
        recovery,
        input.fence,
        reconciledAt
      );
      await persistCandidateExecutionStage(
        query,
        intent,
        input.fence,
        reconciledAt,
        "executed",
        "PAPER_ORDER_RECOVERED_BY_CLIENT_ID"
      );
      return persistedReceipt;
    });
    return {
      status: "completed" as const,
      submittedOrderCount: 1,
      evidence: {
        readyIntentCount: readyCount,
        confirmableIntentCount: confirmableCount,
        confirmationPromoted: promotion?.status === "promoted",
        orderIntentId: intent.order_intent_id,
        orderId: recovery.orderId,
        brokerOrderId: recovery.brokerOrderId,
        brokerStatus: recovery.brokerStatus,
        recoveredFromAmbiguous: true,
        mutationReceipt: reconciledReceipt
      }
    };
  };

  let response: AlpacaApiResponse<AlpacaSubmittedOrder>;
  try {
    response = await input.submitOrder(payload);
  } catch (error) {
    const failedAt = new Date(Math.max(Date.now(), now.getTime()));
    if (!isAmbiguousSubmissionError(error)) {
      await input.transaction((query) =>
        recordDeterministicSubmissionFailure(
          query,
          intent,
          mutationReceipt,
          error,
          input.fence,
          failedAt
        )
      );
      throw error;
    }
    const uncertainReceipt = receiptWithOutcome(mutationReceipt, {
      outcomeClassification: "submission_transport_unknown",
      resultingLifecycleState: intent.review_type === "exit"
        ? "exit_submission_ambiguous"
        : "submission_ambiguous"
    });
    await input.transaction((query) =>
      recordAmbiguousSubmission(
        query,
        intent,
        uncertainReceipt,
        error,
        input.fence,
        failedAt
      )
    );
    return recoverSubmission(uncertainReceipt);
  }

  const brokerOccurredAt = Date.parse(
    text(response.data.submitted_at || response.data.created_at)
  );
  const acknowledgementAt = new Date(
    Math.max(
      Date.now(),
      now.getTime(),
      Number.isFinite(brokerOccurredAt) ? brokerOccurredAt : 0
    ) + (Number.isFinite(brokerOccurredAt) ? 1 : 0)
  );
  let recorded: Awaited<ReturnType<typeof recordSubmission>>;
  try {
    recorded = await input.transaction((query) =>
      recordSubmission(
        query,
        intent,
        response,
        mutationReceipt,
        input.fence,
        acknowledgementAt
      )
    );
  } catch (error) {
    const brokerOrderId = text(response.data.id);
    const brokerStatus = text(response.data.status).toLowerCase();
    const acknowledgementReceipt =
      brokerOrderId && brokerStatus
        ? receiptWithOutcome(mutationReceipt, {
            outcomeClassification: brokerStatus === "rejected"
              ? "submission_rejected"
              : "submission_acknowledged",
            resultingLifecycleState: lifecycleStateForBrokerStatus(
              intent.review_type,
              brokerStatus
            ),
            brokerOrderId,
            brokerAcknowledgementTimestamp: acknowledgementAt.toISOString()
          })
        : receiptWithOutcome(mutationReceipt, {
            outcomeClassification: "submission_transport_unknown",
            resultingLifecycleState: intent.review_type === "exit"
              ? "exit_submission_ambiguous"
              : "submission_ambiguous"
          });
    await input.transaction((query) =>
      recordAmbiguousSubmission(
        query,
        intent,
        acknowledgementReceipt,
        error,
        input.fence,
        acknowledgementAt,
        brokerOrderId
          ? "acknowledgement_persistence_failure"
          : "malformed_broker_acknowledgement"
      )
    );
    return recoverSubmission(acknowledgementReceipt);
  }
  return {
    status: "completed" as const,
    submittedOrderCount: 1,
    evidence: {
      readyIntentCount: readyCount,
      confirmableIntentCount: confirmableCount,
      confirmationPromoted: promotion?.status === "promoted",
      orderIntentId: intent.order_intent_id,
      orderId: recorded.orderId,
      brokerOrderId: recorded.brokerOrderId,
      brokerStatus: recorded.status,
      recoveredFromAmbiguous: false,
      mutationReceipt: recorded.mutationReceipt
    }
  };
};
