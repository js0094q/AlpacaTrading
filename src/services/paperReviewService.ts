import {
  buildPaperPlanReport,
  type PaperPlanCandidate,
  type PaperPlanDiagnostics,
  type PaperPlanEmptyReason,
  type PaperPlanReport
} from "./paperPlanService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";
import type { RiskProfile } from "../types.js";

export type PaperReviewStatus = "ready_for_dry_run_execution" | "warning" | "blocked";
export type PaperReviewBlockReason = ReviewBlockerCode | "NO_ELIGIBLE_PAPER_PAYLOADS";

type PaperReviewFormat = "table" | "json";

interface PaperReviewInput {
  riskProfile?: RiskProfile;
  optionsEnabled?: boolean;
  maxCandidates?: number;
  maxNewPositions?: number;
  maxPositionNotional?: number;
  maxTotalPlanNotional?: number;
  minBuyingPowerReservePct?: number;
  maxPlanAgeMinutes?: number;
  maxBuyingPowerUsePct?: number;
  format?: PaperReviewFormat;
}

interface PaperReviewConfig {
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  maxCandidates: number;
  maxNewPositions: number;
  maxPositionNotional: number;
  maxTotalPlanNotional: number;
  minBuyingPowerReservePct: number;
  maxPlanAgeMinutes: number;
  maxBuyingPowerUsePct: number;
}

const DEFAULTS = {
  riskProfile: "moderate" as RiskProfile,
  optionsEnabled: false,
  maxCandidates: 5,
  maxNewPositions: 3,
  maxPositionNotional: 100,
  maxTotalPlanNotional: 300,
  minBuyingPowerReservePct: 20,
  maxPlanAgeMinutes: 30,
  maxBuyingPowerUsePct: 50,
  maxSingleSymbolPlanPct: 40
} as const;

export interface PaperReviewPlanSummary {
  candidatesEvaluated: number;
  plannedOrders: number;
  watched: number;
  skipped: number;
  estimatedTotalNotional: number;
  buyingPowerUsePct: number | null;
  remainingDeployableBuyingPower: number | null;
}

export interface PaperReviewCandidate {
  symbol: string;
  decision: PaperPlanCandidate["decision"];
  estimatedNotional: number | null;
  estimatedQty: number | null;
  reasonCodes: string[];
  reviewFlags: string[];
}

export interface PaperReviewReport {
  paperOnly: true;
  environment: PaperPlanReport["environment"];
  generatedAt: string;
  reviewOnly: true;
  nonMutating: true;
  config: {
    riskProfile: RiskProfile;
    optionsEnabled: boolean;
    maxCandidates: number;
    maxNewPositions: number;
    maxPositionNotional: number;
    maxTotalPlanNotional: number;
    minBuyingPowerReservePct: number;
    maxPlanAgeMinutes: number;
    maxBuyingPowerUsePct: number;
  };
  planSummary: PaperReviewPlanSummary;
  review: {
    status: PaperReviewStatus;
    blockReason?: PaperReviewBlockReason | null;
    blockers: string[];
    warnings: string[];
    confirmationsRequired: string[];
  };
  risk: {
    concentrationWarnings: string[];
    duplicateExposureWarnings: string[];
    staleDataWarnings: string[];
    aggressiveModeWarnings: string[];
    optionsWarnings: string[];
    buyingPowerWarnings: string[];
  };
  candidateCounts: {
    inputCandidates: number;
    plannedOrders: number;
    eligiblePayloads: number;
    skippedAlreadyHeld: number;
    skippedAlreadyHeldEquity: number;
    skippedAlreadyHeldOptionContract: number;
    skippedUnderlyingEquityHeldForOption: number;
    skippedDuplicateOpenEquityOrder: number;
    skippedDuplicateOpenOptionOrder: number;
    skippedQuoteUnavailable: number;
  };
  topSkipReasons: string[];
  executionReadiness?: {
    equity: {
      eligible: number;
      blocked: number;
    };
    options: {
      eligible: number;
      blocked: number;
      blockers: string[];
    };
  };
  plan: PaperReviewCandidate[];
  source: {
    snapshotRunId?: string | null;
    recommendationTimestamp?: string | null;
    runtimeTimestamp?: string | null;
    planTimestamp?: string | null;
  };
  diagnostics: PaperPlanDiagnostics;
}

type ReviewBlockerCode =
  | "NO_PLAN"
  | "NO_RESEARCH_SNAPSHOTS"
  | "NO_MATCHING_SNAPSHOTS_FOR_FILTERS"
  | "NO_RUNTIME_CANDIDATES"
  | "ALL_CANDIDATES_SKIPPED"
  | "NO_CANDIDATES_EVALUATED"
  | "NO_PLANNED_ORDERS"
  | "PLAN_STALE"
  | "ACCOUNT_UNAVAILABLE"
  | "BUYING_POWER_UNKNOWN"
  | "LIVE_TRADING_ENABLED"
  | "NON_PAPER_ENVIRONMENT"
  | "AGGRESSIVE_MODE_NOT_ENABLED"
  | "PLAN_NOT_DRY_RUN"
  | "PLAN_NOT_NON_MUTATING"
  | "MAX_TOTAL_PLAN_NOTIONAL_EXCEEDED"
  | "MAX_BUYING_POWER_USE_EXCEEDED"
  | "MALFORMED_PLAN";

