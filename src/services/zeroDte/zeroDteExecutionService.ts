import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { getDb } from "../../lib/db.js";
import { redactSensitiveText } from "../../lib/securityRedaction.js";
import {
  getAccount,
  getLatestOptionSnapshots,
  getPaperOrder,
  listPaperPositions,
  listRecentPaperOrders,
  submitPaperOrder,
  type AlpacaAccountRaw,
  type AlpacaApiResponse,
  type AlpacaOptionSnapshotRaw,
  type AlpacaPaperOrderRequest,
  type AlpacaPositionRaw,
  type AlpacaSubmittedOrder
} from "../alpacaClient.js";
import { nowIso } from "../../lib/utils.js";
import { assertScheduledWriteFenceActive } from "../controlPlaneRuntimeContext.js";
import {
  applyPaperExecutionLedgerUpdate,
  buildPaperExecutionLedgerEntry,
  findPaperExecutionByClientOrderId,
  findPaperExecutionByDedupeKey,
  findPaperExecutionById,
  insertPaperExecutionLedgerEntry,
  listActivePaperNewRiskReservations,
  paperNewRiskLedgerMutationFingerprint,
  runAtomicPaperNewRiskReservation,
  updatePaperExecutionLedgerEntry,
  type PaperExecutionLedgerEntry,
  type PaperExecutionLedgerStatus,
  type PaperExecutionLedgerUpdate
} from "../paperExecutionLedgerService.js";
import { executionStateProjectionService } from "../executionStateProjectionService.js";
import {
  insertZeroDteLifecycleEventRow,
  type ZeroDteLifecycleEventInput
} from "./zeroDteLifecycleService.js";
import { buildZeroDteClientOrderId } from "./zeroDteIdentityService.js";
import { loadZeroDteConfig } from "./zeroDteConfigService.js";
import {
  buildZeroDteActivityEvidence,
  type ZeroDteActivityEvidence
} from "./zeroDteActivityEvidenceService.js";
import {
  createZeroDteSubmitAttestation,
  verifyZeroDteSubmitAttestation,
  type ZeroDteSubmitAttestation,
  type ZeroDteSubmitAttestationExpected,
  type ZeroDteSubmitOrderIntent
} from "./zeroDteSubmitAttestationService.js";
import { paperReviewArtifactSigningKey } from "../paperReviewArtifactService.js";
import {
  normalizePaperSubmitReservations,
  paperSubmitReservationFingerprint
} from "../paperSubmitStateService.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import { isActiveBrokerOrderStatus } from "../brokerOrderStatusService.js";
import type {
  ZeroDteAccountOrderSnapshot,
  ZeroDteAccountPositionSnapshot,
  ZeroDteAccountSnapshot,
  ZeroDteConfig,
  ZeroDteRuntimeSnapshot
} from "./zeroDteTypes.js";
import {
  runInZeroDtePersistenceTransaction,
  type ZeroDteQueueCandidate
} from "./zeroDtePersistenceService.js";

export type {
  ZeroDteAccountSnapshot,
  ZeroDteRuntimeSnapshot
} from "./zeroDteTypes.js";

export interface ZeroDteExistingLedgerEntry {
  dedupeKey: string;
  status: PaperExecutionLedgerStatus | string;
}

export interface ZeroDteExecutionEligibilityInput {
  candidate: ZeroDteQueueCandidate;
  config: ZeroDteConfig;
  runtime: ZeroDteRuntimeSnapshot;
  account: ZeroDteAccountSnapshot;
  now: string;
  existingLedgerEntries?: ZeroDteExistingLedgerEntry[];
}

export interface ZeroDteEligibilityResult {
  eligible: boolean;
  blockers: string[];
  warnings: string[];
  reservationKey: string;
  clientOrderId: string;
  quantity: number;
  limitPrice: number | null;
  estimatedPremium: number | null;
  quoteAgeMs: number | null;
  evidence: Record<string, unknown>;
}

export interface ZeroDtePaperMutationProvider {
  config?: ZeroDteConfig;
  runtime?: ZeroDteRuntimeSnapshot | (() => ZeroDteRuntimeSnapshot);
  account?: ZeroDteAccountSnapshot;
  now?: () => string;
  getAccount?: typeof getAccount;
  listPositions?: typeof listPaperPositions;
  listOrders?: typeof listRecentPaperOrders;
  getOrder?: typeof getPaperOrder;
  getLatestOptionSnapshots?: typeof getLatestOptionSnapshots;
  refreshQuote?: (
    symbol: string
  ) => Promise<ZeroDteQueueCandidate["quote"]>;
  submitPaperOrder?: typeof submitPaperOrder;
  authorizeExecution?: typeof executionStateProjectionService.reserveOrderIntent;
  recordExecutionResult?: typeof executionStateProjectionService.recordBrokerResult;
  storeExecutionEvidence?: typeof executionStateProjectionService.storeZeroDteEvidence;
  reconcileExecutionState?: typeof executionStateProjectionService.reconcileBrokerOrders;
}

export interface ZeroDteOrderReconciliationResult {
  paperOnly: true;
  checked: number;
  updated: number;
  filled: number;
  partial: number;
  terminal: number;
  partialTerminal: number;
  linkageUpdated: number;
  errors: Array<{ code: string; message: string; paperTradeId?: string }>;
}

export type ZeroDteExecutionStatus =
  | "blocked"
  | "duplicate_blocked"
  | "submitted"
  | "partial"
  | "filled"
  | "failed";

export interface ZeroDteExecutionResult {
  paperOnly: true;
  status: ZeroDteExecutionStatus;
  mutationAttempted: boolean;
  candidateId: string;
  decisionId: string;
  attestationId: string | null;
  paperTradeId: string | null;
  ledgerId: number | null;
  clientOrderId: string;
  brokerOrderId: string | null;
  requestId: string | null;
  blockers: string[];
  warnings: string[];
  payload: AlpacaPaperOrderRequest | null;
  eligibility: ZeroDteEligibilityResult | null;
}

const ACTIVE_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "partially_filled",
  "accepted_for_bidding",
  "pending_replace",
  "reserved",
  "submitted",
  "partial",
  "filled",
  "attempted"
]);

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const positive = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const normalizedSymbol = (value: unknown) => String(value || "").trim().toUpperCase();

const normalizedStatus = (value: unknown) => String(value || "").trim().toLowerCase();

const normalizedTradingDate = (candidate: ZeroDteQueueCandidate) =>
  text(candidate.tradingDate) || new Date().toISOString().slice(0, 10);

const reservationKeyFor = (candidate: ZeroDteQueueCandidate) =>
  `${normalizedTradingDate(candidate)}:${normalizedSymbol(candidate.optionSymbol)}:entry`;

const clientOrderIdFor = (candidate: ZeroDteQueueCandidate) =>
  buildZeroDteClientOrderId({
    tradingDate: normalizedTradingDate(candidate),
    candidateId: candidate.candidateId,
    action: "entry",
    attempt: 0
  });

const quoteAgeMs = (timestamp: string | null, now: string) => {
  if (!timestamp) return null;
  const observed = Date.parse(timestamp);
  const asOf = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(asOf)) return null;
  return asOf - observed;
};

const etMinuteOf = (timestamp: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
};

const configuredMinute = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};

const accountPosition = (value: unknown): ZeroDteAccountPositionSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const symbol = normalizedSymbol(row.symbol);
  const quantity = finite(row.quantity ?? row.qty) ?? 0;
  return symbol
    ? {
        symbol,
        quantity,
        marketValue: finite(row.marketValue ?? row.market_value),
        currentPrice: finite(row.currentPrice ?? row.current_price)
      }
    : null;
};

const accountOrder = (value: unknown): ZeroDteAccountOrderSnapshot | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const symbol = normalizedSymbol(row.symbol);
  return symbol
    ? {
        symbol,
        side: text(row.side),
        status: text(row.status),
        clientOrderId: text(row.clientOrderId ?? row.client_order_id),
        brokerOrderId: text(row.brokerOrderId ?? row.id),
        quantity: finite(row.quantity ?? row.qty),
        limitPrice: finite(row.limitPrice ?? row.limit_price)
      }
    : null;
};

const toAccountSnapshot = (
  account: AlpacaAccountRaw,
  positions: AlpacaPositionRaw[],
  orders: AlpacaSubmittedOrder[],
  runtime: ZeroDteRuntimeSnapshot,
  activity: ZeroDteActivityEvidence
): ZeroDteAccountSnapshot => ({
  accountIdentityHash: text(account.id)
    ? canonicalJsonHash({ accountId: text(account.id) })
    : null,
  environment: runtime.environment,
  paperVerified: runtime.paperAccountVerified ?? runtime.environment === "paper",
  status: text(account.status),
  cash: finite(account.cash),
  buyingPower: finite(account.buying_power),
  optionsBuyingPower: finite(account.options_buying_power ?? account.buying_power),
  equity: finite(account.equity ?? account.portfolio_value),
  optionApprovalLevel: finite(account.options_approved_level ?? account.options_trading_level),
  tradingBlocked: typeof account.trading_blocked === "boolean" ? account.trading_blocked : null,
  accountBlocked: typeof account.account_blocked === "boolean" ? account.account_blocked : null,
  dailyTradeCount: activity.dailyTradeCount,
  dailyPremium: activity.dailyPremium,
  dailyRealizedLoss: activity.dailyRealizedLoss,
  activityEvidenceComplete: activity.complete,
  activityEvidenceFingerprint: activity.evidenceFingerprint,
  activityEvidenceBlockers: activity.blockers,
  openPositionCount: activity.openPositionCount,
  openOrderCount: activity.openOrderCount,
  openExposureCount: activity.openExposureCount,
  openPositions: positions.map((position) => accountPosition(position)).filter(
    (position): position is ZeroDteAccountPositionSnapshot => position !== null
  ),
  openOrders: orders.map((order) => accountOrder(order)).filter(
    (order): order is ZeroDteAccountOrderSnapshot => order !== null
  )
});

const runtimeFromEnvironment = (): ZeroDteRuntimeSnapshot => {
  const flag = (name: string, fallback = false) => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    return value === "true" || value === "1";
  };
  const environment = String(process.env.ALPACA_ENV || "paper").trim().toLowerCase();
  const tradingMode = String(process.env.TRADING_MODE || "paper").trim().toLowerCase();
  const liveTradingEnabled = flag("LIVE_TRADING_ENABLED") || flag("ALPACA_LIVE_TRADE");
  return {
    environment,
    tradingMode,
    paperOnly: environment === "paper" && tradingMode === "paper" && !liveTradingEnabled,
    liveTradingEnabled,
    engineEnabled: flag("ZERO_DTE_ENGINE_ENABLED", true),
    paperExecutionEnabled: flag("PAPER_ORDER_EXECUTION_ENABLED"),
    paperOptionsExecutionEnabled: flag("PAPER_OPTIONS_EXECUTION_ENABLED"),
    automatedPaperExecutionEnabled: flag("AUTOMATED_PAPER_EXECUTION_ENABLED"),
    marketOpen: true
  };
};

const runtimeValue = (
  runtime: ZeroDteRuntimeSnapshot | (() => ZeroDteRuntimeSnapshot) | undefined
) => (typeof runtime === "function" ? runtime() : runtime) ?? runtimeFromEnvironment();

const runtimeBlockers = (
  config: ZeroDteConfig,
  runtime: ZeroDteRuntimeSnapshot
) => {
  const blockers: string[] = [];
  if (!config.enabled || !runtime.engineEnabled) blockers.push("ENGINE_DISABLED");
  if (!config.paperExecutionEnabled) blockers.push("EXECUTION_DISABLED");
  if (!runtime.paperOnly || runtime.environment !== "paper" || runtime.tradingMode !== "paper" || runtime.liveTradingEnabled) {
    blockers.push("ACCOUNT_NOT_PAPER");
  }
  if (!runtime.paperExecutionEnabled) {
    blockers.push("EXECUTION_DISABLED", "PAPER_EXECUTION_FLAG_REQUIRED");
  }
  if (!runtime.paperOptionsExecutionEnabled) {
    blockers.push("EXECUTION_DISABLED", "PAPER_OPTIONS_EXECUTION_DISABLED");
  }
  if (!runtime.automatedPaperExecutionEnabled) {
    blockers.push("EXECUTION_DISABLED", "AUTOMATED_EXECUTION_DISABLED");
  }
  if (runtime.paperAccountVerified === false) blockers.push("ACCOUNT_NOT_PAPER");
  if (runtime.marketOpen === false) blockers.push("MARKET_CLOSED");
  return unique(blockers);
};

