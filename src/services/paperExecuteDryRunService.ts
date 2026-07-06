import {
  buildPaperPlanReport,
  type PaperPlanCandidate,
  type PaperPlanReport
} from "./paperPlanService.js";
import {
  buildPaperReviewReport,
  type PaperReviewReport,
  type PaperReviewStatus
} from "./paperReviewService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";
import {
  getAccount,
  getOptionContract,
  listRecentPaperOrders,
  listPaperPositions,
  submitPaperOrder,
  AlpacaApiError,
  type AlpacaAccountRaw,
  type AlpacaOptionContractRaw,
  type AlpacaPaperOrderRequest,
  type AlpacaPositionRaw,
  type AlpacaSubmittedOrder
} from "./alpacaClient.js";
import {
  findPaperExecutionByDedupeKey,
  insertPaperExecutionLedgerEntry,
  updatePaperExecutionLedgerEntry
} from "./paperExecutionLedgerService.js";
import { optionsQuoteConfig, roundOptionLimitPrice } from "./optionQuoteNormalizer.js";
import type { RiskProfile } from "../types.js";

type PaperExecuteFormat = "table" | "json";
type PaperExecuteAssetClassFilter = "all" | "equity" | "option";
type PaperExecuteDryRunStatus = "ready" | "blocked" | "no_op";
type PaperExecuteConfirmStatus = "submitted" | "partial" | "blocked" | "no_op";

export type PaperExecuteBlockerCode =
  | "DRY_RUN_OR_CONFIRM_PAPER_REQUIRED"
  | "REVIEW_BLOCKED"
  | "PAPER_REVIEW_BLOCKED"
  | "NO_PLANNED_ORDERS"
  | "NO_ELIGIBLE_PAPER_PAYLOADS"
  | "NON_PAPER_ENVIRONMENT"
  | "PAPER_ENV_REQUIRED"
  | "LIVE_TRADING_ENABLED"
  | "LIVE_TRADING_MUST_BE_DISABLED"
  | "PAPER_ORDER_EXECUTION_DISABLED"
  | "PAPER_OPTIONS_EXECUTION_DISABLED"
  | "PLAN_NOT_DRY_RUN"
  | "PLAN_NOT_NON_MUTATING"
  | "REVIEW_NOT_REVIEW_ONLY"
  | "REVIEW_NOT_NON_MUTATING"
  | "ORDER_PAYLOAD_INVALID"
  | "OPTIONS_APPROVAL_LEVEL_INSUFFICIENT"
  | "OPTION_CONTRACT_NOT_FOUND"
  | "OPTION_CONTRACT_NOT_TRADABLE"
  | "OPTION_LIMIT_PRICE_REQUIRED"
  | "OPTION_LIMIT_PRICE_UNAVAILABLE"
  | "OPTION_SPREAD_TOO_WIDE"
  | "OPTION_0DTE_NOT_ENABLED"
  | "UNSUPPORTED_OPTION_STRATEGY"
  | "OPTION_RISK_LIMIT_EXCEEDED"
  | "ALPACA_PAPER_ORDER_SUBMISSION_FAILED"
  | "DUPLICATE_PAPER_ORDER_BLOCKED"
  | "UNSUPPORTED_ASSET_CLASS"
  | "CLIENT_ORDER_ID_INVALID";

type PaperExecuteInfoCode =
  | "PAPER_ENV_CONFIRMED"
  | "LIVE_TRADING_DISABLED"
  | "DRY_RUN_CONFIRMED"
  | "PLAN_ACCEPTED"
  | "REVIEW_ACCEPTED"
  | "PAYLOAD_CONSTRUCTED"
  | "NO_MUTATION_PERFORMED";

interface PaperExecuteInput {
  dryRun?: boolean;
  confirmPaper?: boolean;
  assetClass?: PaperExecuteAssetClassFilter;
  riskProfile?: RiskProfile;
  optionsEnabled?: boolean;
  maxCandidates?: number;
  maxNewPositions?: number;
  maxPositionNotional?: number;
  maxTotalPlanNotional?: number;
  minBuyingPowerReservePct?: number;
  maxPlanAgeMinutes?: number;
  maxBuyingPowerUsePct?: number;
  format?: PaperExecuteFormat;
}

interface PaperExecuteConfig {
  riskProfile?: RiskProfile;
  optionsEnabled?: boolean;
  maxCandidates?: number;
  maxNewPositions?: number;
  maxPositionNotional?: number;
  maxTotalPlanNotional?: number;
  minBuyingPowerReservePct?: number;
  maxPlanAgeMinutes?: number;
  maxBuyingPowerUsePct?: number;
}

export interface AlpacaOrderPayloadDryRun {
  assetClass: "equity" | "option";
  symbol: string;
  underlyingSymbol?: string;
  strategy?: string;
  maxRisk?: string;
  bidAskSpreadPct?: number | null;
  side: "buy" | "sell";
  type: "market" | "limit";
  time_in_force: "day";
  notional?: string;
  qty?: string;
  limit_price?: string;
  position_intent?: "buy_to_open" | "sell_to_open";
  estimatedPremium?: string;
  client_order_id: string;
  sourceCandidateId?: string;
  dedupeKey: string;
}

export interface BlockedPayload {
  assetClass?: "equity" | "option";
  symbol: string;
  underlyingSymbol?: string;
  strategy?: string;
  reasonCodes: PaperExecuteBlockerCode[];
  explanation: string;
}

export interface PaperExecuteDryRunReport {
  paperOnly: true;
  environment: "paper" | "live";
  generatedAt: string;
  dryRun: boolean;
  nonMutating: true;
  executionMode: "dryRun";
  assetClass: PaperExecuteAssetClassFilter;
  status: PaperExecuteDryRunStatus;
  reason: PaperExecuteBlockerCode | null;
  reviewStatus: PaperReviewStatus | "blocked";
  blockers: PaperExecuteBlockerCode[];
  warnings: string[];
  confirmations: PaperExecuteInfoCode[];
  summary: {
    plannedOrdersFromPlan: number;
    payloadsConstructed: number;
    payloadsBlocked: number;
    estimatedTotalNotional: number;
    wouldSubmitCount: number;
  };
  candidateCounts?: PaperReviewReport["candidateCounts"];
  topSkipReasons?: string[];
  wouldSubmit: AlpacaOrderPayloadDryRun[];
  blockedPayloads: BlockedPayload[];
  source: {
    snapshotRunId?: string | null;
    recommendationTimestamp?: string | null;
    runtimeTimestamp?: string | null;
    planTimestamp?: string | null;
    reviewTimestamp?: string | null;
  };
}

interface PaperExecuteDeps {
  buildPlan?: (input: PaperExecuteConfig) => Promise<PaperPlanReport>;
  buildReview?: typeof buildPaperReviewReport;
  now?: () => string;
}

interface PaperConfirmDeps extends PaperExecuteDeps {
  getAccount?: typeof getAccount;
  getOptionContract?: typeof getOptionContract;
  listRecentPaperOrders?: typeof listRecentPaperOrders;
  listPaperPositions?: typeof listPaperPositions;
  submitPaperOrder?: typeof submitPaperOrder;
}