type ReviewWarningCode =
  | "AGGRESSIVE_MODE_ACTIVE"
  | "OPTIONS_ENABLED"
  | "OPTIONS_PLANNING_NOT_IMPLEMENTED"
  | "SPECULATIVE_OPTION_PAPER_WARNING"
  | "OPTION_WIDE_SPREAD_WARNING"
  | "OPTION_0DTE_PAPER_WARNING"
  | "ELEVATED_BUYING_POWER_USE"
  | "CONCENTRATION_WARNING"
  | "DUPLICATE_EXPOSURE_WARNING"
  | "SKIPPED_CANDIDATES_PRESENT"
  | "WATCHED_CANDIDATES_PRESENT"
  | "EMPTY_SNAPSHOT_HISTORY"
  | "SOURCE_MARKET_DATA_LOOKBACK"
  | "STALE_RECOMMENDATION_SOURCE";

const REVIEWER_BLOCKERS: ReviewBlockerCode[] = [
  "NO_PLAN",
  "NO_RESEARCH_SNAPSHOTS",
  "NO_MATCHING_SNAPSHOTS_FOR_FILTERS",
  "NO_RUNTIME_CANDIDATES",
  "ALL_CANDIDATES_SKIPPED",
  "NO_CANDIDATES_EVALUATED",
  "NO_PLANNED_ORDERS",
  "PLAN_STALE",
  "ACCOUNT_UNAVAILABLE",
  "BUYING_POWER_UNKNOWN",
  "LIVE_TRADING_ENABLED",
  "NON_PAPER_ENVIRONMENT",
  "AGGRESSIVE_MODE_NOT_ENABLED",
  "PLAN_NOT_DRY_RUN",
  "PLAN_NOT_NON_MUTATING",
  "MAX_TOTAL_PLAN_NOTIONAL_EXCEEDED",
  "MAX_BUYING_POWER_USE_EXCEEDED",
  "MALFORMED_PLAN"
] as const;

const REVIEWER_WARNINGS: ReviewWarningCode[] = [
  "AGGRESSIVE_MODE_ACTIVE",
  "OPTIONS_ENABLED",
  "OPTIONS_PLANNING_NOT_IMPLEMENTED",
  "SPECULATIVE_OPTION_PAPER_WARNING",
  "OPTION_WIDE_SPREAD_WARNING",
  "OPTION_0DTE_PAPER_WARNING",
  "ELEVATED_BUYING_POWER_USE",
  "CONCENTRATION_WARNING",
  "DUPLICATE_EXPOSURE_WARNING",
  "SKIPPED_CANDIDATES_PRESENT",
  "WATCHED_CANDIDATES_PRESENT",
  "EMPTY_SNAPSHOT_HISTORY",
  "SOURCE_MARKET_DATA_LOOKBACK",
  "STALE_RECOMMENDATION_SOURCE"
] as const;

const NO_OP_REVIEW_BLOCKERS = new Set<ReviewBlockerCode>([
  "NO_RESEARCH_SNAPSHOTS",
  "NO_MATCHING_SNAPSHOTS_FOR_FILTERS",
  "NO_RUNTIME_CANDIDATES",
  "ALL_CANDIDATES_SKIPPED",
  "NO_CANDIDATES_EVALUATED",
  "NO_PLANNED_ORDERS"
]);

const NON_SKIP_REASON_CODES = new Set<string>([
  "TRADABLE",
  "BUYING_POWER_OK",
  "WITHIN_POSITION_CAP",
  "QTY_ESTIMATED",
  "RISK_PROFILE_ALLOWED",
  "PAPER_ENV_CONFIRMED",
  "LIVE_TRADING_DISABLED",
  "PLAN_ONLY_NO_MUTATION",
  "OPTION_CONTRACT_FOUND",
  "OPTION_DTE_ALLOWED",
  "OPTION_0DTE_ALLOWED",
  "OPTION_RISK_LIMIT_OK",
  "OPTION_COLLATERAL_CONFIRMED",
  "OPTION_WIDE_SPREAD_WARNING",
  "SPECULATIVE_OPTION_PAPER_WARNING"
]);

interface PaperReviewDeps {
  buildPlan?: (input: {
    riskProfile: RiskProfile;
    optionsEnabled: boolean;
    maxCandidates: number;
    maxNewPositions: number;
    maxPositionNotional: number;
    maxTotalPlanNotional: number;
    minBuyingPowerReservePct?: number;
  }) => Promise<PaperPlanReport>;
}

const toPositiveInteger = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const toNonNegativeInteger = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const toPercent = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(100, parsed);
};

const toBool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "undefined") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return value === "true";
};

const normalizeRiskProfile = (input?: RiskProfile): RiskProfile => {
  return input === "aggressive" || input === "moderate" || input === "conservative"
    ? input
    : DEFAULTS.riskProfile;
};

const normalizeDate = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return (Date.now() - parsed) / (1000 * 60);
};

const sortUniqueCodes = <T extends string>(values: readonly T[], order: readonly T[]): T[] => {
  const rank = new Map(order.map((value, index) => [value, index]));
  return [...new Set(values)].sort((left, right) => {
    const leftOrder = rank.get(left);
    const rightOrder = rank.get(right);
    if (leftOrder === undefined && rightOrder === undefined) {
      return left.localeCompare(right);
    }
    if (leftOrder === undefined) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (rightOrder === undefined) {
      return -Number.MAX_SAFE_INTEGER;
    }
    return leftOrder - rightOrder;
  });
};

