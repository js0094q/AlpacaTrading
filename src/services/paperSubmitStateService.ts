import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { queryOne } from "../lib/db.js";
import {
  getAccount,
  getAlpacaPaperEndpoint,
  getLatestOptionSnapshots,
  getLatestStockSnapshots,
  listPaperPositions,
  type AlpacaApiResponse,
  type AlpacaAccountRaw,
  type AlpacaOptionSnapshotRaw,
  type AlpacaPositionRaw,
  type AlpacaStockSnapshotRaw,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import {
  listActivePaperNewRiskReservations,
  type PaperExecutionLedgerEntry
} from "./paperExecutionLedgerService.js";
import {
  loadPaperPlanConfig,
  paperOptionsConfig
} from "./paperPlanService.js";
import type {
  ReviewedPayloadSectionName,
  ReviewedPayloadSections
} from "./paperReviewArtifactService.js";
import { classifyBrokerOrderStatus } from "./brokerOrderStatusService.js";
import {
  buildZeroDteActivityEvidence,
  type ZeroDteActivityEvidence
} from "./zeroDte/zeroDteActivityEvidenceService.js";
import { loadZeroDteConfig } from "./zeroDte/zeroDteConfigService.js";
import { parseOptionSymbol } from "./optionSymbolService.js";

const ENTRY_SECTIONS = new Set<ReviewedPayloadSectionName>([
  "equityBuys",
  "equityAdds",
  "optionBuys"
]);

export interface PaperSubmitConfiguration {
  environment: string;
  tradingMode: string;
  liveTradingEnabled: boolean;
  paperOrderExecutionEnabled: boolean;
  paperOptionsExecutionEnabled: boolean;
  maxPositionNotional: number;
  maxTotalPlanNotional: number;
  equityMaxNotionalPerOrder: number;
  equityMaxPortfolioDeployPct: number;
  equityMaxPositionPct: number;
  equityMinCashReservePct: number;
  optionMaxOrderNotional: number;
  optionMaxContracts: number;
  optionMaxPortfolioRiskPct: number;
  optionMaxPositionRiskPct: number;
  quoteMaxAgeSeconds: number;
  maxPriceDriftPct: number;
  zeroDteMaxTradesPerDay?: number;
  zeroDteMaxDailyPremium?: number;
  zeroDteMaxDailyRealizedLoss?: number;
  zeroDteMaxOpenPositions?: number;
}

export interface PaperSubmitSafetyConfig extends PaperSubmitConfiguration {
  allocationIdentity: "baseline-v1";
}

export interface PaperSubmitAccountState {
  status: string | null;
  cash: number | null;
  equity: number | null;
  buyingPower: number | null;
  optionsBuyingPower: number | null;
  optionsApprovalLevel: number | null;
  tradingBlocked: boolean | null;
  accountBlocked: boolean | null;
}

export interface PaperSubmitPositionState {
  symbol: string;
  assetClass: "equity" | "option";
  quantity: number | null;
  marketValue: number | null;
  currentPrice: number | null;
}

export interface PaperSubmitOrderState {
  symbol: string;
  assetClass: "equity" | "option";
  side: string | null;
  status: string | null;
  quantity: number | null;
  notional: number | null;
  limitPrice: number | null;
  clientOrderIdHash: string | null;
}

export interface PaperSubmitReservationState {
  symbol: string;
  assetClass: "equity" | "option";
  side: string | null;
  status: string;
  quantity: number | null;
  notional: number | null;
  estimatedPremium: number | null;
  limitPrice: number | null;
  clientOrderIdHash: string;
}

export interface PaperSubmitMarketEvidence {
  symbol: string;
  assetClass: "equity" | "option";
  referencePrice: number | null;
  bid: number | null;
  ask: number | null;
  timestamp: string | null;
  complete: boolean;
}

export interface PaperSubmitIntent {
  section: ReviewedPayloadSectionName;
  payloadIndex: number;
  assetClass: "equity" | "option";
  symbol: string;
  side: "buy";
  orderType: "market" | "limit";
  quantity: number | null;
  notional: number | null;
  limitPrice: number | null;
  estimatedPremium: number | null;
  positionIntent: string | null;
  sourceCandidateId: string | null;
  sourceReviewId: string | null;
  clientOrderIdHash: string | null;
}

export interface PaperSubmitStateAttestation {
  version: "paper-submit-state-v1";
  capturedAt: string;
  accountIdentityHash: string | null;
  accountState: PaperSubmitAccountState;
  configuration: PaperSubmitConfiguration;
  configurationFingerprint: string;
  positions: PaperSubmitPositionState[];
  openOrders: PaperSubmitOrderState[];
  reservations: PaperSubmitReservationState[];
  marketEvidence: PaperSubmitMarketEvidence[];
  payloadIntents: PaperSubmitIntent[];
  structuralPortfolioFingerprint: string;
  portfolioFingerprint: string;
  marketEvidenceFingerprint: string;
  zeroDteActivityEvidence?: ZeroDteActivityEvidence | null;
  allocationAttestation: {
    mode: "baseline";
    identity: "baseline-v1";
    allocatorControlled: false;
  };
  complete: boolean;
  blockers: string[];
  warnings: string[];
}

export interface PaperSubmitStateValidation {
  valid: boolean;
  blockers: string[];
  warnings: string[];
  reviewedPortfolioFingerprint: string;
  currentPortfolioFingerprint: string;
}

interface SourceCandidateIdentity {
  id: string;
  symbol: string;
  optionSymbol: string | null;
}

export interface PaperSubmitStateDeps {
  getAccount?: typeof getAccount;
  listPositions?: typeof listPaperPositions;
  listOrders?: () => Promise<AlpacaApiResponse<AlpacaSubmittedOrder[]>>;
  listReservations?: () => PaperExecutionLedgerEntry[];
  getMarketEvidence?: (
    intents: PaperSubmitIntent[],
    capturedAt: string
  ) => Promise<PaperSubmitMarketEvidence[]>;
  resolveSourceCandidate?: (
    sourceCandidateId: string
  ) => SourceCandidateIdentity | null;
  buildZeroDteActivityEvidence?: typeof buildZeroDteActivityEvidence;
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const positive = (value: unknown, fallback: number) => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
};

const percent = (value: unknown, fallback: number) => {
  const parsed = finite(value);
  return parsed === null ? fallback : Math.min(100, Math.max(0, parsed));
};

const flag = (value: string | undefined) => value === "true" || value === "1";

const first = (env: NodeJS.ProcessEnv, ...names: string[]) => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim()) return value;
  }
  return undefined;
};