const BLOCKER_ORDER: PaperExecuteBlockerCode[] = [
  "DRY_RUN_OR_CONFIRM_PAPER_REQUIRED",
  "REVIEW_BLOCKED",
  "PAPER_REVIEW_BLOCKED",
  "NO_PLANNED_ORDERS",
  "NO_ELIGIBLE_PAPER_PAYLOADS",
  "NON_PAPER_ENVIRONMENT",
  "PAPER_ENV_REQUIRED",
  "LIVE_TRADING_ENABLED",
  "LIVE_TRADING_MUST_BE_DISABLED",
  "PAPER_ORDER_EXECUTION_DISABLED",
  "PAPER_OPTIONS_EXECUTION_DISABLED",
  "PLAN_NOT_DRY_RUN",
  "PLAN_NOT_NON_MUTATING",
  "REVIEW_NOT_REVIEW_ONLY",
  "REVIEW_NOT_NON_MUTATING",
  "ORDER_PAYLOAD_INVALID",
  "OPTIONS_APPROVAL_LEVEL_INSUFFICIENT",
  "OPTION_CONTRACT_NOT_FOUND",
  "OPTION_CONTRACT_NOT_TRADABLE",
  "OPTION_LIMIT_PRICE_REQUIRED",
  "OPTION_LIMIT_PRICE_UNAVAILABLE",
  "OPTION_SPREAD_TOO_WIDE",
  "OPTION_0DTE_NOT_ENABLED",
  "UNSUPPORTED_OPTION_STRATEGY",
  "OPTION_RISK_LIMIT_EXCEEDED",
  "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
  "DUPLICATE_PAPER_ORDER_BLOCKED",
  "UNSUPPORTED_ASSET_CLASS",
  "CLIENT_ORDER_ID_INVALID"
];

const INFO_ORDER: PaperExecuteInfoCode[] = [
  "PAPER_ENV_CONFIRMED",
  "LIVE_TRADING_DISABLED",
  "DRY_RUN_CONFIRMED",
  "PLAN_ACCEPTED",
  "REVIEW_ACCEPTED",
  "PAYLOAD_CONSTRUCTED",
  "NO_MUTATION_PERFORMED"
];

const sortUnique = <T extends string>(values: readonly T[], order: readonly T[]): T[] => {
  const rank = new Map(order.map((entry, index) => [entry, index]));
  return [...new Set(values)].sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
  });
};

const normalizeDateForClientOrderId = (value: string): string => {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const pad = (input: number) => String(input).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join("");
};

const safeClientIdPart = (value: string | null | undefined, fallback: string): string => {
  const cleaned = String(value || "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
};

const buildClientOrderId = (input: {
  runId?: string | null;
  assetClass: "equity" | "option";
  symbol: string;
  timestamp: string;
  index: number;
}) => {
  const runPart = safeClientIdPart(input.runId, "local").slice(0, 16);
  const symbolPart = safeClientIdPart(input.symbol, "symbol").slice(0, 32);
  const timestamp = normalizeDateForClientOrderId(input.timestamp);
  return `paper-${input.assetClass}-${symbolPart}-${runPart}-${timestamp}-${input.index + 1}`;
};

const isClientOrderIdValid = (value: string) =>
  value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);

const buildDedupeKey = (input: {
  runId?: string | null;
  assetClass: "equity" | "option";
  symbol: string;
  strategy?: string | null;
}) =>
  [
    "paper",
    input.assetClass,
    safeClientIdPart(input.symbol, "symbol"),
    safeClientIdPart(input.strategy, "simple"),
    safeClientIdPart(input.runId, "local")
  ].join(":");

const moneyString = (value: number) => value.toFixed(2);

const qtyString = (value: number) => {
  const fixed = value.toFixed(6);
  return fixed.replace(/\.?0+$/g, "");
};

const normalizeAssetClassFilter = (
  value: PaperExecuteAssetClassFilter | undefined
): PaperExecuteAssetClassFilter =>
  value === "equity" || value === "option" || value === "all" ? value : "all";

const candidateMatchesAssetFilter = (
  candidate: PaperPlanCandidate,
  filter: PaperExecuteAssetClassFilter
) => {
  if (filter === "all") {
    return true;
  }
  if (filter === "equity") {
    return candidate.assetClass === "us_equity";
  }
  return candidate.assetClass === "option";
};

const emptyReport = (input: {
  generatedAt: string;
  dryRun: boolean;
  environment: "paper" | "live";
  assetClass?: PaperExecuteAssetClassFilter;
  status?: PaperExecuteDryRunStatus;
  reason?: PaperExecuteBlockerCode | null;
  reviewStatus?: PaperReviewStatus | "blocked";
  blockers?: PaperExecuteBlockerCode[];
  warnings?: string[];
  confirmations?: PaperExecuteInfoCode[];
  plannedOrdersFromPlan?: number;
  estimatedTotalNotional?: number;
  candidateCounts?: PaperReviewReport["candidateCounts"];
  topSkipReasons?: string[];
  source?: PaperExecuteDryRunReport["source"];
}): PaperExecuteDryRunReport => ({
  paperOnly: true,
  environment: input.environment,
  generatedAt: input.generatedAt,
  dryRun: input.dryRun,
  nonMutating: true,
  executionMode: "dryRun",
  assetClass: input.assetClass || "all",
  status: input.status || ((input.blockers?.length || 0) > 0 ? "blocked" : "ready"),
  reason: input.reason ?? null,
  reviewStatus: input.reviewStatus || "blocked",
  blockers: sortUnique(input.blockers || [], BLOCKER_ORDER),
  warnings: [...new Set(input.warnings || [])],
  confirmations: sortUnique(input.confirmations || ["NO_MUTATION_PERFORMED"], INFO_ORDER),
  summary: {
    plannedOrdersFromPlan: input.plannedOrdersFromPlan || 0,
    payloadsConstructed: 0,
    payloadsBlocked: 0,
    estimatedTotalNotional: input.estimatedTotalNotional || 0,
    wouldSubmitCount: 0
  },
  candidateCounts: input.candidateCounts,
  topSkipReasons: input.topSkipReasons,
  wouldSubmit: [],
  blockedPayloads: [],
  source: input.source || {}
});

const blockPayload = (
  symbol: string,
  reasonCodes: PaperExecuteBlockerCode[],
  explanation: string,
  metadata: {
    assetClass?: "equity" | "option";
    underlyingSymbol?: string;
    strategy?: string;
  } = {}
): BlockedPayload => ({
  assetClass: metadata.assetClass,
  symbol,
  underlyingSymbol: metadata.underlyingSymbol,
  strategy: metadata.strategy,
  reasonCodes: sortUnique(reasonCodes, BLOCKER_ORDER),
  explanation
});

