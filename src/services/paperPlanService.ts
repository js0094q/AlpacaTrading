import { queryOne, queryAll } from "../lib/db.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import { listAlpacaOpenOrders } from "./alpacaOrderReadService.js";
import { listAlpacaPositions } from "./alpacaPositionService.js";
import {
  checkAlpacaSymbolTradability,
  type AlpacaAssetTradabilityResult
} from "./alpacaAssetService.js";
import { getTradingSafetyState, type TradingSafetyState } from "./tradingSafetyService.js";
import { normalizeSymbol } from "../lib/utils.js";
import type { PreferredExpression, RiskProfile } from "../types.js";

export type PaperPlanDecision = "planned" | "watch" | "skip";

type PaperPlanFormat = "table" | "json";

export interface PaperPlanConfig {
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  maxCandidates: number;
  maxNewPositions: number;
  maxPositionNotional: number;
  maxTotalPlanNotional: number;
  minBuyingPowerReservePct: number;
  equityNotionalPerOrder: number;
  equityMaxNotionalPerOrder: number;
  equityMaxPortfolioDeployPct: number;
  equityMaxPositionPct: number;
  equityMinCashReservePct: number;
  format: PaperPlanFormat;
}

export interface PaperPlanAccountSnapshot {
  status: string;
  equity: number | null;
  cash: number | null;
  buyingPower: number | null;
  reservedBuyingPower: number | null;
  deployableBuyingPower: number | null;
}

export interface PaperPlanSummary {
  candidatesEvaluated: number;
  plannedOrders: number;
  watched: number;
  skipped: number;
  estimatedTotalNotional: number;
  remainingDeployableBuyingPower: number | null;
}

export interface PaperPlanSizingBasis {
  basis: "account_relative" | "fallback";
  targetNotional: number;
  configuredNotionalPerOrder: number;
  configuredMaxNotionalPerOrder: number;
  accountEquity: number | null;
  accountCash: number | null;
  maxPositionNotional: number | null;
  maxPortfolioDeployNotional: number | null;
  currentDeployedNotional: number | null;
  deployableRemaining: number | null;
  cashReserveRequired: number | null;
  cashAfterOrder: number | null;
  usedFallback: boolean;
}

export interface PaperPlanCandidate {
  symbol: string;
  side: "buy" | "sell";
  assetClass: "us_equity" | "option" | "unknown";
  orderType: "market" | "limit";
  timeInForce: "day";
  underlyingSymbol?: string | null;
  optionSymbol?: string | null;
  strategy?: PreferredExpression | null;
  limitPrice?: number | null;
  estimatedPremium?: number | null;
  maxRisk?: number | null;
  expirationDate?: string | null;
  strike?: number | null;
  shortStrike?: number | null;
  contracts?: number | null;
  bidAskSpreadPct?: number | null;
  latestRank: number | null;
  recommendation: string | null;
  estimatedPrice: number | null;
  estimatedQty: number | null;
  estimatedNotional: number | null;
  sizingBasis?: PaperPlanSizingBasis | null;
  decision: PaperPlanDecision;
  reasonCodes: PaperPlanReasonCode[];
  explanation: string;
}

export interface PaperPlanSource {
  snapshotRunId?: string | null;
  recommendationTimestamp?: string | null;
  runtimeTimestamp?: string | null;
}

export type PaperPlanEmptyReason =
  | "NO_RESEARCH_SNAPSHOTS"
  | "NO_MATCHING_SNAPSHOTS_FOR_FILTERS"
  | "NO_RUNTIME_CANDIDATES"
  | "ALL_CANDIDATES_SKIPPED"
  | "NO_CANDIDATES_EVALUATED";

export interface PaperPlanDiagnostics {
  latestSnapshotAvailable: boolean;
  latestSnapshotRunId: string | null;
  latestSnapshotTimestamp: string | null;
  filtersMatchedSnapshots: boolean;
  runtimeCandidatesAvailable: boolean;
  emptyReason: PaperPlanEmptyReason | null;
}

export interface PaperPlanReport {
  paperOnly: true;
  environment: TradingSafetyState["alpacaEnv"];
  generatedAt: string;
  dryRun: true;
  nonMutating: true;
  config: Omit<PaperPlanConfig, "format">;
  account: PaperPlanAccountSnapshot;
  summary: PaperPlanSummary;
  plan: PaperPlanCandidate[];
  source: PaperPlanSource;
  diagnostics: PaperPlanDiagnostics;
}

interface PaperPlanInput {
  riskProfile?: RiskProfile;
  optionsEnabled?: boolean;
  maxCandidates?: number;
  maxNewPositions?: number;
  maxPositionNotional?: number;
  maxTotalPlanNotional?: number;
  minBuyingPowerReservePct?: number;
  format?: PaperPlanFormat;
}

interface ResearchRunRow {
  id: string;
  started_at: string;
  risk_profile: RiskProfile;
  options_enabled: number;
}

interface CandidateRow {
  id: string;
  symbol: string;
  rank: number;
  direction: string;
  preferred_expression: string;
  as_of: string;
  estimated_max_loss: number | null;
  estimated_max_profit: number | null;
  option_symbol: string | null;
  strike: number | null;
  short_strike: number | null;
}

interface OptionContractPlanRow {
  option_symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  expiration_date: string;
  strike: number;
  multiplier: number;
  tradable: number;
}

interface OptionSnapshotPlanRow {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  timestamp: string;
}

const DEFAULTS = {
  riskProfile: "moderate" as RiskProfile,
  optionsEnabled: false,
  maxCandidates: 5,
  maxNewPositions: 3,
  maxPositionNotional: 5000,
  maxTotalPlanNotional: 50000,
  minBuyingPowerReservePct: 20,
  equityNotionalPerOrder: 1000,
  equityMaxNotionalPerOrder: 5000,
  equityMaxPortfolioDeployPct: 50,
  equityMaxPositionPct: 10,
  equityMinCashReservePct: 20
};