export const loadPaperSubmitSafetyConfig = (
  env: NodeJS.ProcessEnv = process.env
): PaperSubmitSafetyConfig => {
  const plan = env === process.env ? loadPaperPlanConfig() : null;
  const options = env === process.env ? paperOptionsConfig() : null;
  const liveTradingEnabled =
    flag(env.ALPACA_LIVE_TRADE) || flag(env.LIVE_TRADING_ENABLED);
  const zeroDte = env === process.env ? loadZeroDteConfig() : null;

  return {
    environment: String(env.ALPACA_ENV || "paper").trim().toLowerCase(),
    tradingMode: String(env.TRADING_MODE || "paper").trim().toLowerCase(),
    liveTradingEnabled,
    paperOrderExecutionEnabled: flag(env.PAPER_ORDER_EXECUTION_ENABLED),
    paperOptionsExecutionEnabled: flag(env.PAPER_OPTIONS_EXECUTION_ENABLED),
    maxPositionNotional:
      plan?.maxPositionNotional ??
      positive(
        first(env, "PAPER_PLAN_MAX_POSITION_NOTIONAL", "PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER"),
        5_000
      ),
    maxTotalPlanNotional:
      plan?.maxTotalPlanNotional ??
      positive(env.PAPER_PLAN_MAX_TOTAL_PLAN_NOTIONAL, 50_000),
    equityMaxNotionalPerOrder:
      plan?.equityMaxNotionalPerOrder ??
      positive(env.PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER, 5_000),
    equityMaxPortfolioDeployPct:
      plan?.equityMaxPortfolioDeployPct ??
      percent(env.PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT, 50),
    equityMaxPositionPct:
      plan?.equityMaxPositionPct ??
      percent(env.PAPER_EQUITY_MAX_POSITION_PCT, 10),
    equityMinCashReservePct:
      plan?.equityMinCashReservePct ??
      percent(
        first(env, "PAPER_EQUITY_MIN_CASH_RESERVE_PCT", "PAPER_PLAN_MIN_BUYING_POWER_RESERVE_PCT"),
        20
      ),
    optionMaxOrderNotional:
      options?.maxOrderNotional ??
      positive(
        first(env, "PAPER_OPTION_MAX_ORDER_NOTIONAL", "PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER"),
        1_500
      ),
    optionMaxContracts:
      options?.maxContracts ??
      Math.max(
        1,
        Math.floor(
          positive(
            first(env, "PAPER_OPTION_MAX_CONTRACTS", "PAPER_OPTIONS_MAX_CONTRACTS"),
            1
          )
        )
      ),
    optionMaxPortfolioRiskPct:
      options?.maxPortfolioRiskPct ??
      percent(env.PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT, 20),
    optionMaxPositionRiskPct:
      options?.maxPositionRiskPct ??
      percent(env.PAPER_OPTIONS_MAX_POSITION_RISK_PCT, 5),
    quoteMaxAgeSeconds: positive(env.PAPER_SUBMIT_QUOTE_MAX_AGE_SECONDS, 60),
    maxPriceDriftPct: percent(env.PAPER_SUBMIT_MAX_PRICE_DRIFT_PCT, 10),
    zeroDteMaxTradesPerDay:
      zeroDte?.maxTradesPerDay ??
      Math.max(1, Math.floor(positive(env.ZERO_DTE_MAX_TRADES_PER_DAY, 3))),
    zeroDteMaxDailyPremium:
      zeroDte?.maxDailyPremium ?? positive(env.ZERO_DTE_MAX_DAILY_PREMIUM, 750),
    zeroDteMaxDailyRealizedLoss:
      zeroDte?.maxDailyRealizedLoss ??
      positive(env.ZERO_DTE_MAX_DAILY_REALIZED_LOSS, 250),
    zeroDteMaxOpenPositions:
      zeroDte?.maxOpenPositions ??
      Math.max(1, Math.floor(positive(env.ZERO_DTE_MAX_OPEN_POSITIONS, 3))),
    allocationIdentity: "baseline-v1"
  };
};

const configurationWithoutAllocation = (
  config: PaperSubmitSafetyConfig
): PaperSubmitConfiguration => {
  const { allocationIdentity: _allocationIdentity, ...configuration } = config;
  return configuration;
};

const assetClass = (value: unknown, symbol: string): "equity" | "option" =>
  String(value ?? "").toLowerCase().includes("option") || /\d{6}[CP]\d{8}$/.test(symbol)
    ? "option"
    : "equity";

const hashIdentifier = (value: string | null) =>
  value ? canonicalJsonHash({ value }) : null;

const normalizeIntents = (sections: ReviewedPayloadSections) => {
  const blockers: string[] = [];
  const intents: PaperSubmitIntent[] = [];
  for (const [section, rows] of Object.entries(sections) as Array<
    [ReviewedPayloadSectionName, unknown[]]
  >) {
    if (!ENTRY_SECTIONS.has(section)) continue;
    rows.forEach((raw, payloadIndex) => {
      if (!isRecord(raw)) {
        blockers.push("REVIEW_ENTRY_INTENT_INVALID");
        return;
      }
      const symbol = upper(raw.symbol);
      const normalizedAssetClass =
        section === "optionBuys" ? "option" : assetClass(raw.assetClass ?? raw.asset_class, symbol);
      const sourceCandidateId = text(raw.sourceCandidateId ?? raw.source_candidate_id);
      const clientOrderId = text(raw.client_order_id ?? raw.clientOrderId);
      const side = text(raw.side)?.toLowerCase();
      if (!symbol || side !== "buy") blockers.push("REVIEW_ENTRY_INTENT_INVALID");
      if (!sourceCandidateId) blockers.push("REVIEW_ENTRY_SOURCE_IDENTITY_MISSING");
      if (!clientOrderId) blockers.push("REVIEW_ENTRY_INTENT_INVALID");
      const quantity = finite(raw.qty ?? raw.quantity);
      const notional = finite(raw.notional);
      const limitPrice = finite(raw.limit_price ?? raw.limitPrice);
      const estimatedPremium =
        finite(raw.estimatedPremium ?? raw.estimated_premium) ??
        (normalizedAssetClass === "option" && quantity !== null && limitPrice !== null
          ? quantity * limitPrice * 100
          : null);
      intents.push({
        section,
        payloadIndex,
        assetClass: normalizedAssetClass,
        symbol,
        side: "buy",
        orderType:
          text(raw.type ?? raw.order_type)?.toLowerCase() === "limit" ? "limit" : "market",
        quantity,
        notional,
        limitPrice,
        estimatedPremium,
        positionIntent: text(raw.position_intent ?? raw.positionIntent),
        sourceCandidateId,
        sourceReviewId: text(raw.sourceReviewId ?? raw.source_review_id),
        clientOrderIdHash: hashIdentifier(clientOrderId)
      });
    });
  }
  intents.sort((left, right) =>
    `${left.section}:${left.payloadIndex}:${left.symbol}`.localeCompare(
      `${right.section}:${right.payloadIndex}:${right.symbol}`
    )
  );
  return { intents, blockers: unique(blockers) };
};