const toConfig = (input: PaperReviewInput): PaperReviewConfig & { maxSingleSymbolPlanPct: number } => {
  return {
    riskProfile: normalizeRiskProfile(input.riskProfile),
    optionsEnabled: toBool(input.optionsEnabled, DEFAULTS.optionsEnabled),
    maxCandidates: toPositiveInteger(
      input.maxCandidates ?? process.env.PAPER_PLAN_MAX_CANDIDATES,
      DEFAULTS.maxCandidates
    ),
    maxNewPositions: toPositiveInteger(
      input.maxNewPositions ?? process.env.PAPER_PLAN_MAX_NEW_POSITIONS,
      DEFAULTS.maxNewPositions
    ),
    maxPositionNotional: toPositiveInteger(
      input.maxPositionNotional ?? process.env.PAPER_PLAN_MAX_POSITION_NOTIONAL,
      DEFAULTS.maxPositionNotional
    ),
    maxTotalPlanNotional: toPositiveInteger(
      input.maxTotalPlanNotional ?? process.env.PAPER_PLAN_MAX_TOTAL_PLAN_NOTIONAL,
      DEFAULTS.maxTotalPlanNotional
    ),
    minBuyingPowerReservePct: toPercent(
      input.minBuyingPowerReservePct ?? process.env.PAPER_PLAN_MIN_BUYING_POWER_RESERVE_PCT,
      DEFAULTS.minBuyingPowerReservePct
    ),
    maxPlanAgeMinutes: toNonNegativeInteger(
      input.maxPlanAgeMinutes ?? process.env.PAPER_REVIEW_MAX_PLAN_AGE_MINUTES,
      DEFAULTS.maxPlanAgeMinutes
    ),
    maxBuyingPowerUsePct: toPercent(
      input.maxBuyingPowerUsePct ?? process.env.PAPER_REVIEW_MAX_BUYING_POWER_USE_PCT,
      DEFAULTS.maxBuyingPowerUsePct
    ),
    maxSingleSymbolPlanPct: toPercent(
      process.env.PAPER_REVIEW_MAX_SINGLE_SYMBOL_PLAN_PCT,
      DEFAULTS.maxSingleSymbolPlanPct
    )
  };
};

const isPaperPlanReport = (value: unknown): value is PaperPlanReport => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;

  return (
    typeof record.paperOnly === "boolean" &&
    typeof record.dryRun === "boolean" &&
    typeof record.nonMutating === "boolean" &&
    typeof record.environment === "string" &&
    typeof record.generatedAt === "string" &&
    typeof record.config === "object" &&
    record.config !== null &&
    typeof record.account === "object" &&
    record.account !== null &&
    typeof record.summary === "object" &&
    record.summary !== null &&
    Array.isArray(record.plan)
  );
};

const isDateMissingOrRecent = (candidateTimestamp: string | null | undefined, maxAgeMinutes: number): boolean => {
  if (maxAgeMinutes <= 0) {
    return true;
  }
  const age = normalizeDate(candidateTimestamp);
  return age !== null && age <= maxAgeMinutes;
};

const buildReviewFlags = (
  candidate: PaperPlanCandidate,
  concentratedSymbols: Set<string>
): string[] => {
  const flags: string[] = [];

  if (candidate.decision === "planned" && concentratedSymbols.has(candidate.symbol)) {
    flags.push("CONCENTRATION_WARNING");
  }

  if (candidate.reasonCodes.includes("DUPLICATE_EXPOSURE")) {
    flags.push("DUPLICATE_EXPOSURE_WARNING");
  }

  if (candidate.reasonCodes.includes("OPTIONS_PLANNING_NOT_IMPLEMENTED")) {
    flags.push("OPTIONS_PLANNING_NOT_IMPLEMENTED");
  }

  if (candidate.reasonCodes.includes("SPECULATIVE_OPTION_PAPER_WARNING")) {
    flags.push("SPECULATIVE_OPTION_PAPER_WARNING");
  }

  if (candidate.reasonCodes.includes("OPTION_WIDE_SPREAD_WARNING")) {
    flags.push("OPTION_WIDE_SPREAD_WARNING");
  }

  if (candidate.reasonCodes.includes("OPTION_0DTE_ALLOWED")) {
    flags.push("OPTION_0DTE_PAPER_WARNING");
  }

  for (const code of [
    "OPTION_LIMIT_PRICE_REQUIRED",
    "OPTION_RISK_LIMIT_EXCEEDED",
    "OPTION_CONTRACT_NOT_FOUND",
    "OPTION_CONTRACT_NOT_TRADABLE",
    "UNSUPPORTED_OPTION_STRATEGY",
    "OPTION_COLLATERAL_INSUFFICIENT"
  ]) {
    if (candidate.reasonCodes.includes(code as PaperPlanCandidate["reasonCodes"][number])) {
      flags.push(code);
    }
  }

  return sortUniqueCodes(flags, REVIEWER_WARNINGS);
};

const buildExecutionReadiness = (plan: PaperPlanCandidate[]) => {
  const optionBlockers: string[] = [];
  const readiness = {
    equity: {
      eligible: 0,
      blocked: 0
    },
    options: {
      eligible: 0,
      blocked: 0,
      blockers: optionBlockers
    }
  };

  for (const candidate of plan) {
    if (candidate.assetClass === "option") {
      if (candidate.decision === "planned") {
        readiness.options.eligible += 1;
      } else {
        readiness.options.blocked += 1;
        for (const code of candidate.reasonCodes) {
          if (
            code.startsWith("OPTION_") ||
            code === "ALREADY_HELD_OPTION_CONTRACT" ||
            code === "DUPLICATE_OPEN_OPTION_ORDER" ||
            code === "UNSUPPORTED_OPTION_STRATEGY" ||
            code === "OPTIONS_PLANNING_NOT_IMPLEMENTED"
          ) {
            optionBlockers.push(code);
          }
        }
      }
      continue;
    }

    if (candidate.assetClass === "us_equity") {
      if (candidate.decision === "planned") {
        readiness.equity.eligible += 1;
      } else {
        readiness.equity.blocked += 1;
      }
    }
  }

  readiness.options.blockers = [...new Set(optionBlockers)].sort();
  return readiness;
};