type PaperPlanReasonCode =
  | "TRADABLE"
  | "NOT_TRADABLE"
  | "ALREADY_HELD"
  | "OPEN_ORDER_EXISTS"
  | "BUYING_POWER_OK"
  | "BUYING_POWER_INSUFFICIENT"
  | "BUYING_POWER_UNKNOWN"
  | "WITHIN_POSITION_CAP"
  | "MAX_NEW_POSITIONS_REACHED"
  | "MAX_POSITION_NOTIONAL_EXCEEDED"
  | "MAX_TOTAL_PLAN_NOTIONAL_EXCEEDED"
  | "PRICE_UNKNOWN"
  | "QTY_ESTIMATED"
  | "RISK_PROFILE_ALLOWED"
  | "AGGRESSIVE_MODE_NOT_ENABLED"
  | "PAPER_ENV_CONFIRMED"
  | "LIVE_TRADING_DISABLED"
  | "PLAN_ONLY_NO_MUTATION"
  | "OPTIONS_PLANNING_NOT_IMPLEMENTED"
  | "OPTION_CONTRACT_FOUND"
  | "OPTION_CONTRACT_NOT_FOUND"
  | "OPTION_CONTRACT_NOT_TRADABLE"
  | "OPTION_LIMIT_PRICE_REQUIRED"
  | "OPTION_RISK_LIMIT_OK"
  | "OPTION_RISK_LIMIT_EXCEEDED"
  | "OPTION_LIMIT_PRICE_UNAVAILABLE"
  | "OPTION_SPREAD_TOO_WIDE"
  | "OPTION_WIDE_SPREAD_WARNING"
  | "SPECULATIVE_OPTION_PAPER_WARNING"
  | "OPTION_0DTE_ALLOWED"
  | "OPTION_DTE_ALLOWED"
  | "OPTION_MARKET_ORDER_BLOCKED"
  | "UNSUPPORTED_OPTION_STRATEGY"
  | "OPTION_COLLATERAL_CONFIRMED"
  | "OPTION_COLLATERAL_INSUFFICIENT"
  | "DUPLICATE_EXPOSURE";

const REASON_ORDER = [
  "TRADABLE",
  "NOT_TRADABLE",
  "ALREADY_HELD",
  "OPEN_ORDER_EXISTS",
  "BUYING_POWER_OK",
  "BUYING_POWER_INSUFFICIENT",
  "BUYING_POWER_UNKNOWN",
  "WITHIN_POSITION_CAP",
  "MAX_NEW_POSITIONS_REACHED",
  "MAX_POSITION_NOTIONAL_EXCEEDED",
  "MAX_TOTAL_PLAN_NOTIONAL_EXCEEDED",
  "PRICE_UNKNOWN",
  "QTY_ESTIMATED",
  "RISK_PROFILE_ALLOWED",
  "AGGRESSIVE_MODE_NOT_ENABLED",
  "PAPER_ENV_CONFIRMED",
  "LIVE_TRADING_DISABLED",
  "PLAN_ONLY_NO_MUTATION",
  "OPTIONS_PLANNING_NOT_IMPLEMENTED",
  "OPTION_CONTRACT_FOUND",
  "OPTION_CONTRACT_NOT_FOUND",
  "OPTION_CONTRACT_NOT_TRADABLE",
  "OPTION_LIMIT_PRICE_REQUIRED",
  "OPTION_RISK_LIMIT_OK",
  "OPTION_RISK_LIMIT_EXCEEDED",
  "OPTION_LIMIT_PRICE_UNAVAILABLE",
  "OPTION_SPREAD_TOO_WIDE",
  "OPTION_WIDE_SPREAD_WARNING",
  "SPECULATIVE_OPTION_PAPER_WARNING",
  "OPTION_0DTE_ALLOWED",
  "OPTION_DTE_ALLOWED",
  "OPTION_MARKET_ORDER_BLOCKED",
  "UNSUPPORTED_OPTION_STRATEGY",
  "OPTION_COLLATERAL_CONFIRMED",
  "OPTION_COLLATERAL_INSUFFICIENT",
  "DUPLICATE_EXPOSURE"
] as const satisfies PaperPlanReasonCode[];

const toPositiveNumber = (value: unknown, fallback: number): number => {
  const raw = typeof value === "string" ? Number.parseFloat(value) : value;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
};

const normalizeRiskProfile = (input?: RiskProfile): RiskProfile =>
  input === "aggressive" || input === "moderate" || input === "conservative"
    ? input
    : DEFAULTS.riskProfile;

const normalizePercent = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : null;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, parsed));
};

const pickEnvValue = (...names: string[]) => {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
};

const pickEnvInt = (fallback: number, ...names: string[]) =>
  toPositiveNumber(pickEnvValue(...names), fallback);