const normalizeAccount = (account: AlpacaAccountRaw): {
  identityHash: string | null;
  state: PaperSubmitAccountState;
  blockers: string[];
} => {
  const blockers: string[] = [];
  const id = text(account.id);
  const state: PaperSubmitAccountState = {
    status: text(account.status),
    cash: finite(account.cash),
    equity: finite(account.equity ?? account.portfolio_value),
    buyingPower: finite(account.buying_power),
    optionsBuyingPower: finite(account.options_buying_power ?? account.buying_power),
    optionsApprovalLevel: finite(
      account.options_approved_level ?? account.options_trading_level
    ),
    tradingBlocked:
      typeof account.trading_blocked === "boolean" ? account.trading_blocked : null,
    accountBlocked:
      typeof account.account_blocked === "boolean" ? account.account_blocked : null
  };
  if (!id) blockers.push("SUBMIT_ACCOUNT_IDENTITY_UNAVAILABLE");
  if (
    !state.status ||
    state.cash === null ||
    state.equity === null ||
    state.buyingPower === null ||
    state.optionsBuyingPower === null ||
    state.tradingBlocked === null ||
    state.accountBlocked === null
  ) {
    blockers.push("SUBMIT_ACCOUNT_EVIDENCE_UNAVAILABLE");
  }
  return {
    identityHash: id ? canonicalJsonHash({ accountId: id }) : null,
    state,
    blockers
  };
};

const normalizePositions = (positions: AlpacaPositionRaw[]) => {
  const blockers: string[] = [];
  const normalized = positions
    .map((position): PaperSubmitPositionState | null => {
      const symbol = upper(position.symbol);
      if (!symbol) {
        blockers.push("SUBMIT_POSITION_EVIDENCE_UNAVAILABLE");
        return null;
      }
      const row = {
        symbol,
        assetClass: assetClass(position.asset_class, symbol),
        quantity: finite(position.qty),
        marketValue: finite(position.market_value),
        currentPrice: finite(position.current_price)
      } satisfies PaperSubmitPositionState;
      if (row.quantity === null || row.marketValue === null) {
        blockers.push("SUBMIT_POSITION_EVIDENCE_UNAVAILABLE");
      }
      return row;
    })
    .filter((row): row is PaperSubmitPositionState => row !== null)
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  return { positions: normalized, blockers: unique(blockers) };
};

const normalizeOrders = (orders: AlpacaSubmittedOrder[]) => {
  const blockers: string[] = [];
  const normalized = orders
    .filter((order) => {
      const classification = classifyBrokerOrderStatus(order.status);
      if (!classification.normalized) {
        blockers.push("SUBMIT_ORDER_EVIDENCE_UNAVAILABLE");
        return false;
      }
      if (!classification.known) {
        blockers.push("SUBMIT_ORDER_STATUS_UNRECOGNIZED");
      }
      return classification.active;
    })
    .map((order): PaperSubmitOrderState => {
      const symbol = upper(order.symbol);
      const row = {
        symbol,
        assetClass: assetClass(order.asset_class, symbol),
        side: text(order.side)?.toLowerCase() ?? null,
        status: text(order.status)?.toLowerCase() ?? null,
        quantity: finite(order.qty),
        notional: finite(order.notional),
        limitPrice: finite(order.limit_price),
        clientOrderIdHash: hashIdentifier(text(order.client_order_id))
      } satisfies PaperSubmitOrderState;
      if (!row.symbol || !row.side || !row.status || !row.clientOrderIdHash) {
        blockers.push("SUBMIT_ORDER_EVIDENCE_UNAVAILABLE");
      }
      return row;
    })
    .sort((left, right) =>
      `${left.symbol}:${left.clientOrderIdHash ?? ""}`.localeCompare(
        `${right.symbol}:${right.clientOrderIdHash ?? ""}`
      )
    );
  return { orders: normalized, blockers: unique(blockers) };
};

export const normalizePaperSubmitReservations = (
  reservations: PaperExecutionLedgerEntry[]
): PaperSubmitReservationState[] =>
  reservations
    .map((entry) => ({
      symbol: upper(entry.symbol),
      assetClass: entry.assetClass === "option" ? "option" as const : "equity" as const,
      side: entry.side?.toLowerCase() ?? null,
      status: entry.status,
      quantity: finite(entry.qty),
      notional: finite(entry.notional),
      estimatedPremium: finite(entry.estimatedPremium),
      limitPrice: finite(entry.limitPrice),
      clientOrderIdHash: canonicalJsonHash({ clientOrderId: entry.clientOrderId })
    }))
    .sort((left, right) =>
      `${left.symbol}:${left.clientOrderIdHash}`.localeCompare(
        `${right.symbol}:${right.clientOrderIdHash}`
      )
    );

export const paperSubmitReservationFingerprint = (
  reservations: PaperSubmitReservationState[]
) => canonicalJsonHash(reservations);

const zeroDteIntents = (intents: PaperSubmitIntent[]) =>
  intents.filter(
    (intent) =>
      intent.assetClass === "option" &&
      intent.sourceCandidateId?.startsWith("discovery:zero_dte_spy:")
  );

const zeroDteActivityStateFingerprint = (
  evidence: ZeroDteActivityEvidence | null | undefined
) =>
  evidence
    ? canonicalJsonHash({
        tradingDate: evidence.tradingDate,
        complete: evidence.complete,
        dailyTradeCount: evidence.dailyTradeCount,
        dailyPremium: evidence.dailyPremium,
        dailyRealizedLoss: evidence.dailyRealizedLoss,
        openPositionCount: evidence.openPositionCount,
        openOrderCount: evidence.openOrderCount,
        openExposureCount: evidence.openExposureCount,
        blockers: [...evidence.blockers].sort()
      })
    : null;

