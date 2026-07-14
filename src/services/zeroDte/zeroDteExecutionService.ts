import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { getDb } from "../../lib/db.js";
import {
  getAccount,
  listPaperPositions,
  listRecentPaperOrders,
  submitPaperOrder,
  type AlpacaAccountRaw,
  type AlpacaApiResponse,
  type AlpacaPaperOrderRequest,
  type AlpacaPositionRaw,
  type AlpacaSubmittedOrder
} from "../alpacaClient.js";
import { nowIso } from "../../lib/utils.js";
import {
  findPaperExecutionByDedupeKey,
  insertPaperExecutionLedgerEntry,
  updatePaperExecutionLedgerEntry,
  type PaperExecutionLedgerEntry,
  type PaperExecutionLedgerStatus
} from "../paperExecutionLedgerService.js";
import {
  insertZeroDteLifecycleEventRow,
  type ZeroDteLifecycleEventInput
} from "./zeroDteLifecycleService.js";
import { buildZeroDteClientOrderId } from "./zeroDteIdentityService.js";
import { loadZeroDteConfig } from "./zeroDteConfigService.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import type {
  ZeroDteAccountOrderSnapshot,
  ZeroDteAccountPositionSnapshot,
  ZeroDteAccountSnapshot,
  ZeroDteConfig,
  ZeroDteRuntimeSnapshot
} from "./zeroDteTypes.js";
import type { ZeroDteQueueCandidate } from "./zeroDtePersistenceService.js";

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
  submitPaperOrder?: typeof submitPaperOrder;
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
  return symbol ? { symbol, quantity } : null;
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
        clientOrderId: text(row.clientOrderId ?? row.client_order_id)
      }
    : null;
};

const toAccountSnapshot = (
  account: AlpacaAccountRaw,
  positions: AlpacaPositionRaw[],
  orders: AlpacaSubmittedOrder[],
  runtime: ZeroDteRuntimeSnapshot
): ZeroDteAccountSnapshot => ({
  environment: runtime.environment,
  paperVerified: runtime.paperAccountVerified ?? runtime.environment === "paper",
  status: text(account.status),
  buyingPower: finite(account.buying_power),
  optionsBuyingPower: finite(account.options_buying_power ?? account.buying_power),
  equity: finite(account.equity ?? account.portfolio_value),
  optionApprovalLevel: finite(account.options_approved_level ?? account.options_trading_level),
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
  const dailyPremium = finite(account.dailyPremium);
  if (estimatedPremium !== null && dailyPremium !== null && dailyPremium + estimatedPremium > config.maxDailyPremium) {
    blockers.push("DAILY_PREMIUM_LIMIT");
  }
  const dailyTradeCount = finite(account.dailyTradeCount);
  if (dailyTradeCount !== null && dailyTradeCount >= config.maxTradesPerDay) {
    blockers.push("DAILY_TRADE_LIMIT");
  }
  const realizedLoss = accountRealizedLoss(account.dailyRealizedLoss);
  if (realizedLoss !== null && realizedLoss >= config.maxDailyRealizedLoss) {
    blockers.push("DAILY_LOSS_LIMIT");
  }
  const openPositions = account.openPositions ?? [];
  const openSameDayOptionPositions = openPositions.filter((position) => {
    if (position.quantity <= 0) return false;
    const openContract = parseOptionSymbol(normalizedSymbol(position.symbol));
    return openContract.ok && openContract.expirationDate === candidate.tradingDate;
  });
  if (openSameDayOptionPositions.length >= config.maxOpenPositions) {
    blockers.push("MAX_OPEN_0DTE_POSITIONS");
  }
  if (openPositions.some((position) => normalizedSymbol(position.symbol) === symbol && position.quantity > 0)) {
    blockers.push("DUPLICATE_EXPOSURE");
  }
  const openOrders = account.openOrders ?? [];
  if (openOrders.some((order) => normalizedSymbol(order.symbol) === symbol && ACTIVE_ORDER_STATUSES.has(normalizedStatus(order.status)))) {
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
      buyingPower,
      dailyPremium,
      dailyTradeCount,
      dailyRealizedLoss: realizedLoss
    }
  };
};

const decisionRow = (decisionId: string) => getDb().prepare(
  `SELECT decision_id, decision_group_id, engine_run_id, candidate_id,
          trading_date, strategy_version, configuration_version_id,
          market_timestamp
   FROM zero_dte_decisions
   WHERE decision_id = ?`
).get(decisionId) as {
  decision_id: string;
  decision_group_id: string;
  engine_run_id: string;
  candidate_id: string;
  trading_date: string;
  strategy_version: string;
  configuration_version_id: string;
  market_timestamp: string | null;
} | undefined;

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