const emptyCandidateCounts = () => ({
  inputCandidates: 0,
  plannedOrders: 0,
  eligiblePayloads: 0,
  skippedAlreadyHeld: 0,
  skippedAlreadyHeldEquity: 0,
  skippedAlreadyHeldOptionContract: 0,
  skippedUnderlyingEquityHeldForOption: 0,
  skippedDuplicateOpenEquityOrder: 0,
  skippedDuplicateOpenOptionOrder: 0,
  skippedQuoteUnavailable: 0
});

const buildCandidateCounts = (
  plan: PaperPlanCandidate[],
  summary: Pick<PaperReviewPlanSummary, "candidatesEvaluated" | "plannedOrders">,
  readiness: ReturnType<typeof buildExecutionReadiness>
) => ({
  inputCandidates: summary.candidatesEvaluated,
  plannedOrders: summary.plannedOrders,
  eligiblePayloads: readiness.equity.eligible + readiness.options.eligible,
  skippedAlreadyHeld: plan.filter((candidate) =>
    candidate.decision !== "planned" &&
    (
      candidate.reasonCodes.includes("ALREADY_HELD") ||
      candidate.reasonCodes.includes("ALREADY_HELD_EQUITY") ||
      candidate.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT")
    )
  ).length,
  skippedAlreadyHeldEquity: plan.filter((candidate) =>
    candidate.decision !== "planned" &&
    candidate.assetClass === "us_equity" &&
    (
      candidate.reasonCodes.includes("ALREADY_HELD") ||
      candidate.reasonCodes.includes("ALREADY_HELD_EQUITY")
    )
  ).length,
  skippedAlreadyHeldOptionContract: plan.filter((candidate) =>
    candidate.decision !== "planned" &&
    candidate.assetClass === "option" &&
    candidate.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT")
  ).length,
  skippedUnderlyingEquityHeldForOption: plan.filter((candidate) =>
    candidate.decision !== "planned" &&
    candidate.assetClass === "option" &&
    candidate.reasonCodes.includes("ALREADY_HELD_EQUITY")
  ).length,
  skippedDuplicateOpenEquityOrder: plan.filter((candidate) =>
    candidate.decision !== "planned" &&
    candidate.assetClass === "us_equity" &&
    (
      candidate.reasonCodes.includes("OPEN_ORDER_EXISTS") ||
      candidate.reasonCodes.includes("DUPLICATE_OPEN_EQUITY_ORDER")
    )
  ).length,
  skippedDuplicateOpenOptionOrder: plan.filter((candidate) =>
    candidate.decision !== "planned" &&
    candidate.assetClass === "option" &&
    candidate.reasonCodes.includes("DUPLICATE_OPEN_OPTION_ORDER")
  ).length,
  skippedQuoteUnavailable: plan.filter((candidate) =>
    candidate.decision !== "planned" && candidate.rejectionReason === "quote_unavailable"
  ).length
});

const primarySkipReason = (candidate: PaperPlanCandidate): string | null => {
  if (candidate.decision === "planned") {
    return null;
  }
  if (candidate.reasonCodes.includes("ALREADY_HELD_EQUITY")) {
    return "ALREADY_HELD_EQUITY";
  }
  if (candidate.reasonCodes.includes("ALREADY_HELD_OPTION_CONTRACT")) {
    return "ALREADY_HELD_OPTION_CONTRACT";
  }
  if (candidate.reasonCodes.includes("DUPLICATE_OPEN_EQUITY_ORDER")) {
    return "DUPLICATE_OPEN_EQUITY_ORDER";
  }
  if (candidate.reasonCodes.includes("DUPLICATE_OPEN_OPTION_ORDER")) {
    return "DUPLICATE_OPEN_OPTION_ORDER";
  }
  if (candidate.reasonCodes.includes("ALREADY_HELD")) {
    return "ALREADY_HELD";
  }
  if (candidate.rejectionReason) {
    return candidate.rejectionReason;
  }
  return candidate.reasonCodes.find((code) => !NON_SKIP_REASON_CODES.has(code)) ?? candidate.decision;
};

const buildTopSkipReasons = (plan: PaperPlanCandidate[]) => {
  const counts = new Map<string, number>();
  for (const candidate of plan) {
    const reason = primarySkipReason(candidate);
    if (!reason) {
      continue;
    }
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason]) => reason);
};

const reviewBlockReason = (
  blockers: ReviewBlockerCode[]
): PaperReviewBlockReason | null => {
  if (!blockers.length) {
    return null;
  }
  if (blockers.every((blocker) => NO_OP_REVIEW_BLOCKERS.has(blocker))) {
    return "NO_ELIGIBLE_PAPER_PAYLOADS";
  }
  return blockers[0] ?? null;
};

const concentrationAnalysis = (
  plan: PaperPlanCandidate[],
  maxSingleSymbolPlanPct: number
): { concentratedSymbols: Set<string>; plannedTotalNotional: number } => {
  const totalsBySymbol = new Map<string, number>();
  let totalNotional = 0;

  for (const entry of plan) {
    if (entry.decision !== "planned") {
      continue;
    }
    if (typeof entry.estimatedNotional !== "number" || !Number.isFinite(entry.estimatedNotional)) {
      continue;
    }
    const nextTotal = (totalsBySymbol.get(entry.symbol) ?? 0) + entry.estimatedNotional;
    totalsBySymbol.set(entry.symbol, nextTotal);
    totalNotional += entry.estimatedNotional;
  }

  const concentratedSymbols = new Set<string>();
  if (totalNotional <= 0) {
    return { concentratedSymbols, plannedTotalNotional: 0 };
  }
  if (totalsBySymbol.size <= 1) {
    return { concentratedSymbols, plannedTotalNotional: totalNotional };
  }

  for (const [symbol, notional] of totalsBySymbol) {
    if ((notional / totalNotional) * 100 >= maxSingleSymbolPlanPct) {
      concentratedSymbols.add(symbol);
    }
  }

  return { concentratedSymbols, plannedTotalNotional: totalNotional };
};