const accountRealizedLoss = (value: number | null | undefined) => {
  const parsed = finite(value);
  return parsed === null ? null : parsed < 0 ? Math.abs(parsed) : parsed;
};

const candidateQuantity = (candidate: ZeroDteQueueCandidate) => {
  const value = finite(candidate.quantity);
  return value !== null && Number.isInteger(value) && value > 0 ? value : 1;
};

export const evaluateZeroDteExecutionEligibility = (
  input: ZeroDteExecutionEligibilityInput
): ZeroDteEligibilityResult => {
  const { candidate, config, runtime, account, now } = input;
  const blockers = runtimeBlockers(config, runtime);
  const warnings: string[] = [];
  const currentEtMinute = etMinuteOf(now);
  if (currentEtMinute < configuredMinute(config.discoveryStartEt)) {
    blockers.push("DISCOVERY_WINDOW_NOT_OPEN");
  } else if (currentEtMinute >= configuredMinute(config.newEntryCutoffEt)) {
    blockers.push("ENTRY_CUTOFF");
  }
  const reservationKey = reservationKeyFor(candidate);
  const clientOrderId = clientOrderIdFor(candidate);
  const symbol = normalizedSymbol(candidate.optionSymbol);
  const quantity = candidateQuantity(candidate);
  const parsed = parseOptionSymbol(symbol);
  const timestamp = text(candidate.quote.marketTimestamp);
  const age = quoteAgeMs(timestamp, now);
  const bid = positive(candidate.quote.bid);
  const ask = positive(candidate.quote.ask);
  const midpoint = positive(candidate.quote.midpoint);
  const limitPrice = midpoint === null ? null : roundMoney(midpoint);
  const estimatedPremium = limitPrice === null ? null : roundMoney(limitPrice * 100 * quantity);
  const existingLedger = input.existingLedgerEntries ?? [];

  if (
    !candidate.eligible ||
    (candidate.state !== "eligible" && candidate.state !== "selected")
  ) {
    blockers.push("CANDIDATE_NOT_ELIGIBLE");
  }
  if (!candidate.executable) blockers.push("CANDIDATE_NOT_EXECUTABLE");
  if (candidate.direction === "neutral") blockers.push("NEUTRAL_DIRECTION");
  blockers.push(...candidate.blockers.filter((code) => code && code !== "NONE"));

  if (!parsed.ok) {
    blockers.push("INVALID_OPTION_SYMBOL");
  } else {
    if (parsed.expirationDate !== candidate.tradingDate || parsed.expirationDate !== candidate.expirationDate) {
      blockers.push("NOT_0DTE_CONTRACT");
    }
    if (parsed.underlying !== normalizedSymbol(candidate.underlyingSymbol)) {
      blockers.push("OPTION_UNDERLYING_MISMATCH");
    }
  }

  if (bid === null || ask === null || midpoint === null) {
    blockers.push("MISSING_QUOTE");
  } else if (ask < bid || midpoint < bid || midpoint > ask) {
    blockers.push("CROSSED_QUOTE");
  }
  if (timestamp === null || age === null || age < 0 || age > config.underlyingMaxAgeMs) {
    blockers.push(age !== null && age < 0 ? "FUTURE_QUOTE" : "STALE_QUOTE");
  }
  const spreadPct = candidate.quote.spreadPct ?? (bid !== null && ask !== null && midpoint !== null
    ? ((ask - bid) / midpoint) * 100
    : null);
  if (spreadPct === null || !Number.isFinite(spreadPct)) blockers.push("SPREAD_UNAVAILABLE");
  else if (spreadPct > config.maxSpreadPct) blockers.push("WIDE_SPREAD");

  if (limitPrice === null || limitPrice <= 0) blockers.push("INVALID_QUOTE");
  if (limitPrice !== null && (limitPrice < config.minPremium || limitPrice > config.maxPremium)) {
    blockers.push("PREMIUM_OUT_OF_RANGE");
  }
  if (quantity > config.maxContractsPerTrade || config.maxContractsPerTrade <= 0) {
    blockers.push("MAX_CONTRACTS_PER_TRADE");
  }
  if (estimatedPremium !== null && estimatedPremium > config.maxPremiumPerTrade) {
    blockers.push("PREMIUM_CAP");
  }

  const buyingPowerValues = [account.buyingPower, account.optionsBuyingPower]
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  const buyingPower = buyingPowerValues.length ? Math.min(...buyingPowerValues) : null;
  if (estimatedPremium !== null && (buyingPower === null || buyingPower < estimatedPremium)) {
    blockers.push("BUYING_POWER");
  }
  const cash = finite(account.cash);
  if (estimatedPremium !== null && (cash === null || cash < estimatedPremium)) {
    blockers.push("CASH_RESERVE");
  }
  if (text(account.accountIdentityHash) === null) {
    blockers.push("ZERO_DTE_ACCOUNT_IDENTITY_REQUIRED");
  }
  if (account.tradingBlocked !== false || account.accountBlocked !== false) {
    blockers.push("ACCOUNT_UNAVAILABLE");
  }
  const dailyPremium = finite(account.dailyPremium);
  const dailyTradeCount = finite(account.dailyTradeCount);
  const realizedLoss = accountRealizedLoss(account.dailyRealizedLoss);
  const openExposureCount = finite(account.openExposureCount);
  const dailyCountersComplete =
    account.activityEvidenceComplete === true &&
    text(account.activityEvidenceFingerprint) !== null &&
    dailyPremium !== null && dailyPremium >= 0 &&
    dailyTradeCount !== null && dailyTradeCount >= 0 && Number.isInteger(dailyTradeCount) &&
    realizedLoss !== null && realizedLoss >= 0 &&
    openExposureCount !== null && openExposureCount >= 0 && Number.isInteger(openExposureCount);
  if (!dailyCountersComplete) {
    blockers.push(
      "ZERO_DTE_DAILY_COUNTER_EVIDENCE_REQUIRED",
      "ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE",
      ...(account.activityEvidenceBlockers ?? [])
    );
  }
  if (estimatedPremium !== null && dailyPremium !== null && dailyPremium + estimatedPremium > config.maxDailyPremium) {
    blockers.push("DAILY_PREMIUM_LIMIT");
  }
  if (dailyTradeCount !== null && dailyTradeCount >= config.maxTradesPerDay) {
    blockers.push("DAILY_TRADE_LIMIT");
  }
  if (realizedLoss !== null && realizedLoss >= config.maxDailyRealizedLoss) {
    blockers.push("DAILY_LOSS_LIMIT");
  }
  const openPositions = account.openPositions ?? [];
  const openSameDayOptionPositions = openPositions.filter((position) => {
    if (position.quantity <= 0) return false;
    const openContract = parseOptionSymbol(normalizedSymbol(position.symbol));
    return openContract.ok && openContract.expirationDate === candidate.tradingDate;
  });
  if (
    (openExposureCount !== null && openExposureCount >= config.maxOpenPositions) ||
    (openExposureCount === null && openSameDayOptionPositions.length >= config.maxOpenPositions)
  ) {
    blockers.push("MAX_OPEN_0DTE_POSITIONS");
  }
  if (openPositions.some((position) => normalizedSymbol(position.symbol) === symbol && position.quantity > 0)) {
    blockers.push("DUPLICATE_EXPOSURE");
  }
  const openOrders = account.openOrders ?? [];
  if (openOrders.some((order) => normalizedSymbol(order.symbol) === symbol && isActiveBrokerOrderStatus(order.status))) {
    blockers.push("DUPLICATE_EXPOSURE");
  }
  if (account.paperVerified === false || String(account.environment || "paper").toLowerCase() !== "paper") {
    blockers.push("ACCOUNT_NOT_PAPER");
  }
  if (account.status && !["active", "account_status_active"].includes(account.status.toLowerCase())) {
    blockers.push("ACCOUNT_UNAVAILABLE");
  }
  if (account.optionApprovalLevel !== null && account.optionApprovalLevel !== undefined && account.optionApprovalLevel < 1) {
    blockers.push("OPTIONS_APPROVAL_REQUIRED");
  }

  const duplicateLedger = existingLedger.find(
    (entry) => entry.dedupeKey === reservationKey && ACTIVE_ORDER_STATUSES.has(normalizedStatus(entry.status))
  );
  if (duplicateLedger) blockers.push("DUPLICATE_ORDER");

  return {
    eligible: unique(blockers).length === 0,
    blockers: unique(blockers),
    warnings,
    reservationKey,
    clientOrderId,
    quantity,
    limitPrice,
    estimatedPremium,
    quoteAgeMs: age,
    evidence: {
      symbol,
      tradingDate: candidate.tradingDate,
      quote: {
        bid,
        ask,
        midpoint,
        spreadPct,
        timestamp,
        ageMs: age
      },
      quantity,
      accountIdentityHash: text(account.accountIdentityHash),
      cash,
      buyingPower,
      dailyPremium,
      dailyTradeCount,
      dailyRealizedLoss: realizedLoss,
      activityEvidenceComplete: account.activityEvidenceComplete === true,
      activityEvidenceFingerprint: text(account.activityEvidenceFingerprint),
      activityEvidenceBlockers: account.activityEvidenceBlockers ?? [],
      openPositionCount: finite(account.openPositionCount),
      openOrderCount: finite(account.openOrderCount),
      openExposureCount
    }
  };
};

const decisionRow = (decisionId: string) => getDb().prepare(
  `SELECT d.decision_id, d.decision_group_id, d.engine_run_id, d.candidate_id,
          d.trading_date, d.strategy_version, d.configuration_version_id,
          d.market_timestamp, c.underlying_symbol, c.option_symbol,
          c.direction, c.expiration_date
   FROM zero_dte_decisions d
   JOIN zero_dte_candidates c ON c.candidate_id = d.candidate_id
   WHERE d.decision_id = ?`
).get(decisionId) as {
  decision_id: string;
  decision_group_id: string;
  engine_run_id: string;
  candidate_id: string;
  trading_date: string;
  strategy_version: string;
  configuration_version_id: string;
  market_timestamp: string | null;
  underlying_symbol: string;
  option_symbol: string;
  direction: string;
  expiration_date: string;
} | undefined;

const decisionLinkageBlockers = (input: {
  decision: NonNullable<ReturnType<typeof decisionRow>> | undefined;
  candidate: ZeroDteQueueCandidate;
  config: ZeroDteConfig;
}) => {
  const { decision, candidate, config } = input;
  if (!decision || decision.candidate_id !== candidate.candidateId) {
    return ["DECISION_CANDIDATE_MISMATCH"];
  }
  const blockers: string[] = [];
  if (decision.trading_date !== candidate.tradingDate || decision.expiration_date !== candidate.expirationDate) {
    blockers.push("DECISION_TRADING_DATE_MISMATCH");
  }
  if (
    decision.strategy_version !== config.strategyVersion ||
    decision.configuration_version_id !== config.configurationVersionId
  ) {
    blockers.push("DECISION_CONFIGURATION_MISMATCH");
  }
  if (
    normalizedSymbol(decision.option_symbol) !== normalizedSymbol(candidate.optionSymbol) ||
    normalizedSymbol(decision.underlying_symbol) !== normalizedSymbol(candidate.underlyingSymbol) ||
    normalizedStatus(decision.direction) !== normalizedStatus(candidate.direction) ||
    text(decision.market_timestamp) !== text(candidate.quote.marketTimestamp)
  ) {
    blockers.push("DECISION_ORDER_INTENT_MISMATCH");
  }
  const parsed = parseOptionSymbol(normalizedSymbol(candidate.optionSymbol));
  if (
    parsed.ok &&
    ((candidate.direction === "bullish" && parsed.optionType !== "call") ||
      (candidate.direction === "bearish" && parsed.optionType !== "put"))
  ) {
    blockers.push("DECISION_ORDER_INTENT_MISMATCH");
  }
  return unique(blockers);
};

const authorityDecisionInputBlockers = (input: {
  decisionId: string;
  candidate: ZeroDteQueueCandidate;
}) => {
  if (!text(input.decisionId) || !text(input.candidate.candidateId)) {
    return ["DECISION_CANDIDATE_MISMATCH"];
  }
  const parsed = parseOptionSymbol(normalizedSymbol(input.candidate.optionSymbol));
  if (
    !parsed.ok ||
    parsed.expirationDate !== input.candidate.expirationDate ||
    parsed.underlying !== normalizedSymbol(input.candidate.underlyingSymbol) ||
    ((input.candidate.direction === "bullish" && parsed.optionType !== "call") ||
      (input.candidate.direction === "bearish" && parsed.optionType !== "put"))
  ) {
    return ["DECISION_ORDER_INTENT_MISMATCH"];
  }
  return [];
};