const quoteParts = (quote: Record<string, unknown> | undefined) => ({
  bid: finite(quote?.bp ?? quote?.b),
  ask: finite(quote?.ap ?? quote?.a),
  timestamp: text(quote?.t)
});

const defaultMarketEvidence = async (
  intents: PaperSubmitIntent[]
): Promise<PaperSubmitMarketEvidence[]> => {
  const equitySymbols = unique(
    intents.filter((intent) => intent.assetClass === "equity").map((intent) => intent.symbol)
  );
  const optionSymbols = unique(
    intents.filter((intent) => intent.assetClass === "option").map((intent) => intent.symbol)
  );
  const [stockResponse, optionResponse] = await Promise.all([
    equitySymbols.length ? getLatestStockSnapshots(equitySymbols) : Promise.resolve({ data: {} }),
    optionSymbols.length ? getLatestOptionSnapshots(optionSymbols) : Promise.resolve({ data: {} })
  ]);
  const stockSnapshots = stockResponse.data as Record<string, AlpacaStockSnapshotRaw>;
  const optionSnapshots = optionResponse.data as Record<string, AlpacaOptionSnapshotRaw>;
  const evidence: PaperSubmitMarketEvidence[] = [];
  for (const symbol of equitySymbols) {
    const snapshot = stockSnapshots[symbol];
    const quote = quoteParts(snapshot?.latestQuote as Record<string, unknown> | undefined);
    const tradePrice = finite(snapshot?.latestTrade?.p);
    const midpoint =
      quote.bid !== null && quote.ask !== null && quote.ask >= quote.bid
        ? (quote.bid + quote.ask) / 2
        : null;
    const referencePrice = tradePrice ?? midpoint ?? finite(snapshot?.minuteBar?.c);
    const timestamp = text(snapshot?.latestTrade?.t) ?? quote.timestamp;
    evidence.push({
      symbol,
      assetClass: "equity",
      referencePrice,
      bid: quote.bid,
      ask: quote.ask,
      timestamp,
      complete: referencePrice !== null && timestamp !== null
    });
  }
  for (const symbol of optionSymbols) {
    const snapshot = optionSnapshots[symbol];
    const rawQuote =
      (snapshot?.latestQuote ?? snapshot?.latest_quote) as Record<string, unknown> | undefined;
    const quote = quoteParts(rawQuote);
    const midpoint =
      quote.bid !== null && quote.ask !== null && quote.ask >= quote.bid
        ? (quote.bid + quote.ask) / 2
        : null;
    const rawTrade = snapshot?.latestTrade ?? snapshot?.latest_trade;
    const referencePrice = midpoint ?? finite(rawTrade?.p);
    const timestamp = quote.timestamp ?? text(rawTrade?.t);
    evidence.push({
      symbol,
      assetClass: "option",
      referencePrice,
      bid: quote.bid,
      ask: quote.ask,
      timestamp,
      complete:
        referencePrice !== null &&
        quote.bid !== null &&
        quote.ask !== null &&
        timestamp !== null
    });
  }
  return evidence.sort((left, right) => left.symbol.localeCompare(right.symbol));
};

const defaultSourceCandidate = (
  sourceCandidateId: string
): SourceCandidateIdentity | null => {
  const discoveryMatch = sourceCandidateId.match(
    /^discovery:(?:zero_dte_spy|leaps):(.+)$/
  );
  if (discoveryMatch?.[1]) {
    const optionSymbol = upper(discoveryMatch[1]);
    const contract = queryOne<{ underlying_symbol: string }>(
      `SELECT underlying_symbol
       FROM option_contracts
       WHERE option_symbol = ?
       LIMIT 1`,
      [optionSymbol]
    );
    return contract
      ? {
          id: sourceCandidateId,
          symbol: upper(contract.underlying_symbol),
          optionSymbol
        }
      : null;
  }
  const row = queryOne<{
    id: string;
    symbol: string;
    option_symbol: string | null;
  }>(
    `SELECT id, symbol, option_symbol
     FROM paper_trade_candidates
     WHERE id = ?
     LIMIT 1`,
    [sourceCandidateId]
  );
  return row
    ? { id: row.id, symbol: upper(row.symbol), optionSymbol: row.option_symbol ? upper(row.option_symbol) : null }
    : null;
};

const marketEvidenceBlockers = (input: {
  intents: PaperSubmitIntent[];
  marketEvidence: PaperSubmitMarketEvidence[];
  capturedAt: string;
  quoteMaxAgeSeconds: number;
}) => {
  const blockers: string[] = [];
  const asOf = Date.parse(input.capturedAt);
  for (const intent of input.intents) {
    const evidence = input.marketEvidence.find(
      (row) => row.symbol === intent.symbol && row.assetClass === intent.assetClass
    );
    if (!evidence?.complete || evidence.referencePrice === null || !evidence.timestamp) {
      blockers.push("SUBMIT_MARKET_EVIDENCE_UNAVAILABLE");
      continue;
    }
    const observedAt = Date.parse(evidence.timestamp);
    const ageSeconds = (asOf - observedAt) / 1_000;
    if (
      !Number.isFinite(asOf) ||
      !Number.isFinite(observedAt) ||
      ageSeconds < 0 ||
      ageSeconds > input.quoteMaxAgeSeconds
    ) {
      blockers.push("SUBMIT_MARKET_EVIDENCE_STALE");
    }
  }
  return unique(blockers);
};

const sourceIdentityBlockers = (input: {
  intents: PaperSubmitIntent[];
  resolveSourceCandidate: NonNullable<PaperSubmitStateDeps["resolveSourceCandidate"]>;
}) => {
  const blockers: string[] = [];
  for (const intent of input.intents) {
    if (!intent.sourceCandidateId) {
      blockers.push("REVIEW_ENTRY_SOURCE_IDENTITY_MISSING");
      continue;
    }
    let source: SourceCandidateIdentity | null = null;
    try {
      source = input.resolveSourceCandidate(intent.sourceCandidateId);
    } catch {
      blockers.push("REVIEW_ENTRY_SOURCE_IDENTITY_UNAVAILABLE");
      continue;
    }
    const sourceSymbol = intent.assetClass === "option" ? source?.optionSymbol : source?.symbol;
    if (!source || sourceSymbol !== intent.symbol) {
      blockers.push("REVIEW_ENTRY_SOURCE_IDENTITY_MISMATCH");
    }
  }
  return unique(blockers);
};

const emptyAccountState = (): PaperSubmitAccountState => ({
  status: null,
  cash: null,
  equity: null,
  buyingPower: null,
  optionsBuyingPower: null,
  optionsApprovalLevel: null,
  tradingBlocked: null,
  accountBlocked: null
});