const createBlockedLedgerEntry = (input: {
  candidate: ZeroDteQueueCandidate;
  eligibility: ZeroDteEligibilityResult;
  reason: string;
  now: string;
}) => {
  const existing = findPaperExecutionByDedupeKey(input.eligibility.reservationKey);
  if (existing) {
    if (ACTIVE_ORDER_STATUSES.has(normalizedStatus(existing.status))) return existing;
    updatePaperExecutionLedgerEntry(existing.id, {
      status: "blocked",
      reason: input.reason,
      blockedReason: input.reason
    });
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
    sourceCandidateId: input.candidate.candidateId,
    payload: {
      candidateId: input.candidate.candidateId,
      optionSymbol: normalizedSymbol(input.candidate.optionSymbol),
      quantity: input.eligibility.quantity,
      limitPrice: input.eligibility.limitPrice,
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
  paperTradeId: input.paperTradeId ?? null,
  ledgerId: input.ledgerId ?? null,
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
  runtime: ZeroDteRuntimeSnapshot
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
  return toAccountSnapshot(
    accountResponse.data,
    Array.isArray(positionsResponse.data) ? positionsResponse.data : [],
    Array.isArray(ordersResponse.data) ? ordersResponse.data : [],
    runtime
  );
};

const recordCandidateExecutionState = (candidateId: string, state: "selected" | "executed", asOf: string) => {
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

  const preflightBlockers = unique([
    ...runtimeBlockers(config, runtime),
    ...(input.confirmPaper ? [] : ["CONFIRM_PAPER_REQUIRED"])
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

  let account: ZeroDteAccountSnapshot;
  try {
    account = await accountFromProvider(provider, runtime);
  } catch (error) {
    const eligibility = { ...skeletonEligibility, blockers: ["ACCOUNT_RECONCILIATION_FAILED"] };
    const ledger = createBlockedLedgerEntry({ candidate: input.candidate, eligibility, reason: "ACCOUNT_RECONCILIATION_FAILED", now });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "blocked",
      ledgerId: ledger.id,
      blockers: ["ACCOUNT_RECONCILIATION_FAILED"],
      warnings: [error instanceof Error ? error.message : "Paper account reconciliation failed."],
      eligibility
    });
  }

  const existingLedgerEntries: ZeroDteExistingLedgerEntry[] = [];
  const currentLedger = findPaperExecutionByDedupeKey(skeletonEligibility.reservationKey);
  if (currentLedger) existingLedgerEntries.push({ dedupeKey: currentLedger.dedupeKey, status: currentLedger.status });
  const eligibility = evaluateZeroDteExecutionEligibility({
    candidate: input.candidate,
    config,
    runtime,
    account,
    now,
    existingLedgerEntries
  });
  if (!eligibility.eligible) {
    const duplicate = eligibility.blockers.includes("DUPLICATE_ORDER");
    const ledger = duplicate
      ? currentLedger
      : createBlockedLedgerEntry({ candidate: input.candidate, eligibility, reason: eligibility.blockers[0] ?? "EXECUTION_BLOCKED", now });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: duplicate ? "duplicate_blocked" : "blocked",
      ledgerId: ledger?.id ?? null,
      blockers: eligibility.blockers,
      warnings: eligibility.warnings,
      eligibility
    });
  }

  const decision = decisionRow(input.decisionId);
  if (!decision || decision.candidate_id !== input.candidate.candidateId) {
    const blockedEligibility = { ...eligibility, blockers: ["DECISION_CANDIDATE_MISMATCH"] };
    const ledger = createBlockedLedgerEntry({ candidate: input.candidate, eligibility: blockedEligibility, reason: "DECISION_CANDIDATE_MISMATCH", now });
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
  const db = getDb();
  const existingTrade = db.prepare("SELECT paper_trade_id, status FROM zero_dte_paper_trades WHERE paper_trade_id = ?").get(paperTradeId) as { paper_trade_id: string; status: string } | undefined;
  if (existingTrade && ["submitted", "partially_filled", "open", "filled"].includes(normalizedStatus(existingTrade.status))) {
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "duplicate_blocked",
      paperTradeId,
      blockers: ["DUPLICATE_ORDER"],
      eligibility
    });
  }

  let ledger: PaperExecutionLedgerEntry;
  try {
    const reusableLedger = findPaperExecutionByDedupeKey(eligibility.reservationKey);
    if (reusableLedger && ["blocked", "failed", "released", "expired"].includes(normalizedStatus(reusableLedger.status))) {
      updatePaperExecutionLedgerEntry(reusableLedger.id, {
        status: "reserved",
        reason: null,
        blockedReason: null,
        errorMessage: null
      });
      ledger = {
        ...reusableLedger,
        status: "reserved",
        reason: null,
        blockedReason: null,
        errorMessage: null
      };
    } else {
      ledger = insertPaperExecutionLedgerEntry({
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
        sourceCandidateId: input.candidate.candidateId,
        payload: {
          candidateId: input.candidate.candidateId,
          decisionId: input.decisionId,
          decisionGroupId: decision.decision_group_id,
          tradingDate: input.candidate.tradingDate,
          symbol: normalizedSymbol(input.candidate.optionSymbol),
          quantity: eligibility.quantity,
          limitPrice: eligibility.limitPrice,
          positionIntent: "buy_to_open"
        }
      });
    }
  } catch {
    const duplicate = findPaperExecutionByDedupeKey(eligibility.reservationKey);
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "duplicate_blocked",
      ledgerId: duplicate?.id ?? null,
      blockers: ["DUPLICATE_ORDER"],
      eligibility
    });
  }

  db.prepare(
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
    decision,
    paperTradeId,
    occurredAt: now,
    reasonCode: "PAPER_ORDER_REQUESTED",
    details: { clientOrderId: eligibility.clientOrderId, quantity: eligibility.quantity, limitPrice: eligibility.limitPrice }
  });

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
    updatePaperExecutionLedgerEntry(ledger.id, {
      status: "failed",
      reason: "ORDER_REJECTED",
      blockedReason: "ORDER_REJECTED",
      errorMessage: error instanceof Error ? error.message : "Paper order submission failed."
    });
    db.prepare(
      `UPDATE zero_dte_paper_trades
       SET status = 'rejected', exit_reason_code = ?, updated_at = ?
       WHERE paper_trade_id = ?`
    ).run("ORDER_REJECTED", now, paperTradeId);
    appendPaperLifecycleEvent({ eventType: "paper_order_rejected", decision, paperTradeId, occurredAt: now, reasonCode: "ORDER_REJECTED" });
    return baseResult({
      candidate: input.candidate,
      decisionId: input.decisionId,
      status: "failed",
      mutationAttempted: true,
      ledgerId: ledger.id,
      paperTradeId,
      blockers: ["ORDER_REJECTED"],
      warnings: [error instanceof Error ? error.message : "Paper order submission failed."],
      payload,
      eligibility
    });
  }

  const brokerOrderId = text(response.data?.id);
  const brokerStatus = normalizedStatus(response.data?.status) || "submitted";
  const executionStatus: ZeroDteExecutionStatus = brokerStatus === "filled"
    ? "filled"
    : brokerStatus === "partially_filled" || brokerStatus === "partial"
      ? "partial"
      : "submitted";
  updatePaperExecutionLedgerEntry(ledger.id, {
    status: executionStatus === "filled" ? "filled" : executionStatus === "partial" ? "partial" : "submitted",
    alpacaOrderId: brokerOrderId,
    alpacaStatus: brokerStatus,
    requestId: response.requestId
  });
  if (!brokerOrderId) {
    updatePaperExecutionLedgerEntry(ledger.id, {
      status: "failed",
      reason: "ORDER_ID_MISSING",
      blockedReason: "ORDER_ID_MISSING",
      requestId: response.requestId
    });
    appendPaperLifecycleEvent({ eventType: "paper_order_rejected", decision, paperTradeId, occurredAt: now, reasonCode: "ORDER_ID_MISSING" });
    return baseResult({ candidate: input.candidate, decisionId: input.decisionId, status: "failed", mutationAttempted: true, ledgerId: ledger.id, paperTradeId, requestId: response.requestId ?? null, blockers: ["ORDER_ID_MISSING"], payload, eligibility });
  }

  db.prepare(
    `UPDATE zero_dte_paper_trades
     SET status = ?, broker_order_id = ?, submitted_at = ?,
         filled_at = CASE WHEN ? IN ('filled', 'partially_filled', 'partial') THEN ? ELSE filled_at END,
         updated_at = ?
     WHERE paper_trade_id = ?`
  ).run(executionStatus === "filled" ? "open" : executionStatus === "partial" ? "partially_filled" : "submitted", brokerOrderId, now, brokerStatus, now, now, paperTradeId);
  recordCandidateExecutionState(input.candidate.candidateId, "executed", now);
  appendPaperLifecycleEvent({ eventType: "paper_order_accepted", decision, paperTradeId, occurredAt: now, details: { brokerOrderId, brokerStatus, requestId: response.requestId ?? null } });
  if (executionStatus === "partial") appendPaperLifecycleEvent({ eventType: "paper_order_partially_filled", decision, paperTradeId, occurredAt: now, details: { brokerOrderId } });
  if (executionStatus === "filled") {
    appendPaperLifecycleEvent({ eventType: "paper_order_filled", decision, paperTradeId, occurredAt: now, details: { brokerOrderId } });
    appendPaperLifecycleEvent({ eventType: "position_opened", decision, paperTradeId, occurredAt: now, details: { brokerOrderId } });
  }
  return baseResult({
    candidate: input.candidate,
    decisionId: input.decisionId,
    status: executionStatus,
    mutationAttempted: true,
    ledgerId: ledger.id,
    paperTradeId,
    brokerOrderId,
    requestId: response.requestId ?? null,
    payload,
    eligibility
  });
};