const accountStateFingerprint = (account: ZeroDteAccountSnapshot) =>
  canonicalJsonHash({
    accountIdentityHash: text(account.accountIdentityHash),
    environment: text(account.environment),
    paperVerified: account.paperVerified === true,
    status: text(account.status),
    cash: finite(account.cash),
    buyingPower: finite(account.buyingPower),
    optionsBuyingPower: finite(account.optionsBuyingPower),
    equity: finite(account.equity),
    optionApprovalLevel: finite(account.optionApprovalLevel),
    tradingBlocked: account.tradingBlocked,
    accountBlocked: account.accountBlocked,
    dailyTradeCount: finite(account.dailyTradeCount),
    dailyPremium: finite(account.dailyPremium),
    dailyRealizedLoss: finite(account.dailyRealizedLoss),
    openPositionCount: finite(account.openPositionCount),
    openOrderCount: finite(account.openOrderCount),
    openExposureCount: finite(account.openExposureCount),
    positions: (account.openPositions ?? [])
      .map((position) => ({
        symbol: normalizedSymbol(position.symbol),
        quantity: finite(position.quantity),
        marketValue: finite(position.marketValue),
        currentPrice: finite(position.currentPrice)
      }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
    orders: (account.openOrders ?? [])
      .map((order) => ({
        symbol: normalizedSymbol(order.symbol),
        side: normalizedStatus(order.side),
        status: normalizedStatus(order.status),
        clientOrderIdHash: text(order.clientOrderId)
          ? canonicalJsonHash({ clientOrderId: text(order.clientOrderId) })
          : null,
        brokerOrderIdHash: text(order.brokerOrderId)
          ? canonicalJsonHash({ brokerOrderId: text(order.brokerOrderId) })
          : null,
        quantity: finite(order.quantity),
        limitPrice: finite(order.limitPrice)
      }))
      .sort((left, right) =>
        `${left.symbol}:${left.clientOrderIdHash ?? ""}`.localeCompare(
          `${right.symbol}:${right.clientOrderIdHash ?? ""}`
        )
      )
  });

const zeroDteSubmitOrderIntent = (
  candidate: ZeroDteQueueCandidate,
  eligibility: ZeroDteEligibilityResult
): ZeroDteSubmitOrderIntent => {
  if (eligibility.limitPrice === null || eligibility.estimatedPremium === null) {
    throw new Error("ZERO_DTE_ORDER_INTENT_INCOMPLETE");
  }
  const quoteTimestamp = text(candidate.quote.marketTimestamp);
  if (!quoteTimestamp) throw new Error("ZERO_DTE_ORDER_INTENT_INCOMPLETE");
  return {
    symbol: normalizedSymbol(candidate.optionSymbol),
    underlying: normalizedSymbol(candidate.underlyingSymbol),
    direction: candidate.direction,
    side: "buy",
    positionIntent: "buy_to_open",
    quantity: eligibility.quantity,
    limitPrice: eligibility.limitPrice,
    estimatedPremium: eligibility.estimatedPremium,
    quoteTimestamp,
    quoteFingerprint: canonicalJsonHash(candidate.quote),
    clientOrderId: eligibility.clientOrderId,
    reservationKey: eligibility.reservationKey
  };
};

const zeroDteAttestationExpected = (input: {
  candidate: ZeroDteQueueCandidate;
  decisionId: string;
  config: ZeroDteConfig;
  account: ZeroDteAccountSnapshot;
  eligibility: ZeroDteEligibilityResult;
}): ZeroDteSubmitAttestationExpected => ({
  decisionId: input.decisionId,
  candidateId: input.candidate.candidateId,
  tradingDate: input.candidate.tradingDate,
  strategyVersion: input.config.strategyVersion,
  configurationVersionId: input.config.configurationVersionId,
  accountIdentityHash: text(input.account.accountIdentityHash) ?? "",
  accountStateFingerprint: accountStateFingerprint(input.account),
  activityEvidenceFingerprint: text(input.account.activityEvidenceFingerprint) ?? "",
  allocationIdentity: "baseline-v1",
  submitPriceDriftLimitPct: submitPriceDriftLimitPct(),
  orderIntent: zeroDteSubmitOrderIntent(input.candidate, input.eligibility)
});

const zeroDteReviewTtlSeconds = () => {
  const parsed = Number(process.env.ZERO_DTE_REVIEW_TTL_SECONDS ?? 300);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 300;
};

const paperTradeIdFor = (candidateId: string, decisionId: string) =>
  `zpt_${canonicalJsonHash({ candidateId, decisionId }).slice(0, 40)}`;

const appendPaperLifecycleEvent = (input: {
  eventType: ZeroDteLifecycleEventInput["eventType"];
  decision: NonNullable<ReturnType<typeof decisionRow>>;
  paperTradeId: string;
  occurredAt: string;
  details?: Record<string, unknown>;
  reasonCode?: string;
}) => {
  const eventId = `zlev_${canonicalJsonHash({
    eventType: input.eventType,
    paperTradeId: input.paperTradeId,
    decisionId: input.decision.decision_id
  }).slice(0, 40)}`;
  const db = getDb();
  const existing = db.prepare("SELECT event_id FROM zero_dte_lifecycle_events WHERE event_id = ?").get(eventId);
  if (existing) return;
  insertZeroDteLifecycleEventRow(db, {
    eventId,
    eventType: input.eventType,
    reasonCode: input.reasonCode ?? null,
    engineRunId: input.decision.engine_run_id,
    candidateId: input.decision.candidate_id,
    decisionId: input.decision.decision_id,
    decisionGroupId: input.decision.decision_group_id,
    paperTradeId: input.paperTradeId,
    accountMode: "paper",
    strategyVersion: input.decision.strategy_version,
    configurationVersionId: input.decision.configuration_version_id,
    marketTimestamp: input.decision.market_timestamp,
    occurredAt: input.occurredAt,
    details: input.details ?? {}
  });
};

const appendExecutionAttestationEvent = (input: {
  decision: NonNullable<ReturnType<typeof decisionRow>>;
  attestation: ZeroDteSubmitAttestation;
}) => {
  const eventId = `zlev_${canonicalJsonHash({
    eventType: "execution_attested",
    attestationId: input.attestation.attestationId,
    decisionId: input.decision.decision_id
  }).slice(0, 40)}`;
  const db = getDb();
  if (db.prepare("SELECT event_id FROM zero_dte_lifecycle_events WHERE event_id = ?").get(eventId)) {
    return;
  }
  insertZeroDteLifecycleEventRow(db, {
    eventId,
    eventType: "execution_attested",
    reasonCode: "ZERO_DTE_SUBMIT_ATTESTED",
    engineRunId: input.decision.engine_run_id,
    candidateId: input.decision.candidate_id,
    decisionId: input.decision.decision_id,
    decisionGroupId: input.decision.decision_group_id,
    accountMode: "paper",
    strategyVersion: input.decision.strategy_version,
    configurationVersionId: input.decision.configuration_version_id,
    marketTimestamp: input.decision.market_timestamp,
    occurredAt: input.attestation.createdAt,
    details: {
      attestationId: input.attestation.attestationId,
      payloadHash: input.attestation.payloadHash,
      signature: input.attestation.signature,
      signatureAlgorithm: input.attestation.signatureAlgorithm,
      expiresAt: input.attestation.expiresAt,
      accountIdentityHash: input.attestation.accountIdentityHash,
      accountStateFingerprint: input.attestation.accountStateFingerprint,
      activityEvidenceFingerprint: input.attestation.activityEvidenceFingerprint,
      allocationIdentity: input.attestation.allocationIdentity,
      orderIntent: input.attestation.orderIntent
    }
  });
};

const ensureZeroDteLedgerDecisionLink = (input: {
  ledgerId: number;
  decisionId: string;
  now: string;
}) => {
  assertScheduledWriteFenceActive();
  const db = getDb();
  const current = db.prepare(
    `SELECT decision_id, decision_linkage_status
     FROM paper_execution_ledger
     WHERE id = ?`
  ).get(input.ledgerId) as {
    decision_id: string | null;
    decision_linkage_status: string;
  } | undefined;
  if (!current) throw new Error("ZERO_DTE_LEDGER_NOT_FOUND");
  if (current.decision_id && current.decision_id !== input.decisionId) {
    throw new Error("ZERO_DTE_LEDGER_DECISION_MISMATCH");
  }
  if (current.decision_id === input.decisionId && current.decision_linkage_status === "EXACT") {
    return false;
  }
  db.prepare(
    `UPDATE paper_execution_ledger
     SET decision_id = ?, decision_linkage_status = 'EXACT', updated_at = ?
     WHERE id = ?`
  ).run(input.decisionId, input.now, input.ledgerId);
  return true;
};

interface ZeroDtePaperOrderRow {
  paper_trade_id: string;
  decision_id: string;
  candidate_id: string;
  trading_date: string;
  underlying_symbol: string;
  status: string;
  option_symbol: string;
  quantity: number;
  client_order_id: string | null;
  broker_order_id: string | null;
  source_ledger_id: number;
  ledger_id: number | null;
  ledger_symbol: string | null;
  ledger_quantity: string | null;
  ledger_client_order_id: string | null;
  ledger_broker_order_id: string | null;
  ledger_dedupe_key: string | null;
  ledger_status: string | null;
}

type ZeroDteBrokerOrderKind = "pending" | "filled" | "partial" | "terminal";

interface ZeroDteTerminalOrderState {
  tradeStatus: string;
  ledgerStatus: PaperExecutionLedgerStatus;
  reasonCode: string;
  eventType: "paper_order_rejected" | "paper_order_canceled";
}

interface ValidatedZeroDteBrokerOrderState {
  kind: ZeroDteBrokerOrderKind;
  brokerStatus: string;
  requestedQuantity: number;
  filledQuantity: number;
  fillPrice: number | null;
  filledAt: string | null;
  terminal: ZeroDteTerminalOrderState | null;
}

const PENDING_BROKER_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "held",
  "pending_cancel",
  "pending_replace"
]);

const TERMINAL_BROKER_ORDER_STATUSES: Record<string, ZeroDteTerminalOrderState> = {
  canceled: {
    tradeStatus: "canceled",
    ledgerStatus: "canceled",
    reasonCode: "ORDER_CANCELED",
    eventType: "paper_order_canceled"
  },
  cancelled: {
    tradeStatus: "canceled",
    ledgerStatus: "canceled",
    reasonCode: "ORDER_CANCELED",
    eventType: "paper_order_canceled"
  },
  expired: {
    tradeStatus: "expired",
    ledgerStatus: "expired",
    reasonCode: "ORDER_EXPIRED",
    eventType: "paper_order_canceled"
  },
  rejected: {
    tradeStatus: "rejected",
    ledgerStatus: "rejected",
    reasonCode: "ORDER_REJECTED",
    eventType: "paper_order_rejected"
  },
  replaced: {
    tradeStatus: "replaced",
    ledgerStatus: "canceled",
    reasonCode: "ORDER_REPLACED",
    eventType: "paper_order_canceled"
  },
  done_for_day: {
    tradeStatus: "done_for_day",
    ledgerStatus: "canceled",
    reasonCode: "ORDER_DONE_FOR_DAY",
    eventType: "paper_order_canceled"
  },
  stopped: {
    tradeStatus: "stopped",
    ledgerStatus: "canceled",
    reasonCode: "ORDER_STOPPED",
    eventType: "paper_order_canceled"
  },
  suspended: {
    tradeStatus: "suspended",
    ledgerStatus: "canceled",
    reasonCode: "ORDER_SUSPENDED",
    eventType: "paper_order_canceled"
  },
  calculated: {
    tradeStatus: "calculated",
    ledgerStatus: "canceled",
    reasonCode: "ORDER_CALCULATED",
    eventType: "paper_order_canceled"
  }
};