const pickEnvNumber = (fallback: number, ...names: string[]) => {
  const value = pickEnvValue(...names);
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toConfig = (input: PaperPlanInput): Required<PaperPlanConfig> => {
  const maxCandidates = toPositiveNumber(
    input.maxCandidates,
    pickEnvInt(DEFAULTS.maxCandidates, "PAPER_PLAN_MAX_CANDIDATES")
  );
  const maxNewPositions = toPositiveNumber(
    input.maxNewPositions,
    pickEnvInt(DEFAULTS.maxNewPositions, "PAPER_PLAN_MAX_NEW_POSITIONS")
  );
  const equityMaxNotionalPerOrder = pickEnvNumber(
    DEFAULTS.equityMaxNotionalPerOrder,
    "PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER",
    "PAPER_PLAN_MAX_POSITION_NOTIONAL"
  );
  const maxPositionNotional = toPositiveNumber(
    input.maxPositionNotional,
    equityMaxNotionalPerOrder
  );
  const maxTotalPlanNotional = toPositiveNumber(
    input.maxTotalPlanNotional,
    pickEnvInt(
      DEFAULTS.maxTotalPlanNotional,
      "PAPER_PLAN_MAX_TOTAL_PLAN_NOTIONAL"
    )
  );
  const equityMinCashReservePct = normalizePercent(
    input.minBuyingPowerReservePct ??
      pickEnvValue(
        "PAPER_EQUITY_MIN_CASH_RESERVE_PCT",
        "PAPER_PLAN_MIN_BUYING_POWER_RESERVE_PCT"
      ),
    DEFAULTS.equityMinCashReservePct
  );

  return {
    riskProfile: normalizeRiskProfile(input.riskProfile),
    optionsEnabled: input.optionsEnabled ?? DEFAULTS.optionsEnabled,
    maxCandidates,
    maxNewPositions,
    maxPositionNotional,
    maxTotalPlanNotional,
    minBuyingPowerReservePct: equityMinCashReservePct,
    equityNotionalPerOrder: pickEnvNumber(
      DEFAULTS.equityNotionalPerOrder,
      "PAPER_EQUITY_NOTIONAL_PER_ORDER"
    ),
    equityMaxNotionalPerOrder,
    equityMaxPortfolioDeployPct: normalizePercent(
      pickEnvValue("PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT"),
      DEFAULTS.equityMaxPortfolioDeployPct
    ),
    equityMaxPositionPct: normalizePercent(
      pickEnvValue("PAPER_EQUITY_MAX_POSITION_PCT"),
      DEFAULTS.equityMaxPositionPct
    ),
    equityMinCashReservePct,
    format: input.format || "table"
  };
};

const now = () => new Date().toISOString();

const buildReasonList = (reasonCodes: PaperPlanReasonCode[]) => {
  const rank = new Map(REASON_ORDER.map((code, index) => [code, index]));
  const unique = [...new Set(reasonCodes)];
  unique.sort((left, right) => (rank.get(left) ?? 999) - (rank.get(right) ?? 999));
  return unique;
};

const explanationFor = (decision: PaperPlanDecision, reasons: string[]) => {
  if (decision === "planned") {
    return `Planned: ${reasons.join(", ")}`;
  }
  if (decision === "watch") {
    return `Watch: ${reasons.join(", ")}`;
  }
  return `Skipped: ${reasons.join(", ")}`;
};

const pickLatestResearchRun = (riskProfile: RiskProfile, optionsEnabled: boolean): ResearchRunRow | null => {
  return queryOne<ResearchRunRow>(
    `
    SELECT id, started_at, risk_profile, options_enabled
    FROM research_runs
    WHERE status = 'completed'
      AND risk_profile = ?
      AND options_enabled = ?
    ORDER BY started_at DESC
    LIMIT 1
    `,
    [riskProfile, optionsEnabled ? 1 : 0]
  );
};

const pickLatestCompletedResearchRun = (): ResearchRunRow | null =>
  queryOne<ResearchRunRow>(
    `
    SELECT id, started_at, risk_profile, options_enabled
    FROM research_runs
    WHERE status = 'completed'
    ORDER BY started_at DESC
    LIMIT 1
    `
  );

const pickCandidates = (runId: string, maxCandidates: number): CandidateRow[] =>
  queryAll<CandidateRow>(
    `
    SELECT
      id,
      symbol,
      rank,
      direction,
      preferred_expression,
      as_of,
      estimated_max_loss,
      estimated_max_profit,
      option_symbol,
      strike,
      short_strike
    FROM paper_trade_candidates
    WHERE research_run_id = ?
    ORDER BY rank ASC
    LIMIT ?
    `,
    [runId, maxCandidates]
  );

const latestTimestamp = (candidates: CandidateRow[]) => {
  let latest: string | null = null;
  for (const candidate of candidates) {
    if (candidate.as_of && (!latest || candidate.as_of > latest)) {
      latest = candidate.as_of;
    }
  }
  return latest;
};

const buildPlanDiagnostics = (input: {
  latestAnyRun: ResearchRunRow | null;
  latestRun: ResearchRunRow | null;
  candidates: CandidateRow[];
  plan: PaperPlanCandidate[];
}): PaperPlanDiagnostics => {
  let emptyReason: PaperPlanEmptyReason | null = null;

  if (input.plan.length === 0) {
    if (!input.latestAnyRun) {
      emptyReason = "NO_RESEARCH_SNAPSHOTS";
    } else if (!input.latestRun) {
      emptyReason = "NO_MATCHING_SNAPSHOTS_FOR_FILTERS";
    } else if (!input.candidates.length) {
      emptyReason = "NO_RUNTIME_CANDIDATES";
    } else {
      emptyReason = "NO_CANDIDATES_EVALUATED";
    }
  } else if (input.plan.every((entry) => entry.decision === "skip")) {
    emptyReason = "ALL_CANDIDATES_SKIPPED";
  }

  return {
    latestSnapshotAvailable: Boolean(input.latestAnyRun),
    latestSnapshotRunId: input.latestAnyRun?.id ?? null,
    latestSnapshotTimestamp: input.latestAnyRun?.started_at ?? null,
    filtersMatchedSnapshots: Boolean(input.latestRun),
    runtimeCandidatesAvailable: input.candidates.length > 0,
    emptyReason
  };
};

const parseAccount = (account: unknown): PaperPlanAccountSnapshot => {
  const row = account as Record<string, unknown>;
  const parsed = {
    status: String(row.status || "unknown"),
    equity: toNullableNumber(row.equity),
    cash: toNullableNumber(row.cash),
    buyingPower: toNullableNumber(row.buyingPower),
    reservedBuyingPower: null as number | null,
    deployableBuyingPower: null as number | null
  };

  return parsed;
};

const withReserve = (
  account: ReturnType<typeof parseAccount>,
  reservePct: number
) => {
  if (account.buyingPower === null) {
    return {
      ...account,
      reservedBuyingPower: null,
      deployableBuyingPower: null
    };
  }
  const reserveFraction = reservePct / 100;
  const reservedBuyingPower = Number((account.buyingPower * reserveFraction).toFixed(2));
  const deployableBuyingPower = Number(
    Math.max(0, account.buyingPower - reservedBuyingPower).toFixed(2)
  );
  return {
    ...account,
    reservedBuyingPower,
    deployableBuyingPower
  };
};

const findLatestPrice = (symbol: string, asOf?: string): number | null => {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) {
    return null;
  }

  const row = queryOne<{ close: number }>(
    `
    SELECT close
    FROM market_bars
    WHERE symbol = ? AND timeframe = '1Day'
      AND (? IS NULL OR timestamp <= ?)
    ORDER BY timestamp DESC
    LIMIT 1
    `,
    [normalizedSymbol, asOf || null, asOf || null]
  );
  return row ? toNullableNumber(row.close) : null;
};

const parseBooleanEnv = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value === "true" || value === "1";
};

const parseNumberEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseIntegerEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const paperOptionsConfig = () => ({
  maxPremiumPerOrder: parseNumberEnv("PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER", 1000),
  maxContracts: Math.max(1, parseIntegerEnv("PAPER_OPTIONS_MAX_CONTRACTS", 5)),
  minDte: parseIntegerEnv("PAPER_OPTIONS_MIN_DTE", 0),
  maxDte: Math.max(1, parseIntegerEnv("PAPER_OPTIONS_MAX_DTE", 90)),
  allow0Dte: parseBooleanEnv("PAPER_OPTIONS_ALLOW_0DTE", true),
  allowMarketOrders: parseBooleanEnv("PAPER_OPTIONS_ALLOW_MARKET_ORDERS", false),
  limitPriceBasis: process.env.PAPER_OPTIONS_LIMIT_PRICE_BASIS || "mid",
  maxSpreadPct: parseNumberEnv("PAPER_OPTIONS_MAX_SPREAD_PCT", 50),
  maxPortfolioRiskPct: parseNumberEnv("PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT", 20),
  maxPositionRiskPct: parseNumberEnv("PAPER_OPTIONS_MAX_POSITION_RISK_PCT", 5),
  allowLongCalls: parseBooleanEnv("PAPER_OPTIONS_ALLOW_LONG_CALLS", true),
  allowLongPuts: parseBooleanEnv("PAPER_OPTIONS_ALLOW_LONG_PUTS", true),
  allowCashSecuredPuts: parseBooleanEnv("PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS", true),
  allowCoveredCalls: parseBooleanEnv("PAPER_OPTIONS_ALLOW_COVERED_CALLS", true),
  allowNakedOptions: parseBooleanEnv("PAPER_OPTIONS_ALLOW_NAKED_OPTIONS", false)
});

const findOptionContract = (optionSymbol: string | null | undefined): OptionContractPlanRow | null => {
  if (!optionSymbol) {
    return null;
  }
  return queryOne<OptionContractPlanRow>(
    `
    SELECT
      option_symbol,
      underlying_symbol,
      type,
      expiration_date,
      strike,
      multiplier,
      tradable
    FROM option_contracts
    WHERE option_symbol = ?
    LIMIT 1
    `,
    [optionSymbol]
  );
};

const findLatestOptionSnapshot = (
  optionSymbol: string,
  asOf?: string
): OptionSnapshotPlanRow | null =>
  queryOne<OptionSnapshotPlanRow>(
    `
    SELECT bid, ask, midpoint, last, timestamp
    FROM option_snapshots
    WHERE option_symbol = ?
      AND (? IS NULL OR timestamp <= ?)
    ORDER BY timestamp DESC
    LIMIT 1
    `,
    [optionSymbol, asOf || null, asOf || null]
  );