const duplicateExposureDetected = (plan: PaperPlanCandidate[]) => {
  const symbols = new Set<string>();
  const duplicates = new Set<string>();

  for (const candidate of plan) {
    const normalized = candidate.symbol;
    if (!normalized) {
      continue;
    }
    if (symbols.has(normalized)) {
      duplicates.add(normalized);
      continue;
    }
    symbols.add(normalized);
  }

  return {
    duplicateExposureWarnings: duplicates.size > 0,
    duplicateSymbols: [...duplicates]
  };
};

const parseReviewStatus = (blockers: ReviewBlockerCode[], warnings: ReviewWarningCode[]): PaperReviewStatus => {
  if (blockers.length > 0) {
    return "blocked";
  }
  if (warnings.length > 0) {
    return "warning";
  }
  return "ready_for_dry_run_execution";
};

const formatMoney = (value: number | null): string => (value === null ? "-" : value.toFixed(2));
const formatPercent = (value: number | null): string => (value === null ? "-" : `${value.toFixed(1)}%`);
const formatQty = (value: number | null): string => (value === null ? "-" : value.toFixed(4));

const pad = (value: string, width: number, alignRight = false) =>
  alignRight ? value.padStart(width, " ") : value.padEnd(width, " ");

const stateText = (value: boolean) => (value ? "true" : "false");

const emptyDiagnostics = (emptyReason: PaperPlanEmptyReason | null = null): PaperPlanDiagnostics => ({
  latestSnapshotAvailable: false,
  latestSnapshotRunId: null,
  latestSnapshotTimestamp: null,
  filtersMatchedSnapshots: false,
  runtimeCandidatesAvailable: false,
  emptyReason
});

const blockerForEmptyReason = (
  emptyReason: PaperPlanEmptyReason | null | undefined
): ReviewBlockerCode => {
  if (
    emptyReason === "NO_RESEARCH_SNAPSHOTS" ||
    emptyReason === "NO_MATCHING_SNAPSHOTS_FOR_FILTERS" ||
    emptyReason === "NO_RUNTIME_CANDIDATES" ||
    emptyReason === "ALL_CANDIDATES_SKIPPED"
  ) {
    return emptyReason;
  }
  return "NO_CANDIDATES_EVALUATED";
};