const buildPayloadForCandidate = (
  candidate: PaperPlanCandidate,
  source: PaperExecuteDryRunReport["source"],
  index: number
): { payload: AlpacaOrderPayloadDryRun | null; blocked: BlockedPayload | null } => {
  if (candidate.assetClass === "option") {
    const strategy = candidate.strategy || candidate.recommendation?.split(" ").at(-1) || "";
    const optionSymbol = candidate.optionSymbol || candidate.symbol;
    const clientOrderId = buildClientOrderId({
      runId: source.snapshotRunId,
      assetClass: "option",
      symbol: optionSymbol,
      timestamp: source.planTimestamp || source.reviewTimestamp || new Date().toISOString(),
      index
    });
    if (!isClientOrderIdValid(clientOrderId)) {
      return {
        payload: null,
        blocked: blockPayload(
          optionSymbol,
          ["CLIENT_ORDER_ID_INVALID"],
          "Generated client_order_id failed local validation.",
          {
            assetClass: "option",
            underlyingSymbol: candidate.underlyingSymbol || candidate.symbol,
            strategy
          }
        )
      };
    }

    if (!isSupportedOptionStrategy(strategy)) {
      return {
        payload: null,
        blocked: blockPayload(
          optionSymbol,
          ["UNSUPPORTED_OPTION_STRATEGY"],
          "Only single-leg long calls, long puts, covered calls, and cash-secured puts are eligible.",
          {
            assetClass: "option",
            underlyingSymbol: candidate.underlyingSymbol || candidate.symbol,
            strategy
          }
        )
      };
    }

    const optionCfg = optionExecutionConfig();
    if (candidate.orderType !== "limit" && !optionCfg.allowMarketOrders) {
      return {
        payload: null,
        blocked: blockPayload(
          optionSymbol,
          ["OPTION_LIMIT_PRICE_REQUIRED"],
          "Options paper execution requires an explicit limit price.",
          {
            assetClass: "option",
            underlyingSymbol: candidate.underlyingSymbol || candidate.symbol,
            strategy
          }
        )
      };
    }

    if (
      candidate.orderType === "limit" &&
      (typeof candidate.limitPrice !== "number" || candidate.limitPrice <= 0)
    ) {
      return {
        payload: null,
        blocked: blockPayload(
          optionSymbol,
          ["OPTION_LIMIT_PRICE_UNAVAILABLE"],
          "Options paper execution requires a usable option limit price.",
          {
            assetClass: "option",
            underlyingSymbol: candidate.underlyingSymbol || candidate.symbol,
            strategy
          }
        )
      };
    }

    const executablePrice =
      typeof candidate.executablePrice === "number" && candidate.executablePrice > 0
        ? roundOptionLimitPrice(candidate.executablePrice)
        : null;
    if (
      candidate.quoteStatus !== "valid" ||
      candidate.executable !== true ||
      executablePrice === null
    ) {
      return {
        payload: null,
        blocked: blockPayload(
          optionSymbol,
          ["OPTION_LIMIT_PRICE_UNAVAILABLE"],
          `Options paper execution requires a valid executable quote${
            candidate.rejectionReason ? ` (${candidate.rejectionReason})` : ""
          }.`,
          {
            assetClass: "option",
            underlyingSymbol: candidate.underlyingSymbol || candidate.symbol,
            strategy
          }
        )
      };
    }

    if (typeof candidate.maxRisk !== "number" || candidate.maxRisk < 0) {
      return {
        payload: null,
        blocked: blockPayload(
          optionSymbol,
          ["OPTION_RISK_LIMIT_EXCEEDED"],
          "Options paper execution requires calculable max risk within configured caps.",
          {
            assetClass: "option",
            underlyingSymbol: candidate.underlyingSymbol || candidate.symbol,
            strategy
          }
        )
      };
    }

    const qty = candidate.contracts && candidate.contracts > 0 ? candidate.contracts : 1;
    return {
      payload: {
        assetClass: "option",
        symbol: optionSymbol,
        underlyingSymbol: candidate.underlyingSymbol || candidate.symbol,
        strategy,
        side: candidate.side,
        type: candidate.orderType,
        time_in_force: candidate.timeInForce,
        qty: qtyString(qty),
        limit_price:
          candidate.orderType === "limit"
            ? moneyString(executablePrice)
            : undefined,
        position_intent: candidate.side === "buy" ? "buy_to_open" : "sell_to_open",
        client_order_id: clientOrderId,
        estimatedPremium:
          typeof candidate.estimatedPremium === "number"
            ? moneyString(candidate.estimatedPremium)
            : undefined,
        maxRisk: moneyString(candidate.maxRisk),
        bidAskSpreadPct: candidate.bidAskSpreadPct ?? null,
        sourceCandidateId: source.snapshotRunId || undefined,
        dedupeKey: buildDedupeKey({
          runId: source.snapshotRunId,
          assetClass: "option",
          symbol: optionSymbol,
          strategy
        })
      },
      blocked: null
    };
  }

  if (candidate.assetClass !== "us_equity") {
    return {
      payload: null,
      blocked: blockPayload(
        candidate.symbol,
        ["UNSUPPORTED_ASSET_CLASS"],
        `Unsupported asset class for dry-run payload construction: ${candidate.assetClass}.`,
        {
          assetClass: "equity"
        }
      )
    };
  }

  const clientOrderId = buildClientOrderId({
    runId: source.snapshotRunId,
    assetClass: "equity",
    symbol: candidate.symbol,
    timestamp: source.planTimestamp || source.reviewTimestamp || new Date().toISOString(),
    index
  });
  if (!isClientOrderIdValid(clientOrderId)) {
    return {
      payload: null,
      blocked: blockPayload(
        candidate.symbol,
        ["CLIENT_ORDER_ID_INVALID"],
        "Generated client_order_id failed local validation.",
        {
          assetClass: "equity"
        }
      )
    };
  }

  if (typeof candidate.estimatedNotional === "number" && candidate.estimatedNotional > 0) {
    return {
      payload: {
        assetClass: "equity",
        symbol: candidate.symbol,
        side: "buy",
        type: candidate.orderType,
        time_in_force: candidate.timeInForce,
        notional: moneyString(candidate.estimatedNotional),
        client_order_id: clientOrderId,
        dedupeKey: buildDedupeKey({
          runId: source.snapshotRunId,
          assetClass: "equity",
          symbol: candidate.symbol
        })
      },
      blocked: null
    };
  }

  if (typeof candidate.estimatedQty === "number" && candidate.estimatedQty > 0) {
    return {
      payload: {
        assetClass: "equity",
        symbol: candidate.symbol,
        side: "buy",
        type: candidate.orderType,
        time_in_force: candidate.timeInForce,
        qty: qtyString(candidate.estimatedQty),
        client_order_id: clientOrderId,
        dedupeKey: buildDedupeKey({
          runId: source.snapshotRunId,
          assetClass: "equity",
          symbol: candidate.symbol
        })
      },
      blocked: null
    };
  }

  return {
    payload: null,
    blocked: blockPayload(
      candidate.symbol,
      ["ORDER_PAYLOAD_INVALID"],
      "Planned candidate is missing positive estimated notional or quantity.",
      {
        assetClass: "equity"
      }
    )
  };
};