const daysToExpiration = (expirationDate: string): number | null => {
  if (expirationDate === new Date().toISOString().slice(0, 10)) {
    return 0;
  }
  const parsed = new Date(`${expirationDate}T23:59:59.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const diff = parsed.getTime() - Date.now();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
};

const spreadPctFor = (bid: number | null, ask: number | null): number | null => {
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) {
    return null;
  }
  const mid = (bid + ask) / 2;
  return mid > 0 ? Number((((ask - bid) / mid) * 100).toFixed(2)) : null;
};

const roundMoney = (value: number): number => Number(value.toFixed(2));

const pickLimitPrice = (
  snapshot: OptionSnapshotPlanRow,
  side: "buy" | "sell",
  basis: string
): number | null => {
  const bid = toNullableNumber(snapshot.bid);
  const ask = toNullableNumber(snapshot.ask);
  const midpoint = toNullableNumber(snapshot.midpoint);
  const last = toNullableNumber(snapshot.last);
  if (basis === "bid" && bid !== null && bid > 0) {
    return roundMoney(bid);
  }
  if (basis === "ask" && ask !== null && ask > 0) {
    return roundMoney(ask);
  }
  if (midpoint !== null && midpoint > 0) {
    return roundMoney(midpoint);
  }
  if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    return roundMoney((bid + ask) / 2);
  }
  if (side === "buy" && ask !== null && ask > 0) {
    return roundMoney(ask);
  }
  if (side === "sell" && bid !== null && bid > 0) {
    return roundMoney(bid);
  }
  return last !== null && last > 0 ? roundMoney(last) : null;
};

const isSupportedSingleLegOptionStrategy = (
  value: string
): value is "long_call" | "long_put" | "cash_secured_put" | "covered_call" =>
  value === "long_call" ||
  value === "long_put" ||
  value === "cash_secured_put" ||
  value === "covered_call";

const optionStrategyEnabled = (
  strategy: string,
  options: ReturnType<typeof paperOptionsConfig>
): boolean => {
  if (strategy === "long_call") {
    return options.allowLongCalls;
  }
  if (strategy === "long_put") {
    return options.allowLongPuts;
  }
  if (strategy === "cash_secured_put") {
    return options.allowCashSecuredPuts;
  }
  if (strategy === "covered_call") {
    return options.allowCoveredCalls;
  }
  return false;
};

const optionPriceUnavailableReasons = (base: PaperPlanReasonCode[]) =>
  buildReasonList([...base, "OPTION_CONTRACT_FOUND", "OPTION_LIMIT_PRICE_UNAVAILABLE"]);

const accountRelativeCap = (
  accountEquity: number | null,
  pct: number
): number | null =>
  accountEquity !== null && accountEquity > 0
    ? roundMoney((accountEquity * pct) / 100)
    : null;

const positiveFloor = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const assertPlanGuards = (riskProfile: RiskProfile): void => {
  const state = getTradingSafetyState();

  if (state.alpacaEnv !== "paper") {
    throw new Error("paper:plan requires ALPACA_ENV=paper.");
  }

  if (state.liveTradingEnabled) {
    throw new Error("paper:plan requires LIVE_TRADING_ENABLED=false.");
  }

  if (riskProfile === "aggressive" && process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES !== "true") {
    throw new Error("AGGRESSIVE mode requires ENABLE_AGGRESSIVE_PAPER_STRATEGIES=true.");
  }
};

const formatQty = (value: number | null): string =>
  value === null ? "-" : value.toFixed(4);

const formatNotional = (value: number | null): string =>
  value === null ? "-" : value.toFixed(2);

interface CandidateEvaluationContext {
  candidate: CandidateRow;
  tradability: AlpacaAssetTradabilityResult;
  estimatedPrice: number | null;
  isHeld: boolean;
  heldQty: number;
  openOrderExists: boolean;
  duplicateExposure: boolean;
  config: Required<PaperPlanConfig>;
  deployableBuyingPower: number | null;
  accountEquity: number | null;
  accountCash: number | null;
  currentDeployedNotional: number;
  plannedCount: number;
  plannedNotional: number;
}

const buildEquitySizing = (input: {
  config: Required<PaperPlanConfig>;
  accountEquity: number | null;
  accountCash: number | null;
  deployableBuyingPower: number | null;
  currentDeployedNotional: number;
  plannedNotional: number;
}): PaperPlanSizingBasis => {
  const {
    config,
    accountEquity,
    accountCash,
    deployableBuyingPower,
    currentDeployedNotional,
    plannedNotional
  } = input;
  const configuredFallback = Math.min(
    config.equityNotionalPerOrder,
    config.equityMaxNotionalPerOrder,
    config.maxPositionNotional
  );
  const accountUsable = accountEquity !== null && accountEquity > 0;
  const maxPositionNotional = accountUsable
    ? roundMoney((accountEquity * config.equityMaxPositionPct) / 100)
    : null;
  const maxPortfolioDeployNotional = accountUsable
    ? roundMoney((accountEquity * config.equityMaxPortfolioDeployPct) / 100)
    : null;
  const deployedIncludingPlan = accountUsable
    ? roundMoney(currentDeployedNotional + plannedNotional)
    : null;
  const deployableRemaining =
    accountUsable && maxPortfolioDeployNotional !== null && deployedIncludingPlan !== null
      ? roundMoney(Math.max(0, maxPortfolioDeployNotional - deployedIncludingPlan))
      : null;
  const cashReserveRequired = accountUsable
    ? roundMoney((accountEquity * config.equityMinCashReservePct) / 100)
    : null;
  const cashAvailableAfterReserve =
    accountCash !== null && cashReserveRequired !== null
      ? Math.max(0, accountCash - cashReserveRequired)
      : null;
  const remainingPlanCap = Math.max(0, config.maxTotalPlanNotional - plannedNotional);

  let target = configuredFallback;
  target = Math.min(target, remainingPlanCap);
  if (maxPositionNotional !== null) {
    target = Math.min(target, maxPositionNotional);
  }
  if (deployableRemaining !== null) {
    target = Math.min(target, deployableRemaining);
  }
  if (deployableBuyingPower !== null) {
    target = Math.min(target, Math.max(0, deployableBuyingPower));
  }
  if (cashAvailableAfterReserve !== null) {
    target = Math.min(target, cashAvailableAfterReserve);
  }

  target = roundMoney(Math.max(0, target));

  return {
    basis: accountUsable ? "account_relative" : "fallback",
    targetNotional: target,
    configuredNotionalPerOrder: config.equityNotionalPerOrder,
    configuredMaxNotionalPerOrder: config.equityMaxNotionalPerOrder,
    accountEquity,
    accountCash,
    maxPositionNotional,
    maxPortfolioDeployNotional,
    currentDeployedNotional: accountUsable ? roundMoney(currentDeployedNotional) : null,
    deployableRemaining,
    cashReserveRequired,
    cashAfterOrder: accountCash === null ? null : roundMoney(accountCash - target),
    usedFallback: !accountUsable
  };
};

const evaluateCandidate = (input: CandidateEvaluationContext): PaperPlanCandidate => {
  const {
    candidate,
    tradability,
    estimatedPrice,
  isHeld,
  heldQty,
    openOrderExists,
    duplicateExposure,
    config,
    deployableBuyingPower,
    accountEquity,
    accountCash,
    currentDeployedNotional,
    plannedCount,
    plannedNotional
  } = input;

  const symbol = normalizeSymbol(candidate.symbol);
  const recommendation = `${candidate.direction} ${candidate.preferred_expression}`;
  const base: PaperPlanCandidate = {
    symbol,
    side: "buy",
    assetClass: "unknown",
    orderType: "market",
    timeInForce: "day",
    latestRank: candidate.rank,
    recommendation,
    estimatedPrice: null,
    estimatedQty: null,
    estimatedNotional: null,
    decision: "skip",
    reasonCodes: [
      "PAPER_ENV_CONFIRMED",
      "LIVE_TRADING_DISABLED",
      "PLAN_ONLY_NO_MUTATION",
      "RISK_PROFILE_ALLOWED"
    ],
    explanation: ""
  };

  if (!symbol) {
    return {
      ...base,
      decision: "skip",
      reasonCodes: buildReasonList([...(base.reasonCodes), "PRICE_UNKNOWN"]),
      explanation: explanationFor("skip", ["PRICE_UNKNOWN"])
    };
  }

  if (!tradability.tradable) {
    return {
      ...base,
      decision: "skip",
      reasonCodes: buildReasonList([...(base.reasonCodes), "NOT_TRADABLE"]),
      explanation: explanationFor("skip", ["NOT_TRADABLE"])
    };
  }

  base.assetClass = (tradability.asset?.class || "unknown") as PaperPlanCandidate["assetClass"];

  if (candidate.preferred_expression !== "shares") {
    const strategy = candidate.preferred_expression;
    const options = paperOptionsConfig();

    if (!config.optionsEnabled) {
      return {
        ...base,
        decision: "watch",
        assetClass: "option",
        strategy: strategy as PreferredExpression,
        reasonCodes: buildReasonList([...(base.reasonCodes), "OPTIONS_PLANNING_NOT_IMPLEMENTED"]),
        explanation: explanationFor("watch", ["OPTIONS_PLANNING_NOT_IMPLEMENTED"])
      };
    }

    if (!isSupportedSingleLegOptionStrategy(strategy)) {
      return {
        ...base,
        decision: "watch",
        assetClass: "option",
        strategy: strategy as PreferredExpression,
        reasonCodes: buildReasonList([...(base.reasonCodes), "UNSUPPORTED_OPTION_STRATEGY"]),
        explanation: explanationFor("watch", ["UNSUPPORTED_OPTION_STRATEGY"])
      };
    }

    if (!optionStrategyEnabled(strategy, options)) {
      return {
        ...base,
        decision: "watch",
        assetClass: "option",
        strategy: strategy as PreferredExpression,
        reasonCodes: buildReasonList([...(base.reasonCodes), "UNSUPPORTED_OPTION_STRATEGY"]),
        explanation: explanationFor("watch", ["UNSUPPORTED_OPTION_STRATEGY"])
      };
    }

    const contract = findOptionContract(candidate.option_symbol);
    if (!contract) {
      return {
        ...base,
        decision: "watch",
        assetClass: "option",
        strategy,
        reasonCodes: buildReasonList([...(base.reasonCodes), "OPTION_CONTRACT_NOT_FOUND"]),
        explanation: explanationFor("watch", ["OPTION_CONTRACT_NOT_FOUND"])
      };
    }

    const expectedType =
      strategy === "long_call" || strategy === "covered_call" ? "call" : "put";
    const dte = daysToExpiration(contract.expiration_date);
    const dteAllowed =
      dte !== null &&
      dte >= options.minDte &&
      dte <= options.maxDte &&
      (options.allow0Dte || dte > 0);
    if (!contract.tradable || contract.type !== expectedType || !dteAllowed) {
      return {
        ...base,
        decision: "watch",
        assetClass: "option",
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_CONTRACT_NOT_TRADABLE"
        ]),
        explanation: explanationFor("watch", ["OPTION_CONTRACT_NOT_TRADABLE"])
      };
    }

    const side = strategy === "long_call" || strategy === "long_put" ? "buy" : "sell";
    if (!options.allowMarketOrders) {
      base.orderType = "limit";
    }
    const snapshot = findLatestOptionSnapshot(contract.option_symbol, candidate.as_of || undefined);
    if (!snapshot) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_LIMIT_PRICE_UNAVAILABLE"
        ]),
        explanation: explanationFor("watch", ["OPTION_LIMIT_PRICE_UNAVAILABLE"])
      };
    }

    const spreadPct = spreadPctFor(snapshot.bid, snapshot.ask);
    const limitPrice = pickLimitPrice(snapshot, side, options.limitPriceBasis);
    if (limitPrice === null) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        bidAskSpreadPct: spreadPct,
        reasonCodes: optionPriceUnavailableReasons(base.reasonCodes),
        explanation: explanationFor("watch", ["OPTION_LIMIT_PRICE_UNAVAILABLE"])
      };
    }

    const multiplier = contract.multiplier || 100;
    const perContractPremium = roundMoney(limitPrice * multiplier);
    const perContractMaxRisk =
      strategy === "cash_secured_put"
        ? roundMoney(contract.strike * multiplier)
        : perContractPremium;
    const maxPositionRisk = accountRelativeCap(accountEquity, options.maxPositionRiskPct);
    const maxPortfolioRisk = accountRelativeCap(accountEquity, options.maxPortfolioRiskPct);
    const remainingPortfolioRisk =
      maxPortfolioRisk === null ? null : roundMoney(Math.max(0, maxPortfolioRisk - plannedNotional));
    const contractsByPremium = positiveFloor(options.maxPremiumPerOrder / perContractPremium);
    const contractsByPositionRisk =
      maxPositionRisk === null
        ? options.maxContracts
        : positiveFloor(maxPositionRisk / perContractMaxRisk);
    const contractsByPortfolioRisk =
      remainingPortfolioRisk === null
        ? options.maxContracts
        : positiveFloor(remainingPortfolioRisk / perContractMaxRisk);
    const contractsByBuyingPower =
      deployableBuyingPower === null
        ? options.maxContracts
        : positiveFloor(deployableBuyingPower / perContractMaxRisk);
    const contracts = Math.min(
      options.maxContracts,
      contractsByPremium,
      contractsByPositionRisk,
      contractsByPortfolioRisk,
      contractsByBuyingPower
    );
    const premiumRisk = roundMoney(limitPrice * multiplier * contracts);
    const collateralRisk =
      strategy === "cash_secured_put"
        ? roundMoney(contract.strike * multiplier * contracts)
        : 0;
    const maxRisk = strategy === "cash_secured_put" ? collateralRisk : premiumRisk;
    const candidateMaxLoss = toNullableNumber(candidate.estimated_max_loss);
    const configuredRisk =
      candidateMaxLoss !== null && candidateMaxLoss > 0 && strategy !== "covered_call"
        ? Math.max(maxRisk, candidateMaxLoss)
        : maxRisk;

    const accountRiskExceeded =
      (maxPositionRisk !== null && configuredRisk > maxPositionRisk) ||
      (remainingPortfolioRisk !== null && configuredRisk > remainingPortfolioRisk);

    if (contracts <= 0 || premiumRisk > options.maxPremiumPerOrder || accountRiskExceeded) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        limitPrice,
        estimatedPremium: premiumRisk,
        maxRisk: configuredRisk,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        contracts,
        bidAskSpreadPct: spreadPct,
        estimatedNotional: configuredRisk,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_DTE_ALLOWED",
          "OPTION_RISK_LIMIT_EXCEEDED"
        ]),
        explanation: explanationFor("watch", ["OPTION_RISK_LIMIT_EXCEEDED"])
      };
    }

    if (spreadPct !== null && spreadPct > options.maxSpreadPct) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        limitPrice,
        estimatedPremium: premiumRisk,
        maxRisk: configuredRisk,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        contracts,
        bidAskSpreadPct: spreadPct,
        estimatedNotional: configuredRisk,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_DTE_ALLOWED",
          "OPTION_SPREAD_TOO_WIDE"
        ]),
        explanation: explanationFor("watch", ["OPTION_SPREAD_TOO_WIDE"])
      };
    }

    if (strategy === "covered_call" && heldQty < multiplier * contracts) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        limitPrice,
        estimatedPremium: premiumRisk,
        maxRisk: configuredRisk,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        contracts,
        bidAskSpreadPct: spreadPct,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_COLLATERAL_INSUFFICIENT",
          "UNSUPPORTED_OPTION_STRATEGY"
        ]),
        explanation: explanationFor("watch", ["UNSUPPORTED_OPTION_STRATEGY"])
      };
    }

    if (
      strategy === "cash_secured_put" &&
      (deployableBuyingPower === null || deployableBuyingPower < configuredRisk)
    ) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        limitPrice,
        estimatedPremium: premiumRisk,
        maxRisk: configuredRisk,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        contracts,
        bidAskSpreadPct: spreadPct,
        estimatedNotional: configuredRisk,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_COLLATERAL_INSUFFICIENT",
          "OPTION_RISK_LIMIT_EXCEEDED"
        ]),
        explanation: explanationFor("watch", ["OPTION_RISK_LIMIT_EXCEEDED"])
      };
    }

    return {
      ...base,
      side,
      assetClass: "option",
      orderType: "limit",
      underlyingSymbol: contract.underlying_symbol,
      optionSymbol: contract.option_symbol,
      strategy,
      limitPrice,
      estimatedPremium: premiumRisk,
      maxRisk: configuredRisk,
      expirationDate: contract.expiration_date,
      strike: contract.strike,
      shortStrike: candidate.short_strike,
      contracts,
      bidAskSpreadPct: spreadPct,
      estimatedPrice: limitPrice,
      estimatedQty: contracts,
      estimatedNotional: configuredRisk,
      decision: "planned",
      reasonCodes: buildReasonList([
        ...base.reasonCodes,
        "OPTION_CONTRACT_FOUND",
        "OPTION_DTE_ALLOWED",
        ...(dte === 0 ? (["OPTION_0DTE_ALLOWED"] as PaperPlanReasonCode[]) : []),
        ...(spreadPct !== null && spreadPct > 20
          ? (["OPTION_WIDE_SPREAD_WARNING"] as PaperPlanReasonCode[])
          : []),
        ...(strategy === "long_call" || strategy === "long_put"
          ? (["SPECULATIVE_OPTION_PAPER_WARNING"] as PaperPlanReasonCode[])
          : []),
        "OPTION_RISK_LIMIT_OK",
        "OPTION_COLLATERAL_CONFIRMED",
        "TRADABLE",
        "BUYING_POWER_OK",
        "WITHIN_POSITION_CAP",
        "QTY_ESTIMATED"
      ]),
      explanation: explanationFor("planned", [
        "OPTION_CONTRACT_FOUND",
        "OPTION_RISK_LIMIT_OK",
        "OPTION_COLLATERAL_CONFIRMED",
        "QTY_ESTIMATED"
      ])
    };
  }

  if (isHeld) {
    return {
      ...base,
      decision: "watch",
      reasonCodes: buildReasonList([...(base.reasonCodes), "ALREADY_HELD"]),
      explanation: explanationFor("watch", ["ALREADY_HELD"])
    };
  }

  if (openOrderExists) {
    return {
      ...base,
      decision: "skip",
      reasonCodes: buildReasonList([...(base.reasonCodes), "OPEN_ORDER_EXISTS"]),
      explanation: explanationFor("skip", ["OPEN_ORDER_EXISTS"])
    };
  }

  if (duplicateExposure) {
    return {
      ...base,
      decision: "skip",
      reasonCodes: buildReasonList([...(base.reasonCodes), "DUPLICATE_EXPOSURE"]),
      explanation: explanationFor("skip", ["DUPLICATE_EXPOSURE"])
    };
  }

  const remainingSlots = Math.max(0, config.maxNewPositions - plannedCount);
  if (remainingSlots <= 0) {
    return {
      ...base,
      decision: "skip",
      reasonCodes: buildReasonList([...(base.reasonCodes), "MAX_NEW_POSITIONS_REACHED"]),
      explanation: explanationFor("skip", ["MAX_NEW_POSITIONS_REACHED"])
    };
  }

  const sizingBasis = buildEquitySizing({
    config,
    accountEquity,
    accountCash,
    deployableBuyingPower,
    currentDeployedNotional,
    plannedNotional
  });

  if (sizingBasis.targetNotional <= 0) {
    const reason =
      plannedNotional >= config.maxTotalPlanNotional
        ? "MAX_TOTAL_PLAN_NOTIONAL_EXCEEDED"
        : "BUYING_POWER_INSUFFICIENT";
    return {
      ...base,
      decision: "skip",
      sizingBasis,
      reasonCodes: buildReasonList([...(base.reasonCodes), reason]),
      explanation: explanationFor("skip", [reason])
    };
  }

  if (estimatedPrice === null || estimatedPrice <= 0) {
    return {
      ...base,
      decision: "watch",
      sizingBasis,
      reasonCodes: buildReasonList([...(base.reasonCodes), "PRICE_UNKNOWN"]),
      explanation: explanationFor("watch", ["PRICE_UNKNOWN"])
    };
  }

  let estimatedQty = sizingBasis.targetNotional / estimatedPrice;

  const hasFractionalSupport = tradability.asset?.fractionable !== false;
  if (!hasFractionalSupport) {
    estimatedQty = Math.floor(estimatedQty);
  }

  if (!Number.isFinite(estimatedQty) || estimatedQty <= 0) {
    return {
      ...base,
      decision: "watch",
      sizingBasis,
      reasonCodes: buildReasonList([...(base.reasonCodes), "PRICE_UNKNOWN"]),
      explanation: explanationFor("watch", ["PRICE_UNKNOWN"])
    };
  }

  const estimatedNotional = Number((estimatedQty * estimatedPrice).toFixed(2));

  return {
    ...base,
    estimatedPrice,
    estimatedQty,
    estimatedNotional,
    sizingBasis: {
      ...sizingBasis,
      targetNotional: estimatedNotional,
      cashAfterOrder:
        sizingBasis.accountCash === null
          ? null
          : roundMoney(sizingBasis.accountCash - estimatedNotional)
    },
    decision: "planned",
    reasonCodes: buildReasonList([
      ...base.reasonCodes,
      "TRADABLE",
      "BUYING_POWER_OK",
      "WITHIN_POSITION_CAP",
      "QTY_ESTIMATED"
    ]),
    explanation: explanationFor("planned", ["TRADABLE", "BUYING_POWER_OK", "WITHIN_POSITION_CAP", "QTY_ESTIMATED"])
  };
};

export const buildPaperPlanReport = async (
  input: PaperPlanInput = {}
): Promise<PaperPlanReport> => {
  const config = toConfig(input);
  assertPlanGuards(config.riskProfile);

  const generatedAt = now();
  const state = getTradingSafetyState();

  const rawAccount = parseAccount(await getAlpacaAccountSnapshot());
  const account = withReserve(rawAccount, config.minBuyingPowerReservePct);

  const [ordersResult, positionsResult] = await Promise.all([
    listAlpacaOpenOrders(),
    listAlpacaPositions()
  ]);

  const heldSymbols = new Set<string>();
  const heldQuantities = new Map<string, number>();
  let currentDeployedNotional = 0;
  for (const row of positionsResult.positions || []) {
    const symbol = normalizeSymbol(row.symbol);
    const qty = toNullableNumber(row.qty);
    const marketValue = toNullableNumber(row.marketValue);
    const size = qty ?? 0;
    if (symbol && size !== 0) {
      heldSymbols.add(symbol);
      heldQuantities.set(symbol, (heldQuantities.get(symbol) ?? 0) + size);
    }
    if (marketValue !== null) {
      currentDeployedNotional += Math.abs(marketValue);
    }
  }

  const openOrderSymbols = new Set<string>(
    (ordersResult.orders || [])
      .map((row) => normalizeSymbol(row.symbol))
      .filter(Boolean)
  );

  const latestAnyRun = pickLatestCompletedResearchRun();
  const latestRun = pickLatestResearchRun(config.riskProfile, config.optionsEnabled);
  const candidates = latestRun
    ? pickCandidates(latestRun.id, config.maxCandidates)
    : [];

  const source: PaperPlanSource = {
    snapshotRunId: latestRun?.id ?? null,
    recommendationTimestamp: latestTimestamp(candidates),
    runtimeTimestamp: generatedAt
  };

  const tradabilityCache = new Map<string, Promise<AlpacaAssetTradabilityResult>>();
  const plan: PaperPlanCandidate[] = [];
  const seenSymbols = new Set<string>();
  let plannedNotional = 0;
  let plannedCount = 0;

  for (const candidate of candidates) {
    const symbol = normalizeSymbol(candidate.symbol);
    let tradabilityPromise = tradabilityCache.get(symbol);
    if (!tradabilityPromise) {
      tradabilityPromise = checkAlpacaSymbolTradability(symbol);
      tradabilityCache.set(symbol, tradabilityPromise);
    }

    const candidatePlan = evaluateCandidate({
      candidate,
      tradability: await tradabilityPromise,
      estimatedPrice: findLatestPrice(symbol, candidate.as_of || undefined),
      isHeld: heldSymbols.has(symbol),
      heldQty: heldQuantities.get(symbol) ?? 0,
      openOrderExists: openOrderSymbols.has(symbol),
      duplicateExposure: seenSymbols.has(symbol),
      config,
      deployableBuyingPower: account.deployableBuyingPower,
      accountEquity: account.equity,
      accountCash: account.cash,
      currentDeployedNotional,
      plannedCount,
      plannedNotional
    });

    plan.push(candidatePlan);
    seenSymbols.add(symbol);

    if (candidatePlan.decision === "planned") {
      plannedCount += 1;
      plannedNotional += candidatePlan.estimatedNotional ?? 0;
    }
  }

  const remainingDeployableBuyingPower = account.deployableBuyingPower === null
    ? null
    : Number(Math.max(0, account.deployableBuyingPower - plannedNotional).toFixed(2));
  const diagnostics = buildPlanDiagnostics({
    latestAnyRun,
    latestRun,
    candidates,
    plan
  });

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    generatedAt,
    dryRun: true,
    nonMutating: true,
    config: {
      riskProfile: config.riskProfile,
      optionsEnabled: config.optionsEnabled,
      maxCandidates: config.maxCandidates,
      maxNewPositions: config.maxNewPositions,
      maxPositionNotional: config.maxPositionNotional,
      maxTotalPlanNotional: config.maxTotalPlanNotional,
      minBuyingPowerReservePct: config.minBuyingPowerReservePct,
      equityNotionalPerOrder: config.equityNotionalPerOrder,
      equityMaxNotionalPerOrder: config.equityMaxNotionalPerOrder,
      equityMaxPortfolioDeployPct: config.equityMaxPortfolioDeployPct,
      equityMaxPositionPct: config.equityMaxPositionPct,
      equityMinCashReservePct: config.equityMinCashReservePct
    },
    account,
    summary: {
      candidatesEvaluated: plan.length,
      plannedOrders: plan.filter((entry) => entry.decision === "planned").length,
      watched: plan.filter((entry) => entry.decision === "watch").length,
      skipped: plan.filter((entry) => entry.decision === "skip").length,
      estimatedTotalNotional: Number(plannedNotional.toFixed(2)),
      remainingDeployableBuyingPower
    },
    plan,
    source,
    diagnostics
  };
};

const pad = (value: string, width: number, alignRight = false) =>
  alignRight ? value.padStart(width, " ") : value.padEnd(width, " ");

const stateText = (paperOnly: boolean) => (paperOnly ? "true" : "false");

export const formatPaperPlanReportAsTable = (report: PaperPlanReport) => {
  const lines: string[] = [];
  lines.push("Paper Plan (dry-run)");
  lines.push(`Environment: ${report.environment}`);
  lines.push(`Paper Only: ${stateText(report.paperOnly)}`);
  lines.push(`Dry-run only: ${stateText(report.nonMutating)}`);

  if (!report.plan.length) {
    lines.push("No candidates were evaluated.");
    if (report.diagnostics.emptyReason) {
      lines.push(`Empty reason: ${report.diagnostics.emptyReason}.`);
    }
    lines.push(
      `Latest snapshot: ${report.diagnostics.latestSnapshotRunId || "none"}; filters matched: ${stateText(report.diagnostics.filtersMatchedSnapshots)}.`
    );
    lines.push("Dry-run only. No orders were submitted.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(
    [
      pad("Rank", 6, true),
      pad("Symbol", 10),
      pad("Decision", 8),
      pad("Est Qty", 12, true),
      pad("Est Notional", 14, true),
      "Reason"
    ].join(" ")
  );

  report.plan.forEach((entry) => {
    const reason = entry.reasonCodes.join(", ");
    lines.push([
      pad(String(entry.latestRank ?? ""), 6, true),
      pad(entry.symbol, 10),
      pad(entry.decision, 8),
      pad(formatQty(entry.estimatedQty), 12, true),
      pad(formatNotional(entry.estimatedNotional), 14, true),
      reason
    ].join(" "));
  });

  lines.push("");
  lines.push(
    `Summary: candidates=${report.summary.candidatesEvaluated}, planned=${report.summary.plannedOrders}, watch=${report.summary.watched}, skip=${report.summary.skipped}, estimatedNotional=${formatNotional(report.summary.estimatedTotalNotional)}`
  );
  if (report.diagnostics.emptyReason) {
    lines.push(`Plan diagnostic: ${report.diagnostics.emptyReason}.`);
  }
  lines.push(`Deployable buying power remaining: ${formatNotional(report.summary.remainingDeployableBuyingPower)}.`);
  lines.push("Dry-run only. No orders were submitted.");
  return lines.join("\n");
};

export const normalizePaperPlanCandidate = (candidate: PaperPlanCandidate) => ({
  ...candidate,
  reasonCodes: buildReasonList(candidate.reasonCodes),
  explanation:
    candidate.explanation || explanationFor(candidate.decision, candidate.reasonCodes)
});