const zeroDtePaperOrderRowForTrade = (paperTradeId: string) => getDb().prepare(
  `SELECT t.paper_trade_id, t.decision_id, t.candidate_id, t.trading_date,
          t.underlying_symbol, t.status, t.option_symbol, t.quantity,
          t.client_order_id, t.broker_order_id, t.source_ledger_id,
          l.id AS ledger_id, l.symbol AS ledger_symbol, l.qty AS ledger_quantity,
          l.client_order_id AS ledger_client_order_id,
          l.alpaca_order_id AS ledger_broker_order_id,
          l.dedupe_key AS ledger_dedupe_key, l.status AS ledger_status
   FROM zero_dte_paper_trades AS t
   LEFT JOIN paper_execution_ledger AS l ON l.id = t.source_ledger_id
   WHERE t.paper_trade_id = ?`
).get(paperTradeId) as ZeroDtePaperOrderRow | undefined;

const REPAIRABLE_ZERO_DTE_LEDGER_STATUSES = new Set([
  "blocked",
  "failed",
  "released",
  "expired"
]);

const repairStaleZeroDteLedgerLinkage = (input: {
  row: ZeroDtePaperOrderRow;
  response: AlpacaApiResponse<AlpacaSubmittedOrder>;
  now: string;
}): { row: ZeroDtePaperOrderRow; repaired: boolean } => {
  const { row, response, now } = input;
  const tradeClientOrderId = text(row.client_order_id);
  const ledgerClientOrderId = text(row.ledger_client_order_id);
  if (
    tradeClientOrderId === null ||
    ledgerClientOrderId === tradeClientOrderId ||
    !REPAIRABLE_ZERO_DTE_LEDGER_STATUSES.has(normalizedStatus(row.ledger_status))
  ) {
    return { row, repaired: false };
  }

  const brokerOrderId = text(row.broker_order_id);
  const responseOrderId = text(response.data?.id);
  const responseClientOrderId = text(response.data?.client_order_id);
  const optionSymbol = normalizedSymbol(row.option_symbol);
  const requestedQuantity = finite(row.quantity);
  const responseQuantity = finite(response.data?.qty);
  const limitPrice = positive(response.data?.limit_price);
  const brokerStatus = normalizedStatus(response.data?.status);
  const dedupeKey = `${row.trading_date}:${optionSymbol}:entry`;
  const decision = decisionRow(row.decision_id);

  if (row.ledger_id === null || row.ledger_id !== row.source_ledger_id) {
    throw new Error("ZERO_DTE_LEDGER_NOT_FOUND");
  }
  if (brokerOrderId === null || responseOrderId !== brokerOrderId) {
    throw new Error("BROKER_ORDER_ID_MISMATCH");
  }
  if (responseClientOrderId !== tradeClientOrderId) {
    throw new Error("BROKER_CLIENT_ORDER_ID_MISMATCH");
  }
  if (!optionSymbol || normalizedSymbol(response.data?.symbol) !== optionSymbol) {
    throw new Error("BROKER_ORDER_SYMBOL_MISMATCH");
  }
  if (
    normalizedStatus(response.data?.side) !== "buy" ||
    normalizedStatus(response.data?.position_intent) !== "buy_to_open" ||
    normalizedStatus(response.data?.type) !== "limit" ||
    normalizedStatus(response.data?.time_in_force) !== "day"
  ) {
    throw new Error("BROKER_ENTRY_ORDER_SEMANTICS_MISMATCH");
  }
  if (
    requestedQuantity === null ||
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity <= 0 ||
    responseQuantity !== requestedQuantity
  ) {
    throw new Error("BROKER_ORDER_QUANTITY_MISMATCH");
  }
  if (limitPrice === null || !brokerStatus) {
    throw new Error("BROKER_ENTRY_ORDER_EVIDENCE_INCOMPLETE");
  }
  if (text(row.ledger_dedupe_key) !== dedupeKey) {
    throw new Error("ZERO_DTE_LEDGER_DEDUPE_MISMATCH");
  }
  if (!decision || decision.candidate_id !== row.candidate_id) {
    throw new Error("DECISION_CANDIDATE_MISMATCH");
  }

  let replacementLedgerId = 0;
  runInZeroDtePersistenceTransaction(() => {
    const existing = findPaperExecutionByClientOrderId(tradeClientOrderId);
    if (existing) {
      if (
        existing.dedupeKey !== dedupeKey ||
        normalizedSymbol(existing.symbol) !== optionSymbol ||
        existing.sourceCandidateId !== row.candidate_id ||
        existing.decisionId !== row.decision_id ||
        finite(existing.qty) !== requestedQuantity ||
        normalizedStatus(existing.side) !== "buy" ||
        (existing.alpacaOrderId !== null && existing.alpacaOrderId !== brokerOrderId)
      ) {
        throw new Error("ZERO_DTE_REPAIR_LEDGER_CONFLICT");
      }
      replacementLedgerId = existing.id;
    } else {
      const estimatedPremium = roundMoney(limitPrice * requestedQuantity * 100);
      const replacement = insertPaperExecutionLedgerEntry({
        mode: "zero-dte-entry",
        assetClass: "option",
        symbol: optionSymbol,
        underlyingSymbol: normalizedSymbol(row.underlying_symbol),
        strategy: "zero_dte_level_2",
        side: "buy",
        orderType: "limit",
        timeInForce: "day",
        qty: String(requestedQuantity),
        limitPrice: String(limitPrice),
        estimatedPremium,
        maxRisk: estimatedPremium,
        dedupeKey,
        clientOrderId: tradeClientOrderId,
        requestId: response.requestId ?? null,
        status: "submitted",
        sourceCandidateId: row.candidate_id,
        decisionId: row.decision_id as NonNullable<PaperExecutionLedgerEntry["decisionId"]>,
        decisionLinkageStatus: "EXACT",
        payload: {
          candidateId: row.candidate_id,
          decisionId: row.decision_id,
          decisionGroupId: decision.decision_group_id,
          tradingDate: row.trading_date,
          symbol: optionSymbol,
          quantity: requestedQuantity,
          limitPrice,
          positionIntent: "buy_to_open"
        },
        rawResponse: response.data
      });
      replacementLedgerId = replacement.id;
    }
    updatePaperExecutionLedgerEntry(replacementLedgerId, {
      status: "submitted",
      alpacaOrderId: brokerOrderId,
      alpacaStatus: brokerStatus,
      requestId: response.requestId ?? null,
      rawResponse: response.data
    });
    getDb().prepare(
      `UPDATE zero_dte_paper_trades
       SET source_ledger_id = ?, updated_at = ?
       WHERE paper_trade_id = ? AND source_ledger_id = ?`
    ).run(replacementLedgerId, now, row.paper_trade_id, row.source_ledger_id);
  });

  const repaired = zeroDtePaperOrderRowForTrade(row.paper_trade_id);
  if (!repaired || repaired.source_ledger_id !== replacementLedgerId) {
    throw new Error("ZERO_DTE_LEDGER_RELINK_FAILED");
  }
  return { row: repaired, repaired: true };
};

const exactBrokerFillTime = (value: unknown) => {
  const timestamp = text(value);
  if (timestamp === null || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("BROKER_FILL_TIME_INVALID");
  }
  return new Date(timestamp).toISOString();
};

const validateZeroDteBrokerOrderState = (input: {
  row: ZeroDtePaperOrderRow;
  response: AlpacaApiResponse<AlpacaSubmittedOrder>;
}): ValidatedZeroDteBrokerOrderState => {
  const { row, response } = input;
  if (row.ledger_id === null || row.ledger_id !== row.source_ledger_id) {
    throw new Error("ZERO_DTE_LEDGER_NOT_FOUND");
  }
  const brokerOrderId = text(row.broker_order_id);
  const responseOrderId = text(response.data?.id);
  if (brokerOrderId === null || responseOrderId !== brokerOrderId) {
    throw new Error("BROKER_ORDER_ID_MISMATCH");
  }
  const tradeClientOrderId = text(row.client_order_id);
  const ledgerClientOrderId = text(row.ledger_client_order_id);
  const responseClientOrderId = text(response.data?.client_order_id);
  if (
    tradeClientOrderId === null ||
    ledgerClientOrderId === null ||
    tradeClientOrderId !== ledgerClientOrderId ||
    responseClientOrderId !== tradeClientOrderId
  ) {
    throw new Error("BROKER_CLIENT_ORDER_ID_MISMATCH");
  }
  const optionSymbol = normalizedSymbol(row.option_symbol);
  if (
    !optionSymbol ||
    normalizedSymbol(row.ledger_symbol) !== optionSymbol ||
    normalizedSymbol(response.data?.symbol) !== optionSymbol
  ) {
    throw new Error("BROKER_ORDER_SYMBOL_MISMATCH");
  }
  const ledgerBrokerOrderId = text(row.ledger_broker_order_id);
  if (ledgerBrokerOrderId !== null && ledgerBrokerOrderId !== brokerOrderId) {
    throw new Error("BROKER_LEDGER_ORDER_ID_MISMATCH");
  }

  const requestedQuantity = finite(row.ledger_quantity);
  if (requestedQuantity === null || !Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
    throw new Error("BROKER_REQUESTED_QUANTITY_INVALID");
  }
  if (response.data?.qty !== undefined && response.data.qty !== null && response.data.qty !== "") {
    const responseQuantity = finite(response.data.qty);
    if (
      responseQuantity === null ||
      !Number.isInteger(responseQuantity) ||
      responseQuantity !== requestedQuantity
    ) {
      throw new Error("BROKER_ORDER_QUANTITY_MISMATCH");
    }
  }

  const brokerStatus = normalizedStatus(response.data?.status);
  if (!brokerStatus) throw new Error("BROKER_ORDER_STATUS_MISSING");
  const rawFilledQuantity = response.data?.filled_qty;
  const hasFilledQuantity = rawFilledQuantity !== undefined && rawFilledQuantity !== null && rawFilledQuantity !== "";
  const parsedFilledQuantity = hasFilledQuantity ? finite(rawFilledQuantity) : 0;
  if (
    parsedFilledQuantity === null ||
    !Number.isInteger(parsedFilledQuantity) ||
    parsedFilledQuantity < 0 ||
    parsedFilledQuantity > requestedQuantity
  ) {
    throw new Error("BROKER_FILLED_QUANTITY_INVALID");
  }
  const filledQuantity = parsedFilledQuantity;

  let kind: ZeroDteBrokerOrderKind;
  let terminal: ZeroDteTerminalOrderState | null = null;
  if (brokerStatus === "filled") {
    kind = "filled";
    if (!hasFilledQuantity || filledQuantity !== requestedQuantity) {
      throw new Error("BROKER_FILLED_QUANTITY_INCOMPLETE");
    }
  } else if (brokerStatus === "partially_filled" || brokerStatus === "partial") {
    kind = "partial";
    if (!hasFilledQuantity || filledQuantity <= 0 || filledQuantity >= requestedQuantity) {
      throw new Error("BROKER_PARTIAL_QUANTITY_INVALID");
    }
  } else if (PENDING_BROKER_ORDER_STATUSES.has(brokerStatus)) {
    kind = "pending";
    if (filledQuantity !== 0) throw new Error("BROKER_PENDING_ORDER_HAS_FILL");
  } else {
    terminal = TERMINAL_BROKER_ORDER_STATUSES[brokerStatus] ?? null;
    if (terminal === null) throw new Error("BROKER_ORDER_STATUS_UNSUPPORTED");
    if (!hasFilledQuantity) throw new Error("BROKER_TERMINAL_FILLED_QUANTITY_MISSING");
    kind = "terminal";
  }

  let fillPrice: number | null = null;
  let filledAt: string | null = null;
  if (filledQuantity > 0) {
    fillPrice = positive(response.data?.filled_avg_price);
    if (fillPrice === null) throw new Error("BROKER_FILL_PRICE_INVALID");
    filledAt = exactBrokerFillTime(response.data?.filled_at);
  }
  return {
    kind,
    brokerStatus,
    requestedQuantity,
    filledQuantity,
    fillPrice,
    filledAt,
    terminal
  };
};

interface CurrentZeroDtePaperOrderState {
  trade_status: string;
  quantity: number;
  filled_at: string | null;
  ledger_status: string;
}

const TERMINAL_LOCAL_TRADE_STATUSES = new Set([
  "canceled",
  "expired",
  "rejected",
  "replaced",
  "done_for_day",
  "stopped",
  "suspended",
  "calculated",
  "closed"
]);

const localBrokerStateStrength = (current: CurrentZeroDtePaperOrderState) => {
  const tradeStatus = normalizedStatus(current.trade_status);
  const ledgerStatus = normalizedStatus(current.ledger_status);
  if (
    ledgerStatus === "filled" ||
    ["open", "exit_requested"].includes(tradeStatus)
  ) return 3;
  if (tradeStatus === "partially_filled" || ledgerStatus === "partial") return 1;
  if (current.filled_at !== null) return 3;
  if (
    TERMINAL_LOCAL_TRADE_STATUSES.has(tradeStatus) ||
    ["canceled", "expired", "rejected"].includes(ledgerStatus)
  ) return 2;
  return 0;
};