export const capturePaperSubmitState = async (
  input: {
    capturedAt: string;
    payloadSections: ReviewedPayloadSections;
  },
  deps: PaperSubmitStateDeps = {}
): Promise<PaperSubmitStateAttestation> => {
  const config = loadPaperSubmitSafetyConfig();
  const configuration = configurationWithoutAllocation(config);
  const normalizedIntents = normalizeIntents(input.payloadSections);
  const blockers = [...normalizedIntents.blockers];
  const warnings: string[] = [];

  if (!normalizedIntents.intents.length) {
    return {
      version: "paper-submit-state-v1",
      capturedAt: input.capturedAt,
      accountIdentityHash: null,
      accountState: emptyAccountState(),
      configuration,
      configurationFingerprint: canonicalJsonHash(configuration),
      positions: [],
      openOrders: [],
      reservations: [],
      marketEvidence: [],
      payloadIntents: [],
      structuralPortfolioFingerprint: canonicalJsonHash([]),
      portfolioFingerprint: canonicalJsonHash([]),
      marketEvidenceFingerprint: canonicalJsonHash([]),
      zeroDteActivityEvidence: null,
      allocationAttestation: {
        mode: "baseline",
        identity: "baseline-v1",
        allocatorControlled: false
      },
      complete: true,
      blockers: [],
      warnings: []
    };
  }

  const [accountResult, positionsResult, ordersResult, marketResult] =
    await Promise.allSettled([
      (deps.getAccount ?? getAccount)(),
      (deps.listPositions ?? listPaperPositions)(),
      (deps.listOrders ?? (() =>
        getAlpacaPaperEndpoint<AlpacaSubmittedOrder[]>(
          "/v2/orders?status=open&limit=500&nested=false"
        )))(),
      (deps.getMarketEvidence ?? defaultMarketEvidence)(
        normalizedIntents.intents,
        input.capturedAt
      )
    ]);

  let accountIdentityHash: string | null = null;
  let accountState = emptyAccountState();
  if (accountResult.status === "fulfilled") {
    const normalized = normalizeAccount(accountResult.value.data);
    accountIdentityHash = normalized.identityHash;
    accountState = normalized.state;
    blockers.push(...normalized.blockers);
  } else {
    blockers.push("SUBMIT_ACCOUNT_EVIDENCE_UNAVAILABLE");
  }

  let positions: PaperSubmitPositionState[] = [];
  let rawPositions: AlpacaPositionRaw[] = [];
  if (positionsResult.status === "fulfilled") {
    rawPositions = Array.isArray(positionsResult.value.data)
      ? positionsResult.value.data
      : [];
    const normalized = normalizePositions(rawPositions);
    positions = normalized.positions;
    blockers.push(...normalized.blockers);
  } else {
    blockers.push("SUBMIT_POSITION_EVIDENCE_UNAVAILABLE");
  }

  let openOrders: PaperSubmitOrderState[] = [];
  let rawOrders: AlpacaSubmittedOrder[] = [];
  if (ordersResult.status === "fulfilled") {
    rawOrders = Array.isArray(ordersResult.value.data)
      ? ordersResult.value.data
      : [];
    const normalized = normalizeOrders(rawOrders);
    openOrders = normalized.orders;
    blockers.push(...normalized.blockers);
  } else {
    blockers.push("SUBMIT_ORDER_EVIDENCE_UNAVAILABLE");
  }

  let reservations: PaperSubmitReservationState[] = [];
  try {
    reservations = normalizePaperSubmitReservations(
      (deps.listReservations ?? listActivePaperNewRiskReservations)()
    );
  } catch {
    blockers.push("SUBMIT_RESERVATION_EVIDENCE_UNAVAILABLE");
  }

  const marketEvidence =
    marketResult.status === "fulfilled" ? marketResult.value : [];
  if (marketResult.status === "rejected") {
    blockers.push("SUBMIT_MARKET_EVIDENCE_UNAVAILABLE");
  }
  blockers.push(
    ...marketEvidenceBlockers({
      intents: normalizedIntents.intents,
      marketEvidence,
      capturedAt: input.capturedAt,
      quoteMaxAgeSeconds: config.quoteMaxAgeSeconds
    })
  );

  let zeroDteActivityEvidence: ZeroDteActivityEvidence | null = null;
  const zeroDteEntries = zeroDteIntents(normalizedIntents.intents);
  if (zeroDteEntries.length) {
    const tradingDates = unique(
      zeroDteEntries
        .map((intent) => parseOptionSymbol(intent.symbol))
        .map((parsed) => (parsed.ok ? parsed.expirationDate : ""))
        .filter(Boolean)
    );
    if (
      tradingDates.length !== 1 ||
      positionsResult.status !== "fulfilled" ||
      ordersResult.status !== "fulfilled"
    ) {
      blockers.push(
        "ZERO_DTE_ACTIVITY_SOURCE_UNAVAILABLE",
        "ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE"
      );
    } else {
      try {
        zeroDteActivityEvidence = (
          deps.buildZeroDteActivityEvidence ?? buildZeroDteActivityEvidence
        )({
          tradingDate: tradingDates[0]!,
          asOf: input.capturedAt,
          positions: rawPositions,
          orders: rawOrders
        });
        blockers.push(...zeroDteActivityEvidence.blockers);
      } catch {
        blockers.push(
          "ZERO_DTE_ACTIVITY_SOURCE_UNAVAILABLE",
          "ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE"
        );
      }
    }
  }
  blockers.push(
    ...sourceIdentityBlockers({
      intents: normalizedIntents.intents,
      resolveSourceCandidate: deps.resolveSourceCandidate ?? defaultSourceCandidate
    })
  );

  if (
    configuration.environment !== "paper" ||
    configuration.tradingMode !== "paper" ||
    configuration.liveTradingEnabled
  ) {
    blockers.push("PAPER_RUNTIME_REQUIRED");
  }

  const structuralState = {
    accountIdentityHash,
    accountStatus: accountState.status,
    accountBlocked: accountState.accountBlocked,
    tradingBlocked: accountState.tradingBlocked,
    positions: positions.map(({ symbol, assetClass: kind, quantity }) => ({
      symbol,
      assetClass: kind,
      quantity
    })),
    openOrders,
    reservations
  };
  const portfolioState = {
    ...structuralState,
    accountState,
    positions
  };

  return {
    version: "paper-submit-state-v1",
    capturedAt: input.capturedAt,
    accountIdentityHash,
    accountState,
    configuration,
    configurationFingerprint: canonicalJsonHash(configuration),
    positions,
    openOrders,
    reservations,
    marketEvidence,
    payloadIntents: normalizedIntents.intents,
    structuralPortfolioFingerprint: canonicalJsonHash(structuralState),
    portfolioFingerprint: canonicalJsonHash(portfolioState),
    marketEvidenceFingerprint: canonicalJsonHash(marketEvidence),
    zeroDteActivityEvidence,
    allocationAttestation: {
      mode: "baseline",
      identity: "baseline-v1",
      allocatorControlled: false
    },
    complete: unique(blockers).length === 0,
    blockers: unique(blockers),
    warnings: unique(warnings)
  };
};