export const buildPaperExecuteDryRunReport = async (
  input: PaperExecuteInput = {},
  deps: PaperExecuteDeps = {}
): Promise<PaperExecuteDryRunReport> => {
  const generatedAt = deps.now?.() || new Date().toISOString();
  const dryRun = input.dryRun === true;
  const assetClass = normalizeAssetClassFilter(input.assetClass);
  const state = getTradingSafetyState();
  const blockers: PaperExecuteBlockerCode[] = [];
  const confirmations: PaperExecuteInfoCode[] = ["NO_MUTATION_PERFORMED"];

  if (!dryRun) {
    blockers.push("DRY_RUN_OR_CONFIRM_PAPER_REQUIRED");
  } else {
    confirmations.push("DRY_RUN_CONFIRMED");
  }

  if (state.alpacaEnv !== "paper") {
    blockers.push("PAPER_ENV_REQUIRED");
    blockers.push("NON_PAPER_ENVIRONMENT");
  } else {
    confirmations.push("PAPER_ENV_CONFIRMED");
  }

  if (state.liveTradingEnabled) {
    blockers.push("LIVE_TRADING_MUST_BE_DISABLED");
    blockers.push("LIVE_TRADING_ENABLED");
  } else {
    confirmations.push("LIVE_TRADING_DISABLED");
  }

  if (blockers.length > 0) {
    return emptyReport({
      generatedAt,
      dryRun,
      environment: state.alpacaEnv,
      assetClass,
      blockers,
      confirmations
    });
  }

  const planInput: PaperExecuteConfig = {
    riskProfile: input.riskProfile,
    optionsEnabled: input.optionsEnabled,
    maxCandidates: input.maxCandidates,
    maxNewPositions: input.maxNewPositions,
    maxPositionNotional: input.maxPositionNotional,
    maxTotalPlanNotional: input.maxTotalPlanNotional,
    minBuyingPowerReservePct: input.minBuyingPowerReservePct
  };
  const reviewInput = {
    ...planInput,
    maxPlanAgeMinutes: input.maxPlanAgeMinutes,
    maxBuyingPowerUsePct: input.maxBuyingPowerUsePct
  };

  const planBuilder = deps.buildPlan ?? buildPaperPlanReport;
  const reviewBuilder = deps.buildReview ?? buildPaperReviewReport;
  const planReport = await planBuilder(planInput);
  const reviewReport: PaperReviewReport = await reviewBuilder(reviewInput, {
    buildPlan: async () => planReport
  });

  const warnings = [...reviewReport.review.warnings];
  const source = {
    snapshotRunId: reviewReport.source.snapshotRunId ?? null,
    recommendationTimestamp: reviewReport.source.recommendationTimestamp ?? null,
    runtimeTimestamp: reviewReport.source.runtimeTimestamp ?? null,
    planTimestamp: reviewReport.source.planTimestamp ?? planReport.generatedAt,
    reviewTimestamp: reviewReport.generatedAt
  };

  if (!planReport.dryRun) {
    blockers.push("PLAN_NOT_DRY_RUN");
  } else {
    confirmations.push("PLAN_ACCEPTED");
  }

  if (!planReport.nonMutating) {
    blockers.push("PLAN_NOT_NON_MUTATING");
  }

  if (!reviewReport.reviewOnly) {
    blockers.push("REVIEW_NOT_REVIEW_ONLY");
  } else {
    confirmations.push("REVIEW_ACCEPTED");
  }

  if (!reviewReport.nonMutating) {
    blockers.push("REVIEW_NOT_NON_MUTATING");
  }

  const reviewNoOp = isReviewNoOp(reviewReport) && planReport.summary.plannedOrders === 0;
  if (reviewReport.review.status === "blocked" && !reviewNoOp) {
    blockers.push("REVIEW_BLOCKED");
  }

  const plannedCandidates = planReport.plan.filter((candidate) => candidate.decision === "planned");
  const filteredPlannedCandidates = plannedCandidates.filter((candidate) =>
    candidateMatchesAssetFilter(candidate, assetClass)
  );
  let noOpReason: PaperExecuteBlockerCode | null = null;
  if (!plannedCandidates.length) {
    noOpReason = "NO_ELIGIBLE_PAPER_PAYLOADS";
  }
  if (plannedCandidates.length > 0 && !filteredPlannedCandidates.length) {
    noOpReason = "NO_ELIGIBLE_PAPER_PAYLOADS";
  }

  if (blockers.length > 0) {
    return emptyReport({
      generatedAt,
      dryRun,
      environment: state.alpacaEnv,
      assetClass,
      reviewStatus: reviewReport.review.status,
      blockers,
      warnings,
      confirmations,
      plannedOrdersFromPlan: filteredPlannedCandidates.length,
      estimatedTotalNotional: planReport.summary.estimatedTotalNotional,
      candidateCounts: reviewReport.candidateCounts,
      topSkipReasons: reviewReport.topSkipReasons,
      source
    });
  }

  if (noOpReason) {
    return emptyReport({
      generatedAt,
      dryRun,
      environment: state.alpacaEnv,
      assetClass,
      status: "no_op",
      reason: noOpReason,
      reviewStatus: reviewReport.review.status,
      warnings,
      confirmations,
      plannedOrdersFromPlan: filteredPlannedCandidates.length,
      estimatedTotalNotional: planReport.summary.estimatedTotalNotional,
      candidateCounts: reviewReport.candidateCounts,
      topSkipReasons: reviewReport.topSkipReasons,
      source
    });
  }

  const wouldSubmit: AlpacaOrderPayloadDryRun[] = [];
  const blockedPayloads: BlockedPayload[] = [];

  filteredPlannedCandidates.forEach((candidate, index) => {
    const result = buildPayloadForCandidate(candidate, source, index);
    if (result.payload) {
      wouldSubmit.push(result.payload);
      confirmations.push("PAYLOAD_CONSTRUCTED");
    }
    if (result.blocked) {
      blockedPayloads.push(result.blocked);
    }
  });

  const payloadBlockers =
    wouldSubmit.length === 0 && blockedPayloads.length > 0
      ? blockedPayloads.flatMap((payload) => payload.reasonCodes)
      : [];

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    generatedAt,
    dryRun: true,
    nonMutating: true,
    executionMode: "dryRun",
    assetClass,
    status: payloadBlockers.length ? "blocked" : "ready",
    reason: payloadBlockers.length ? payloadBlockers[0] ?? "ORDER_PAYLOAD_INVALID" : null,
    reviewStatus: payloadBlockers.length ? "blocked" : reviewReport.review.status,
    blockers: sortUnique(payloadBlockers, BLOCKER_ORDER),
    warnings,
    confirmations: sortUnique(confirmations, INFO_ORDER),
    summary: {
      plannedOrdersFromPlan: filteredPlannedCandidates.length,
      payloadsConstructed: wouldSubmit.length,
      payloadsBlocked: blockedPayloads.length,
      estimatedTotalNotional: planReport.summary.estimatedTotalNotional,
      wouldSubmitCount: wouldSubmit.length
    },
    candidateCounts: reviewReport.candidateCounts,
    topSkipReasons: reviewReport.topSkipReasons,
    wouldSubmit,
    blockedPayloads,
    source
  };
};

export interface PaperExecuteSubmittedOrder {
  assetClass: "equity" | "option";
  symbol: string;
  underlyingSymbol?: string;
  strategy?: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty?: string;
  notional?: string;
  limitPrice?: string;
  clientOrderId: string;
  alpacaOrderId?: string;
  status: string;
  requestId?: string;
}

export interface PaperExecuteConfirmBlocked {
  assetClass: "equity" | "option";
  symbol: string;
  underlyingSymbol?: string;
  strategy?: string;
  clientOrderId?: string;
  reason: PaperExecuteBlockerCode;
  explanation?: string;
}

export interface PaperExecuteConfirmReport {
  paperOnly: true;
  environment: "paper" | "live";
  generatedAt: string;
  mode: "confirmPaper";
  assetClass: PaperExecuteAssetClassFilter;
  status: PaperExecuteConfirmStatus;
  reason: PaperExecuteBlockerCode | null;
  submitted: PaperExecuteSubmittedOrder[];
  blocked: PaperExecuteConfirmBlocked[];
  errors: Array<{
    reason: PaperExecuteBlockerCode;
    symbol?: string;
    message?: string;
    requestId?: string;
  }>;
  summary: {
    eligiblePayloads: number;
    submitted: number;
    blocked: number;
    errors: number;
  };
  candidateCounts?: PaperReviewReport["candidateCounts"];
  topSkipReasons?: string[];
  source: PaperExecuteDryRunReport["source"];
}

const parseExecutionBoolean = (name: string) =>
  process.env[name] === "true" || process.env[name] === "1";