const brokerStateStrength = (state: ValidatedZeroDteBrokerOrderState) => {
  if (state.kind === "filled") return 3;
  if (state.kind === "terminal") return 2;
  if (state.kind === "partial") return 1;
  return 0;
};

const verifiedLocalFilledQuantity = (current: CurrentZeroDtePaperOrderState) => {
  const tradeStatus = normalizedStatus(current.trade_status);
  const ledgerStatus = normalizedStatus(current.ledger_status);
  const hasVerifiedFill =
    current.filled_at !== null ||
    ["partially_filled", "open", "exit_requested"].includes(tradeStatus) ||
    ["partial", "filled"].includes(ledgerStatus);
  return hasVerifiedFill ? positive(current.quantity) ?? 0 : 0;
};

const shouldApplyBrokerState = (
  current: CurrentZeroDtePaperOrderState,
  state: ValidatedZeroDteBrokerOrderState
) => {
  const currentFilledQuantity = verifiedLocalFilledQuantity(current);
  if (state.filledQuantity < currentFilledQuantity) return false;
  const currentStrength = localBrokerStateStrength(current);
  const incomingStrength = brokerStateStrength(state);
  if (incomingStrength > currentStrength) return true;
  if (incomingStrength < currentStrength) return false;
  if (state.kind === "pending") return currentStrength === 0;
  if (state.kind === "partial") {
    return state.filledQuantity > currentFilledQuantity;
  }
  return false;
};

const applyZeroDteBrokerOrderState = (input: {
  row: ZeroDtePaperOrderRow;
  state: ValidatedZeroDteBrokerOrderState;
  response: AlpacaApiResponse<AlpacaSubmittedOrder>;
  now: string;
}) => {
  const { row, state, response, now } = input;
  const brokerOrderId = text(row.broker_order_id);
  if (brokerOrderId === null) throw new Error("BROKER_ORDER_ID_MISSING");
  const decision = decisionRow(row.decision_id);
  if (!decision) throw new Error("ZERO_DTE_RECONCILIATION_DECISION_NOT_FOUND");
  const terminalWithFill = state.kind === "terminal" && state.filledQuantity > 0;
  const ledgerStatus: PaperExecutionLedgerStatus = state.kind === "filled"
    ? "filled"
    : state.kind === "partial"
      ? "partial"
      : state.kind === "terminal"
        ? state.terminal?.ledgerStatus ?? "failed"
        : "submitted";
  let linkageChanged = false;
  let stateApplied = false;

  runInZeroDtePersistenceTransaction(() => {
    const current = getDb().prepare(
      `SELECT t.status AS trade_status, t.quantity, t.filled_at,
              l.status AS ledger_status
       FROM zero_dte_paper_trades AS t
       JOIN paper_execution_ledger AS l ON l.id = t.source_ledger_id
       WHERE t.paper_trade_id = ? AND l.id = ?`
    ).get(row.paper_trade_id, row.source_ledger_id) as CurrentZeroDtePaperOrderState | undefined;
    if (!current) throw new Error("ZERO_DTE_CURRENT_ORDER_STATE_NOT_FOUND");
    if (!shouldApplyBrokerState(current, state)) return;
    stateApplied = true;
    linkageChanged = ensureZeroDteLedgerDecisionLink({
      ledgerId: row.source_ledger_id,
      decisionId: row.decision_id,
      now
    });
    updatePaperExecutionLedgerEntry(row.source_ledger_id, {
      status: ledgerStatus,
      alpacaOrderId: brokerOrderId,
      alpacaStatus: state.brokerStatus,
      requestId: response.requestId ?? null,
      reason: state.terminal?.reasonCode ?? null,
      blockedReason: state.terminal?.reasonCode ?? null,
      rawResponse: response.data
    });

    if (state.kind === "pending") {
      getDb().prepare(
        `UPDATE zero_dte_paper_trades
         SET status = 'submitted', broker_order_id = ?,
             submitted_at = COALESCE(submitted_at, ?), updated_at = ?
         WHERE paper_trade_id = ?`
      ).run(brokerOrderId, now, now, row.paper_trade_id);
    } else if (state.kind === "filled" || state.kind === "partial" || terminalWithFill) {
      if (state.fillPrice === null || state.filledAt === null) {
        throw new Error("BROKER_FILL_EVIDENCE_MISSING");
      }
      const tradeStatus = state.kind === "partial" ? "partially_filled" : "open";
      getDb().prepare(
        `UPDATE zero_dte_paper_trades
         SET status = ?, broker_order_id = ?,
             submitted_at = COALESCE(submitted_at, ?),
             quantity = ?, entry_premium = ?, filled_at = ?,
             terminal_state = NULL, exit_reason_code = NULL, updated_at = ?
         WHERE paper_trade_id = ?`
      ).run(
        tradeStatus,
        brokerOrderId,
        now,
        state.filledQuantity,
        state.fillPrice,
        state.filledAt,
        now,
        row.paper_trade_id
      );
    } else {
      if (state.terminal === null) throw new Error("BROKER_TERMINAL_STATE_MISSING");
      getDb().prepare(
        `UPDATE zero_dte_paper_trades
         SET status = ?, broker_order_id = ?,
             submitted_at = COALESCE(submitted_at, ?),
             terminal_state = ?, exit_reason_code = ?, updated_at = ?
         WHERE paper_trade_id = ?`
      ).run(
        state.terminal.tradeStatus,
        brokerOrderId,
        now,
        state.terminal.tradeStatus,
        state.terminal.reasonCode,
        now,
        row.paper_trade_id
      );
    }

    if (state.brokerStatus !== "rejected") {
      appendPaperLifecycleEvent({
        eventType: "paper_order_accepted",
        decision,
        paperTradeId: row.paper_trade_id,
        occurredAt: now,
        details: { brokerOrderId, brokerStatus: state.brokerStatus, requestId: response.requestId ?? null }
      });
    }
    if (state.kind === "filled" || state.kind === "partial" || terminalWithFill) {
      if (state.fillPrice === null || state.filledAt === null) {
        throw new Error("BROKER_FILL_EVIDENCE_MISSING");
      }
      const fillEventType = state.kind === "filled" || state.filledQuantity === state.requestedQuantity
        ? "paper_order_filled"
        : "paper_order_partially_filled";
      appendPaperLifecycleEvent({
        eventType: fillEventType,
        decision,
        paperTradeId: row.paper_trade_id,
        occurredAt: state.filledAt,
        details: {
          brokerOrderId,
          brokerStatus: state.brokerStatus,
          filledQuantity: state.filledQuantity,
          filledAveragePrice: state.fillPrice,
          requestId: response.requestId ?? null
        }
      });
      appendPaperLifecycleEvent({
        eventType: "position_opened",
        decision,
        paperTradeId: row.paper_trade_id,
        occurredAt: state.filledAt,
        details: {
          brokerOrderId,
          filledQuantity: state.filledQuantity,
          filledAveragePrice: state.fillPrice
        }
      });
    }
    if (state.kind === "terminal" && state.terminal !== null) {
      appendPaperLifecycleEvent({
        eventType: state.terminal.eventType,
        decision,
        paperTradeId: row.paper_trade_id,
        occurredAt: now,
        reasonCode: state.terminal.reasonCode,
        details: {
          brokerOrderId,
          brokerStatus: state.brokerStatus,
          filledQuantity: state.filledQuantity,
          requestId: response.requestId ?? null
        }
      });
    }
  });

  return {
    linkageChanged,
    stateApplied,
    updated: stateApplied && state.kind !== "pending",
    terminalWithFill: stateApplied && terminalWithFill
  };
};

export const reconcileZeroDtePaperOrders = async (input: {
  now?: string;
  provider?: ZeroDtePaperMutationProvider;
} = {}): Promise<ZeroDteOrderReconciliationResult> => {
  const now = new Date(input.now ?? nowIso()).toISOString();
  const provider = input.provider ?? {};
  const runtime = runtimeValue(provider.runtime);
  const result: ZeroDteOrderReconciliationResult = {
    paperOnly: true,
    checked: 0,
    updated: 0,
    filled: 0,
    partial: 0,
    terminal: 0,
    partialTerminal: 0,
    linkageUpdated: 0,
    errors: []
  };
  if (executionStateProjectionService.isAuthorityActive()) {
    const reconciled = await (
      provider.reconcileExecutionState ?? executionStateProjectionService.reconcileBrokerOrders
    )({ now });
    result.checked = reconciled.checked;
    result.updated = reconciled.recorded;
    result.filled = reconciled.filled;
    result.partial = reconciled.partial;
    result.terminal = reconciled.terminal;
    result.errors = reconciled.errors.map(({ code }) => ({ code, message: code }));
    return result;
  }
  const rows = getDb().prepare(
    `SELECT t.paper_trade_id, t.decision_id, t.candidate_id, t.trading_date,
            t.underlying_symbol, t.status, t.option_symbol, t.quantity,
            t.client_order_id, t.broker_order_id, t.source_ledger_id,
            l.id AS ledger_id, l.symbol AS ledger_symbol, l.qty AS ledger_quantity,
            l.client_order_id AS ledger_client_order_id,
            l.alpaca_order_id AS ledger_broker_order_id,
            l.dedupe_key AS ledger_dedupe_key, l.status AS ledger_status
     FROM zero_dte_paper_trades AS t
     LEFT JOIN paper_execution_ledger AS l ON l.id = t.source_ledger_id
     WHERE t.status IN ('intended', 'submitted', 'partially_filled')
       AND t.broker_order_id IS NOT NULL
       AND t.source_ledger_id IS NOT NULL
     ORDER BY t.requested_at`
  ).all() as unknown as ZeroDtePaperOrderRow[];
  if (!rows.length) return result;
  if (!runtime.paperOnly || runtime.environment !== "paper" || runtime.tradingMode !== "paper" || runtime.liveTradingEnabled) {
    result.errors.push({
      code: "ACCOUNT_NOT_PAPER",
      message: "0DTE paper-order reconciliation is disabled outside the paper-only runtime."
    });
    return result;
  }

  const getOrder = provider.getOrder?.bind(provider) ?? getPaperOrder;
  for (const row of rows) {
    result.checked += 1;
    try {
      if (row.broker_order_id === null) throw new Error("BROKER_ORDER_ID_MISSING");
      const response = await getOrder(row.broker_order_id);
      const linkage = repairStaleZeroDteLedgerLinkage({ row, response, now });
      const state = validateZeroDteBrokerOrderState({ row: linkage.row, response });
      const applied = applyZeroDteBrokerOrderState({ row: linkage.row, state, response, now });
      if (linkage.repaired || applied.linkageChanged) result.linkageUpdated += 1;
      if (applied.updated) result.updated += 1;
      if (applied.stateApplied && state.kind === "filled") result.filled += 1;
      if (applied.stateApplied && state.kind === "partial") result.partial += 1;
      if (applied.stateApplied && state.kind === "terminal") result.terminal += 1;
      if (applied.terminalWithFill) result.partialTerminal += 1;
    } catch (error) {
      result.errors.push({
        code: "PAPER_ORDER_RECONCILIATION_FAILED",
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500),
        paperTradeId: row.paper_trade_id
      });
    }
  }
  return result;
};