const selectedIntents = (
  state: PaperSubmitStateAttestation,
  sections: ReviewedPayloadSectionName[]
) => {
  const selected = new Set(sections.filter((section) => ENTRY_SECTIONS.has(section)));
  return state.payloadIntents.filter((intent) => selected.has(intent.section));
};

const intentRisk = (
  intent: PaperSubmitIntent,
  state: PaperSubmitStateAttestation
) => {
  if (intent.assetClass === "option") {
    return (
      intent.estimatedPremium ??
      (intent.quantity !== null && intent.limitPrice !== null
        ? intent.quantity * intent.limitPrice * 100
        : null)
    );
  }
  if (intent.notional !== null) return intent.notional;
  const market = state.marketEvidence.find(
    (row) => row.symbol === intent.symbol && row.assetClass === intent.assetClass
  );
  return intent.quantity !== null && market?.referencePrice !== null && market?.referencePrice !== undefined
    ? Math.abs(intent.quantity * market.referencePrice)
    : null;
};

const reservationRisk = (reservation: PaperSubmitReservationState) =>
  reservation.assetClass === "option"
    ? reservation.estimatedPremium ??
      (reservation.quantity !== null && reservation.limitPrice !== null
        ? reservation.quantity * reservation.limitPrice * 100
        : null)
    : reservation.notional;

const openOrderRisk = (
  order: PaperSubmitOrderState,
  state: PaperSubmitStateAttestation
) => {
  if (order.notional !== null) return Math.abs(order.notional);
  if (order.quantity === null) return null;
  const market = state.marketEvidence.find(
    (row) => row.symbol === order.symbol && row.assetClass === order.assetClass
  );
  const unitPrice = order.limitPrice ?? market?.referencePrice ?? null;
  if (unitPrice === null) return null;
  return Math.abs(
    order.quantity * unitPrice * (order.assetClass === "option" ? 100 : 1)
  );
};