const parseExecutionNumber = (name: string, fallback: number) => {
  const parsed = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseExecutionInteger = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const optionExecutionConfig = () => {
  const quoteCfg = optionsQuoteConfig();
  return {
    maxPremiumPerOrder: parseExecutionNumber("PAPER_OPTIONS_MAX_PREMIUM_PER_ORDER", 1000),
    maxContracts: Math.max(1, parseExecutionInteger("PAPER_OPTIONS_MAX_CONTRACTS", 5)),
    minDte: parseExecutionInteger("PAPER_OPTIONS_MIN_DTE", 0),
    maxDte: Math.max(1, parseExecutionInteger("PAPER_OPTIONS_MAX_DTE", 90)),
    allow0Dte: quoteCfg.allow0DteOptions,
    allowMarketOrders: parseExecutionBoolean("PAPER_OPTIONS_ALLOW_MARKET_ORDERS"),
    limitPriceBasis: process.env.PAPER_OPTIONS_LIMIT_PRICE_BASIS || "mid",
    maxSpreadPct: parseExecutionNumber("PAPER_OPTIONS_MAX_SPREAD_PCT", 50),
    maxPortfolioRiskPct: parseExecutionNumber("PAPER_OPTIONS_MAX_PORTFOLIO_RISK_PCT", 20),
    maxPositionRiskPct: parseExecutionNumber("PAPER_OPTIONS_MAX_POSITION_RISK_PCT", 5)
  };
};

const OPTION_GATE_BLOCKERS = new Set<PaperExecuteBlockerCode>([
  "OPTION_LIMIT_PRICE_REQUIRED",
  "OPTION_LIMIT_PRICE_UNAVAILABLE",
  "OPTION_RISK_LIMIT_EXCEEDED",
  "OPTION_SPREAD_TOO_WIDE",
  "OPTION_CONTRACT_NOT_FOUND",
  "OPTION_CONTRACT_NOT_TRADABLE",
  "OPTION_0DTE_NOT_ENABLED",
  "UNSUPPORTED_OPTION_STRATEGY",
  "OPTIONS_APPROVAL_LEVEL_INSUFFICIENT"
]);

const NO_OP_REVIEW_BLOCKERS = new Set<string>([
  "NO_RESEARCH_SNAPSHOTS",
  "NO_MATCHING_SNAPSHOTS_FOR_FILTERS",
  "NO_RUNTIME_CANDIDATES",
  "ALL_CANDIDATES_SKIPPED",
  "NO_CANDIDATES_EVALUATED",
  "NO_PLANNED_ORDERS"
]);

const OPTION_EXECUTION_STRATEGIES = new Set<string>([
  "long_call",
  "long_put",
  "cash_secured_put",
  "covered_call"
]);

const isSupportedOptionStrategy = (
  value: string | undefined
): value is "long_call" | "long_put" | "cash_secured_put" | "covered_call" =>
  OPTION_EXECUTION_STRATEGIES.has(value || "");

const isReviewNoOp = (review: PaperReviewReport): boolean =>
  review.review.status === "blocked" &&
  review.review.blockers.length > 0 &&
  review.review.blockers.every((blocker) => NO_OP_REVIEW_BLOCKERS.has(blocker));

const emptyConfirmReport = (input: {
  generatedAt: string;
  environment: "paper" | "live";
  assetClass: PaperExecuteAssetClassFilter;
  status?: PaperExecuteConfirmStatus;
  reason?: PaperExecuteBlockerCode | null;
  blocked?: PaperExecuteConfirmBlocked[];
  errors?: PaperExecuteConfirmReport["errors"];
  candidateCounts?: PaperReviewReport["candidateCounts"];
  topSkipReasons?: string[];
  source?: PaperExecuteDryRunReport["source"];
}): PaperExecuteConfirmReport => ({
  paperOnly: true,
  environment: input.environment,
  generatedAt: input.generatedAt,
  mode: "confirmPaper",
  assetClass: input.assetClass,
  status: input.status || ((input.errors?.length || 0) > 0 ? "blocked" : "no_op"),
  reason: input.reason ?? null,
  submitted: [],
  blocked: input.blocked || [],
  errors: input.errors || [],
  summary: {
    eligiblePayloads: 0,
    submitted: 0,
    blocked: input.blocked?.length || 0,
    errors: input.errors?.length || 0
  },
  candidateCounts: input.candidateCounts,
  topSkipReasons: input.topSkipReasons,
  source: input.source || {}
});

const numericField = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const optionApprovalLevel = (account: AlpacaAccountRaw): number => {
  const approved = numericField(account.options_approved_level) ?? 0;
  const trading = numericField(account.options_trading_level) ?? 0;
  return Math.max(approved, trading);
};

const requiredOptionsApprovalLevel = (strategy: string | undefined): number => {
  if (strategy === "covered_call" || strategy === "cash_secured_put") {
    return 1;
  }
  return 2;
};

const optionDte = (expirationDate: string | undefined): number | null => {
  if (!expirationDate) {
    return null;
  }
  if (expirationDate === new Date().toISOString().slice(0, 10)) {
    return 0;
  }
  const parsed = new Date(`${expirationDate}T23:59:59.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return Math.ceil((parsed.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
};

const normalizeUpper = (value: string | undefined | null) => String(value || "").toUpperCase();

const sumUnderlyingShares = (positions: AlpacaPositionRaw[], symbol: string): number => {
  const normalized = normalizeUpper(symbol);
  return positions.reduce((total, position) => {
    if (normalizeUpper(position.symbol) !== normalized) {
      return total;
    }
    if (position.asset_class && !["us_equity", "equity"].includes(position.asset_class)) {
      return total;
    }
    return total + (numericField(position.qty_available) ?? numericField(position.qty) ?? 0);
  }, 0);
};

const validateOptionPayload = (input: {
  payload: AlpacaOrderPayloadDryRun;
  account: AlpacaAccountRaw;
  contract: AlpacaOptionContractRaw;
  positions: AlpacaPositionRaw[];
}): PaperExecuteBlockerCode | null => {
  const { payload, account, contract, positions } = input;
  const cfg = optionExecutionConfig();
  const strategy = payload.strategy;

  if (!["long_call", "long_put", "cash_secured_put", "covered_call"].includes(strategy || "")) {
    return "UNSUPPORTED_OPTION_STRATEGY";
  }

  if (optionApprovalLevel(account) < requiredOptionsApprovalLevel(strategy)) {
    return "OPTIONS_APPROVAL_LEVEL_INSUFFICIENT";
  }

  const status = String(contract.status || "active").toLowerCase();
  const tradable = contract.tradable ?? contract.tradeable ?? status === "active";
  const dte = optionDte(contract.expiration_date);
  const dteAllowed =
    dte !== null &&
    dte >= cfg.minDte &&
    dte <= cfg.maxDte &&
    (cfg.allow0Dte || dte > 0);
  const underlying = normalizeUpper(contract.underlying_symbol || contract.root_symbol);
  const hasLiquidityBasis = payload.bidAskSpreadPct !== null && payload.bidAskSpreadPct !== undefined;
  if (dte === 0 && !cfg.allow0Dte) {
    return "OPTION_0DTE_NOT_ENABLED";
  }
  if (
    !tradable ||
    status !== "active" ||
    !dteAllowed ||
    !hasLiquidityBasis ||
    underlying !== normalizeUpper(payload.underlyingSymbol)
  ) {
    return "OPTION_CONTRACT_NOT_TRADABLE";
  }

  if (payload.type !== "limit" && !cfg.allowMarketOrders) {
    return "OPTION_LIMIT_PRICE_REQUIRED";
  }

  const limitPrice = numericField(payload.limit_price);
  if (payload.type === "limit" && (limitPrice === null || limitPrice <= 0)) {
    return "OPTION_LIMIT_PRICE_UNAVAILABLE";
  }

  const qty = numericField(payload.qty) ?? 0;
  if (qty <= 0 || qty > cfg.maxContracts) {
    return "OPTION_RISK_LIMIT_EXCEEDED";
  }

  if (
    payload.bidAskSpreadPct !== null &&
    payload.bidAskSpreadPct !== undefined &&
    payload.bidAskSpreadPct > cfg.maxSpreadPct
  ) {
    return "OPTION_SPREAD_TOO_WIDE";
  }

  const maxRisk = numericField(payload.maxRisk);
  if (maxRisk === null || maxRisk < 0) {
    return "OPTION_RISK_LIMIT_EXCEEDED";
  }
  const multiplier = numericField(contract.multiplier) ?? 100;
  const strike = numericField(contract.strike_price) ?? 0;
  const estimatedPremium =
    numericField(payload.estimatedPremium) ??
    (limitPrice !== null ? limitPrice * multiplier * qty : maxRisk);
  if (estimatedPremium > cfg.maxPremiumPerOrder) {
    return "OPTION_RISK_LIMIT_EXCEEDED";
  }
  const accountEquity =
    numericField(account.equity) ??
    numericField(account.portfolio_value) ??
    numericField(account.cash) ??
    0;
  const maxPositionRisk =
    accountEquity > 0 ? (accountEquity * cfg.maxPositionRiskPct) / 100 : cfg.maxPremiumPerOrder;
  const maxPortfolioRisk =
    accountEquity > 0 ? (accountEquity * cfg.maxPortfolioRiskPct) / 100 : cfg.maxPremiumPerOrder;
  if (maxRisk > maxPositionRisk || maxRisk > maxPortfolioRisk) {
    return "OPTION_RISK_LIMIT_EXCEEDED";
  }
  const effectiveRisk =
    strategy === "cash_secured_put" ? Math.max(maxRisk, strike * multiplier * qty) : maxRisk;
  if (effectiveRisk > maxPositionRisk || effectiveRisk > maxPortfolioRisk) {
    return "OPTION_RISK_LIMIT_EXCEEDED";
  }

  const optionsBuyingPower =
    numericField(account.options_buying_power) ??
    numericField(account.buying_power) ??
    numericField(account.cash) ??
    0;
  if (
    (strategy === "long_call" || strategy === "long_put" || strategy === "cash_secured_put") &&
    optionsBuyingPower < effectiveRisk
  ) {
    return "OPTION_RISK_LIMIT_EXCEEDED";
  }

  if (strategy === "covered_call") {
    const requiredShares = multiplier * qty;
    if (sumUnderlyingShares(positions, payload.underlyingSymbol || "") < requiredShares) {
      return "UNSUPPORTED_OPTION_STRATEGY";
    }
  }

  return null;
};

const toAlpacaOrderPayload = (payload: AlpacaOrderPayloadDryRun): AlpacaPaperOrderRequest => ({
  symbol: payload.symbol,
  qty: payload.qty,
  notional: payload.assetClass === "equity" ? payload.notional : undefined,
  side: payload.side,
  type: payload.type,
  time_in_force: payload.time_in_force,
  limit_price: payload.limit_price,
  client_order_id: payload.client_order_id,
  position_intent: payload.position_intent
});

const blockConfirmPayload = (
  payload: AlpacaOrderPayloadDryRun,
  reason: PaperExecuteBlockerCode,
  explanation?: string
): PaperExecuteConfirmBlocked => ({
  assetClass: payload.assetClass,
  symbol: payload.symbol,
  underlyingSymbol: payload.underlyingSymbol,
  strategy: payload.strategy,
  clientOrderId: payload.client_order_id,
  reason,
  explanation
});

const numericPayloadField = (value: string | undefined): number | null => {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const ledgerInputForPayload = (
  payload: AlpacaOrderPayloadDryRun,
  source: PaperExecuteDryRunReport["source"],
  status: Parameters<typeof insertPaperExecutionLedgerEntry>[0]["status"],
  reason?: string | null,
  clientOrderId = payload.client_order_id
) => ({
  mode: "confirmPaper",
  assetClass: payload.assetClass,
  symbol: payload.symbol,
  underlyingSymbol: payload.underlyingSymbol,
  strategy: payload.strategy,
  side: payload.side,
  orderType: payload.type,
  timeInForce: payload.time_in_force,
  qty: payload.qty ?? null,
  notional: payload.notional ?? null,
  limitPrice: payload.limit_price ?? null,
  estimatedPremium: numericPayloadField(payload.estimatedPremium),
  maxRisk: numericPayloadField(payload.maxRisk),
  dedupeKey: payload.dedupeKey,
  clientOrderId,
  status,
  reason: reason ?? null,
  blockedReason: reason ?? null,
  sourcePlanId: source.snapshotRunId ?? null,
  sourceCandidateId: payload.sourceCandidateId ?? null,
  payload,
  rawPayload: payload
});

const pushConfirmError = (
  errors: PaperExecuteConfirmReport["errors"],
  reason: PaperExecuteBlockerCode
) => {
  if (!errors.some((error) => error.reason === reason)) {
    errors.push({ reason });
  }
};

const runtimeDuplicateReconciliationEnabled = () =>
  process.env.PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED === "true" ||
  process.env.PAPER_RUNTIME_DUPLICATE_RECONCILIATION_ENABLED === "1";

export const buildPaperExecuteConfirmPaperReport = async (
  input: PaperExecuteInput = {},
  deps: PaperConfirmDeps = {}
): Promise<PaperExecuteConfirmReport> => {
  const generatedAt = deps.now?.() || new Date().toISOString();
  const assetClass = normalizeAssetClassFilter(input.assetClass);
  const state = getTradingSafetyState();
  const errors: PaperExecuteConfirmReport["errors"] = [];
  const paperOptionsExecutionEnabled = parseExecutionBoolean("PAPER_OPTIONS_EXECUTION_ENABLED");
  const paperOrderExecutionEnabled = parseExecutionBoolean("PAPER_ORDER_EXECUTION_ENABLED");

  if (input.confirmPaper !== true) {
    pushConfirmError(errors, "DRY_RUN_OR_CONFIRM_PAPER_REQUIRED");
  }
  if (state.alpacaEnv !== "paper") {
    pushConfirmError(errors, "PAPER_ENV_REQUIRED");
  }
  if (state.liveTradingEnabled) {
    pushConfirmError(errors, "LIVE_TRADING_MUST_BE_DISABLED");
  }
  if (!paperOrderExecutionEnabled) {
    pushConfirmError(errors, "PAPER_ORDER_EXECUTION_DISABLED");
  }
  if (errors.length > 0) {
    return emptyConfirmReport({
      generatedAt,
      environment: state.alpacaEnv,
      assetClass,
      errors
    });
  }

  const dryRunReport = await buildPaperExecuteDryRunReport(
    {
      ...input,
      dryRun: true,
      confirmPaper: false,
      assetClass
    },
    deps
  );

  const preflightBlocked = dryRunReport.blockedPayloads.map((blocked) => ({
    assetClass: blocked.assetClass || "equity",
    symbol: blocked.symbol,
    underlyingSymbol: blocked.underlyingSymbol,
    strategy: blocked.strategy,
    reason: blocked.reasonCodes[0] || "ORDER_PAYLOAD_INVALID",
    explanation: blocked.explanation
  })) satisfies PaperExecuteConfirmBlocked[];

  if (dryRunReport.status === "no_op") {
    return emptyConfirmReport({
      generatedAt,
      environment: state.alpacaEnv,
      assetClass,
      status: "no_op",
      reason: dryRunReport.reason || "NO_ELIGIBLE_PAPER_PAYLOADS",
      blocked: preflightBlocked,
      candidateCounts: dryRunReport.candidateCounts,
      topSkipReasons: dryRunReport.topSkipReasons,
      source: dryRunReport.source
    });
  }

  if (dryRunReport.blockers.includes("REVIEW_BLOCKED")) {
    pushConfirmError(errors, "PAPER_REVIEW_BLOCKED");
  }
  const globalDryRunBlockers = dryRunReport.blockers.filter(
    (blocker) => !OPTION_GATE_BLOCKERS.has(blocker)
  );
  for (const blocker of globalDryRunBlockers) {
    if (blocker === "REVIEW_BLOCKED") {
      continue;
    }
    if (blocker === "NO_ELIGIBLE_PAPER_PAYLOADS" || blocker === "NO_PLANNED_ORDERS") {
      pushConfirmError(errors, "NO_ELIGIBLE_PAPER_PAYLOADS");
      continue;
    }
    pushConfirmError(errors, blocker);
  }
  if (errors.length > 0) {
    if (!dryRunReport.wouldSubmit.length) {
      pushConfirmError(errors, "NO_ELIGIBLE_PAPER_PAYLOADS");
    }
    return {
      ...emptyConfirmReport({
        generatedAt,
        environment: state.alpacaEnv,
        assetClass,
        blocked: preflightBlocked,
        errors,
        source: dryRunReport.source
      }),
      summary: {
        eligiblePayloads: 0,
        submitted: 0,
        blocked: preflightBlocked.length,
        errors: errors.length
      }
    };
  }

  if (!dryRunReport.wouldSubmit.length) {
    return emptyConfirmReport({
      generatedAt,
      environment: state.alpacaEnv,
      assetClass,
      status: "no_op",
      reason: "NO_ELIGIBLE_PAPER_PAYLOADS",
      blocked: preflightBlocked,
      candidateCounts: dryRunReport.candidateCounts,
      topSkipReasons: dryRunReport.topSkipReasons,
      source: dryRunReport.source
    });
  }

  const getAccountFn = deps.getAccount ?? getAccount;
  const getOptionContractFn = deps.getOptionContract ?? getOptionContract;
  const listPositionsFn = deps.listPaperPositions ?? listPaperPositions;
  const listRecentOrdersFn = deps.listRecentPaperOrders ?? listRecentPaperOrders;
  const submitOrderFn = deps.submitPaperOrder ?? submitPaperOrder;

  const submitted: PaperExecuteSubmittedOrder[] = [];
  const blocked: PaperExecuteConfirmBlocked[] = [...preflightBlocked];
  let account: AlpacaAccountRaw | null = null;
  let positions: AlpacaPositionRaw[] = [];
  let recentPaperOrders: AlpacaSubmittedOrder[] | null = null;

  for (const payload of dryRunReport.wouldSubmit) {
    if (payload.assetClass === "option" && !paperOptionsExecutionEnabled) {
      const entry = blockConfirmPayload(
        payload,
        "PAPER_OPTIONS_EXECUTION_DISABLED",
        "Options paper execution requires PAPER_OPTIONS_EXECUTION_ENABLED=true."
      );
      blocked.push(entry);
      insertPaperExecutionLedgerEntry(
        ledgerInputForPayload(payload, dryRunReport.source, "blocked", entry.reason)
      );
      continue;
    }

    if (payload.assetClass === "option") {
      try {
        if (!account) {
          const accountResponse = await getAccountFn();
          account = accountResponse.data;
        }
        if (!positions.length) {
          const positionResponse = await listPositionsFn();
          positions = Array.isArray(positionResponse.data) ? positionResponse.data : [];
        }
        const contractResponse = await getOptionContractFn(payload.symbol);
        const optionBlocker = validateOptionPayload({
          payload,
          account,
          contract: contractResponse.data,
          positions
        });
        if (optionBlocker) {
          const entry = blockConfirmPayload(payload, optionBlocker);
          blocked.push(entry);
          insertPaperExecutionLedgerEntry(
            ledgerInputForPayload(payload, dryRunReport.source, "blocked", optionBlocker)
          );
          continue;
        }
      } catch (error) {
        const reason =
          error instanceof AlpacaApiError && error.status === 404
            ? "OPTION_CONTRACT_NOT_FOUND"
            : "ALPACA_PAPER_ORDER_SUBMISSION_FAILED";
        blocked.push(blockConfirmPayload(payload, reason));
        errors.push({
          reason,
          symbol: payload.symbol,
          message: error instanceof Error ? error.message : "Option pre-submit check failed.",
          requestId: error instanceof AlpacaApiError ? error.requestId : undefined
        });
        insertPaperExecutionLedgerEntry(
          ledgerInputForPayload(payload, dryRunReport.source, "blocked", reason)
        );
        continue;
      }
    }

    const existingExecution = findPaperExecutionByDedupeKey(payload.dedupeKey);
    if (
      existingExecution &&
      existingExecution.status !== "blocked" &&
      existingExecution.status !== "duplicate_blocked"
    ) {
      blocked.push(
        blockConfirmPayload(
          payload,
          "DUPLICATE_PAPER_ORDER_BLOCKED",
          `A prior ${existingExecution.status} ledger row exists for this plan payload.`
        )
      );
      insertPaperExecutionLedgerEntry(
        ledgerInputForPayload(
          payload,
          dryRunReport.source,
          "duplicate_blocked",
          "DUPLICATE_PAPER_ORDER_BLOCKED",
          `${payload.client_order_id}-duplicate-${Date.now()}`
        )
      );
      continue;
    }

    if (runtimeDuplicateReconciliationEnabled()) {
      if (!recentPaperOrders) {
        try {
          const recentOrdersResponse = await listRecentOrdersFn();
          recentPaperOrders = Array.isArray(recentOrdersResponse.data)
            ? recentOrdersResponse.data
            : [];
        } catch {
          recentPaperOrders = [];
        }
      }
      const runtimeDuplicate = recentPaperOrders.find(
        (order) => order.client_order_id === payload.client_order_id
      );
      if (runtimeDuplicate) {
        blocked.push(
          blockConfirmPayload(
            payload,
            "DUPLICATE_PAPER_ORDER_BLOCKED",
            "A recent Alpaca paper order already has this client_order_id."
          )
        );
        insertPaperExecutionLedgerEntry(
          ledgerInputForPayload(
            payload,
            dryRunReport.source,
            "duplicate_blocked",
            "DUPLICATE_PAPER_ORDER_BLOCKED",
            `${payload.client_order_id}-runtime-duplicate-${Date.now()}`
          )
        );
        continue;
      }
    }

    const ledger = insertPaperExecutionLedgerEntry(
      ledgerInputForPayload(payload, dryRunReport.source, "built")
    );

    try {
      const response = await submitOrderFn(toAlpacaOrderPayload(payload));
      const order = response.data;
      const alpacaOrderId = order.id;
      const status = order.status || "submitted";
      const ledgerStatus: "accepted" | "rejected" | "submitted" =
        status === "accepted" ? "accepted" : status === "rejected" ? "rejected" : "submitted";
      updatePaperExecutionLedgerEntry(ledger.id, {
        status: ledgerStatus,
        alpacaOrderId,
        alpacaStatus: status,
        requestId: response.requestId,
        reason: null,
        rawResponse: order
      });
      submitted.push({
        assetClass: payload.assetClass,
        symbol: payload.symbol,
        underlyingSymbol: payload.underlyingSymbol,
        strategy: payload.strategy,
        side: payload.side,
        type: payload.type,
        qty: payload.qty,
        notional: payload.notional,
        limitPrice: payload.limit_price,
        clientOrderId: payload.client_order_id,
        alpacaOrderId,
        status,
        requestId: response.requestId
      });
    } catch (error) {
      const requestId = error instanceof AlpacaApiError ? error.requestId : undefined;
      updatePaperExecutionLedgerEntry(ledger.id, {
        status: "failed",
        requestId,
        reason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        errorMessage:
          error instanceof Error ? error.message : "Alpaca paper order submission failed.",
        rawResponse: error instanceof AlpacaApiError ? error.responseBody : undefined
      });
      blocked.push(
        blockConfirmPayload(
          payload,
          "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
          error instanceof Error ? error.message : "Alpaca paper order submission failed."
        )
      );
      errors.push({
        reason: "ALPACA_PAPER_ORDER_SUBMISSION_FAILED",
        symbol: payload.symbol,
        message: error instanceof Error ? error.message : "Alpaca paper order submission failed.",
        requestId
      });
    }
  }

  if (!submitted.length && !blocked.length && !errors.length) {
    return emptyConfirmReport({
      generatedAt,
      environment: state.alpacaEnv,
      assetClass,
      status: "no_op",
      reason: "NO_ELIGIBLE_PAPER_PAYLOADS",
      candidateCounts: dryRunReport.candidateCounts,
      topSkipReasons: dryRunReport.topSkipReasons,
      source: dryRunReport.source
    });
  }

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    generatedAt,
    mode: "confirmPaper",
    assetClass,
    status: submitted.length > 0
      ? blocked.length > 0 || errors.length > 0
        ? "partial"
        : "submitted"
      : "blocked",
    reason: errors[0]?.reason ?? blocked[0]?.reason ?? null,
    submitted,
    blocked,
    errors,
    summary: {
      eligiblePayloads: dryRunReport.wouldSubmit.length,
      submitted: submitted.length,
      blocked: blocked.length,
      errors: errors.length
    },
    candidateCounts: dryRunReport.candidateCounts,
    topSkipReasons: dryRunReport.topSkipReasons,
    source: dryRunReport.source
  };
};

const pad = (value: string, width: number, alignRight = false) =>
  alignRight ? value.padStart(width, " ") : value.padEnd(width, " ");

const displayMoney = (value?: string) => (value ? `$${value}` : "-");

export const formatPaperExecuteDryRunReportAsTable = (report: PaperExecuteDryRunReport) => {
  const lines: string[] = [];
  lines.push("Paper Execute, dry-run only");
  lines.push(`Asset filter: ${report.assetClass}`);
  lines.push(`Status: ${report.status}`);
  lines.push(`Reason: ${report.reason || "none"}`);

  if (report.blockers.length > 0) {
    lines.push("Blockers:");
    for (const blocker of report.blockers) {
      lines.push(`- ${blocker}`);
    }
    lines.push("Dry-run only. No orders were submitted.");
    return lines.join("\n");
  }

  lines.push(`Review status: ${report.reviewStatus}`);
  lines.push(`Payloads constructed: ${report.summary.payloadsConstructed}`);
  lines.push(`Payloads blocked: ${report.summary.payloadsBlocked}`);
  if (report.candidateCounts) {
    lines.push(
      `Candidate counts: input=${report.candidateCounts.inputCandidates}, planned=${report.candidateCounts.plannedOrders}, eligiblePayloads=${report.candidateCounts.eligiblePayloads}, alreadyHeld=${report.candidateCounts.skippedAlreadyHeld}, quoteUnavailable=${report.candidateCounts.skippedQuoteUnavailable}`
    );
  }
  if (report.topSkipReasons?.length) {
    lines.push(`Top skip reasons: ${report.topSkipReasons.join(", ")}`);
  }
  lines.push(
    [
      pad("Asset Class", 12),
      pad("Symbol", 24),
      pad("Strategy", 16),
      pad("Side", 5),
      pad("Qty/Notional", 14, true),
      pad("Type", 8),
      pad("Limit", 10, true),
      pad("Status", 12),
      "Reason"
    ].join(" ")
  );

  if (!report.wouldSubmit.length) {
    lines.push("- None");
  } else {
    for (const payload of report.wouldSubmit) {
      lines.push(
        [
          pad(payload.assetClass, 12),
          pad(payload.symbol, 24),
          pad(payload.strategy || "-", 16),
          pad(payload.side, 5),
          pad(payload.notional ? displayMoney(payload.notional) : payload.qty || "-", 14, true),
          pad(payload.type, 8),
          pad(displayMoney(payload.limit_price), 10, true),
          pad("would-submit", 12),
          payload.client_order_id
        ].join(" ")
      );
    }
  }

  if (report.blockedPayloads.length) {
    lines.push("Blocked payloads:");
    for (const blocked of report.blockedPayloads) {
      lines.push(
        `- ${blocked.assetClass || "unknown"} ${blocked.symbol}: ${blocked.reasonCodes.join(", ")}`
      );
    }
  }

  lines.push("Warnings:");
  if (!report.warnings.length) {
    lines.push("- None");
  } else {
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("Dry-run only. No orders were submitted.");
  return lines.join("\n");
};

export const formatPaperExecuteConfirmReportAsTable = (
  report: PaperExecuteConfirmReport
) => {
  const lines: string[] = [];
  lines.push("Paper Execute, confirm-paper");
  lines.push(`Asset filter: ${report.assetClass}`);
  lines.push(`Status: ${report.status}`);
  lines.push(`Reason: ${report.reason || "none"}`);
  lines.push(`Submitted: ${report.summary.submitted}`);
  lines.push(`Blocked: ${report.summary.blocked}`);
  lines.push(`Errors: ${report.summary.errors}`);
  if (report.candidateCounts) {
    lines.push(
      `Candidate counts: input=${report.candidateCounts.inputCandidates}, planned=${report.candidateCounts.plannedOrders}, eligiblePayloads=${report.candidateCounts.eligiblePayloads}, alreadyHeld=${report.candidateCounts.skippedAlreadyHeld}, quoteUnavailable=${report.candidateCounts.skippedQuoteUnavailable}`
    );
  }
  if (report.topSkipReasons?.length) {
    lines.push(`Top skip reasons: ${report.topSkipReasons.join(", ")}`);
  }
  lines.push(
    [
      pad("Asset Class", 12),
      pad("Symbol", 24),
      pad("Strategy", 16),
      pad("Side", 5),
      pad("Qty/Notional", 14, true),
      pad("Type", 8),
      pad("Limit", 10, true),
      pad("Status", 12),
      "Reason"
    ].join(" ")
  );

  if (!report.submitted.length && !report.blocked.length) {
    lines.push("- None");
  }

  for (const submitted of report.submitted) {
    lines.push(
      [
        pad(submitted.assetClass, 12),
        pad(submitted.symbol, 24),
        pad(submitted.strategy || "-", 16),
        pad(submitted.side, 5),
        pad(submitted.notional ? displayMoney(submitted.notional) : submitted.qty || "-", 14, true),
        pad(submitted.type, 8),
        pad(displayMoney(submitted.limitPrice), 10, true),
        pad(submitted.status, 12),
        submitted.requestId || submitted.alpacaOrderId || submitted.clientOrderId
      ].join(" ")
    );
  }

  for (const blocked of report.blocked) {
    lines.push(
      [
        pad(blocked.assetClass, 12),
        pad(blocked.symbol, 24),
        pad(blocked.strategy || "-", 16),
        pad("-", 5),
        pad("-", 14, true),
        pad("-", 8),
        pad("-", 10, true),
        pad("blocked", 12),
        blocked.reason
      ].join(" ")
    );
  }

  if (report.errors.length) {
    lines.push("Errors:");
    for (const error of report.errors) {
      lines.push(`- ${error.symbol ? `${error.symbol}: ` : ""}${error.reason}`);
    }
  }

  return lines.join("\n");
};