const createBlockedLedgerEntry = (input: {
  candidate: ZeroDteQueueCandidate;
  eligibility: ZeroDteEligibilityResult;
  reason: string;
  now: string;
  attestation?: ZeroDteSubmitAttestation | null;
}) => {
  if (executionStateProjectionService.isAuthorityActive()) {
    return buildPaperExecutionLedgerEntry({
      mode: "zero-dte-entry",
      assetClass: "option",
      symbol: normalizedSymbol(input.candidate.optionSymbol),
      underlyingSymbol: normalizedSymbol(input.candidate.underlyingSymbol),
      strategy: "zero_dte_level_2",
      side: "buy",
      orderType: "limit",
      timeInForce: "day",
      qty: String(input.eligibility.quantity),
      limitPrice: input.eligibility.limitPrice === null
        ? null
        : String(input.eligibility.limitPrice),
      estimatedPremium: input.eligibility.estimatedPremium,
      maxRisk: input.eligibility.estimatedPremium,
      dedupeKey: input.eligibility.reservationKey,
      clientOrderId: input.eligibility.clientOrderId,
      status: "blocked",
      reason: input.reason,
      blockedReason: input.reason,
      sourcePlanId: input.attestation?.attestationId ?? null,
      sourceCandidateId: input.candidate.candidateId,
      payload: {
        candidateId: input.candidate.candidateId,
        optionSymbol: normalizedSymbol(input.candidate.optionSymbol),
        quantity: input.eligibility.quantity,
        limitPrice: input.eligibility.limitPrice,
        attestation: input.attestation ?? null,
        asOf: input.now
      }
    }, { createdAt: input.now });
  }
  const existing = findPaperExecutionByDedupeKey(input.eligibility.reservationKey);
  if (existing) {
    if (ACTIVE_ORDER_STATUSES.has(normalizedStatus(existing.status))) return existing;
    updatePaperExecutionLedgerEntry(existing.id, {
      status: "blocked",
      reason: input.reason,
      blockedReason: input.reason
    });
    if (input.attestation) {
      const payloadJson = JSON.stringify({
        candidateId: input.candidate.candidateId,
        optionSymbol: normalizedSymbol(input.candidate.optionSymbol),
        quantity: input.eligibility.quantity,
        limitPrice: input.eligibility.limitPrice,
        attestation: input.attestation,
        asOf: input.now
      });
      getDb().prepare(
        `UPDATE paper_execution_ledger
         SET source_plan_id = ?, payload_json = ?, raw_payload_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.attestation.attestationId,
        payloadJson,
        payloadJson,
        input.now,
        existing.id
      );
    }
    return findPaperExecutionByDedupeKey(input.eligibility.reservationKey) ?? existing;
  }
  return insertPaperExecutionLedgerEntry({
    mode: "zero-dte-entry",
    assetClass: "option",
    symbol: normalizedSymbol(input.candidate.optionSymbol),
    underlyingSymbol: normalizedSymbol(input.candidate.underlyingSymbol),
    strategy: "zero_dte_level_2",
    side: "buy",
    orderType: "limit",
    timeInForce: "day",
    qty: String(input.eligibility.quantity),
    limitPrice: input.eligibility.limitPrice === null ? null : String(input.eligibility.limitPrice),
    estimatedPremium: input.eligibility.estimatedPremium,
    maxRisk: input.eligibility.estimatedPremium,
    dedupeKey: input.eligibility.reservationKey,
    clientOrderId: input.eligibility.clientOrderId,
    status: "blocked",
    reason: input.reason,
    blockedReason: input.reason,
    sourcePlanId: input.attestation?.attestationId ?? null,
    sourceCandidateId: input.candidate.candidateId,
    payload: {
      candidateId: input.candidate.candidateId,
      optionSymbol: normalizedSymbol(input.candidate.optionSymbol),
      quantity: input.eligibility.quantity,
      limitPrice: input.eligibility.limitPrice,
      attestation: input.attestation ?? null,
      asOf: input.now
    }
  });
};

const baseResult = (input: {
  candidate: ZeroDteQueueCandidate;
  decisionId: string;
  status: ZeroDteExecutionStatus;
  mutationAttempted?: boolean;
  ledgerId?: number | null;
  paperTradeId?: string | null;
  brokerOrderId?: string | null;
  requestId?: string | null;
  attestationId?: string | null;
  blockers?: string[];
  warnings?: string[];
  payload?: AlpacaPaperOrderRequest | null;
  eligibility?: ZeroDteEligibilityResult | null;
}): ZeroDteExecutionResult => ({
  paperOnly: true,
  status: input.status,
  mutationAttempted: input.mutationAttempted ?? false,
  candidateId: input.candidate.candidateId,
  decisionId: input.decisionId,
  attestationId:
    input.attestationId ?? text(input.eligibility?.evidence.attestationId) ?? null,
  paperTradeId: input.paperTradeId ?? null,
  ledgerId: input.ledgerId !== undefined && input.ledgerId !== null && input.ledgerId > 0
    ? input.ledgerId
    : null,
  clientOrderId: input.eligibility?.clientOrderId ?? clientOrderIdFor(input.candidate),
  brokerOrderId: input.brokerOrderId ?? null,
  requestId: input.requestId ?? null,
  blockers: unique(input.blockers ?? []),
  warnings: unique(input.warnings ?? []),
  payload: input.payload ?? null,
  eligibility: input.eligibility ?? null
});

const accountFromProvider = async (
  provider: ZeroDtePaperMutationProvider,
  runtime: ZeroDteRuntimeSnapshot,
  tradingDate: string,
  asOf: string
): Promise<ZeroDteAccountSnapshot> => {
  if (provider.account) return provider.account;
  const accountFn = provider.getAccount ?? getAccount;
  const positionsFn = provider.listPositions ?? listPaperPositions;
  const ordersFn = provider.listOrders ?? listRecentPaperOrders;
  const [accountResponse, positionsResponse, ordersResponse] = await Promise.all([
    accountFn(),
    positionsFn(),
    ordersFn({ limit: 500 })
  ]);
  const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];
  const orders = Array.isArray(ordersResponse.data) ? ordersResponse.data : [];
  const activityInput = {
    tradingDate,
    asOf,
    positions,
    orders
  };
  const sqliteActivity = executionStateProjectionService.isAuthorityActive()
    ? undefined
    : buildZeroDteActivityEvidence(activityInput);
  const activity = await executionStateProjectionService.resolveZeroDteActivityEvidence(
    activityInput,
    sqliteActivity
  );
  return toAccountSnapshot(
    accountResponse.data,
    positions,
    orders,
    runtime,
    activity
  );
};

const refreshZeroDteQuote = async (input: {
  candidate: ZeroDteQueueCandidate;
  provider: ZeroDtePaperMutationProvider;
}) => {
  if (input.provider.refreshQuote) {
    return input.provider.refreshQuote(input.candidate.optionSymbol);
  }
  // A fully injected account snapshot is the unit-test/offline provider contract
  // unless that provider also supplies an explicit quote source.
  if (
    !input.provider.getLatestOptionSnapshots &&
    (input.provider.account ||
      input.provider.getAccount ||
      input.provider.listPositions ||
      input.provider.listOrders)
  ) {
    return input.candidate.quote;
  }
  const response = await (
    input.provider.getLatestOptionSnapshots ?? getLatestOptionSnapshots
  )([normalizedSymbol(input.candidate.optionSymbol)]);
  const snapshots = response.data as Record<string, AlpacaOptionSnapshotRaw>;
  const snapshot = snapshots[normalizedSymbol(input.candidate.optionSymbol)];
  const quote = snapshot?.latestQuote ?? snapshot?.latest_quote;
  const trade = snapshot?.latestTrade ?? snapshot?.latest_trade;
  const bid = positive(quote?.bp ?? quote?.b);
  const ask = positive(quote?.ap ?? quote?.a);
  const midpoint =
    bid !== null && ask !== null && ask >= bid
      ? roundMoney((bid + ask) / 2)
      : positive(trade?.p);
  const spreadPct =
    bid !== null && ask !== null && midpoint !== null && midpoint > 0
      ? ((ask - bid) / midpoint) * 100
      : null;
  return {
    ...input.candidate.quote,
    bid,
    ask,
    midpoint,
    premium: midpoint,
    spreadPct,
    marketTimestamp: text(quote?.t) ?? text(trade?.t)
  };
};

const submitPriceDriftLimitPct = () => {
  const parsed = Number(process.env.PAPER_SUBMIT_MAX_PRICE_DRIFT_PCT ?? 10);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 10;
};

const zeroDteQuoteDriftBlockers = (input: {
  reviewed: ZeroDteQueueCandidate["quote"];
  current: ZeroDteQueueCandidate["quote"];
}) => {
  const reviewedPrice = positive(input.reviewed.midpoint ?? input.reviewed.premium);
  const currentPrice = positive(input.current.midpoint ?? input.current.premium);
  const reviewedTimestamp = text(input.reviewed.marketTimestamp);
  const currentTimestamp = text(input.current.marketTimestamp);
  const blockers: string[] = [];
  if (
    reviewedPrice === null ||
    currentPrice === null ||
    !reviewedTimestamp ||
    !currentTimestamp
  ) {
    blockers.push("ZERO_DTE_MARKET_EVIDENCE_UNAVAILABLE");
  } else {
    const driftPct =
      (Math.abs(currentPrice - reviewedPrice) / reviewedPrice) * 100;
    if (driftPct > submitPriceDriftLimitPct()) {
      blockers.push("ZERO_DTE_PRICE_DRIFT");
    }
    if (
      !Number.isFinite(Date.parse(reviewedTimestamp)) ||
      !Number.isFinite(Date.parse(currentTimestamp)) ||
      Date.parse(currentTimestamp) < Date.parse(reviewedTimestamp)
    ) {
      blockers.push("ZERO_DTE_QUOTE_IDENTITY_DRIFT");
    }
  }
  return unique(blockers);
};

const recordCandidateExecutionState = (candidateId: string, state: "selected" | "executed", asOf: string) => {
  assertScheduledWriteFenceActive();
  getDb().prepare(
    `UPDATE zero_dte_candidates
     SET state = ?, state_changed_at = ?, state_reason_code = ?, updated_at = ?
     WHERE candidate_id = ?`
  ).run(state, asOf, state === "executed" ? "PAPER_ORDER_ACCEPTED" : "PAPER_ORDER_REQUESTED", asOf, candidateId);
};

export const executeZeroDteCandidate = async (input: {
  candidate: ZeroDteQueueCandidate;
  decisionId: string;
  confirmPaper: boolean;
  provider?: ZeroDtePaperMutationProvider;
}): Promise<ZeroDteExecutionResult> => {
  const provider = input.provider ?? {};
  const config = provider.config ?? loadZeroDteConfig();
  const now = provider.now?.() ?? nowIso();
  const runtime = runtimeValue(provider.runtime);
  const postgresAuthority = executionStateProjectionService.isAuthorityActive();
  const skeletonEligibility = evaluateZeroDteExecutionEligibility({
    candidate: input.candidate,
    config,
    runtime,
    account: provider.account ?? {
      environment: runtime.environment,
      paperVerified: runtime.paperAccountVerified,
      buyingPower: null,
      openPositions: [],
      openOrders: []
    },
    now,
    existingLedgerEntries: []
  });

  const signingKey = paperReviewArtifactSigningKey();
  const preflightBlockers = unique([
    ...runtimeBlockers(config, runtime),
    ...(input.confirmPaper ? [] : ["CONFIRM_PAPER_REQUIRED"]),
    ...(signingKey
      ? []
      : ["ZERO_DTE_SUBMIT_ATTESTATION_INVALID", "PAPER_REVIEW_SIGNING_KEY_REQUIRED"])
  ]);
  if (preflightBlockers.length > 0) {
    const eligibility = { ...skeletonEligibility, blockers: unique([...skeletonEligibility.blockers, ...preflightBlockers]) };
    const reason = eligibility.blockers[0] ?? "EXECUTION_BLOCKED";
    const ledger = createBlockedLedgerEntry({ candidate: input.candidate, eligibility, reason, now });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "blocked",
      ledgerId: ledger.id,
      blockers: eligibility.blockers,
      warnings: eligibility.warnings,
      eligibility
    });
  }

  let reviewedAccount: ZeroDteAccountSnapshot;
  try {
    reviewedAccount = await accountFromProvider(
      provider,
      runtime,
      input.candidate.tradingDate,
      now
    );
  } catch {
    const eligibility = { ...skeletonEligibility, blockers: ["ACCOUNT_RECONCILIATION_FAILED"] };
    const ledger = createBlockedLedgerEntry({ candidate: input.candidate, eligibility, reason: "ACCOUNT_RECONCILIATION_FAILED", now });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "blocked",
      ledgerId: ledger.id,
      blockers: ["ACCOUNT_RECONCILIATION_FAILED"],
      warnings: ["Paper account reconciliation failed."],
      eligibility
    });
  }

  const reviewedLedgerEntries: ZeroDteExistingLedgerEntry[] = [];
  const reviewedLedger = postgresAuthority
    ? null
    : findPaperExecutionByDedupeKey(skeletonEligibility.reservationKey);
  if (reviewedLedger) {
    reviewedLedgerEntries.push({ dedupeKey: reviewedLedger.dedupeKey, status: reviewedLedger.status });
  }
  const reviewedEligibility = evaluateZeroDteExecutionEligibility({
    candidate: input.candidate,
    config,
    runtime,
    account: reviewedAccount,
    now,
    existingLedgerEntries: reviewedLedgerEntries
  });
  if (!reviewedEligibility.eligible) {
    const duplicate = reviewedEligibility.blockers.includes("DUPLICATE_ORDER");
    const ledger = duplicate
      ? reviewedLedger
      : createBlockedLedgerEntry({
          candidate: input.candidate,
          eligibility: reviewedEligibility,
          reason: reviewedEligibility.blockers[0] ?? "EXECUTION_BLOCKED",
          now
        });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: duplicate ? "duplicate_blocked" : "blocked",
      ledgerId: ledger?.id ?? null,
      blockers: reviewedEligibility.blockers,
      warnings: reviewedEligibility.warnings,
      eligibility: reviewedEligibility
    });
  }

  const decision = postgresAuthority ? undefined : decisionRow(input.decisionId);
  const linkageBlockers = postgresAuthority
    ? authorityDecisionInputBlockers({
        decisionId: input.decisionId,
        candidate: input.candidate
      })
    : decisionLinkageBlockers({ decision, candidate: input.candidate, config });
  if ((!postgresAuthority && !decision) || linkageBlockers.length > 0) {
    const blockedEligibility = { ...reviewedEligibility, blockers: linkageBlockers };
    const reason = linkageBlockers[0] ?? "DECISION_CANDIDATE_MISMATCH";
    const ledger = createBlockedLedgerEntry({
      candidate: input.candidate,
      eligibility: blockedEligibility,
      reason,
      now
    });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "blocked",
      ledgerId: ledger.id,
      blockers: blockedEligibility.blockers,
      eligibility: blockedEligibility
    });
  }

  const paperTradeId = paperTradeIdFor(input.candidate.candidateId, input.decisionId);
  const db = postgresAuthority ? null : getDb();
  const existingTrade = postgresAuthority
    ? undefined
    : db!.prepare("SELECT paper_trade_id, status FROM zero_dte_paper_trades WHERE paper_trade_id = ?").get(paperTradeId) as { paper_trade_id: string; status: string } | undefined;
  if (existingTrade && ["submitted", "partially_filled", "open", "filled"].includes(normalizedStatus(existingTrade.status))) {
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "duplicate_blocked",
      paperTradeId,
      blockers: ["DUPLICATE_ORDER"],
      eligibility: reviewedEligibility
    });
  }

  let attestation: ZeroDteSubmitAttestation;
  try {
    attestation = createZeroDteSubmitAttestation({
      ...zeroDteAttestationExpected({
        candidate: input.candidate,
        decisionId: input.decisionId,
        config,
        account: reviewedAccount,
        eligibility: reviewedEligibility
      }),
      createdAt: now,
      ttlSeconds: zeroDteReviewTtlSeconds(),
      signingKey
    });
    if (!postgresAuthority) appendExecutionAttestationEvent({ decision: decision!, attestation });
  } catch {
    const blockers = [
      "ZERO_DTE_SUBMIT_ATTESTATION_INVALID",
      "FRESH_REVIEW_REQUIRED"
    ];
    const blockedEligibility = { ...reviewedEligibility, blockers };
    const ledger = createBlockedLedgerEntry({
      candidate: input.candidate,
      eligibility: blockedEligibility,
      reason: blockers[0],
      now
    });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "blocked",
      ledgerId: ledger.id,
      blockers,
      eligibility: blockedEligibility
    });
  }

  const expectedReservationFingerprint = postgresAuthority
    ? ""
    : paperSubmitReservationFingerprint(
        normalizePaperSubmitReservations(listActivePaperNewRiskReservations())
      );
  const expectedNewRiskLedgerFingerprint = postgresAuthority
    ? ""
    : paperNewRiskLedgerMutationFingerprint();
  let freshAccount: ZeroDteAccountSnapshot;
  try {
    freshAccount = await accountFromProvider(
      provider,
      runtime,
      input.candidate.tradingDate,
      now
    );
  } catch {
    const blockers = ["ACCOUNT_RECONCILIATION_FAILED", "FRESH_REVIEW_REQUIRED"];
    const blockedEligibility = { ...reviewedEligibility, blockers };
    const ledger = createBlockedLedgerEntry({
      candidate: input.candidate,
      eligibility: blockedEligibility,
      reason: blockers[0],
      now,
      attestation
    });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      attestationId: attestation.attestationId,
      status: "blocked",
      ledgerId: ledger.id,
      blockers,
      eligibility: blockedEligibility
    });
  }

  const freshAsOf = provider.now?.() ?? nowIso();
  let freshQuote: ZeroDteQueueCandidate["quote"];
  try {
    freshQuote = await refreshZeroDteQuote({
      candidate: input.candidate,
      provider
    });
  } catch {
    const blockers = [
      "ZERO_DTE_MARKET_EVIDENCE_UNAVAILABLE",
      "FRESH_REVIEW_REQUIRED"
    ];
    const blockedEligibility = { ...reviewedEligibility, blockers };
    const ledger = createBlockedLedgerEntry({
      candidate: input.candidate,
      eligibility: blockedEligibility,
      reason: blockers[0],
      now: freshAsOf,
      attestation
    });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      attestationId: attestation.attestationId,
      status: "blocked",
      ledgerId: ledger.id,
      blockers,
      eligibility: blockedEligibility
    });
  }
  const freshCandidate: ZeroDteQueueCandidate = {
    ...input.candidate,
    quote: freshQuote
  };
  const quoteDriftBlockers = zeroDteQuoteDriftBlockers({
    reviewed: input.candidate.quote,
    current: freshQuote
  });
  const freshLedgerEntries: ZeroDteExistingLedgerEntry[] = [];
  const freshLedger = postgresAuthority
    ? null
    : findPaperExecutionByDedupeKey(reviewedEligibility.reservationKey);
  if (freshLedger) {
    freshLedgerEntries.push({ dedupeKey: freshLedger.dedupeKey, status: freshLedger.status });
  }
  const freshEligibility = evaluateZeroDteExecutionEligibility({
    candidate: freshCandidate,
    config,
    runtime,
    account: freshAccount,
    now: freshAsOf,
    existingLedgerEntries: freshLedgerEntries
  });
  const signedIntentEligibility: ZeroDteEligibilityResult = {
    ...freshEligibility,
    limitPrice: reviewedEligibility.limitPrice,
    estimatedPremium: reviewedEligibility.estimatedPremium,
    reservationKey: reviewedEligibility.reservationKey,
    clientOrderId: reviewedEligibility.clientOrderId,
    quantity: reviewedEligibility.quantity
  };
  const freshExpected = zeroDteAttestationExpected({
    candidate: input.candidate,
    decisionId: input.decisionId,
    config,
    account: freshAccount,
    eligibility: signedIntentEligibility
  });
  const verification = verifyZeroDteSubmitAttestation({
    attestation,
    signingKey,
    asOf: freshAsOf,
    expected: freshExpected
  });
  const freshDecisionBlockers = postgresAuthority
    ? authorityDecisionInputBlockers({
        decisionId: input.decisionId,
        candidate: input.candidate
      })
    : decisionLinkageBlockers({
        decision: decisionRow(input.decisionId),
        candidate: input.candidate,
        config
      });
  const submitBlockers = unique([
    ...freshEligibility.blockers,
    ...quoteDriftBlockers,
    ...verification.blockers,
    ...freshDecisionBlockers
  ]);
  if (submitBlockers.length > 0) {
    const blockers = unique([...submitBlockers, "FRESH_REVIEW_REQUIRED"]);
    const blockedEligibility = {
      ...freshEligibility,
      blockers,
      evidence: {
        ...freshEligibility.evidence,
        attestationId: attestation.attestationId,
        attestationPayloadHash: attestation.payloadHash,
        attestationVerification: verification
      }
    };
    const duplicate = blockers.includes("DUPLICATE_ORDER");
    const ledger = duplicate
      ? freshLedger
      : createBlockedLedgerEntry({
          candidate: input.candidate,
          eligibility: blockedEligibility,
          reason: blockers[0],
          now: freshAsOf,
          attestation
        });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      attestationId: attestation.attestationId,
      status: duplicate ? "duplicate_blocked" : "blocked",
      ledgerId: ledger?.id ?? null,
      blockers,
      warnings: blockedEligibility.warnings,
      eligibility: blockedEligibility
    });
  }

  const eligibility: ZeroDteEligibilityResult = {
    ...freshEligibility,
    limitPrice: reviewedEligibility.limitPrice,
    estimatedPremium: reviewedEligibility.estimatedPremium,
    reservationKey: reviewedEligibility.reservationKey,
    clientOrderId: reviewedEligibility.clientOrderId,
    quantity: reviewedEligibility.quantity,
    evidence: {
      ...freshEligibility.evidence,
      reviewedOrderIntent: zeroDteSubmitOrderIntent(
        input.candidate,
        reviewedEligibility
      ),
      freshQuote,
      freshQuoteFingerprint: canonicalJsonHash(freshQuote),
      attestationId: attestation.attestationId,
      attestationPayloadHash: attestation.payloadHash,
      attestationVerification: verification
    }
  };
  const reservationPayload = {
    candidateId: input.candidate.candidateId,
    decisionId: input.decisionId,
    decisionGroupId: decision?.decision_group_id ?? null,
    tradingDate: input.candidate.tradingDate,
    symbol: normalizedSymbol(input.candidate.optionSymbol),
    quantity: eligibility.quantity,
    limitPrice: eligibility.limitPrice,
    positionIntent: "buy_to_open",
    attestation
  };

  let ledger: PaperExecutionLedgerEntry;
  let ledgerId: number | null = null;
  if (postgresAuthority) {
    ledger = buildPaperExecutionLedgerEntry({
      mode: "zero-dte-entry",
      assetClass: "option",
      symbol: normalizedSymbol(input.candidate.optionSymbol),
      underlyingSymbol: normalizedSymbol(input.candidate.underlyingSymbol),
      strategy: "zero_dte_level_2",
      side: "buy",
      orderType: "limit",
      timeInForce: "day",
      qty: String(eligibility.quantity),
      limitPrice: String(eligibility.limitPrice),
      estimatedPremium: eligibility.estimatedPremium,
      maxRisk: eligibility.estimatedPremium,
      dedupeKey: eligibility.reservationKey,
      clientOrderId: eligibility.clientOrderId,
      status: "reserved",
      sourcePlanId: attestation.attestationId,
      sourceCandidateId: input.candidate.candidateId,
      decisionId: input.decisionId as NonNullable<PaperExecutionLedgerEntry["decisionId"]>,
      decisionLinkageStatus: "EXACT",
      payload: reservationPayload
    }, { createdAt: freshAsOf });
  } else {
    const atomicReservation = runAtomicPaperNewRiskReservation({
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
            "ZERO_DTE_RESERVATION_STATE_DRIFT",
            "FRESH_REVIEW_REQUIRED"
          ];
        }
        const currentLedgerEntries: ZeroDteExistingLedgerEntry[] = [];
        const currentLedger = findPaperExecutionByDedupeKey(
          eligibility.reservationKey
        );
        if (currentLedger) {
          currentLedgerEntries.push({
            dedupeKey: currentLedger.dedupeKey,
            status: currentLedger.status
          });
        }
        const currentHeadroom = evaluateZeroDteExecutionEligibility({
          candidate: freshCandidate,
          config,
          runtime,
          account: freshAccount,
          now: freshAsOf,
          existingLedgerEntries: currentLedgerEntries
        });
        const blockers = unique([
          ...currentHeadroom.blockers,
          ...zeroDteQuoteDriftBlockers({
            reviewed: input.candidate.quote,
            current: freshQuote
          })
        ]);
        return blockers.length
          ? [...blockers, "FRESH_REVIEW_REQUIRED"]
          : [];
      },
      insert: () => {
        const exactReusableLedger = findPaperExecutionByDedupeKey(
          eligibility.reservationKey
        );
        let reservedLedger: PaperExecutionLedgerEntry;
        if (
          exactReusableLedger &&
          REPAIRABLE_ZERO_DTE_LEDGER_STATUSES.has(
            normalizedStatus(exactReusableLedger.status)
          ) &&
          exactReusableLedger.clientOrderId === eligibility.clientOrderId &&
          exactReusableLedger.sourceCandidateId === input.candidate.candidateId &&
          exactReusableLedger.alpacaOrderId === null &&
          (exactReusableLedger.decisionId === null ||
            exactReusableLedger.decisionId === input.decisionId)
        ) {
          updatePaperExecutionLedgerEntry(exactReusableLedger.id, {
            status: "reserved",
            reason: null,
            blockedReason: null,
            errorMessage: null
          });
          const payloadJson = JSON.stringify(reservationPayload);
          getDb().prepare(
            `UPDATE paper_execution_ledger
             SET source_plan_id = ?, payload_json = ?, raw_payload_json = ?, updated_at = ?
             WHERE id = ?`
          ).run(
            attestation.attestationId,
            payloadJson,
            payloadJson,
            freshAsOf,
            exactReusableLedger.id
          );
          reservedLedger = {
            ...exactReusableLedger,
            sourcePlanId: attestation.attestationId,
            payloadJson,
            rawPayloadJson: payloadJson,
            status: "reserved",
            reason: null,
            blockedReason: null,
            errorMessage: null
          };
        } else {
          reservedLedger = insertPaperExecutionLedgerEntry({
            mode: "zero-dte-entry",
            assetClass: "option",
            symbol: normalizedSymbol(input.candidate.optionSymbol),
            underlyingSymbol: normalizedSymbol(input.candidate.underlyingSymbol),
            strategy: "zero_dte_level_2",
            side: "buy",
            orderType: "limit",
            timeInForce: "day",
            qty: String(eligibility.quantity),
            limitPrice: String(eligibility.limitPrice),
            estimatedPremium: eligibility.estimatedPremium,
            maxRisk: eligibility.estimatedPremium,
            dedupeKey: eligibility.reservationKey,
            clientOrderId: eligibility.clientOrderId,
            status: "reserved",
            sourcePlanId: attestation.attestationId,
            sourceCandidateId: input.candidate.candidateId,
            payload: reservationPayload
          });
        }
        ensureZeroDteLedgerDecisionLink({
          ledgerId: reservedLedger.id,
          decisionId: input.decisionId,
          now: freshAsOf
        });
        return reservedLedger;
      }
    });
    if (!atomicReservation.reserved || !atomicReservation.value) {
      const blockers = unique([
        ...atomicReservation.blockers,
        "FRESH_REVIEW_REQUIRED"
      ]);
      const duplicate = blockers.includes("DUPLICATE_ORDER");
      return baseResult({
        candidate: input.candidate,
        decisionId: input.decisionId,
        attestationId: attestation.attestationId,
        status: duplicate ? "duplicate_blocked" : "blocked",
        blockers,
        eligibility: { ...eligibility, blockers }
      });
    }
    ledger = atomicReservation.value;
    ledgerId = ledger.id;
  }
  const authorizeExecution = provider.authorizeExecution ??
    executionStateProjectionService.reserveOrderIntent;
  const recordExecutionResult = provider.recordExecutionResult ??
    executionStateProjectionService.recordBrokerResult;
  const storeExecutionEvidence = provider.storeExecutionEvidence ??
    executionStateProjectionService.storeZeroDteEvidence;
  const updateCurrentExecution = (update: PaperExecutionLedgerUpdate) => {
    if (postgresAuthority) {
      ledger = applyPaperExecutionLedgerUpdate(ledger, update);
      return;
    }
    updatePaperExecutionLedgerEntry(ledger.id, update);
    ledger = findPaperExecutionById(ledger.id) ?? ledger;
  };
  const recordCurrentExecution = async () => recordExecutionResult(ledger);
  await storeExecutionEvidence(attestation, ledger);
  const postgresAuthorization = await authorizeExecution(ledger);
  if (!postgresAuthorization.brokerAllowed) {
    const blockers = [...(postgresAuthorization.blockers ?? [
      "POSTGRES_EXECUTION_RESERVATION_BLOCKED"
    ])];
    updateCurrentExecution({
      status: "released",
      reason: blockers[0],
      blockedReason: blockers[0]
    });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      attestationId: attestation.attestationId,
      status: "blocked",
      ledgerId,
      blockers,
      eligibility: { ...eligibility, blockers }
    });
  }

  if (!postgresAuthority) {
    assertScheduledWriteFenceActive();
    db!.prepare(
      `INSERT OR IGNORE INTO zero_dte_paper_trades
        (paper_trade_id, decision_id, candidate_id, trading_date, underlying_symbol,
         option_symbol, playbook, direction, status, client_order_id, source_ledger_id,
         quantity, entry_premium, fees, slippage, entry_quote_json, requested_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intended', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`
    ).run(
      paperTradeId,
      input.decisionId,
      input.candidate.candidateId,
      input.candidate.tradingDate,
      normalizedSymbol(input.candidate.underlyingSymbol),
      normalizedSymbol(input.candidate.optionSymbol),
      input.candidate.playbook,
      input.candidate.direction,
      eligibility.clientOrderId,
      ledger.id,
      eligibility.quantity,
      eligibility.limitPrice,
      JSON.stringify(input.candidate.quote),
      now,
      now,
      now
    );
    recordCandidateExecutionState(input.candidate.candidateId, "selected", now);
    appendPaperLifecycleEvent({
      eventType: "paper_order_requested",
      decision: decision!,
      paperTradeId,
      occurredAt: now,
      reasonCode: "PAPER_ORDER_REQUESTED",
      details: { clientOrderId: eligibility.clientOrderId, quantity: eligibility.quantity, limitPrice: eligibility.limitPrice }
    });
  }

  const payload: AlpacaPaperOrderRequest = {
    symbol: normalizedSymbol(input.candidate.optionSymbol),
    qty: String(eligibility.quantity),
    side: "buy",
    type: "limit",
    time_in_force: "day",
    limit_price: String(eligibility.limitPrice),
    client_order_id: eligibility.clientOrderId,
    position_intent: "buy_to_open"
  };
  let response: AlpacaApiResponse<AlpacaSubmittedOrder>;
  try {
    response = await (provider.submitPaperOrder ?? submitPaperOrder)(payload);
  } catch (error) {
    updateCurrentExecution({
      status: "failed",
      reason: "ORDER_REJECTED",
      blockedReason: "ORDER_REJECTED",
      errorMessage: error instanceof Error ? error.message : "Paper order submission failed."
    });
    if (!postgresAuthority) {
      assertScheduledWriteFenceActive();
      db!.prepare(
        `UPDATE zero_dte_paper_trades
         SET status = 'rejected', exit_reason_code = ?, updated_at = ?
         WHERE paper_trade_id = ?`
      ).run("ORDER_REJECTED", now, paperTradeId);
      appendPaperLifecycleEvent({ eventType: "paper_order_rejected", decision: decision!, paperTradeId, occurredAt: now, reasonCode: "ORDER_REJECTED" });
    }
    await recordCurrentExecution();
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "failed",
      mutationAttempted: true,
      ledgerId,
      paperTradeId,
      blockers: ["ORDER_REJECTED"],
      warnings: [error instanceof Error ? error.message : "Paper order submission failed."],
      payload,
      eligibility
    });
  }

  const brokerOrderId = text(response.data?.id);
  const brokerStatus = normalizedStatus(response.data?.status);
  if (!brokerOrderId) {
    updateCurrentExecution({
      status: "failed",
      reason: "ORDER_ID_MISSING",
      blockedReason: "ORDER_ID_MISSING",
      requestId: response.requestId,
      alpacaStatus: brokerStatus || null,
      rawResponse: response.data
    });
    if (!postgresAuthority) {
      runInZeroDtePersistenceTransaction(() => {
        db!.prepare(
          `UPDATE zero_dte_paper_trades
           SET status = 'rejected', terminal_state = 'rejected',
               exit_reason_code = 'ORDER_ID_MISSING', updated_at = ?
           WHERE paper_trade_id = ?`
        ).run(now, paperTradeId);
        appendPaperLifecycleEvent({
          eventType: "paper_order_rejected",
          decision: decision!,
          paperTradeId,
          occurredAt: now,
          reasonCode: "ORDER_ID_MISSING"
        });
      });
    }
    await recordCurrentExecution();
    return baseResult({ candidate: input.candidate, decisionId: input.decisionId, status: "failed", mutationAttempted: true, ledgerId, paperTradeId, requestId: response.requestId ?? null, blockers: ["ORDER_ID_MISSING"], payload, eligibility });
  }

  updateCurrentExecution({
    status: "submitted",
    alpacaOrderId: brokerOrderId,
    alpacaStatus: brokerStatus || null,
    requestId: response.requestId,
    rawResponse: response.data
  });
  if (!postgresAuthority) {
    runInZeroDtePersistenceTransaction(() => {
      db!.prepare(
        `UPDATE zero_dte_paper_trades
         SET status = 'submitted', broker_order_id = ?,
             submitted_at = COALESCE(submitted_at, ?), updated_at = ?
         WHERE paper_trade_id = ?`
      ).run(brokerOrderId, now, now, paperTradeId);
    });
  }
  await recordCurrentExecution();

  const row: ZeroDtePaperOrderRow | undefined = postgresAuthority
    ? {
        paper_trade_id: paperTradeId,
        decision_id: input.decisionId,
        candidate_id: input.candidate.candidateId,
        trading_date: input.candidate.tradingDate,
        underlying_symbol: normalizedSymbol(input.candidate.underlyingSymbol),
        status: "submitted",
        option_symbol: normalizedSymbol(input.candidate.optionSymbol),
        quantity: eligibility.quantity,
        client_order_id: eligibility.clientOrderId,
        broker_order_id: brokerOrderId,
        source_ledger_id: ledger.id,
        ledger_id: ledger.id,
        ledger_symbol: ledger.symbol,
        ledger_quantity: ledger.qty,
        ledger_client_order_id: ledger.clientOrderId,
        ledger_broker_order_id: brokerOrderId,
        ledger_dedupe_key: ledger.dedupeKey,
        ledger_status: ledger.status
      }
    : zeroDtePaperOrderRowForTrade(paperTradeId);
  try {
    if (!row) throw new Error("ZERO_DTE_PAPER_TRADE_NOT_FOUND");
    const state = validateZeroDteBrokerOrderState({ row, response });
    if (postgresAuthority) {
      const terminalWithFill = state.kind === "terminal" && state.filledQuantity > 0;
      const stateStatus: PaperExecutionLedgerStatus = state.kind === "filled"
        ? "filled"
        : state.kind === "partial" || terminalWithFill
          ? "partial"
          : state.kind === "terminal"
            ? state.terminal?.ledgerStatus ?? "failed"
            : "submitted";
      if (stateStatus !== "submitted") {
        updateCurrentExecution({
          status: stateStatus,
          alpacaOrderId: brokerOrderId,
          alpacaStatus: state.brokerStatus,
          requestId: response.requestId,
          reason: state.terminal?.reasonCode ?? null,
          blockedReason: state.terminal?.reasonCode ?? null,
          rawResponse: response.data
        });
        await recordCurrentExecution();
      }
    } else {
      applyZeroDteBrokerOrderState({ row, state, response, now });
      recordCandidateExecutionState(input.candidate.candidateId, "executed", now);
    }
    const executionStatus: ZeroDteExecutionStatus = state.kind === "filled"
      ? "filled"
      : state.kind === "partial" || (state.kind === "terminal" && state.filledQuantity > 0)
        ? "partial"
        : state.kind === "terminal"
          ? "failed"
          : "submitted";
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: executionStatus,
      mutationAttempted: true,
      ledgerId,
      paperTradeId,
      brokerOrderId,
      requestId: response.requestId ?? null,
      blockers: state.kind === "terminal" && state.filledQuantity === 0
        ? [state.terminal?.reasonCode ?? "BROKER_ORDER_TERMINAL"]
        : [],
      warnings: state.kind === "terminal" && state.filledQuantity > 0
        ? [state.terminal?.reasonCode ?? "BROKER_ORDER_PARTIAL_TERMINAL"]
        : [],
      payload,
      eligibility
    });
  } catch (error) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500);
    updateCurrentExecution({
      status: "failed",
      alpacaOrderId: brokerOrderId,
      alpacaStatus: brokerStatus || null,
      requestId: response.requestId,
      reason: "BROKER_ORDER_EVIDENCE_INVALID",
      blockedReason: "BROKER_ORDER_EVIDENCE_INVALID",
      errorMessage: message,
      rawResponse: response.data
    });
    if (!postgresAuthority) {
      recordCandidateExecutionState(input.candidate.candidateId, "executed", now);
    }
    await recordCurrentExecution();
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "failed",
      mutationAttempted: true,
      ledgerId,
      paperTradeId,
      brokerOrderId,
      requestId: response.requestId ?? null,
      blockers: ["BROKER_ORDER_EVIDENCE_INVALID"],
      warnings: [message],
      payload,
      eligibility
    });
  }
};