export const buildPaperReviewReport = async (
  input: PaperReviewInput = {},
  deps: PaperReviewDeps = {}
): Promise<PaperReviewReport> => {
  const config = toConfig(input);
  const state = getTradingSafetyState();
  const builder = deps.buildPlan ?? buildPaperPlanReport;

  const blockers: ReviewBlockerCode[] = [];
  const warnings: ReviewWarningCode[] = [];

  if (state.alpacaEnv !== "paper") {
    blockers.push("NON_PAPER_ENVIRONMENT");
  }

  if (state.liveTradingEnabled) {
    blockers.push("LIVE_TRADING_ENABLED");
  }

  if (
    config.riskProfile === "aggressive" &&
    process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES !== "true"
  ) {
    blockers.push("AGGRESSIVE_MODE_NOT_ENABLED");
  }

  if (config.riskProfile === "aggressive") {
    warnings.push("AGGRESSIVE_MODE_ACTIVE");
  }

  if (config.optionsEnabled) {
    warnings.push("OPTIONS_ENABLED");
  }

  let planReport: PaperPlanReport | null = null;
  if (blockers.length === 0) {
    try {
      planReport = await builder({
        riskProfile: config.riskProfile,
        optionsEnabled: config.optionsEnabled,
        maxCandidates: config.maxCandidates,
        maxNewPositions: config.maxNewPositions,
        maxPositionNotional: config.maxPositionNotional,
        maxTotalPlanNotional: config.maxTotalPlanNotional,
        minBuyingPowerReservePct: config.minBuyingPowerReservePct
      });
    } catch (error) {
      blockers.push("ACCOUNT_UNAVAILABLE");
    }
  }

  if (!planReport) {
    blockers.push("NO_PLAN");

    const review = {
      status: parseReviewStatus(blockers, warnings),
      blockReason: reviewBlockReason(sortUniqueCodes(blockers, REVIEWER_BLOCKERS)),
      blockers: sortUniqueCodes(blockers, [...REVIEWER_BLOCKERS, ...REVIEWER_WARNINGS]),
      warnings: sortUniqueCodes(warnings, REVIEWER_WARNINGS),
      confirmationsRequired: blockers.length
        ? ["Resolve blockers before review is safe for dry-run execution review."]
        : []
    };

    return {
      paperOnly: true,
      environment: state.alpacaEnv,
      generatedAt: new Date().toISOString(),
      reviewOnly: true,
      nonMutating: true,
      config: {
        riskProfile: config.riskProfile,
        optionsEnabled: config.optionsEnabled,
        maxCandidates: config.maxCandidates,
        maxNewPositions: config.maxNewPositions,
        maxPositionNotional: config.maxPositionNotional,
        maxTotalPlanNotional: config.maxTotalPlanNotional,
        minBuyingPowerReservePct: config.minBuyingPowerReservePct,
        maxPlanAgeMinutes: config.maxPlanAgeMinutes,
        maxBuyingPowerUsePct: config.maxBuyingPowerUsePct
      },
      planSummary: {
        candidatesEvaluated: 0,
        plannedOrders: 0,
        watched: 0,
        skipped: 0,
        estimatedTotalNotional: 0,
        buyingPowerUsePct: null,
        remainingDeployableBuyingPower: null
      },
      review,
      risk: {
        concentrationWarnings: [],
        duplicateExposureWarnings: [],
        staleDataWarnings: [],
        aggressiveModeWarnings: sortUniqueCodes(
          warnings.filter((warning) => warning === "AGGRESSIVE_MODE_ACTIVE"),
          ["AGGRESSIVE_MODE_ACTIVE"]
        ),
        optionsWarnings: sortUniqueCodes(
          warnings.filter(
            (warning) =>
              warning === "OPTIONS_ENABLED" ||
              warning === "OPTIONS_PLANNING_NOT_IMPLEMENTED" ||
              warning === "SPECULATIVE_OPTION_PAPER_WARNING" ||
              warning === "OPTION_WIDE_SPREAD_WARNING" ||
              warning === "OPTION_0DTE_PAPER_WARNING"
          ),
          [
            "OPTIONS_ENABLED",
            "OPTIONS_PLANNING_NOT_IMPLEMENTED",
            "SPECULATIVE_OPTION_PAPER_WARNING",
            "OPTION_WIDE_SPREAD_WARNING",
            "OPTION_0DTE_PAPER_WARNING"
          ]
        ),
        buyingPowerWarnings: []
      },
      candidateCounts: emptyCandidateCounts(),
      topSkipReasons: [],
      executionReadiness: {
        equity: {
          eligible: 0,
          blocked: 0
        },
        options: {
          eligible: 0,
          blocked: 0,
          blockers: []
        }
      },
      plan: [],
      source: {},
      diagnostics: emptyDiagnostics()
    };
  }

  if (!isPaperPlanReport(planReport)) {
    blockers.push("MALFORMED_PLAN");
  }

  if (planReport.environment !== "paper") {
    blockers.push("NON_PAPER_ENVIRONMENT");
  }

  if (!planReport.paperOnly) {
    blockers.push("MALFORMED_PLAN");
  }

  if (!planReport.dryRun) {
    blockers.push("PLAN_NOT_DRY_RUN");
  }

  if (!planReport.nonMutating) {
    blockers.push("PLAN_NOT_NON_MUTATING");
  }

  const ageMinutes = normalizeDate(planReport.generatedAt);
  if (ageMinutes === null || ageMinutes > config.maxPlanAgeMinutes) {
    blockers.push("PLAN_STALE");
  }

  const summary: PaperReviewPlanSummary = {
    candidatesEvaluated: planReport.summary?.candidatesEvaluated ?? 0,
    plannedOrders: planReport.summary?.plannedOrders ?? 0,
    watched: planReport.summary?.watched ?? 0,
    skipped: planReport.summary?.skipped ?? 0,
    estimatedTotalNotional: planReport.summary?.estimatedTotalNotional ?? 0,
    buyingPowerUsePct: null,
    remainingDeployableBuyingPower: planReport.account?.deployableBuyingPower ?? null
  };

  const buyingPower = planReport.account?.buyingPower;
  const deployableBuyingPower = planReport.account?.deployableBuyingPower;

  const accountAvailable =
    typeof buyingPower === "number" && typeof deployableBuyingPower === "number";

  if (!accountAvailable) {
    blockers.push("ACCOUNT_UNAVAILABLE");
  }

  if (summary.candidatesEvaluated === 0) {
    blockers.push(blockerForEmptyReason(planReport.diagnostics?.emptyReason));
    if (!planReport.source?.snapshotRunId && !planReport.source?.recommendationTimestamp) {
      warnings.push("EMPTY_SNAPSHOT_HISTORY");
    }
  }

  if (summary.plannedOrders === 0 && summary.candidatesEvaluated > 0) {
    if (planReport.diagnostics?.emptyReason === "ALL_CANDIDATES_SKIPPED") {
      blockers.push("ALL_CANDIDATES_SKIPPED");
    }
    blockers.push("NO_PLANNED_ORDERS");
  }

  if (summary.estimatedTotalNotional > planReport.config.maxTotalPlanNotional) {
    blockers.push("MAX_TOTAL_PLAN_NOTIONAL_EXCEEDED");
  }

  if (accountAvailable) {
    if (deployableBuyingPower <= 0) {
      blockers.push("BUYING_POWER_UNKNOWN");
    } else {
      const buyingPowerUsePct = (summary.estimatedTotalNotional / deployableBuyingPower) * 100;
      if (!Number.isFinite(buyingPowerUsePct) || buyingPowerUsePct < 0) {
        blockers.push("BUYING_POWER_UNKNOWN");
      } else {
        summary.buyingPowerUsePct = Number(Math.max(0, buyingPowerUsePct).toFixed(2));
        if (buyingPowerUsePct > config.maxBuyingPowerUsePct) {
          blockers.push("MAX_BUYING_POWER_USE_EXCEEDED");
        } else if (buyingPowerUsePct >= config.maxBuyingPowerUsePct * 0.8) {
          warnings.push("ELEVATED_BUYING_POWER_USE");
        }
      }
    }

    if (typeof buyingPower === "number" && buyingPower <= 0) {
      blockers.push("BUYING_POWER_UNKNOWN");
    }
  }

  const recommendationTimestamp = planReport.source?.recommendationTimestamp;
  if (recommendationTimestamp && !isDateMissingOrRecent(recommendationTimestamp, config.maxPlanAgeMinutes)) {
    warnings.push("SOURCE_MARKET_DATA_LOOKBACK");
  }

  if (summary.skipped > 0) {
    warnings.push("SKIPPED_CANDIDATES_PRESENT");
  }

  if (summary.watched > 0) {
    warnings.push("WATCHED_CANDIDATES_PRESENT");
  }

  if (
    planReport.plan.some((candidate) =>
      candidate.reasonCodes.includes("OPTIONS_PLANNING_NOT_IMPLEMENTED")
    )
  ) {
    warnings.push("OPTIONS_PLANNING_NOT_IMPLEMENTED");
  }

  if (
    planReport.plan.some((candidate) =>
      candidate.reasonCodes.includes("SPECULATIVE_OPTION_PAPER_WARNING")
    )
  ) {
    warnings.push("SPECULATIVE_OPTION_PAPER_WARNING");
  }

  if (
    planReport.plan.some((candidate) =>
      candidate.reasonCodes.includes("OPTION_WIDE_SPREAD_WARNING")
    )
  ) {
    warnings.push("OPTION_WIDE_SPREAD_WARNING");
  }

  if (
    planReport.plan.some((candidate) =>
      candidate.reasonCodes.includes("OPTION_0DTE_ALLOWED")
    )
  ) {
    warnings.push("OPTION_0DTE_PAPER_WARNING");
  }

  const { concentratedSymbols, plannedTotalNotional } = concentrationAnalysis(
    planReport.plan,
    config.maxSingleSymbolPlanPct
  );

  if (plannedTotalNotional > 0 && concentratedSymbols.size > 0) {
    warnings.push("CONCENTRATION_WARNING");
  }

  const duplicateExposure = duplicateExposureDetected(planReport.plan);
  if (duplicateExposure.duplicateExposureWarnings) {
    warnings.push("DUPLICATE_EXPOSURE_WARNING");
  }

  const status = parseReviewStatus(
    [...new Set(blockers)],
    [...new Set(warnings)]
  );

  const orderedBlockers = sortUniqueCodes(blockers, REVIEWER_BLOCKERS);
  const orderedWarnings = sortUniqueCodes(warnings, REVIEWER_WARNINGS);
  const executionReadiness = buildExecutionReadiness(planReport.plan);
  const candidateCounts = buildCandidateCounts(planReport.plan, summary, executionReadiness);
  const topSkipReasons = buildTopSkipReasons(planReport.plan);
  const blockReason = reviewBlockReason(orderedBlockers);

  const review = {
    status,
    blockReason,
    blockers: orderedBlockers,
    warnings: orderedWarnings,
    confirmationsRequired:
      status === "ready_for_dry_run_execution"
        ? []
        : [
            status === "blocked"
              ? blockReason === "NO_ELIGIBLE_PAPER_PAYLOADS"
                ? "No eligible paper payloads after candidate filtering; no orders should be submitted."
                : "Resolve blockers before running paper:review with a fresh execution plan."
              : "Review this plan and manually confirm elevated risk signals before dry-run execution review."
          ]
  };

  const reviewPlan: PaperReviewCandidate[] = planReport.plan.map((candidate) => ({
    symbol: candidate.symbol,
    decision: candidate.decision,
    estimatedNotional: candidate.estimatedNotional,
    estimatedQty: candidate.estimatedQty,
    reasonCodes: [...new Set(candidate.reasonCodes)].sort(),
    reviewFlags: buildReviewFlags(candidate, concentratedSymbols)
  }));

  const riskFlags = {
    concentrationWarnings: sortUniqueCodes(
      orderedWarnings.includes("CONCENTRATION_WARNING") ? ["CONCENTRATION_WARNING"] : [],
      REVIEWER_WARNINGS
    ),
    duplicateExposureWarnings: sortUniqueCodes(
      orderedWarnings.includes("DUPLICATE_EXPOSURE_WARNING")
        ? ["DUPLICATE_EXPOSURE_WARNING"]
        : [],
      REVIEWER_WARNINGS
    ),
    staleDataWarnings: sortUniqueCodes(
      orderedWarnings.includes("EMPTY_SNAPSHOT_HISTORY") ||
        orderedWarnings.includes("SOURCE_MARKET_DATA_LOOKBACK") ||
        orderedWarnings.includes("STALE_RECOMMENDATION_SOURCE")
        ? [
            ...(orderedWarnings.includes("EMPTY_SNAPSHOT_HISTORY") ? ["EMPTY_SNAPSHOT_HISTORY"] : []),
            ...(orderedWarnings.includes("SOURCE_MARKET_DATA_LOOKBACK")
              ? ["SOURCE_MARKET_DATA_LOOKBACK"]
              : []),
            ...(orderedWarnings.includes("STALE_RECOMMENDATION_SOURCE")
              ? ["STALE_RECOMMENDATION_SOURCE"]
              : [])
          ]
        : [],
      REVIEWER_WARNINGS
    ),
    aggressiveModeWarnings: sortUniqueCodes(
      orderedWarnings.includes("AGGRESSIVE_MODE_ACTIVE") ? ["AGGRESSIVE_MODE_ACTIVE"] : [],
      REVIEWER_WARNINGS
    ),
    optionsWarnings: sortUniqueCodes(
      orderedWarnings.includes("OPTIONS_ENABLED") ||
        orderedWarnings.includes("OPTIONS_PLANNING_NOT_IMPLEMENTED") ||
        orderedWarnings.includes("SPECULATIVE_OPTION_PAPER_WARNING") ||
        orderedWarnings.includes("OPTION_WIDE_SPREAD_WARNING") ||
        orderedWarnings.includes("OPTION_0DTE_PAPER_WARNING")
        ? [
            ...(orderedWarnings.includes("OPTIONS_ENABLED") ? ["OPTIONS_ENABLED"] : []),
            ...(orderedWarnings.includes("OPTIONS_PLANNING_NOT_IMPLEMENTED")
              ? ["OPTIONS_PLANNING_NOT_IMPLEMENTED"]
              : []),
            ...(orderedWarnings.includes("SPECULATIVE_OPTION_PAPER_WARNING")
              ? ["SPECULATIVE_OPTION_PAPER_WARNING"]
              : []),
            ...(orderedWarnings.includes("OPTION_WIDE_SPREAD_WARNING")
              ? ["OPTION_WIDE_SPREAD_WARNING"]
              : []),
            ...(orderedWarnings.includes("OPTION_0DTE_PAPER_WARNING")
              ? ["OPTION_0DTE_PAPER_WARNING"]
              : [])
          ]
        : [],
      REVIEWER_WARNINGS
    ),
    buyingPowerWarnings: sortUniqueCodes(
      orderedWarnings.includes("ELEVATED_BUYING_POWER_USE") ? ["ELEVATED_BUYING_POWER_USE"] : [],
      REVIEWER_WARNINGS
    )
  };

  return {
    paperOnly: true,
    environment: planReport.environment,
    generatedAt: new Date().toISOString(),
    reviewOnly: true,
    nonMutating: true,
    config: {
      riskProfile: config.riskProfile,
      optionsEnabled: config.optionsEnabled,
      maxCandidates: config.maxCandidates,
      maxNewPositions: config.maxNewPositions,
      maxPositionNotional: config.maxPositionNotional,
      maxTotalPlanNotional: config.maxTotalPlanNotional,
      minBuyingPowerReservePct: config.minBuyingPowerReservePct,
      maxPlanAgeMinutes: config.maxPlanAgeMinutes,
      maxBuyingPowerUsePct: config.maxBuyingPowerUsePct
    },
    planSummary: summary,
    review,
    risk: riskFlags,
    candidateCounts,
    topSkipReasons,
    executionReadiness,
    plan: reviewPlan,
    source: {
      snapshotRunId: planReport.source?.snapshotRunId ?? null,
      recommendationTimestamp: planReport.source?.recommendationTimestamp ?? null,
      runtimeTimestamp: planReport.source?.runtimeTimestamp ?? null,
      planTimestamp: planReport.generatedAt
    },
    diagnostics: planReport.diagnostics ?? emptyDiagnostics()
  };
};

