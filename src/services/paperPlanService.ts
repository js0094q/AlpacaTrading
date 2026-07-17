import { queryOne, queryAll } from "../lib/db.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import { listAlpacaOpenOrders } from "./alpacaOrderReadService.js";
import { listAlpacaPositions } from "./alpacaPositionService.js";
import {
  checkAlpacaSymbolTradability,
  type AlpacaAssetTradabilityResult
} from "./alpacaAssetService.js";
import { getTradingSafetyState, type TradingSafetyState } from "./tradingSafetyService.js";
import {
  normalizeOptionQuote,
  optionsQuoteConfig,
  roundOptionLimitPrice,
  type NormalizedOptionQuote,
  type OptionExecutablePriceSource,
  type OptionQuoteStatus
} from "./optionQuoteNormalizer.js";
import { normalizeSymbol } from "../lib/utils.js";
import {
  getCandidateAssetIdentity,
  getOrderAssetIdentity,
  getPositionAssetIdentity
} from "./assetIdentity.js";
import {
  ingestOptionContracts,
  ingestOptionSnapshotsForSymbols
} from "./optionsService.js";
import {
  insertPaperLearningRecord,
  type LiveLikeFillModel,
  type PaperFillModel,
  type PaperStrategyFamily,
  type QuoteSnapshotModel,
  type RiskModel
} from "./paperLearningLedgerService.js";
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
  zeroDteSpyCandidates?: number;
  zeroDteSpyEligible?: number;
  zeroDteSpySkipped?: number;
  leapsCandidates?: number;
  leapsEligible?: number;
  leapsSkipped?: number;
  zeroDteSpyDiscoveryCandidates?: number;
  zeroDteSpyDiscoveryEligible?: number;
  zeroDteSpyDiscoverySkipped?: number;
  leapsDiscoveryCandidates?: number;
  leapsDiscoveryEligible?: number;
  leapsDiscoverySkipped?: number;
  learningRecordsWritten?: number;
  learningRecordsPending?: number;
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
  sourceCandidateId?: string | null;
  sourceResearchRunId?: string | null;
  strategyFamily?: PaperStrategyFamily | null;
  strategy?: PreferredExpression | null;
  hypothesis?: string | null;
  signalInputs?: Record<string, unknown> | null;
  optionMetadata?: Record<string, unknown> | null;
  quoteSnapshot?: QuoteSnapshotModel | null;
  paperFillModel?: PaperFillModel | null;
  liveLikeFillModel?: LiveLikeFillModel | null;
  riskModel?: RiskModel | null;
  learningRecordId?: string | null;
  learningRecordWriteStatus?: "written" | "disabled" | "failed" | null;
  learningRecordError?: string | null;
  limitPrice?: number | null;
  estimatedPremium?: number | null;
  maxRisk?: number | null;
  expirationDate?: string | null;
  strike?: number | null;
  shortStrike?: number | null;
  contracts?: number | null;
  bidAskSpreadPct?: number | null;
  quoteStatus?: OptionQuoteStatus | null;
  executable?: boolean;
  executablePrice?: number | null;
  executablePriceSource?: OptionExecutablePriceSource | null;
  rejectionReason?: string | null;
  quoteTimestamp?: string | null;
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
  discoveryTopBlockers?: string[];
  zeroDteSpyDiscovery?: PaperPlanDiscoveryDiagnostics;
  leapsDiscovery?: PaperPlanDiscoveryDiagnostics;
}

export interface PaperPlanDiscoveryDiagnostics {
  enabled: boolean;
  underlyings: string[];
  contractsFound: number;
  candidatesSelected: number;
  selectedOptionSymbols: string[];
  warnings: string[];
  hardBlockers: string[];
  cacheRefresh?: PaperPlanDiscoveryCacheRefresh;
}