const capBlockers = (
  state: PaperSubmitStateAttestation,
  sections: ReviewedPayloadSectionName[]
) => {
  const blockers: string[] = [];
  const intents = selectedIntents(state, sections);
  if (!intents.length) return blockers;
  const { accountState: account, configuration: config } = state;
  const requiredAccountValues = [
    account.cash,
    account.equity,
    account.buyingPower,
    account.optionsBuyingPower
  ];
  if (requiredAccountValues.some((value) => value === null || !Number.isFinite(value))) {
    blockers.push("SUBMIT_CAP_EVIDENCE_INCOMPLETE");
    return blockers;
  }
  if (
    String(account.status ?? "").toUpperCase() !== "ACTIVE" ||
    account.tradingBlocked !== false ||
    account.accountBlocked !== false
  ) {
    blockers.push("SUBMIT_ACCOUNT_UNAVAILABLE");
  }
  if (
    config.environment !== "paper" ||
    config.tradingMode !== "paper" ||
    config.liveTradingEnabled ||
    !config.paperOrderExecutionEnabled
  ) {
    blockers.push("PAPER_RUNTIME_REQUIRED");
  }

  const risks = intents.map((intent) => ({ intent, risk: intentRisk(intent, state) }));
  if (risks.some(({ risk }) => risk === null || !Number.isFinite(risk) || risk <= 0)) {
    blockers.push("SUBMIT_CAP_EVIDENCE_INCOMPLETE");
    return unique(blockers);
  }
  const reservations = state.reservations.map((reservation) => ({
    reservation,
    risk: reservationRisk(reservation)
  }));
  const openBuyOrders = state.openOrders
    .filter((order) => order.side === "buy")
    .map((order) => ({ order, risk: openOrderRisk(order, state) }));
  if (reservations.some(({ risk }) => risk === null || !Number.isFinite(risk) || risk < 0)) {
    blockers.push("SUBMIT_CAP_EVIDENCE_INCOMPLETE");
    return unique(blockers);
  }
  if (openBuyOrders.some(({ risk }) => risk === null || !Number.isFinite(risk) || risk < 0)) {
    blockers.push("SUBMIT_CAP_EVIDENCE_INCOMPLETE");
    return unique(blockers);
  }
  if (
    state.positions.some(
      (position) =>
        position.quantity === null ||
        position.marketValue === null ||
        !Number.isFinite(position.quantity) ||
        !Number.isFinite(position.marketValue)
    )
  ) {
    blockers.push("SUBMIT_CAP_EVIDENCE_INCOMPLETE");
    return unique(blockers);
  }

  const totalRequested = risks.reduce((sum, row) => sum + row.risk!, 0);
  const reservedRisk = reservations.reduce((sum, row) => sum + row.risk!, 0);
  const openOrderRiskTotal = openBuyOrders.reduce((sum, row) => sum + row.risk!, 0);
  if (totalRequested > config.maxTotalPlanNotional) {
    blockers.push("SUBMIT_TOTAL_PLAN_CAP_EXCEEDED");
  }
  if (totalRequested + reservedRisk + openOrderRiskTotal > account.buyingPower!) {
    blockers.push("SUBMIT_BUYING_POWER_EXCEEDED");
  }
  const cashReserve = account.equity! * (config.equityMinCashReservePct / 100);
  if (
    account.cash! - totalRequested - reservedRisk - openOrderRiskTotal <
    cashReserve
  ) {
    blockers.push("SUBMIT_CASH_RESERVE_EXCEEDED");
  }

  const currentEquityDeployment = state.positions
    .filter((position) => position.assetClass === "equity")
    .reduce((sum, position) => sum + Math.abs(position.marketValue!), 0);
  const requestedEquity = risks
    .filter(({ intent }) => intent.assetClass === "equity")
    .reduce((sum, row) => sum + row.risk!, 0);
  const reservedEquity = reservations
    .filter(({ reservation }) => reservation.assetClass === "equity")
    .reduce((sum, row) => sum + row.risk!, 0);
  const openEquityOrders = openBuyOrders
    .filter(({ order }) => order.assetClass === "equity")
    .reduce((sum, row) => sum + row.risk!, 0);
  const maxEquityDeployment =
    account.equity! * (config.equityMaxPortfolioDeployPct / 100);
  if (
    currentEquityDeployment + requestedEquity + reservedEquity + openEquityOrders >
    maxEquityDeployment
  ) {
    blockers.push("SUBMIT_PORTFOLIO_DEPLOYMENT_CAP_EXCEEDED");
  }

  const currentOptionRisk = state.positions
    .filter((position) => position.assetClass === "option")
    .reduce((sum, position) => sum + Math.abs(position.marketValue!), 0);
  const requestedOptionRisk = risks
    .filter(({ intent }) => intent.assetClass === "option")
    .reduce((sum, row) => sum + row.risk!, 0);
  const reservedOptionRisk = reservations
    .filter(({ reservation }) => reservation.assetClass === "option")
    .reduce((sum, row) => sum + row.risk!, 0);
  const openOptionRisk = openBuyOrders
    .filter(({ order }) => order.assetClass === "option")
    .reduce((sum, row) => sum + row.risk!, 0);
  if (
    currentOptionRisk + requestedOptionRisk + reservedOptionRisk + openOptionRisk >
    account.equity! * (config.optionMaxPortfolioRiskPct / 100)
  ) {
    blockers.push("SUBMIT_OPTION_PORTFOLIO_CAP_EXCEEDED");
  }

  const duplicateIntentSymbols = new Set<string>();
  for (const { intent, risk } of risks) {
    if (!intent.sourceCandidateId) {
      blockers.push("REVIEW_ENTRY_SOURCE_IDENTITY_MISSING");
    }
    if (duplicateIntentSymbols.has(intent.symbol)) {
      blockers.push("SUBMIT_DUPLICATE_ORDER_OR_RESERVATION");
    }
    duplicateIntentSymbols.add(intent.symbol);
    if (
      state.openOrders.some(
        (order) => order.symbol === intent.symbol && order.side === "buy"
      ) ||
      state.reservations.some(
        (reservation) =>
          reservation.symbol === intent.symbol && reservation.side === "buy"
      )
    ) {
      blockers.push("SUBMIT_DUPLICATE_ORDER_OR_RESERVATION");
    }

    const currentPositionValue = state.positions
      .filter((position) => position.symbol === intent.symbol)
      .reduce((sum, position) => sum + Math.abs(position.marketValue!), 0);
    const currentQuantity = state.positions
      .filter((position) => position.symbol === intent.symbol)
      .reduce((sum, position) => sum + Math.abs(position.quantity!), 0);
    if (intent.section === "equityBuys" && currentQuantity > 0) {
      blockers.push("SUBMIT_DUPLICATE_EXPOSURE");
    }
    if (intent.section === "equityAdds" && currentQuantity <= 0) {
      blockers.push("SUBMIT_SCALE_IN_POSITION_MISSING");
    }
    if (intent.section === "optionBuys" && currentQuantity > 0) {
      blockers.push("SUBMIT_DUPLICATE_EXPOSURE");
    }

    if (intent.assetClass === "equity") {
      if (
        risk! > config.equityMaxNotionalPerOrder ||
        risk! > config.maxPositionNotional
      ) {
        blockers.push("SUBMIT_ORDER_CAP_EXCEEDED");
      }
      const maxPosition = Math.min(
        config.maxPositionNotional,
        account.equity! * (config.equityMaxPositionPct / 100)
      );
      if (currentPositionValue + risk! > maxPosition) {
        blockers.push("SUBMIT_POSITION_CAP_EXCEEDED");
      }
    } else {
      if (!config.paperOptionsExecutionEnabled) {
        blockers.push("PAPER_OPTIONS_EXECUTION_FLAG_REQUIRED");
      }
      if (
        intent.quantity === null ||
        !Number.isInteger(intent.quantity) ||
        intent.quantity <= 0 ||
        intent.quantity > config.optionMaxContracts
      ) {
        blockers.push("SUBMIT_OPTION_QUANTITY_CAP_EXCEEDED");
      }
      if (
        risk! > config.optionMaxOrderNotional ||
        risk! > account.equity! * (config.optionMaxPositionRiskPct / 100)
      ) {
        blockers.push("SUBMIT_OPTION_PREMIUM_CAP_EXCEEDED");
      }
      if (
        account.optionsApprovalLevel === null ||
        account.optionsApprovalLevel < 1
      ) {
        blockers.push("OPTIONS_APPROVAL_LEVEL_INSUFFICIENT");
      }
      if (risk! > account.optionsBuyingPower!) {
        blockers.push("SUBMIT_BUYING_POWER_EXCEEDED");
      }
    }
  }
  return unique(blockers);
};

const zeroDteCapBlockers = (
  state: PaperSubmitStateAttestation,
  sections: ReviewedPayloadSectionName[]
) => {
  const intents = zeroDteIntents(selectedIntents(state, sections));
  if (!intents.length) return [];
  const blockers: string[] = [];
  const evidence = state.zeroDteActivityEvidence;
  if (
    !evidence?.complete ||
    evidence.dailyTradeCount === null ||
    evidence.dailyPremium === null ||
    evidence.dailyRealizedLoss === null ||
    evidence.openExposureCount === null
  ) {
    return unique([
      ...(evidence?.blockers ?? []),
      "ZERO_DTE_DAILY_COUNTER_EVIDENCE_REQUIRED",
      "ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE"
    ]);
  }
  const risks = intents.map((intent) => intentRisk(intent, state));
  if (risks.some((risk) => risk === null || !Number.isFinite(risk) || risk <= 0)) {
    return ["ZERO_DTE_DAILY_COUNTER_EVIDENCE_REQUIRED"];
  }
  const requestedPremium = risks.reduce<number>(
    (sum, risk) => sum + (risk ?? 0),
    0
  );
  const config = state.configuration;
  const maxTrades = config.zeroDteMaxTradesPerDay ?? 3;
  const maxDailyPremium = config.zeroDteMaxDailyPremium ?? 750;
  const maxDailyRealizedLoss = config.zeroDteMaxDailyRealizedLoss ?? 250;
  const maxOpenPositions = config.zeroDteMaxOpenPositions ?? 3;
  if (evidence.dailyTradeCount + intents.length > maxTrades) {
    blockers.push("DAILY_TRADE_LIMIT");
  }
  if (evidence.dailyPremium + requestedPremium > maxDailyPremium) {
    blockers.push("DAILY_PREMIUM_LIMIT");
  }
  if (evidence.dailyRealizedLoss >= maxDailyRealizedLoss) {
    blockers.push("DAILY_LOSS_LIMIT");
  }
  if (evidence.openExposureCount + intents.length > maxOpenPositions) {
    blockers.push("MAX_OPEN_0DTE_POSITIONS");
  }
  return unique(blockers);
};