export const formatPaperReviewReportAsTable = (report: PaperReviewReport) => {
  const lines: string[] = [];
  lines.push("Paper Review (non-mutating)");
  lines.push(`Status: ${report.review.status}`);
  lines.push(`Environment: ${report.environment}`);
  lines.push(`Paper Only: ${stateText(report.paperOnly)}`);
  lines.push(`Review Only: ${stateText(report.reviewOnly)}`);
  lines.push(`Non-Mutating: ${stateText(report.nonMutating)}`);
  lines.push(`Planned orders: ${report.planSummary.plannedOrders}`);
  lines.push(`Estimated notional: ${formatMoney(report.planSummary.estimatedTotalNotional)}`);
  lines.push(`Buying power use: ${formatPercent(report.planSummary.buyingPowerUsePct)}`);
  lines.push(`Block reason: ${report.review.blockReason || "none"}`);
  lines.push(
    `Candidate counts: input=${report.candidateCounts.inputCandidates}, planned=${report.candidateCounts.plannedOrders}, eligiblePayloads=${report.candidateCounts.eligiblePayloads}, alreadyHeld=${report.candidateCounts.skippedAlreadyHeld}, alreadyHeldEquity=${report.candidateCounts.skippedAlreadyHeldEquity}, alreadyHeldOptionContract=${report.candidateCounts.skippedAlreadyHeldOptionContract}, underlyingEquityHeldForOption=${report.candidateCounts.skippedUnderlyingEquityHeldForOption}, duplicateOpenEquityOrder=${report.candidateCounts.skippedDuplicateOpenEquityOrder}, duplicateOpenOptionOrder=${report.candidateCounts.skippedDuplicateOpenOptionOrder}, quoteUnavailable=${report.candidateCounts.skippedQuoteUnavailable}`
  );
  lines.push(`Top skip reasons: ${report.topSkipReasons.length ? report.topSkipReasons.join(", ") : "none"}`);
  if (report.executionReadiness) {
    lines.push(
      `Execution readiness: equity eligible=${report.executionReadiness.equity.eligible}, equity blocked=${report.executionReadiness.equity.blocked}, options eligible=${report.executionReadiness.options.eligible}, options blocked=${report.executionReadiness.options.blocked}`
    );
  }
  lines.push(`Plan diagnostic: ${report.diagnostics.emptyReason || "none"}`);
  lines.push(
    `Latest snapshot: ${report.diagnostics.latestSnapshotRunId || "none"}; filters matched: ${stateText(report.diagnostics.filtersMatchedSnapshots)}; runtime candidates: ${stateText(report.diagnostics.runtimeCandidatesAvailable)}`
  );

  lines.push("Blockers:");
  if (!report.review.blockers.length) {
    lines.push("- None");
  } else {
    for (const blocker of report.review.blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  lines.push("Warnings:");
  if (!report.review.warnings.length) {
    lines.push("- None");
  } else {
    for (const warning of report.review.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("Plan:");
  if (!report.plan.length) {
    lines.push("- None");
  } else {
    lines.push(
      [
        pad("Rank", 6, true),
        pad("Symbol", 10),
        pad("Decision", 8),
        pad("Est Qty", 12, true),
        pad("Est Notional", 14, true),
        "Review Flags"
      ].join(" ")
    );

    report.plan.forEach((entry, index) => {
      lines.push(
        [
          pad(String(index + 1), 6, true),
          pad(entry.symbol, 10),
          pad(entry.decision, 8),
          pad(formatQty(entry.estimatedQty), 12, true),
          pad(formatMoney(entry.estimatedNotional), 14, true),
          entry.reviewFlags.join(", ") || "—"
        ].join(" ")
      );
    });
  }

  lines.push("Review only. No orders were submitted.");
  return lines.join("\n");
};