export interface PaperPlanDiscoveryCacheRefresh {
  providerUsed: boolean;
  refreshed: boolean;
  reason: string;
  localContractsBefore: number;
  missingUnderlyings?: string[];
  rowsIngested?: number;
  error?: string | null;
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

export interface PaperPlanInput {
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
  discovery_warnings?: string[];
  discovery_selection_rank?: number | null;
  discovery_selection_reason?: string | null;
  discovery_selection_group?: string | null;
}

interface OptionContractPlanRow {
  option_symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  expiration_date: string;
  strike: number;
  multiplier: number;
  tradable: number;
  delta?: number | null;
}

interface OptionSnapshotPlanRow {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  timestamp: string;
  quote_status: string | null;
  executable: number | null;
  executable_price: number | null;
  executable_price_source: string | null;
  rejection_reason: string | null;
  quote_timestamp: string | null;
}

interface TargetSignalRow {
  symbol: string;
  as_of: string;
  direction: "long" | "short" | "neutral";
  confidence: number | null;
  expected_return: number | null;
}

interface DiscoveryBuildResult {
  candidates: CandidateRow[];
  diagnostics: PaperPlanDiscoveryDiagnostics;
}

interface DiscoveryRefreshResult {
  providerUsed: boolean;
  refreshed: boolean;
  reason: string;
  localContractsBefore: number;
  missingUnderlyings?: string[];
  rowsIngested?: number;
  error?: string | null;
}

interface DiscoveryRefreshState {
  zeroDteSpy?: DiscoveryRefreshResult;
  leaps?: DiscoveryRefreshResult;
}

const DEFAULTS = {
  riskProfile: "moderate" as RiskProfile,
  optionsEnabled: false,
  maxCandidates: 5,
  maxNewPositions: 3,
  maxPositionNotional: 5000,
  maxTotalPlanNotional: 30_000,
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
  | "ALREADY_HELD_EQUITY"
  | "ALREADY_HELD_OPTION_CONTRACT"
  | "OPEN_ORDER_EXISTS"
  | "DUPLICATE_OPEN_EQUITY_ORDER"
  | "DUPLICATE_OPEN_OPTION_ORDER"
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
  | "OPTION_0DTE_NOT_ENABLED"
  | "ZERO_DTE_SPY_DISABLED"
  | "LEAPS_DISABLED"
  | "NOT_ZERO_DTE"
  | "DTE_OUT_OF_RANGE"
  | "QUOTE_NULL"
  | "QUOTE_STALE"
  | "QUOTE_CROSSED"
  | "SPREAD_TOO_WIDE"
  | "PREMIUM_ABOVE_LIMIT"
  | "MAX_CONTRACTS_EXCEEDED"
  | "MAX_DAILY_ZERO_DTE_TRADES_REACHED"
  | "PAPER_ONLY_GUARD_FAILED"
  | "LEARNING_LEDGER_WRITE_FAILED"
  | "SPECULATIVE_OPTION_PAPER_WARNING"
  | "WEAK_SIGNAL"
  | "FALLBACK_LIMIT_PRICE_USED"
  | "ALTERNATE_CONTRACT_NOT_SELECTED"
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
  "ALREADY_HELD_EQUITY",
  "ALREADY_HELD_OPTION_CONTRACT",
  "OPEN_ORDER_EXISTS",
  "DUPLICATE_OPEN_EQUITY_ORDER",
  "DUPLICATE_OPEN_OPTION_ORDER",
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
  "OPTION_0DTE_NOT_ENABLED",
  "ZERO_DTE_SPY_DISABLED",
  "LEAPS_DISABLED",
  "NOT_ZERO_DTE",
  "DTE_OUT_OF_RANGE",
  "QUOTE_NULL",
  "QUOTE_STALE",
  "QUOTE_CROSSED",
  "SPREAD_TOO_WIDE",
  "PREMIUM_ABOVE_LIMIT",
  "MAX_CONTRACTS_EXCEEDED",
  "MAX_DAILY_ZERO_DTE_TRADES_REACHED",
  "PAPER_ONLY_GUARD_FAILED",
  "LEARNING_LEDGER_WRITE_FAILED",
  "SPECULATIVE_OPTION_PAPER_WARNING",
  "WEAK_SIGNAL",
  "FALLBACK_LIMIT_PRICE_USED",
  "ALTERNATE_CONTRACT_NOT_SELECTED",
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

export const loadPaperPlanConfig = (
  input: PaperPlanInput = {}
): Required<PaperPlanConfig> => {
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
    WHERE research_run_id = ? AND decision = 'selected'
    ORDER BY rank ASC
    LIMIT ?
    `,
    [runId, maxCandidates]
  );

const latestTargetSignal = (symbol: string): TargetSignalRow | null =>
  queryOne<TargetSignalRow>(
    `
    SELECT symbol, as_of, direction, confidence, expected_return
    FROM target_snapshots
    WHERE symbol = ?
    ORDER BY as_of DESC
    LIMIT 1
    `,
    [symbol]
  );

const optionContractsForUnderlyings = (underlyings: string[]): OptionContractPlanRow[] => {
  if (!underlyings.length) {
    return [];
  }
  return queryAll<OptionContractPlanRow>(
    `
    SELECT
      option_symbol,
      underlying_symbol,
      type,
      expiration_date,
      strike,
      multiplier,
      tradable,
      (
        SELECT s.delta
        FROM option_snapshots AS s
        WHERE s.option_symbol = option_contracts.option_symbol
        ORDER BY s.timestamp DESC
        LIMIT 1
      ) AS delta
    FROM option_contracts
    WHERE underlying_symbol IN (${underlyings.map(() => "?").join(",")})
    ORDER BY underlying_symbol ASC, expiration_date ASC, type ASC, strike ASC
    `,
    underlyings
  );
};

const discoverySourceFromCandidateId = (candidateId: string): string | null => {
  if (candidateId.startsWith("discovery:zero_dte_spy:")) {
    return "explicit_zero_dte_spy";
  }
  if (candidateId.startsWith("discovery:leaps:")) {
    return "explicit_leaps";
  }
  return null;
};

const signalDirectionFor = (symbol: string): TargetSignalRow => {
  const signal = latestTargetSignal(symbol);
  return signal ?? {
    symbol,
    as_of: now(),
    direction: "long",
    confidence: null,
    expected_return: null
  };
};

const strategyForContract = (contract: OptionContractPlanRow): "long_call" | "long_put" =>
  contract.type === "put" ? "long_put" : "long_call";

const discoveryWarningsForSignal = (signal: TargetSignalRow): string[] => {
  const warnings: string[] = [];
  if (signal.confidence === null) {
    warnings.push("missing_signal_confidence");
  } else if (signal.confidence < 0.5) {
    warnings.push("weak_signal_confidence");
  }
  if (signal.direction === "neutral") {
    warnings.push("neutral_signal_direction");
  }
  return warnings;
};

const discoveryCandidate = (input: {
  family: "zero_dte_spy" | "leaps";
  contract: OptionContractPlanRow;
  signal: TargetSignalRow;
  rank: number;
  selectionRank: number;
  selectionReason: string;
  selectionGroup: string;
  warnings?: string[];
}): CandidateRow => ({
  id: `discovery:${input.family}:${input.contract.option_symbol}`,
  symbol: input.contract.underlying_symbol,
  rank: input.rank,
  direction: input.contract.type === "put" ? "short" : "long",
  preferred_expression: strategyForContract(input.contract),
  as_of: input.signal.as_of,
  estimated_max_loss: null,
  estimated_max_profit: null,
  option_symbol: input.contract.option_symbol,
  strike: input.contract.strike,
  short_strike: null,
  discovery_warnings: input.warnings ?? [],
  discovery_selection_rank: input.selectionRank,
  discovery_selection_reason: input.selectionReason,
  discovery_selection_group: input.selectionGroup
});

const rankContractByMoneyness = (
  left: OptionContractPlanRow,
  right: OptionContractPlanRow,
  referencePrice: number | null,
  preferItm = false
) => {
  if (referencePrice !== null && referencePrice > 0) {
    if (preferItm) {
      const leftItmPenalty = left.type === "call"
        ? left.strike <= referencePrice ? 0 : 1
        : left.strike >= referencePrice ? 0 : 1;
      const rightItmPenalty = right.type === "call"
        ? right.strike <= referencePrice ? 0 : 1
        : right.strike >= referencePrice ? 0 : 1;
      if (leftItmPenalty !== rightItmPenalty) {
        return leftItmPenalty - rightItmPenalty;
      }
    }
    const leftDistance = Math.abs(left.strike - referencePrice);
    const rightDistance = Math.abs(right.strike - referencePrice);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
  }
  if (left.expiration_date !== right.expiration_date) {
    return left.expiration_date.localeCompare(right.expiration_date);
  }
  return left.strike - right.strike;
};

const ZERO_DTE_DISCOVERY_ALTERNATIVES_PER_SIDE = 40;
const LEAPS_DISCOVERY_DELTA_ALTERNATIVES_PER_UNDERLYING = 12;
const LEAPS_DISCOVERY_CHEAPER_STRIKES_PER_UNDERLYING = 60;

const uniqueContractsBySymbol = (contracts: OptionContractPlanRow[]): OptionContractPlanRow[] => {
  const seen = new Set<string>();
  const unique: OptionContractPlanRow[] = [];
  for (const contract of contracts) {
    if (seen.has(contract.option_symbol)) {
      continue;
    }
    seen.add(contract.option_symbol);
    unique.push(contract);
  }
  return unique;
};

const rankContractsForUnderlying = (input: {
  contracts: OptionContractPlanRow[];
  underlying: string;
  type: "call" | "put";
  referencePrice: number | null;
  preferItm?: boolean;
  preferDeltaRange?: {
    min: number;
    max: number;
    target: number;
  };
}): OptionContractPlanRow[] => {
  return input.contracts
    .filter((contract) =>
      contract.underlying_symbol === input.underlying &&
      contract.type === input.type &&
      contract.tradable === 1
    )
    .sort((left, right) => {
      if (input.preferDeltaRange) {
        const deltaRank = (contract: OptionContractPlanRow) => {
          const delta = typeof contract.delta === "number" ? Math.abs(contract.delta) : null;
          if (delta === null) {
            return { band: 2, distance: Number.MAX_SAFE_INTEGER };
          }
          const inBand = delta >= input.preferDeltaRange!.min && delta <= input.preferDeltaRange!.max;
          return {
            band: inBand ? 0 : 1,
            distance: Math.abs(delta - input.preferDeltaRange!.target)
          };
        };
        const leftDelta = deltaRank(left);
        const rightDelta = deltaRank(right);
        if (leftDelta.band !== rightDelta.band) {
          return leftDelta.band - rightDelta.band;
        }
        if (leftDelta.distance !== rightDelta.distance) {
          return leftDelta.distance - rightDelta.distance;
        }
      }
      return rankContractByMoneyness(left, right, input.referencePrice, input.preferItm ?? false);
    });
};

const selectContractForUnderlying = (
  input: Parameters<typeof rankContractsForUnderlying>[0]
): OptionContractPlanRow | null => {
  const candidates = rankContractsForUnderlying(input);
  return candidates[0] ?? null;
};

const zeroDteAlternativesForUnderlying = (
  input: Parameters<typeof rankContractsForUnderlying>[0]
): OptionContractPlanRow[] => {
  const ranked = rankContractsForUnderlying(input);
  if (input.referencePrice === null || input.referencePrice <= 0) {
    return ranked.slice(0, ZERO_DTE_DISCOVERY_ALTERNATIVES_PER_SIDE);
  }
  const otmRanked = [...ranked].sort((left, right) => {
    const leftOtm = input.type === "call"
      ? left.strike >= input.referencePrice!
      : left.strike <= input.referencePrice!;
    const rightOtm = input.type === "call"
      ? right.strike >= input.referencePrice!
      : right.strike <= input.referencePrice!;
    if (leftOtm !== rightOtm) {
      return leftOtm ? -1 : 1;
    }
    const leftDistance = Math.abs(left.strike - input.referencePrice!);
    const rightDistance = Math.abs(right.strike - input.referencePrice!);
    return leftDistance - rightDistance || rankContractByMoneyness(left, right, input.referencePrice, false);
  });
  return uniqueContractsBySymbol([...ranked.slice(0, 8), ...otmRanked]).slice(
    0,
    ZERO_DTE_DISCOVERY_ALTERNATIVES_PER_SIDE
  );
};

const leapsAlternativesForUnderlying = (
  input: Parameters<typeof rankContractsForUnderlying>[0]
): OptionContractPlanRow[] => {
  const ranked = rankContractsForUnderlying(input);
  const cheaperStrikeLadder = [...ranked].sort((left, right) => {
    if (input.referencePrice !== null && input.referencePrice > 0) {
      const leftOtm = left.strike >= input.referencePrice;
      const rightOtm = right.strike >= input.referencePrice;
      if (leftOtm !== rightOtm) {
        return leftOtm ? -1 : 1;
      }
      if (leftOtm && rightOtm) {
        const leftDistance = Math.abs(left.strike - input.referencePrice);
        const rightDistance = Math.abs(right.strike - input.referencePrice);
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }
        if (left.strike !== right.strike) {
          return left.strike - right.strike;
        }
      }
    }
    return rankContractByMoneyness(left, right, input.referencePrice, false);
  });
  const cheaperByStrike: OptionContractPlanRow[] = [];
  const seenStrikes = new Set<number>();
  for (const contract of cheaperStrikeLadder) {
    if (seenStrikes.has(contract.strike)) {
      continue;
    }
    seenStrikes.add(contract.strike);
    cheaperByStrike.push(contract);
  }
  return uniqueContractsBySymbol([
    ...ranked.slice(0, LEAPS_DISCOVERY_DELTA_ALTERNATIVES_PER_UNDERLYING),
    ...cheaperByStrike.slice(0, LEAPS_DISCOVERY_CHEAPER_STRIKES_PER_UNDERLYING)
  ]);
};

const emptyDiscoveryDiagnostics = (
  enabled: boolean,
  underlyings: string[]
): PaperPlanDiscoveryDiagnostics => ({
  enabled,
  underlyings,
  contractsFound: 0,
  candidatesSelected: 0,
  selectedOptionSymbols: [],
  warnings: [],
  hardBlockers: []
});

const dateOnlyFromDays = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Math.floor(days));
  return date.toISOString().slice(0, 10);
};

const latestCompletedOptionContractRun = (): { completed_at: string | null } | null =>
  queryOne<{ completed_at: string | null }>(
    `
    SELECT completed_at
    FROM ingestion_runs
    WHERE run_type = 'options_contracts'
      AND status = 'completed'
      AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
    `
  );

const optionContractCacheMaxAgeMs = () =>
  Math.max(60_000, parseIntegerEnv("OPTION_CONTRACT_CACHE_MAX_AGE_MS", 6 * 60 * 60 * 1000));

const optionContractCacheIsStale = (contractCount: number) => {
  if (contractCount === 0) {
    return true;
  }
  const latest = latestCompletedOptionContractRun();
  if (!latest?.completed_at) {
    return false;
  }
  const completedAt = Date.parse(latest.completed_at);
  if (!Number.isFinite(completedAt)) {
    return true;
  }
  return Date.now() - completedAt > optionContractCacheMaxAgeMs();
};

const optionContractCacheCount = (input: {
  underlyings: string[];
  expirationDate?: string;
  expirationDateGte?: string;
  expirationDateLte?: string;
}) => {
  if (!input.underlyings.length) {
    return 0;
  }
  const clauses = [
    `underlying_symbol IN (${input.underlyings.map(() => "?").join(",")})`
  ];
  const params: Array<string | number> = [...input.underlyings];
  if (input.expirationDate) {
    clauses.push("expiration_date = ?");
    params.push(input.expirationDate);
  }
  if (input.expirationDateGte) {
    clauses.push("expiration_date >= ?");
    params.push(input.expirationDateGte);
  }
  if (input.expirationDateLte) {
    clauses.push("expiration_date <= ?");
    params.push(input.expirationDateLte);
  }

  const row = queryOne<{ contracts: number }>(
    `
    SELECT COUNT(*) AS contracts
    FROM option_contracts
    WHERE ${clauses.join(" AND ")}
    `,
    params
  );
  return row?.contracts ?? 0;
};

const optionContractCacheCountsByUnderlying = (input: {
  underlyings: string[];
  expirationDate?: string;
  expirationDateGte?: string;
  expirationDateLte?: string;
}) => {
  if (!input.underlyings.length) {
    return new Map<string, number>();
  }
  const clauses = [
    `underlying_symbol IN (${input.underlyings.map(() => "?").join(",")})`
  ];
  const params: Array<string | number> = [...input.underlyings];
  if (input.expirationDate) {
    clauses.push("expiration_date = ?");
    params.push(input.expirationDate);
  }
  if (input.expirationDateGte) {
    clauses.push("expiration_date >= ?");
    params.push(input.expirationDateGte);
  }
  if (input.expirationDateLte) {
    clauses.push("expiration_date <= ?");
    params.push(input.expirationDateLte);
  }

  const rows = queryAll<{ underlying_symbol: string; contracts: number }>(
    `
    SELECT underlying_symbol, COUNT(*) AS contracts
    FROM option_contracts
    WHERE ${clauses.join(" AND ")}
    GROUP BY underlying_symbol
    `,
    params
  );
  return new Map(
    rows.map((row) => [normalizeSymbol(row.underlying_symbol), row.contracts ?? 0])
  );
};

const safeDiscoveryError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 180 ? `${message.slice(0, 180)}...` : message;
};

const refreshDiscoveryContractCache = async (input: {
  enabled: boolean;
  underlyings: string[];
  minDaysToExpiration?: number;
  maxDaysToExpiration?: number;
  expirationDate?: string;
  expirationDateGte?: string;
  expirationDateLte?: string;
}): Promise<DiscoveryRefreshResult | undefined> => {
  if (!input.enabled || !input.underlyings.length) {
    return undefined;
  }
  const localContractsBefore = optionContractCacheCount({
    underlyings: input.underlyings,
    expirationDate: input.expirationDate,
    expirationDateGte: input.expirationDateGte,
    expirationDateLte: input.expirationDateLte
  });
  const localCountsByUnderlying = optionContractCacheCountsByUnderlying({
    underlyings: input.underlyings,
    expirationDate: input.expirationDate,
    expirationDateGte: input.expirationDateGte,
    expirationDateLte: input.expirationDateLte
  });
  const missingUnderlyings = input.underlyings.filter(
    (symbol) => (localCountsByUnderlying.get(normalizeSymbol(symbol)) ?? 0) === 0
  );
  if (missingUnderlyings.length === 0 && !optionContractCacheIsStale(localContractsBefore)) {
    return {
      providerUsed: false,
      refreshed: false,
      reason: "local_cache_has_matching_contracts",
      localContractsBefore
    };
  }

  try {
    const result = await ingestOptionContracts({
      underlyingSymbols: input.underlyings,
      minDaysToExpiration: input.minDaysToExpiration,
      maxDaysToExpiration: input.maxDaysToExpiration
    });
    return {
      providerUsed: true,
      refreshed: true,
      reason: localContractsBefore === 0
        ? "local_cache_empty"
        : missingUnderlyings.length
          ? "local_cache_partial"
          : "local_cache_stale",
      localContractsBefore,
      missingUnderlyings: missingUnderlyings.length ? missingUnderlyings : undefined,
      rowsIngested: result.rowsIngested
    };
  } catch (error) {
    return {
      providerUsed: true,
      refreshed: false,
      reason: localContractsBefore === 0
        ? "local_cache_empty"
        : missingUnderlyings.length
          ? "local_cache_partial"
          : "local_cache_stale",
      localContractsBefore,
      missingUnderlyings: missingUnderlyings.length ? missingUnderlyings : undefined,
      error: safeDiscoveryError(error)
    };
  }
};

const refreshOptionDiscoveryCache = async (
  options: ReturnType<typeof paperOptionsConfig>,
  optionsPlanningEnabled: boolean
): Promise<DiscoveryRefreshState> => {
  if (!optionsPlanningEnabled) {
    return {};
  }
  const zeroUnderlyings = Array.from(new Set(["SPY", ...options.zeroDteSpy.underlyings]))
    .map((symbol) => normalizeSymbol(symbol))
    .filter((symbol) => symbol === "SPY");
  const today = new Date().toISOString().slice(0, 10);
  const leapsMinDate = dateOnlyFromDays(options.leaps.minDte);
  const leapsMaxDate = dateOnlyFromDays(options.leaps.maxDte);

  const [zeroDteSpy, leaps] = await Promise.all([
    refreshDiscoveryContractCache({
      enabled: options.zeroDteSpy.enabled,
      underlyings: zeroUnderlyings,
      minDaysToExpiration: 0,
      maxDaysToExpiration: 0,
      expirationDate: today
    }),
    refreshDiscoveryContractCache({
      enabled: options.leaps.enabled,
      underlyings: options.leaps.underlyings,
      minDaysToExpiration: options.leaps.minDte,
      maxDaysToExpiration: options.leaps.maxDte,
      expirationDateGte: leapsMinDate,
      expirationDateLte: leapsMaxDate
    })
  ]);

  return { zeroDteSpy, leaps };
};

const refreshSelectedOptionSnapshots = async (
  optionSymbols: string[],
  diagnostics: PaperPlanDiscoveryDiagnostics[]
) => {
  const symbols = Array.from(new Set(optionSymbols.filter(Boolean)));
  if (!symbols.length) {
    return;
  }
  try {
    await ingestOptionSnapshotsForSymbols(symbols);
  } catch (error) {
    const message = `quote_refresh_failed:${safeDiscoveryError(error)}`;
    diagnostics.forEach((diagnostic) => {
      if (diagnostic.enabled) {
        diagnostic.warnings.push(message);
      }
    });
  }
};

const buildZeroDteSpyDiscoveryCandidates = (
  options: ReturnType<typeof paperOptionsConfig>,
  startingRank: number,
  optionsPlanningEnabled: boolean,
  refresh?: DiscoveryRefreshResult
): DiscoveryBuildResult => {
  const underlyings = Array.from(new Set(["SPY", ...options.zeroDteSpy.underlyings]))
    .map((symbol) => normalizeSymbol(symbol))
    .filter((symbol) => symbol === "SPY");
  const diagnostics = emptyDiscoveryDiagnostics(
    optionsPlanningEnabled && options.zeroDteSpy.enabled,
    underlyings
  );
  if (refresh) {
    diagnostics.cacheRefresh = refresh;
    if (refresh.error) {
      diagnostics.warnings.push(`contract_refresh_failed:${refresh.error}`);
    }
  }
  if (!optionsPlanningEnabled) {
    if (options.zeroDteSpy.enabled) {
      diagnostics.hardBlockers.push("OPTIONS_PLANNING_NOT_IMPLEMENTED");
    }
    return { candidates: [], diagnostics };
  }
  if (!options.zeroDteSpy.enabled || !underlyings.length) {
    return { candidates: [], diagnostics };
  }

  const today = new Date().toISOString().slice(0, 10);
  const chain = optionContractsForUnderlyings(underlyings);
  diagnostics.contractsFound = chain.length;
  if (chain.length === 0) {
    diagnostics.hardBlockers.push("OPTION_CONTRACT_NOT_FOUND");
    return { candidates: [], diagnostics };
  }

  const sameDay = chain.filter((contract) =>
    contract.underlying_symbol === "SPY" && contract.expiration_date === today
  );
  if (!sameDay.length) {
    diagnostics.hardBlockers.push("OPTION_CONTRACT_NOT_FOUND");
    return { candidates: [], diagnostics };
  }

  const signal = signalDirectionFor("SPY");
  const warnings = discoveryWarningsForSignal(signal);
  diagnostics.warnings.push(...warnings);
  const referencePrice = findLatestPrice("SPY", signal.as_of);
  const candidates: CandidateRow[] = [];

  for (const type of ["call", "put"] as const) {
    const strategyEnabled = type === "call" ? options.allowLongCalls : options.allowLongPuts;
    if (!strategyEnabled) {
      diagnostics.hardBlockers.push("UNSUPPORTED_OPTION_STRATEGY");
      continue;
    }

    const alternatives = zeroDteAlternativesForUnderlying({
      contracts: sameDay,
      underlying: "SPY",
      type,
      referencePrice
    });
    if (!alternatives.length) {
      diagnostics.hardBlockers.push("OPTION_CONTRACT_NOT_FOUND");
      continue;
    }

    alternatives.forEach((contract, index) => {
      candidates.push(
        discoveryCandidate({
          family: "zero_dte_spy",
          contract,
          signal,
          rank: startingRank + candidates.length,
          selectionRank: index + 1,
          selectionReason: index === 0 ? "nearest_reference_contract" : "cheaper_otm_alternative",
          selectionGroup: `zero_dte_spy:SPY:${strategyForContract(contract)}`,
          warnings
        })
      );
    });
  }

  diagnostics.candidatesSelected = candidates.length;
  diagnostics.selectedOptionSymbols = candidates
    .map((candidate) => candidate.option_symbol)
    .filter((symbol): symbol is string => Boolean(symbol));
  return { candidates, diagnostics };
};

const buildLeapsDiscoveryCandidates = (
  options: ReturnType<typeof paperOptionsConfig>,
  startingRank: number,
  optionsPlanningEnabled: boolean,
  refresh?: DiscoveryRefreshResult
): DiscoveryBuildResult => {
  const underlyings = options.leaps.underlyings;
  const diagnostics = emptyDiscoveryDiagnostics(
    optionsPlanningEnabled && options.leaps.enabled,
    underlyings
  );
  if (refresh) {
    diagnostics.cacheRefresh = refresh;
    if (refresh.error) {
      diagnostics.warnings.push(`contract_refresh_failed:${refresh.error}`);
    }
  }
  if (!optionsPlanningEnabled) {
    if (options.leaps.enabled) {
      diagnostics.hardBlockers.push("OPTIONS_PLANNING_NOT_IMPLEMENTED");
    }
    return { candidates: [], diagnostics };
  }
  if (!options.leaps.enabled || !underlyings.length) {
    return { candidates: [], diagnostics };
  }

  const chain = optionContractsForUnderlyings(underlyings);
  diagnostics.contractsFound = chain.length;
  if (chain.length === 0) {
    diagnostics.hardBlockers.push("OPTION_CONTRACT_NOT_FOUND");
    return { candidates: [], diagnostics };
  }

  const inRange = chain.filter((contract) => {
    const dte = daysToExpiration(contract.expiration_date);
    return dte !== null && dte >= options.leaps.minDte && dte <= options.leaps.maxDte;
  });
  if (!inRange.length) {
    diagnostics.hardBlockers.push("OPTION_CONTRACT_NOT_FOUND");
    return { candidates: [], diagnostics };
  }

  if (!options.allowLongCalls) {
    diagnostics.hardBlockers.push("UNSUPPORTED_OPTION_STRATEGY");
    return { candidates: [], diagnostics };
  }

  const candidates: CandidateRow[] = [];
  for (const underlying of underlyings) {
    const signal = signalDirectionFor(underlying);
    const warnings = discoveryWarningsForSignal(signal);
    diagnostics.warnings.push(...warnings.map((warning) => `${underlying}:${warning}`));
    const alternatives = leapsAlternativesForUnderlying({
      contracts: inRange,
      underlying,
      type: "call",
      referencePrice: findLatestPrice(underlying, signal.as_of),
      preferItm: true,
      preferDeltaRange: { min: 0.6, max: 0.8, target: 0.7 }
    });
    if (!alternatives.length) {
      continue;
    }
    alternatives.forEach((contract, index) => {
      candidates.push(
        discoveryCandidate({
          family: "leaps",
          contract,
          signal,
          rank: startingRank + candidates.length,
          selectionRank: index + 1,
          selectionReason: index === 0 ? "delta_preferred_contract" : "cheaper_leaps_alternative",
          selectionGroup: `leaps:${underlying}:${strategyForContract(contract)}`,
          warnings
        })
      );
    });
  }

  if (!candidates.length) {
    diagnostics.hardBlockers.push("OPTION_CONTRACT_NOT_FOUND");
  }
  diagnostics.candidatesSelected = candidates.length;
  diagnostics.selectedOptionSymbols = candidates
    .map((candidate) => candidate.option_symbol)
    .filter((symbol): symbol is string => Boolean(symbol));
  return { candidates, diagnostics };
};

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
  zeroDteSpyDiscovery: PaperPlanDiscoveryDiagnostics;
  leapsDiscovery: PaperPlanDiscoveryDiagnostics;
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

  const discoveryTopBlockers = [
    ...input.zeroDteSpyDiscovery.hardBlockers,
    ...input.leapsDiscovery.hardBlockers
  ];

  return {
    latestSnapshotAvailable: Boolean(input.latestAnyRun),
    latestSnapshotRunId: input.latestAnyRun?.id ?? null,
    latestSnapshotTimestamp: input.latestAnyRun?.started_at ?? null,
    filtersMatchedSnapshots: Boolean(input.latestRun),
    runtimeCandidatesAvailable: input.candidates.length > 0,
    emptyReason,
    discoveryTopBlockers: [...new Set(discoveryTopBlockers)],
    zeroDteSpyDiscovery: input.zeroDteSpyDiscovery,
    leapsDiscovery: input.leapsDiscovery
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

const firstEnvValue = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
};

const parseNumberEnvAny = (names: string[], fallback: number): number => {
  const parsed = Number.parseFloat(firstEnvValue(...names) || "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseIntegerEnvAny = (names: string[], fallback: number): number => {
  const parsed = Number.parseInt(firstEnvValue(...names) || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseSymbolListEnv = (name: string, fallback: string[]): string[] => {
  const value = process.env[name];
  const source = value === undefined || value.trim() === "" ? fallback.join(",") : value;
  return Array.from(
    new Set(
      source
        .split(",")
        .map((entry) => normalizeSymbol(entry))
        .filter(Boolean)
    )
  );
};

export const paperOptionsConfig = () => {
  const quoteCfg = optionsQuoteConfig();
  const hardSpreadCapEnabled = parseBooleanEnv("PAPER_OPTIONS_HARD_SPREAD_CAP_ENABLED", false);
  const maxPremiumPerContract = parseNumberEnvAny(
    ["PAPER_OPTION_MAX_PREMIUM_PER_CONTRACT", "PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER"],
    1500
  );
  const maxOrderNotional = parseNumberEnvAny(
    ["PAPER_OPTION_MAX_ORDER_NOTIONAL", "PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER"],
    1500
  );
  const maxContracts = Math.max(
    1,
    parseIntegerEnvAny(["PAPER_OPTION_MAX_CONTRACTS", "PAPER_OPTIONS_MAX_CONTRACTS"], 1)
  );
  const zeroDteMaxPremiumPerContract = parseNumberEnvAny(
    ["PAPER_0DTE_SPY_MAX_PREMIUM_PER_CONTRACT", "PAPER_0DTE_SPY_MAX_PREMIUM_PER_TRADE"],
    250
  );
  const zeroDteMaxOrderNotional = parseNumberEnvAny(
    ["PAPER_0DTE_SPY_MAX_ORDER_NOTIONAL", "PAPER_0DTE_SPY_MAX_PREMIUM_PER_TRADE"],
    250
  );
  const leapsMaxPremiumPerContract = parseNumberEnvAny(
    ["PAPER_LEAPS_MAX_PREMIUM_PER_CONTRACT", "PAPER_LEAPS_MAX_PREMIUM_PER_TRADE"],
    1500
  );
  const leapsMaxOrderNotional = parseNumberEnvAny(
    ["PAPER_LEAPS_MAX_ORDER_NOTIONAL", "PAPER_LEAPS_MAX_PREMIUM_PER_TRADE"],
    1500
  );
  return {
    maxPremiumPerOrder: maxOrderNotional,
    maxPremiumPerContract,
    maxOrderNotional,
    maxContracts,
    minDte: parseIntegerEnv("PAPER_OPTIONS_MIN_DTE", 0),
    maxDte: Math.max(1, parseIntegerEnv("PAPER_OPTIONS_MAX_DTE", 90)),
    allow0Dte: quoteCfg.allow0DteOptions,
    allowMarketOrders: parseBooleanEnv("PAPER_OPTIONS_ALLOW_MARKET_ORDERS", false),
    limitPriceBasis: process.env.PAPER_OPTIONS_LIMIT_PRICE_BASIS || "mid",
    maxSpreadPct: parseNumberEnv("PAPER_OPTIONS_MAX_SPREAD_PCT", 50),
    hardSpreadCapEnabled,
    maxPortfolioRiskPct: parseNumberEnv("PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT", 20),
    maxPositionRiskPct: parseNumberEnv("PAPER_OPTIONS_MAX_POSITION_RISK_PCT", 5),
    allowLongCalls: parseBooleanEnv("PAPER_OPTIONS_ALLOW_LONG_CALLS", true),
    allowLongPuts: parseBooleanEnv("PAPER_OPTIONS_ALLOW_LONG_PUTS", true),
    allowCashSecuredPuts: parseBooleanEnv("PAPER_OPTIONS_ALLOW_CASH_SECURED_PUTS", true),
    allowCoveredCalls: parseBooleanEnv("PAPER_OPTIONS_ALLOW_COVERED_CALLS", true),
    allowNakedOptions: parseBooleanEnv("PAPER_OPTIONS_ALLOW_NAKED_OPTIONS", false),
    quoteMaxAgeMs: quoteCfg.maxAgeMs,
    allowLastPriceFallback: quoteCfg.allowLastPriceFallback,
    learningLedgerEnabled: parseBooleanEnv("PAPER_OPTION_LEARNING_LEDGER_ENABLED", true),
    zeroDteSpy: {
      enabled:
        parseBooleanEnv("PAPER_0DTE_SPY_ENABLED", false) ||
        parseBooleanEnv("PAPER_0DTE_DISCOVERY_ENABLED", false),
      underlyings: parseSymbolListEnv("PAPER_0DTE_SPY_UNDERLYINGS", ["SPY"]),
      maxPremiumPerTrade: Math.min(maxOrderNotional, zeroDteMaxOrderNotional),
      maxPremiumPerContract: Math.min(maxPremiumPerContract, zeroDteMaxPremiumPerContract),
      maxOrderNotional: Math.min(maxOrderNotional, zeroDteMaxOrderNotional),
      maxContracts: Math.min(
        maxContracts,
        Math.max(1, parseIntegerEnv("PAPER_0DTE_SPY_MAX_CONTRACTS", maxContracts))
      ),
      maxDailyTrades: Math.max(1, parseIntegerEnv("PAPER_0DTE_SPY_MAX_DAILY_TRADES", 3)),
      maxQuoteAgeSeconds: Math.max(1, parseIntegerEnv("PAPER_0DTE_SPY_MAX_QUOTE_AGE_SECONDS", 60)),
      maxSpreadPct: parseNumberEnv("PAPER_0DTE_SPY_MAX_SPREAD_PCT", 20),
      hardSpreadCapEnabled: parseBooleanEnv(
        "PAPER_0DTE_SPY_HARD_SPREAD_CAP_ENABLED",
        hardSpreadCapEnabled
      )
    },
    leaps: {
      enabled: parseBooleanEnv("PAPER_LEAPS_ENABLED", false),
      underlyings: parseSymbolListEnv("PAPER_LEAPS_UNDERLYINGS", ["SPY", "QQQ"]),
      maxPremiumPerTrade: Math.min(maxOrderNotional, leapsMaxOrderNotional),
      maxPremiumPerContract: Math.min(maxPremiumPerContract, leapsMaxPremiumPerContract),
      maxOrderNotional: Math.min(maxOrderNotional, leapsMaxOrderNotional),
      maxContracts: Math.min(
        maxContracts,
        Math.max(1, parseIntegerEnv("PAPER_LEAPS_MAX_CONTRACTS", maxContracts))
      ),
      minDte: parseIntegerEnv("PAPER_LEAPS_MIN_DTE", 180),
      maxDte: Math.max(1, parseIntegerEnv("PAPER_LEAPS_MAX_DTE", 730)),
      maxSpreadPct: parseNumberEnv("PAPER_LEAPS_MAX_SPREAD_PCT", 15),
      hardSpreadCapEnabled: parseBooleanEnv(
        "PAPER_LEAPS_HARD_SPREAD_CAP_ENABLED",
        hardSpreadCapEnabled
      )
    }
  };
};

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
  optionSymbol: string
): OptionSnapshotPlanRow | null =>
  queryOne<OptionSnapshotPlanRow>(
    `
    SELECT
      bid,
      ask,
      midpoint,
      last,
      timestamp,
      quote_status,
      executable,
      executable_price,
      executable_price_source,
      rejection_reason,
      quote_timestamp
    FROM option_snapshots
    WHERE option_symbol = ?
    ORDER BY timestamp DESC
    LIMIT 1
    `,
    [optionSymbol]
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

const asQuoteStatus = (value: string | null): OptionQuoteStatus | null =>
  value === "valid" || value === "missing" || value === "invalid" || value === "stale"
    ? value
    : null;

const asExecutablePriceSource = (value: string | null): OptionExecutablePriceSource | null =>
  value === "midpoint" || value === "ask" || value === "askFallback" || value === "last"
    ? value
    : null;

const optionQuoteFields = (quote: NormalizedOptionQuote) => ({
  quoteStatus: quote.quoteStatus,
  executable: quote.executable,
  executablePrice: quote.executablePrice,
  executablePriceSource: quote.executablePriceSource,
  rejectionReason: quote.rejectionReason,
  quoteTimestamp: quote.quoteTimestamp
});

const quoteAgeSeconds = (quoteTimestamp: string | null): number | null => {
  if (!quoteTimestamp) {
    return null;
  }
  const parsed = Date.parse(quoteTimestamp);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
};

const quoteQualityReason = (quote: NormalizedOptionQuote): PaperPlanReasonCode => {
  if (quote.rejectionReason === "crossed_quote") {
    return "QUOTE_CROSSED";
  }
  if (quote.quoteStatus === "stale") {
    return "QUOTE_STALE";
  }
  if (quote.bid === null || quote.ask === null) {
    return "QUOTE_NULL";
  }
  return "OPTION_LIMIT_PRICE_UNAVAILABLE";
};

type DerivedOptionLimitPrice = {
  limitPrice: number | null;
  source: "midpoint" | "askFallback" | "unavailable";
};

const derivePaperOptionLimitPrice = (
  quote: NormalizedOptionQuote,
  side: "buy" | "sell",
  basis: string
): DerivedOptionLimitPrice => {
  if (quote.bid === null || quote.ask === null || quote.bid <= 0 || quote.ask <= 0) {
    return { limitPrice: null, source: "unavailable" };
  }
  if (quote.ask < quote.bid) {
    return { limitPrice: null, source: "unavailable" };
  }

  if (basis === "ask" && side === "buy") {
    return {
      limitPrice: roundOptionLimitPrice(quote.ask),
      source: "askFallback"
    };
  }

  const midpoint = roundOptionLimitPrice((quote.bid + quote.ask) / 2);
  if (midpoint > 0) {
    return { limitPrice: midpoint, source: "midpoint" };
  }

  if (side === "buy" && quote.ask > 0) {
    return {
      limitPrice: roundOptionLimitPrice(quote.ask),
      source: "askFallback"
    };
  }

  return { limitPrice: null, source: "unavailable" };
};

const quoteSnapshotModel = (
  quote: NormalizedOptionQuote,
  spreadPct: number | null
): QuoteSnapshotModel => ({
  bid: quote.bid,
  ask: quote.ask,
  midpoint: quote.midpoint,
  spreadPct,
  quoteAgeSeconds: quoteAgeSeconds(quote.quoteTimestamp)
});

const paperFillModelFor = (
  quote: NormalizedOptionQuote,
  limitPrice: number | null
): PaperFillModel | null => {
  if (limitPrice === null) {
    return null;
  }
  const source =
    quote.executablePriceSource === "midpoint"
      ? "midpoint"
      : quote.executablePriceSource === "askFallback"
        ? "askFallback"
        : quote.executablePriceSource === "ask"
          ? "ask"
          : "paper_order";
  return {
    submittedLimitPrice: limitPrice,
    assumedFillPrice: limitPrice,
    source
  };
};

const liveLikeFillModelFor = (
  quote: NormalizedOptionQuote,
  limitPrice: number | null,
  spreadPct: number | null
): LiveLikeFillModel | null => {
  if (quote.ask !== null && quote.ask > 0) {
    const paperPrice = limitPrice ?? quote.midpoint ?? quote.ask;
    const slippageBps = paperPrice > 0 ? ((quote.ask - paperPrice) / paperPrice) * 10000 : 0;
    return {
      assumedEntryPrice: roundMoney(quote.ask),
      method: "ask",
      slippageBps: Number(Math.max(0, slippageBps).toFixed(2)),
      spreadPenaltyPct: spreadPct ?? undefined
    };
  }
  if (quote.midpoint !== null && quote.midpoint > 0 && spreadPct !== null) {
    const penalty = spreadPct / 2;
    return {
      assumedEntryPrice: roundMoney(quote.midpoint * (1 + penalty / 100)),
      method: "midpoint_plus_spread_fraction",
      spreadPenaltyPct: penalty
    };
  }
  return null;
};

const hypothesisForFamily = (family: PaperStrategyFamily) => {
  if (family === "zero_dte_spy") {
    return "SPY intraday momentum/mean-reversion signal is strong enough to overcome same-day theta decay, spread cost, and conservative live-like fill assumptions.";
  }
  if (family === "leaps") {
    return "Long-horizon directional signal is strong enough to justify long-dated premium exposure after spread, liquidity, and drawdown controls.";
  }
  if (family === "standard_option") {
    return "Defined paper option exposure can express the directional signal after quote, spread, liquidity, and risk controls.";
  }
  return "Equity paper exposure can validate the directional signal while preserving paper-only execution controls.";
};

const expectedHoldPeriodForFamily = (
  family: PaperStrategyFamily
): RiskModel["expectedHoldPeriod"] => {
  if (family === "zero_dte_spy") {
    return "intraday";
  }
  if (family === "leaps") {
    return "long_horizon";
  }
  return "swing";
};

const missingOptionQuoteFields = (optionSymbol: string): NormalizedOptionQuote => ({
  optionSymbol,
  bid: null,
  ask: null,
  midpoint: null,
  last: null,
  quoteTimestamp: null,
  quoteStatus: "missing",
  executable: false,
  executablePrice: null,
  executablePriceSource: null,
  rejectionReason: "quote_unavailable"
});

const normalizedSnapshotQuote = (
  optionSymbol: string,
  snapshot: OptionSnapshotPlanRow,
  options: ReturnType<typeof paperOptionsConfig>
): NormalizedOptionQuote => {
  const persistedStatus = asQuoteStatus(snapshot.quote_status);
  const persistedSource = asExecutablePriceSource(snapshot.executable_price_source);
  const normalized = normalizeOptionQuote(
    {
      optionSymbol,
      bid: snapshot.bid,
      ask: snapshot.ask,
      midpoint: snapshot.midpoint,
      last: snapshot.last,
      timestamp: snapshot.quote_timestamp || snapshot.timestamp
    },
    new Date(),
    options.quoteMaxAgeMs,
    {
      allowLastPriceFallback: options.allowLastPriceFallback
    }
  );

  if (persistedStatus === null) {
    return normalized;
  }

  if (persistedStatus !== "valid") {
    return {
      ...normalized,
      quoteStatus: normalized.quoteStatus === "stale" ? "stale" : persistedStatus,
      executable: false,
      executablePrice: null,
      executablePriceSource: null,
      rejectionReason:
        normalized.quoteStatus === "stale"
          ? normalized.rejectionReason
          : snapshot.rejection_reason || normalized.rejectionReason,
      quoteTimestamp: snapshot.quote_timestamp || normalized.quoteTimestamp
    };
  }

  const persistedExecutable = snapshot.executable === 1;
  return {
    ...normalized,
    quoteStatus: normalized.quoteStatus === "valid" ? "valid" : normalized.quoteStatus,
    executable:
      normalized.quoteStatus === "valid"
        ? persistedExecutable
        : normalized.executable,
    executablePrice:
      normalized.quoteStatus === "valid" && persistedExecutable
        ? toNullableNumber(snapshot.executable_price) ?? normalized.executablePrice
        : null,
    executablePriceSource:
      normalized.quoteStatus === "valid" && persistedExecutable
        ? persistedSource ?? normalized.executablePriceSource
        : null,
    rejectionReason:
      normalized.quoteStatus === "valid"
        ? snapshot.rejection_reason
        : normalized.rejectionReason,
    quoteTimestamp: snapshot.quote_timestamp || normalized.quoteTimestamp
  };
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

const classifyOptionFamily = (input: {
  dte: number | null;
  genericMaxDte: number;
  leapsMinDte: number;
}): PaperStrategyFamily => {
  if (input.dte === 0) {
    return "zero_dte_spy";
  }
  if (input.dte !== null && (input.dte >= input.leapsMinDte || input.dte > input.genericMaxDte)) {
    return "leaps";
  }
  return "standard_option";
};

const zeroDteSubmittedToday = (): number => {
  const today = new Date().toISOString().slice(0, 10);
  const row = queryOne<{ count: number }>(
    `
    SELECT COUNT(DISTINCT COALESCE(source_candidate_id, id)) AS count
    FROM paper_learning_records
    WHERE strategy_family = 'zero_dte_spy'
      AND decision = 'submitted'
      AND substr(created_at, 1, 10) = ?
    `,
    [today]
  );
  return Number(row?.count ?? 0);
};

const familyRiskCaps = (
  family: PaperStrategyFamily,
  options: ReturnType<typeof paperOptionsConfig>
) => {
  if (family === "zero_dte_spy") {
    return {
      maxPremiumPerTrade: options.zeroDteSpy.maxPremiumPerTrade,
      maxPremiumPerContract: options.zeroDteSpy.maxPremiumPerContract,
      maxOrderNotional: options.zeroDteSpy.maxOrderNotional,
      maxContracts: options.zeroDteSpy.maxContracts,
      maxSpreadPct: options.zeroDteSpy.maxSpreadPct,
      hardSpreadCapEnabled: options.zeroDteSpy.hardSpreadCapEnabled
    };
  }
  if (family === "leaps") {
    return {
      maxPremiumPerTrade: options.leaps.maxPremiumPerTrade,
      maxPremiumPerContract: options.leaps.maxPremiumPerContract,
      maxOrderNotional: options.leaps.maxOrderNotional,
      maxContracts: options.leaps.maxContracts,
      maxSpreadPct: options.leaps.maxSpreadPct,
      hardSpreadCapEnabled: options.leaps.hardSpreadCapEnabled
    };
  }
  return {
    maxPremiumPerTrade: options.maxPremiumPerOrder,
    maxPremiumPerContract: options.maxPremiumPerContract,
    maxOrderNotional: options.maxOrderNotional,
    maxContracts: options.maxContracts,
    maxSpreadPct: options.maxSpreadPct,
    hardSpreadCapEnabled: options.hardSpreadCapEnabled
  };
};

const learningDecisionFor = (candidate: PaperPlanCandidate) => {
  if (candidate.decision === "planned") {
    return "submitted" as const;
  }
  if (candidate.reasonCodes.some((code) =>
    code.startsWith("QUOTE_") ||
    code === "OPTION_LIMIT_PRICE_UNAVAILABLE" ||
    code === "OPTION_SPREAD_TOO_WIDE" ||
    code === "SPREAD_TOO_WIDE" ||
    code === "PREMIUM_ABOVE_LIMIT" ||
    code === "DTE_OUT_OF_RANGE" ||
    code === "NOT_ZERO_DTE"
  )) {
    return "rejected" as const;
  }
  return "skipped" as const;
};

const learningBlockReasonFor = (candidate: PaperPlanCandidate): string | null => {
  const blocking = candidate.reasonCodes.find((code) =>
    ![
      "PAPER_ENV_CONFIRMED",
      "LIVE_TRADING_DISABLED",
      "PLAN_ONLY_NO_MUTATION",
      "RISK_PROFILE_ALLOWED",
      "OPTION_CONTRACT_FOUND",
      "OPTION_DTE_ALLOWED",
      "OPTION_0DTE_ALLOWED",
      "TRADABLE",
      "BUYING_POWER_OK",
      "WITHIN_POSITION_CAP",
      "QTY_ESTIMATED",
      "SPECULATIVE_OPTION_PAPER_WARNING",
      "OPTION_WIDE_SPREAD_WARNING",
      "QUOTE_STALE",
      "WEAK_SIGNAL",
      "FALLBACK_LIMIT_PRICE_USED"
    ].includes(code)
  );
  return candidate.rejectionReason || blocking || null;
};

const attachLearningRecord = (input: {
  candidate: CandidateRow;
  plan: PaperPlanCandidate;
  researchRunId: string | null;
  generatedAt: string;
}): PaperPlanCandidate => {
  const family = input.plan.strategyFamily ?? (
    input.plan.assetClass === "option" ? "standard_option" : "equity"
  );
  if (!parseBooleanEnv("PAPER_OPTION_LEARNING_LEDGER_ENABLED", true)) {
    return {
      ...input.plan,
      learningRecordWriteStatus: "disabled"
    };
  }

  const decision = learningDecisionFor(input.plan);
  const blockReason = learningBlockReasonFor(input.plan);
  const signalInputs = input.plan.signalInputs ?? {
    rank: input.candidate.rank,
    direction: input.candidate.direction,
    preferredExpression: input.candidate.preferred_expression,
    estimatedMaxLoss: input.candidate.estimated_max_loss,
    estimatedMaxProfit: input.candidate.estimated_max_profit
  };

  try {
    const record = insertPaperLearningRecord({
      createdAt: input.generatedAt,
      strategyFamily: family,
      symbol: input.plan.symbol,
      underlyingSymbol: input.plan.underlyingSymbol ?? input.plan.symbol,
      optionSymbol: input.plan.optionSymbol ?? null,
      decision,
      skipReason: decision === "submitted" ? null : blockReason,
      blockReason: decision === "submitted" ? null : blockReason,
      hypothesis: input.plan.hypothesis || hypothesisForFamily(family),
      signalInputs,
      optionMetadata: input.plan.optionMetadata ?? null,
      quoteSnapshot: input.plan.quoteSnapshot ?? null,
      paperFillModel: input.plan.paperFillModel ?? null,
      liveLikeFillModel: input.plan.liveLikeFillModel ?? null,
      riskModel: input.plan.riskModel ?? null,
      sourceResearchRunId: input.researchRunId,
      sourceCandidateId: input.candidate.id,
      sourcePlanTimestamp: input.generatedAt
    });
    return {
      ...input.plan,
      learningRecordId: record.id,
      learningRecordWriteStatus: "written"
    };
  } catch (error) {
    return {
      ...input.plan,
      reasonCodes: buildReasonList([...input.plan.reasonCodes, "LEARNING_LEDGER_WRITE_FAILED"]),
      learningRecordWriteStatus: "failed",
      learningRecordError: error instanceof Error ? error.message : "unknown"
    };
  }
};

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

const discoverySelectionGroupForPlan = (candidate: PaperPlanCandidate): string | null => {
  const selectionGroup = candidate.optionMetadata?.selectionGroup;
  return typeof selectionGroup === "string" && selectionGroup.trim() !== ""
    ? selectionGroup
    : null;
};

const skipUnselectedDiscoveryAlternative = (
  candidate: PaperPlanCandidate
): PaperPlanCandidate => ({
  ...candidate,
  decision: "skip",
  reasonCodes: buildReasonList([
    ...candidate.reasonCodes,
    "ALTERNATE_CONTRACT_NOT_SELECTED"
  ]),
  explanation: explanationFor("skip", ["ALTERNATE_CONTRACT_NOT_SELECTED"])
});

const formatQty = (value: number | null): string =>
  value === null ? "-" : value.toFixed(4);

const formatNotional = (value: number | null): string =>
  value === null ? "-" : value.toFixed(2);

interface CandidateEvaluationContext {
  candidate: CandidateRow;
  tradability: AlpacaAssetTradabilityResult;
  estimatedPrice: number | null;
  heldEquity: boolean;
  heldOptionContract: boolean;
  heldQty: number;
  openEquityOrderExists: boolean;
  openOptionOrderExists: boolean;
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
    heldEquity,
    heldOptionContract,
    heldQty,
    openEquityOrderExists,
    openOptionOrderExists,
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
        sourceCandidateId: candidate.id,
        strategyFamily: "standard_option",
        hypothesis: hypothesisForFamily("standard_option"),
        signalInputs: {
          rank: candidate.rank,
          direction: candidate.direction,
          preferredExpression: candidate.preferred_expression,
          estimatedMaxLoss: candidate.estimated_max_loss,
          estimatedMaxProfit: candidate.estimated_max_profit
        },
        strategy,
        reasonCodes: buildReasonList([...(base.reasonCodes), "OPTION_CONTRACT_NOT_FOUND"]),
        explanation: explanationFor("watch", ["OPTION_CONTRACT_NOT_FOUND"])
      };
    }

    const expectedType =
      strategy === "long_call" || strategy === "covered_call" ? "call" : "put";
    const dte = daysToExpiration(contract.expiration_date);
    const strategyFamily = classifyOptionFamily({
      dte,
      genericMaxDte: options.maxDte,
      leapsMinDte: options.leaps.minDte
    });
    const optionMetadata = {
      type: contract.type,
      expectedType,
      expirationDate: contract.expiration_date,
      dte,
      strike: contract.strike,
      multiplier: contract.multiplier || 100,
      tradable: contract.tradable === 1,
      selectionRank: candidate.discovery_selection_rank ?? null,
      selectionReason: candidate.discovery_selection_reason ?? null,
      selectionGroup: candidate.discovery_selection_group ?? null
    };
    const discoverySource = discoverySourceFromCandidateId(candidate.id);
    const signalInputs = {
      rank: candidate.rank,
      direction: candidate.direction,
      preferredExpression: candidate.preferred_expression,
      estimatedMaxLoss: candidate.estimated_max_loss,
      estimatedMaxProfit: candidate.estimated_max_profit,
      dte,
      strategyFamily,
      ...(discoverySource
        ? {
            discoverySource,
            discoveryGenerated: true,
            discoveryUnderlying: contract.underlying_symbol,
            selectionRank: candidate.discovery_selection_rank ?? null,
            selectionReason: candidate.discovery_selection_reason ?? null,
            selectionGroup: candidate.discovery_selection_group ?? null,
            warnings: candidate.discovery_warnings ?? []
          }
        : {})
    };
    const baseOptionFields = {
      sourceCandidateId: candidate.id,
      strategyFamily,
      hypothesis: hypothesisForFamily(strategyFamily),
      signalInputs,
      optionMetadata
    };
    const genericDteAllowed =
      dte !== null &&
      dte >= options.minDte &&
      dte <= options.maxDte &&
      (options.allow0Dte || dte > 0);
    let dteBlockReason: PaperPlanReasonCode | null = null;
    let familyRejectionReason: string | null = null;

    if (!contract.tradable || contract.type !== expectedType) {
      dteBlockReason = "OPTION_CONTRACT_NOT_TRADABLE";
    } else if (strategyFamily === "zero_dte_spy") {
      if (contract.underlying_symbol !== "SPY") {
        dteBlockReason = "NOT_ZERO_DTE";
        familyRejectionReason = "zero_dte_spy_requires_spy_underlying";
      } else if (!options.zeroDteSpy.enabled) {
        dteBlockReason = "ZERO_DTE_SPY_DISABLED";
        familyRejectionReason = "zero_dte_spy_disabled";
      } else if (zeroDteSubmittedToday() >= options.zeroDteSpy.maxDailyTrades) {
        dteBlockReason = "MAX_DAILY_ZERO_DTE_TRADES_REACHED";
        familyRejectionReason = "max_daily_zero_dte_trades_reached";
      }
    } else if (strategyFamily === "leaps") {
      if (!options.leaps.enabled) {
        dteBlockReason = "LEAPS_DISABLED";
        familyRejectionReason = "leaps_disabled";
      } else if (dte === null || dte < options.leaps.minDte || dte > options.leaps.maxDte) {
        dteBlockReason = "DTE_OUT_OF_RANGE";
        familyRejectionReason = "leaps_dte_out_of_range";
      } else if (contract.type === "put" && candidate.direction !== "short") {
        dteBlockReason = "UNSUPPORTED_OPTION_STRATEGY";
        familyRejectionReason = "leaps_put_requires_bearish_signal";
      }
    } else if (!genericDteAllowed) {
      dteBlockReason =
        dte === 0 && !options.allow0Dte ? "OPTION_0DTE_NOT_ENABLED" : "DTE_OUT_OF_RANGE";
      familyRejectionReason =
        dte === 0 && !options.allow0Dte
          ? "same_day_expiration_not_enabled"
          : "standard_option_dte_out_of_range";
    }

    if (dteBlockReason) {
      return {
        ...base,
        decision: "watch",
        assetClass: "option",
        ...baseOptionFields,
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        executable: false,
        executablePrice: null,
        executablePriceSource: null,
        rejectionReason: familyRejectionReason,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          dteBlockReason
        ]),
        explanation: explanationFor("watch", [dteBlockReason])
      };
    }

    const side = strategy === "long_call" || strategy === "long_put" ? "buy" : "sell";
    if (!options.allowMarketOrders) {
      base.orderType = "limit";
    }
    const snapshot = findLatestOptionSnapshot(contract.option_symbol);
    if (!snapshot) {
      const missingQuote = missingOptionQuoteFields(contract.option_symbol);
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        ...baseOptionFields,
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        quoteSnapshot: quoteSnapshotModel(missingQuote, null),
        ...optionQuoteFields(missingQuote),
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_LIMIT_PRICE_UNAVAILABLE",
          "QUOTE_NULL"
        ]),
        explanation: explanationFor("watch", ["OPTION_LIMIT_PRICE_UNAVAILABLE"])
      };
    }

    const quote = normalizedSnapshotQuote(
      contract.option_symbol,
      snapshot,
      strategyFamily === "zero_dte_spy"
        ? {
            ...options,
            quoteMaxAgeMs: options.zeroDteSpy.maxQuoteAgeSeconds * 1000
          }
        : options
    );
    const spreadPct = spreadPctFor(quote.bid, quote.ask);
    const quoteBidAskUsable =
      quote.bid !== null &&
      quote.ask !== null &&
      quote.bid > 0 &&
      quote.ask > 0 &&
      quote.ask >= quote.bid;
    const staleQuoteUsable =
      quote.quoteStatus === "stale" &&
      quoteBidAskUsable;
    const quoteUsableForPaper =
      quote.quoteStatus === "valid" || staleQuoteUsable;
    const derivedLimit = quoteUsableForPaper
      ? derivePaperOptionLimitPrice(quote, side, options.limitPriceBasis)
      : { limitPrice: null, source: "unavailable" as const };
    const quoteForPlanning: NormalizedOptionQuote =
      quoteUsableForPaper && derivedLimit.limitPrice !== null
      ? {
          ...quote,
          executable: true,
          executablePrice: derivedLimit.limitPrice,
          executablePriceSource:
            derivedLimit.source === "midpoint" ? "midpoint" : "askFallback",
          rejectionReason:
            quote.quoteStatus === "stale"
              ? quote.rejectionReason ?? "quote_stale"
              : quote.rejectionReason
        }
      : quote;
    const limitPrice = derivedLimit.limitPrice;
    if (
      !quoteUsableForPaper ||
      limitPrice === null ||
      limitPrice <= 0
    ) {
      const qualityReason = quoteQualityReason(quote);
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        ...baseOptionFields,
        underlyingSymbol: contract.underlying_symbol,
        optionSymbol: contract.option_symbol,
        strategy,
        expirationDate: contract.expiration_date,
        strike: contract.strike,
        shortStrike: candidate.short_strike,
        bidAskSpreadPct: spreadPct,
        quoteSnapshot: quoteSnapshotModel(quote, spreadPct),
        ...optionQuoteFields(quote),
        reasonCodes: buildReasonList([
          ...optionPriceUnavailableReasons(base.reasonCodes),
          qualityReason
        ]),
        explanation: explanationFor("watch", ["OPTION_LIMIT_PRICE_UNAVAILABLE"])
      };
    }

    const familyCaps = familyRiskCaps(strategyFamily, options);
    const multiplier = contract.multiplier || 100;
    const perContractPremium = roundMoney(limitPrice * multiplier);
    const perContractMaxRisk =
      strategy === "cash_secured_put"
        ? roundMoney(contract.strike * multiplier)
        : perContractPremium;
    const contractsByPremium =
      perContractPremium <= familyCaps.maxPremiumPerContract
        ? familyCaps.maxContracts
        : 0;
    const contractsByOrderNotional = positiveFloor(
      familyCaps.maxOrderNotional / perContractPremium
    );
    const contractsByBuyingPower =
      deployableBuyingPower === null
        ? familyCaps.maxContracts
        : positiveFloor(deployableBuyingPower / perContractMaxRisk);
    const contracts = Math.min(
      familyCaps.maxContracts,
      contractsByPremium,
      contractsByOrderNotional,
      contractsByBuyingPower
    );
    const premiumRisk = roundMoney(limitPrice * multiplier * contracts);
    const collateralRisk =
      strategy === "cash_secured_put"
        ? roundMoney(contract.strike * multiplier * contracts)
        : 0;
    const maxRisk = strategy === "cash_secured_put" ? collateralRisk : premiumRisk;
    const configuredRisk = maxRisk;
    const maxPositionRisk = accountRelativeCap(accountEquity, options.maxPositionRiskPct);
    const maxPortfolioRisk = accountRelativeCap(accountEquity, options.maxPortfolioRiskPct);
    const remainingPortfolioRisk =
      maxPortfolioRisk === null ? null : roundMoney(Math.max(0, maxPortfolioRisk - plannedNotional));
    const accountRiskExceeded =
      strategy === "cash_secured_put" &&
      (
        (maxPositionRisk !== null && configuredRisk > maxPositionRisk) ||
        (remainingPortfolioRisk !== null && configuredRisk > remainingPortfolioRisk)
      );

    const premiumAboveLimit =
      contractsByPremium <= 0 ||
      contractsByOrderNotional <= 0 ||
      premiumRisk > familyCaps.maxOrderNotional ||
      perContractPremium > familyCaps.maxPremiumPerContract;
    const weakSignalWarning = (candidate.discovery_warnings ?? []).length > 0;
    const fallbackLimitPriceUsed = derivedLimit.source === "askFallback";
    const commonOptionWarnings: PaperPlanReasonCode[] = [
      ...(staleQuoteUsable ? (["QUOTE_STALE"] as PaperPlanReasonCode[]) : []),
      ...(fallbackLimitPriceUsed ? (["FALLBACK_LIMIT_PRICE_USED"] as PaperPlanReasonCode[]) : []),
      ...(weakSignalWarning ? (["WEAK_SIGNAL"] as PaperPlanReasonCode[]) : [])
    ];
    const optionRiskModel: RiskModel = {
      maxPremium: familyCaps.maxOrderNotional,
      maxPremiumPerContract: familyCaps.maxPremiumPerContract,
      maxOrderNotional: familyCaps.maxOrderNotional,
      capUsed: familyCaps.maxOrderNotional,
      contracts,
      notionalPremium: premiumRisk,
      maxLoss: configuredRisk,
      priceSource: derivedLimit.source,
      selectionRank: candidate.discovery_selection_rank ?? null,
      selectionReason: candidate.discovery_selection_reason ?? null,
      expectedHoldPeriod: expectedHoldPeriodForFamily(strategyFamily)
    };
    if (contracts <= 0 || premiumAboveLimit || accountRiskExceeded) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        ...baseOptionFields,
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
        quoteSnapshot: quoteSnapshotModel(quoteForPlanning, spreadPct),
        paperFillModel: paperFillModelFor(quoteForPlanning, limitPrice),
        liveLikeFillModel: liveLikeFillModelFor(quoteForPlanning, limitPrice, spreadPct),
        riskModel: optionRiskModel,
        ...optionQuoteFields(quoteForPlanning),
        estimatedNotional: configuredRisk,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_DTE_ALLOWED",
          ...commonOptionWarnings,
          "OPTION_RISK_LIMIT_EXCEEDED",
          ...(premiumAboveLimit ? (["PREMIUM_ABOVE_LIMIT"] as PaperPlanReasonCode[]) : [])
        ]),
        explanation: explanationFor("watch", ["OPTION_RISK_LIMIT_EXCEEDED"])
      };
    }

    const spreadAboveConfiguredCap =
      spreadPct !== null && spreadPct > familyCaps.maxSpreadPct;
    if (spreadAboveConfiguredCap && familyCaps.hardSpreadCapEnabled) {
      return {
        ...base,
        decision: "watch",
        side,
        assetClass: "option",
        orderType: "limit",
        ...baseOptionFields,
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
        quoteSnapshot: quoteSnapshotModel(quoteForPlanning, spreadPct),
        paperFillModel: paperFillModelFor(quoteForPlanning, limitPrice),
        liveLikeFillModel: liveLikeFillModelFor(quoteForPlanning, limitPrice, spreadPct),
        riskModel: optionRiskModel,
        ...optionQuoteFields(quoteForPlanning),
        estimatedNotional: configuredRisk,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_DTE_ALLOWED",
          ...commonOptionWarnings,
          "OPTION_SPREAD_TOO_WIDE",
          "SPREAD_TOO_WIDE"
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
        ...baseOptionFields,
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
        quoteSnapshot: quoteSnapshotModel(quoteForPlanning, spreadPct),
        paperFillModel: paperFillModelFor(quoteForPlanning, limitPrice),
        liveLikeFillModel: liveLikeFillModelFor(quoteForPlanning, limitPrice, spreadPct),
        riskModel: optionRiskModel,
        ...optionQuoteFields(quoteForPlanning),
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          ...commonOptionWarnings,
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
        ...baseOptionFields,
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
        quoteSnapshot: quoteSnapshotModel(quoteForPlanning, spreadPct),
        paperFillModel: paperFillModelFor(quoteForPlanning, limitPrice),
        liveLikeFillModel: liveLikeFillModelFor(quoteForPlanning, limitPrice, spreadPct),
        riskModel: optionRiskModel,
        ...optionQuoteFields(quoteForPlanning),
        estimatedNotional: configuredRisk,
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          ...commonOptionWarnings,
          "OPTION_COLLATERAL_INSUFFICIENT",
          "OPTION_RISK_LIMIT_EXCEEDED"
        ]),
        explanation: explanationFor("watch", ["OPTION_RISK_LIMIT_EXCEEDED"])
      };
    }

    if (heldOptionContract) {
      return {
        ...base,
        side,
        assetClass: "option",
        orderType: "limit",
        ...baseOptionFields,
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
        quoteSnapshot: quoteSnapshotModel(quoteForPlanning, spreadPct),
        paperFillModel: paperFillModelFor(quoteForPlanning, limitPrice),
        liveLikeFillModel: liveLikeFillModelFor(quoteForPlanning, limitPrice, spreadPct),
        riskModel: optionRiskModel,
        ...optionQuoteFields(quoteForPlanning),
        estimatedPrice: limitPrice,
        estimatedQty: contracts,
        estimatedNotional: configuredRisk,
        decision: "watch",
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_DTE_ALLOWED",
          ...commonOptionWarnings,
          "ALREADY_HELD_OPTION_CONTRACT"
        ]),
        explanation: explanationFor("watch", ["ALREADY_HELD_OPTION_CONTRACT"])
      };
    }

    if (openOptionOrderExists) {
      return {
        ...base,
        side,
        assetClass: "option",
        orderType: "limit",
        ...baseOptionFields,
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
        quoteSnapshot: quoteSnapshotModel(quoteForPlanning, spreadPct),
        paperFillModel: paperFillModelFor(quoteForPlanning, limitPrice),
        liveLikeFillModel: liveLikeFillModelFor(quoteForPlanning, limitPrice, spreadPct),
        riskModel: optionRiskModel,
        ...optionQuoteFields(quoteForPlanning),
        estimatedPrice: limitPrice,
        estimatedQty: contracts,
        estimatedNotional: configuredRisk,
        decision: "skip",
        reasonCodes: buildReasonList([
          ...(base.reasonCodes),
          "OPTION_CONTRACT_FOUND",
          "OPTION_DTE_ALLOWED",
          ...commonOptionWarnings,
          "DUPLICATE_OPEN_OPTION_ORDER"
        ]),
        explanation: explanationFor("skip", ["DUPLICATE_OPEN_OPTION_ORDER"])
      };
    }

    return {
      ...base,
      side,
      assetClass: "option",
      orderType: "limit",
      ...baseOptionFields,
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
      quoteSnapshot: quoteSnapshotModel(quoteForPlanning, spreadPct),
      paperFillModel: paperFillModelFor(quoteForPlanning, limitPrice),
      liveLikeFillModel: liveLikeFillModelFor(quoteForPlanning, limitPrice, spreadPct),
      riskModel: optionRiskModel,
      ...optionQuoteFields(quoteForPlanning),
      estimatedPrice: limitPrice,
      estimatedQty: contracts,
      estimatedNotional: configuredRisk,
      decision: "planned",
      reasonCodes: buildReasonList([
        ...base.reasonCodes,
        "OPTION_CONTRACT_FOUND",
        "OPTION_DTE_ALLOWED",
        ...commonOptionWarnings,
        ...(dte === 0 ? (["OPTION_0DTE_ALLOWED"] as PaperPlanReasonCode[]) : []),
        ...(spreadAboveConfiguredCap || (spreadPct !== null && spreadPct > 20)
          ? (["OPTION_WIDE_SPREAD_WARNING"] as PaperPlanReasonCode[])
          : []),
        ...(contractsByPremium > familyCaps.maxContracts ||
        contractsByOrderNotional > familyCaps.maxContracts ||
        contractsByBuyingPower > familyCaps.maxContracts
          ? (["MAX_CONTRACTS_EXCEEDED"] as PaperPlanReasonCode[])
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

  if (heldEquity) {
    return {
      ...base,
      decision: "watch",
      reasonCodes: buildReasonList([...(base.reasonCodes), "ALREADY_HELD_EQUITY"]),
      explanation: explanationFor("watch", ["ALREADY_HELD_EQUITY"])
    };
  }

  if (openEquityOrderExists) {
    return {
      ...base,
      decision: "skip",
      reasonCodes: buildReasonList([...(base.reasonCodes), "DUPLICATE_OPEN_EQUITY_ORDER"]),
      explanation: explanationFor("skip", ["DUPLICATE_OPEN_EQUITY_ORDER"])
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
  const config = loadPaperPlanConfig(input);
  assertPlanGuards(config.riskProfile);

  const generatedAt = now();
  const state = getTradingSafetyState();

  const rawAccount = parseAccount(await getAlpacaAccountSnapshot());
  const account = withReserve(rawAccount, config.minBuyingPowerReservePct);

  const [ordersResult, positionsResult] = await Promise.all([
    listAlpacaOpenOrders(),
    listAlpacaPositions()
  ]);

  const heldEquitySymbols = new Set<string>();
  const heldOptionSymbols = new Set<string>();
  const heldEquityQuantities = new Map<string, number>();
  let currentDeployedNotional = 0;
  for (const row of positionsResult.positions || []) {
    const identity = getPositionAssetIdentity(row);
    const qty = toNullableNumber(row.qty);
    const marketValue = toNullableNumber(row.marketValue);
    const size = qty ?? 0;
    if (identity && size !== 0) {
      if (identity.assetClass === "option") {
        heldOptionSymbols.add(identity.optionSymbol);
      } else {
        heldEquitySymbols.add(identity.symbol);
        heldEquityQuantities.set(
          identity.symbol,
          (heldEquityQuantities.get(identity.symbol) ?? 0) + size
        );
      }
    }
    if (marketValue !== null) {
      currentDeployedNotional += Math.abs(marketValue);
    }
  }

  const openEquityOrderSymbols = new Set<string>();
  const openOptionOrderSymbols = new Set<string>();
  for (const row of ordersResult.orders || []) {
    const identity = getOrderAssetIdentity(row);
    if (!identity) {
      continue;
    }
    if (identity.assetClass === "option") {
      openOptionOrderSymbols.add(identity.optionSymbol);
    } else {
      openEquityOrderSymbols.add(identity.symbol);
    }
  }

  const latestAnyRun = pickLatestCompletedResearchRun();
  const latestRun = pickLatestResearchRun(config.riskProfile, config.optionsEnabled);
  const candidates = latestRun
    ? pickCandidates(latestRun.id, config.maxCandidates)
    : [];
  const optionConfig = paperOptionsConfig();
  const discoveryRefresh = await refreshOptionDiscoveryCache(
    optionConfig,
    config.optionsEnabled
  );
  const zeroDteSpyDiscovery = buildZeroDteSpyDiscoveryCandidates(
    optionConfig,
    candidates.length + 1,
    config.optionsEnabled,
    discoveryRefresh.zeroDteSpy
  );
  const leapsDiscovery = buildLeapsDiscoveryCandidates(
    optionConfig,
    candidates.length + zeroDteSpyDiscovery.candidates.length + 1,
    config.optionsEnabled,
    discoveryRefresh.leaps
  );
  await refreshSelectedOptionSnapshots(
    [
      ...zeroDteSpyDiscovery.diagnostics.selectedOptionSymbols,
      ...leapsDiscovery.diagnostics.selectedOptionSymbols
    ],
    [zeroDteSpyDiscovery.diagnostics, leapsDiscovery.diagnostics]
  );
  const allCandidates = [
    ...candidates,
    ...zeroDteSpyDiscovery.candidates,
    ...leapsDiscovery.candidates
  ];

  const source: PaperPlanSource = {
    snapshotRunId: latestRun?.id ?? null,
    recommendationTimestamp: latestTimestamp(allCandidates),
    runtimeTimestamp: generatedAt
  };

  const tradabilityCache = new Map<string, Promise<AlpacaAssetTradabilityResult>>();
  const plan: PaperPlanCandidate[] = [];
  const seenSymbols = new Set<string>();
  const selectedDiscoveryGroups = new Set<string>();
  let plannedNotional = 0;
  let plannedCount = 0;

  for (const candidate of allCandidates) {
    const symbol = normalizeSymbol(candidate.symbol);
    const candidateIdentity = getCandidateAssetIdentity({
      assetClass: candidate.preferred_expression === "shares" ? "equity" : "option",
      symbol,
      optionSymbol: candidate.option_symbol
    });
    let tradabilityPromise = tradabilityCache.get(symbol);
    if (!tradabilityPromise) {
      tradabilityPromise = checkAlpacaSymbolTradability(symbol);
      tradabilityCache.set(symbol, tradabilityPromise);
    }

    let evaluatedPlan = evaluateCandidate({
      candidate,
      tradability: await tradabilityPromise,
      estimatedPrice: findLatestPrice(symbol, candidate.as_of || undefined),
      heldEquity:
        candidateIdentity?.assetClass === "equity" &&
        heldEquitySymbols.has(candidateIdentity.symbol),
      heldOptionContract:
        candidateIdentity?.assetClass === "option" &&
        heldOptionSymbols.has(candidateIdentity.optionSymbol),
      heldQty: heldEquityQuantities.get(symbol) ?? 0,
      openEquityOrderExists:
        candidateIdentity?.assetClass === "equity" &&
        openEquityOrderSymbols.has(candidateIdentity.symbol),
      openOptionOrderExists:
        candidateIdentity?.assetClass === "option" &&
        openOptionOrderSymbols.has(candidateIdentity.optionSymbol),
      duplicateExposure: seenSymbols.has(symbol),
      config,
      deployableBuyingPower: account.deployableBuyingPower,
      accountEquity: account.equity,
      accountCash: account.cash,
      currentDeployedNotional,
      plannedCount,
      plannedNotional
    });
    const discoverySelectionGroup = discoverySelectionGroupForPlan(evaluatedPlan);
    if (
      discoverySelectionGroup &&
      selectedDiscoveryGroups.has(discoverySelectionGroup) &&
      evaluatedPlan.decision === "planned"
    ) {
      evaluatedPlan = skipUnselectedDiscoveryAlternative(evaluatedPlan);
    }
    if (discoverySelectionGroup && evaluatedPlan.decision === "planned") {
      selectedDiscoveryGroups.add(discoverySelectionGroup);
    }
    const candidatePlan = attachLearningRecord({
      candidate,
      plan: {
        ...evaluatedPlan,
        sourceResearchRunId: latestRun?.id ?? null,
        sourceCandidateId: candidate.id
      },
      researchRunId: latestRun?.id ?? null,
      generatedAt
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
    candidates: allCandidates,
    plan,
    zeroDteSpyDiscovery: zeroDteSpyDiscovery.diagnostics,
    leapsDiscovery: leapsDiscovery.diagnostics
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
      remainingDeployableBuyingPower,
      zeroDteSpyCandidates: plan.filter((entry) => entry.strategyFamily === "zero_dte_spy").length,
      zeroDteSpyEligible: plan.filter(
        (entry) => entry.strategyFamily === "zero_dte_spy" && entry.decision === "planned"
      ).length,
      zeroDteSpySkipped: plan.filter(
        (entry) => entry.strategyFamily === "zero_dte_spy" && entry.decision !== "planned"
      ).length,
      leapsCandidates: plan.filter((entry) => entry.strategyFamily === "leaps").length,
      leapsEligible: plan.filter(
        (entry) => entry.strategyFamily === "leaps" && entry.decision === "planned"
      ).length,
      leapsSkipped: plan.filter(
        (entry) => entry.strategyFamily === "leaps" && entry.decision !== "planned"
      ).length,
      zeroDteSpyDiscoveryCandidates: plan.filter(
        (entry) => entry.sourceCandidateId?.startsWith("discovery:zero_dte_spy:")
      ).length,
      zeroDteSpyDiscoveryEligible: plan.filter(
        (entry) =>
          entry.sourceCandidateId?.startsWith("discovery:zero_dte_spy:") &&
          entry.decision === "planned"
      ).length,
      zeroDteSpyDiscoverySkipped: plan.filter(
        (entry) =>
          entry.sourceCandidateId?.startsWith("discovery:zero_dte_spy:") &&
          entry.decision !== "planned"
      ).length,
      leapsDiscoveryCandidates: plan.filter(
        (entry) => entry.sourceCandidateId?.startsWith("discovery:leaps:")
      ).length,
      leapsDiscoveryEligible: plan.filter(
        (entry) =>
          entry.sourceCandidateId?.startsWith("discovery:leaps:") &&
          entry.decision === "planned"
      ).length,
      leapsDiscoverySkipped: plan.filter(
        (entry) =>
          entry.sourceCandidateId?.startsWith("discovery:leaps:") &&
          entry.decision !== "planned"
      ).length,
      learningRecordsWritten: plan.filter((entry) => entry.learningRecordWriteStatus === "written").length,
      learningRecordsPending: plan.filter((entry) =>
        entry.learningRecordWriteStatus === "written" &&
        (entry.decision === "planned" || entry.decision === "watch" || entry.decision === "skip")
      ).length
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
    const discoveryTopBlockers = report.diagnostics.discoveryTopBlockers ?? [];
    if (discoveryTopBlockers.length) {
      lines.push(`Discovery blockers: ${discoveryTopBlockers.join(", ")}.`);
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
  lines.push(
    `Strategy families: zeroDteSpy candidates=${report.summary.zeroDteSpyCandidates ?? 0}, eligible=${report.summary.zeroDteSpyEligible ?? 0}, skipped=${report.summary.zeroDteSpySkipped ?? 0}; leaps candidates=${report.summary.leapsCandidates ?? 0}, eligible=${report.summary.leapsEligible ?? 0}, skipped=${report.summary.leapsSkipped ?? 0}`
  );
  const zeroDiscovery = report.diagnostics.zeroDteSpyDiscovery;
  const leapsDiscovery = report.diagnostics.leapsDiscovery;
  lines.push(
    `Discovery: zeroDteSpy ran=${stateText(Boolean(zeroDiscovery?.enabled))}, underlyings=${zeroDiscovery?.underlyings.join(",") || "none"}, contracts=${zeroDiscovery?.contractsFound ?? 0}, selected=${zeroDiscovery?.selectedOptionSymbols.join(",") || "none"}, warnings=${zeroDiscovery?.warnings.join(",") || "none"}, hardBlockers=${zeroDiscovery?.hardBlockers.join(",") || "none"}; leaps ran=${stateText(Boolean(leapsDiscovery?.enabled))}, underlyings=${leapsDiscovery?.underlyings.join(",") || "none"}, contracts=${leapsDiscovery?.contractsFound ?? 0}, selected=${leapsDiscovery?.selectedOptionSymbols.join(",") || "none"}, warnings=${leapsDiscovery?.warnings.join(",") || "none"}, hardBlockers=${leapsDiscovery?.hardBlockers.join(",") || "none"}`
  );
  lines.push(
    `Learning ledger: written=${report.summary.learningRecordsWritten ?? 0}, pending=${report.summary.learningRecordsPending ?? 0}`
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