export const validatePaperSubmitReservationHeadroom = (input: {
  state: PaperSubmitStateAttestation;
  sections: ReviewedPayloadSectionName[];
  reservations: PaperSubmitReservationState[];
}) => {
  const state = { ...input.state, reservations: input.reservations };
  return unique([
    ...capBlockers(state, input.sections),
    ...zeroDteCapBlockers(state, input.sections)
  ]);
};

const evidenceForIntent = (
  state: PaperSubmitStateAttestation,
  intent: PaperSubmitIntent
) =>
  state.marketEvidence.find(
    (row) => row.symbol === intent.symbol && row.assetClass === intent.assetClass
  );

export const validatePaperSubmitState = (input: {
  reviewed: PaperSubmitStateAttestation;
  current: PaperSubmitStateAttestation;
  sections: ReviewedPayloadSectionName[];
}): PaperSubmitStateValidation => {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const reviewedIntents = selectedIntents(input.reviewed, input.sections);
  const currentIntents = selectedIntents(input.current, input.sections);

  if (!reviewedIntents.length && !currentIntents.length) {
    return {
      valid: true,
      blockers: [],
      warnings: [],
      reviewedPortfolioFingerprint: input.reviewed.portfolioFingerprint,
      currentPortfolioFingerprint: input.current.portfolioFingerprint
    };
  }

  if (!input.reviewed.complete || !input.current.complete) {
    blockers.push("SUBMIT_CAP_EVIDENCE_INCOMPLETE");
  }
  if (
    input.reviewed.accountIdentityHash !== input.current.accountIdentityHash ||
    !input.current.accountIdentityHash
  ) {
    blockers.push("SUBMIT_ACCOUNT_STATE_DRIFT");
  }
  if (
    input.reviewed.configurationFingerprint !==
    input.current.configurationFingerprint
  ) {
    blockers.push("SUBMIT_CONFIGURATION_DRIFT");
  }
  if (
    input.reviewed.allocationAttestation.identity !== "baseline-v1" ||
    input.current.allocationAttestation.identity !== "baseline-v1" ||
    input.reviewed.allocationAttestation.identity !==
      input.current.allocationAttestation.identity ||
    input.reviewed.allocationAttestation.allocatorControlled ||
    input.current.allocationAttestation.allocatorControlled
  ) {
    blockers.push("SUBMIT_ALLOCATION_IDENTITY_DRIFT");
  }
  if (
    canonicalJsonHash(reviewedIntents) !== canonicalJsonHash(currentIntents)
  ) {
    blockers.push("SUBMIT_ORDER_INTENT_DRIFT");
  }
  if (
    input.reviewed.structuralPortfolioFingerprint !==
    input.current.structuralPortfolioFingerprint
  ) {
    blockers.push("SUBMIT_PORTFOLIO_STATE_DRIFT");
  }
  if (
    input.reviewed.portfolioFingerprint !== input.current.portfolioFingerprint
  ) {
    warnings.push("SUBMIT_PORTFOLIO_MARK_CHANGED");
  }
  const reviewedZeroDteIntents = zeroDteIntents(reviewedIntents);
  if (reviewedZeroDteIntents.length) {
    const reviewedActivityFingerprint = zeroDteActivityStateFingerprint(
      input.reviewed.zeroDteActivityEvidence
    );
    const currentActivityFingerprint = zeroDteActivityStateFingerprint(
      input.current.zeroDteActivityEvidence
    );
    if (!reviewedActivityFingerprint || !currentActivityFingerprint) {
      blockers.push(
        "ZERO_DTE_DAILY_COUNTER_EVIDENCE_REQUIRED",
        "ZERO_DTE_ACTIVITY_EVIDENCE_INCOMPLETE"
      );
    } else if (reviewedActivityFingerprint !== currentActivityFingerprint) {
      blockers.push("ZERO_DTE_ACTIVITY_EVIDENCE_CHANGED");
    }
  }

  blockers.push(
    ...marketEvidenceBlockers({
      intents: currentIntents,
      marketEvidence: input.current.marketEvidence,
      capturedAt: input.current.capturedAt,
      quoteMaxAgeSeconds: input.current.configuration.quoteMaxAgeSeconds
    })
  );
  for (const reviewedIntent of reviewedIntents) {
    const currentIntent = currentIntents.find(
      (intent) =>
        intent.section === reviewedIntent.section &&
        intent.payloadIndex === reviewedIntent.payloadIndex
    );
    if (!currentIntent) continue;
    const reviewedEvidence = evidenceForIntent(input.reviewed, reviewedIntent);
    const currentEvidence = evidenceForIntent(input.current, currentIntent);
    const reviewedPrice = reviewedEvidence?.referencePrice;
    const currentPrice = currentEvidence?.referencePrice;
    if (
      reviewedPrice === null ||
      reviewedPrice === undefined ||
      currentPrice === null ||
      currentPrice === undefined ||
      reviewedPrice <= 0
    ) {
      blockers.push("SUBMIT_MARKET_EVIDENCE_UNAVAILABLE");
      continue;
    }
    const driftPct = (Math.abs(currentPrice - reviewedPrice) / reviewedPrice) * 100;
    if (driftPct > input.current.configuration.maxPriceDriftPct) {
      blockers.push("SUBMIT_PRICE_DRIFT");
    }
  }

  blockers.push(...capBlockers(input.current, input.sections));
  blockers.push(...zeroDteCapBlockers(input.current, input.sections));
  blockers.push(...input.current.blockers);
  const finalBlockers = unique(blockers);
  if (finalBlockers.length) finalBlockers.push("FRESH_REVIEW_REQUIRED");

  return {
    valid: finalBlockers.length === 0,
    blockers: unique(finalBlockers),
    warnings: unique([...warnings, ...input.current.warnings]),
    reviewedPortfolioFingerprint: input.reviewed.portfolioFingerprint,
    currentPortfolioFingerprint: input.current.portfolioFingerprint
  };
};
