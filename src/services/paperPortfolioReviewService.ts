import { queryAll } from "../lib/db.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import {
  listAlpacaPositions,
  type AlpacaPositionSnapshot
} from "./alpacaPositionService.js";
import {
  evaluateLeapsExit,
  type LeapsExitEvaluation
} from "./leapsExitReviewService.js";
import { parseOptionSymbol } from "./optionSymbolService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export type PaperPortfolioRecommendationType =
  | "BUY_NEW_EQUITY"
  | "ADD_TO_EQUITY"
  | "SELL_EQUITY"
  | "HOLD_EQUITY"
  | "BUY_OPTION"
  | "SELL_TO_CLOSE_OPTION"
  | "HOLD_OPTION";

export type PaperPortfolioReviewMoment = "manual" | "morning" | "midday" | "late_day";

export interface PaperPortfolioReviewPayload {
  orderAction: "BUY" | "SELL" | "BUY_TO_OPEN" | "SELL_TO_CLOSE";
  assetClass: "equity" | "option";
  symbol: string;
  qty?: string;
  notional?: string;
  side: "buy" | "sell";
  order_type: "market" | "limit";
  type: "market" | "limit";
  time_in_force: "day";
  limit_price?: string;
  position_intent?: "buy_to_open" | "sell_to_close";
  client_order_id: string;
  reason: string;
  reasonCodes?: string[];
  leapsExitEvaluation?: LeapsExitEvaluation;
  sourceReviewId: string;
}

export interface PaperPortfolioRecommendation {
  recommendation: PaperPortfolioRecommendationType;
  symbol: string;
  assetClass: "equity" | "option";
  currentQuantity: number;
  currentMarketValue: number | null;
  unrealizedPl: number | null;
  unrealizedPlPercent: number | null;
  signalRank: number | null;
  reason: string;
  reasonCodes?: string[];
  confidence: number | null;
  eligiblePayload: PaperPortfolioReviewPayload | null;
  skippedReason: string | null;
  leapsExitEvaluation?: LeapsExitEvaluation;
}

export interface PaperPortfolioReviewReport {
  paperOnly: true;
  environment: "paper" | "live";
  generatedAt: string;
  reviewOnly: true;
  nonMutating: true;
  status: "success" | "warning" | "blocked";
  moment: PaperPortfolioReviewMoment;
  reviewId: string;
  summary: {
    positionsReviewed: number;
    equityPositions: number;
    optionPositions: number;
    recommendations: Record<PaperPortfolioRecommendationType, number>;
    eligiblePayloads: number;
  };
  config: ReturnType<typeof paperPortfolioReviewConfig>;
  recommendations: PaperPortfolioRecommendation[];
  leapsExitEvaluations: LeapsExitEvaluation[];
  warnings: string[];
  blockers: string[];
}

interface CandidateRow {
  symbol: string;
  rank: number;
  confidence: number | null;
  score: number | null;
  risk_profile: string;
  preferred_expression: string;
  research_run_id: string;
}

interface PaperPortfolioReviewDeps {
  listPositions?: typeof listAlpacaPositions;
  getAccount?: typeof getAlpacaAccountSnapshot;
  getCandidates?: () => Promise<CandidateRow[]> | CandidateRow[];
  evaluateLeapsExit?: typeof evaluateLeapsExit;
  now?: () => string;
}

const parseBoolean = (value: string | undefined, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }
  return value === "true" || value === "1";
};

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const pctFromPosition = (value: string | number | undefined): number | null => {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
};

const numeric = (value: string | number | undefined): number | null => {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const qtyString = (value: number) => {
  const fixed = value.toFixed(6);
  return fixed.replace(/\.?0+$/g, "");
};

const moneyString = (value: number) => value.toFixed(2);

const safeIdPart = (value: string) =>
  value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "payload";

const portfolioClientOrderId = (input: {
  reviewId: string;
  action: string;
  symbol: string;
}) =>
  `paper-review-${safeIdPart(input.action)}-${safeIdPart(input.symbol)}-${safeIdPart(input.reviewId)}`.slice(
    0,
    128
  );

export const paperPortfolioReviewConfig = () => ({
  equityScaleInEnabled: parseBoolean(process.env.PAPER_EQUITY_SCALE_IN_ENABLED, false),
  equityScaleInMaxRank: Math.max(
    1,
    Math.floor(parseNumber(process.env.PAPER_EQUITY_SCALE_IN_MAX_RANK, 3))
  ),
  equityScaleInNotional: parseNumber(process.env.PAPER_EQUITY_SCALE_IN_NOTIONAL, 250),
  equityMaxPositionPct: parseNumber(process.env.PAPER_EQUITY_MAX_POSITION_PCT, 10),
  equitySellMaxLossPct: parseNumber(process.env.PAPER_EQUITY_SELL_MAX_LOSS_PCT, 8),
  equityRankDeteriorationSellRank: Math.max(
    1,
    Math.floor(parseNumber(process.env.PAPER_EQUITY_RANK_DETERIORATION_SELL_RANK, 25))
  ),
  optionExitReviewEnabled: parseBoolean(process.env.PAPER_OPTION_EXIT_REVIEW_ENABLED, true),
  optionStopLossPct: parseNumber(process.env.PAPER_OPTION_EXIT_STOP_LOSS_PCT, 50),
  optionProfitTargetPct: parseNumber(process.env.PAPER_OPTION_EXIT_PROFIT_TARGET_PCT, 80),
  optionLateDayForcedExitHourEt: Math.max(
    0,
    Math.min(23, Math.floor(parseNumber(process.env.PAPER_OPTION_LATE_DAY_EXIT_HOUR_ET, 15)))
  ),
  optionLateDayForcedExitMinuteEt: Math.max(
    0,
    Math.min(59, Math.floor(parseNumber(process.env.PAPER_OPTION_LATE_DAY_EXIT_MINUTE_ET, 15)))
  )
});

const latestCandidates = () =>
  queryAll<CandidateRow>(
    `
    SELECT
      c.symbol,
      c.rank,
      c.confidence,
      c.score,
      c.risk_profile,
      c.preferred_expression,
      c.research_run_id
    FROM paper_trade_candidates c
    JOIN (
      SELECT id
      FROM research_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC, started_at DESC
      LIMIT 1
    ) latest
      ON latest.id = c.research_run_id
    WHERE c.decision = 'selected'
    ORDER BY c.rank ASC
    LIMIT 50
    `
  );

const optionSymbolMetadata = (symbol: string): { expirationDate: string; side: "call" | "put" } | null => {
  const parsed = parseOptionSymbol(symbol);
  if (!parsed.ok) {
    return null;
  }
  return {
    expirationDate: parsed.expirationDate,
    side: parsed.optionType
  };
};

const isOptionPosition = (position: AlpacaPositionSnapshot) =>
  String(position.assetClass || "").toLowerCase().includes("option") ||
  optionSymbolMetadata(position.symbol) !== null;

const todayEt = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(iso));

const afterLateDayExitWindow = (iso: string, hour: number, minute: number) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(iso));
  const currentHour = Number(parts.find((part) => part.type === "hour")?.value || "0");
  const currentMinute = Number(parts.find((part) => part.type === "minute")?.value || "0");
  return currentHour > hour || (currentHour === hour && currentMinute >= minute);
};

const emptyCounts = (): Record<PaperPortfolioRecommendationType, number> => ({
  BUY_NEW_EQUITY: 0,
  ADD_TO_EQUITY: 0,
  SELL_EQUITY: 0,
  HOLD_EQUITY: 0,
  BUY_OPTION: 0,
  SELL_TO_CLOSE_OPTION: 0,
  HOLD_OPTION: 0
});

const addRecommendation = (
  target: PaperPortfolioRecommendation[],
  recommendation: PaperPortfolioRecommendation
) => {
  target.push(recommendation);
};

const equityPayload = (input: {
  action: "BUY" | "SELL";
  symbol: string;
  qty?: number;
  notional?: number;
  reason: string;
  reviewId: string;
}): PaperPortfolioReviewPayload => ({
  orderAction: input.action,
  assetClass: "equity",
  symbol: input.symbol,
  side: input.action === "BUY" ? "buy" : "sell",
  order_type: "market",
  type: "market",
  time_in_force: "day",
  ...(input.qty ? { qty: qtyString(input.qty) } : {}),
  ...(input.notional ? { notional: moneyString(input.notional) } : {}),
  client_order_id: portfolioClientOrderId({
    reviewId: input.reviewId,
    action: input.action,
    symbol: input.symbol
  }),
  reason: input.reason,
  sourceReviewId: input.reviewId
});

const optionExitPayload = (input: {
  symbol: string;
  qty: number;
  limitPrice: number | null;
  reason: string;
  reasonCodes?: string[];
  leapsExitEvaluation?: LeapsExitEvaluation;
  reviewId: string;
}): PaperPortfolioReviewPayload => ({
  orderAction: "SELL_TO_CLOSE",
  assetClass: "option",
  symbol: input.symbol,
  qty: qtyString(input.qty),
  side: "sell",
  order_type: input.limitPrice && input.limitPrice > 0 ? "limit" : "market",
  type: input.limitPrice && input.limitPrice > 0 ? "limit" : "market",
  time_in_force: "day",
  ...(input.limitPrice && input.limitPrice > 0 ? { limit_price: moneyString(input.limitPrice) } : {}),
  position_intent: "sell_to_close",
  client_order_id: portfolioClientOrderId({
    reviewId: input.reviewId,
    action: "SELL_TO_CLOSE",
    symbol: input.symbol
  }),
  reason: input.reason,
  ...(input.reasonCodes?.length ? { reasonCodes: input.reasonCodes } : {}),
  ...(input.leapsExitEvaluation ? { leapsExitEvaluation: input.leapsExitEvaluation } : {}),
  sourceReviewId: input.reviewId
});

const primaryLeapsReason = (evaluation: LeapsExitEvaluation): string =>
  evaluation.reasons.find((reason) =>
    [
      "LEAPS_HARD_STOP_LOSS",
      "LEAPS_FULL_PROFIT_TAKE",
      "LEAPS_DTE_EXIT_WINDOW",
      "LEAPS_SEVERE_TREND_BREAK"
    ].includes(reason)
  ) ??
  evaluation.reasons.find((reason) => reason !== "LEAPS_CLASSIFICATION_INFERRED") ??
  "LEAPS_HOLD_REVIEW";

const firstLeapsSkipReason = (evaluation: LeapsExitEvaluation): string =>
  evaluation.reasons.find((reason) =>
    ["LIMIT_EXIT_REQUIRED", "LEAPS_QUOTE_UNAVAILABLE"].includes(reason)
  ) ??
  (evaluation.hardExit ? "LEAPS_EXIT_NOT_EXECUTABLE" : "LEAPS_REVIEW_ONLY");

export const buildPaperPortfolioReviewReport = async (
  input: {
    moment?: PaperPortfolioReviewMoment;
    reviewId?: string;
  } = {},
  deps: PaperPortfolioReviewDeps = {}
): Promise<PaperPortfolioReviewReport> => {
  const generatedAt = deps.now?.() || new Date().toISOString();
  const reviewId = input.reviewId || `ppr_${generatedAt.replace(/[^0-9]/g, "")}`;
  const cfg = paperPortfolioReviewConfig();
  const state = getTradingSafetyState();
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!state.paperOnly) {
    blockers.push("PAPER_ENV_REQUIRED");
  }

  const [positionResult, account, candidates] = await Promise.all([
    (deps.listPositions ?? listAlpacaPositions)(),
    (deps.getAccount ?? getAlpacaAccountSnapshot)(),
    Promise.resolve(deps.getCandidates ? deps.getCandidates() : latestCandidates())
  ]);

  const positions = positionResult.positions || [];
  const candidateMap = new Map(candidates.map((candidate) => [candidate.symbol.toUpperCase(), candidate]));
  const heldSymbols = new Set(positions.map((position) => position.symbol.toUpperCase()));
  const buyingPower = numeric(account.buyingPower) ?? numeric(account.cash) ?? 0;
  const accountEquity = numeric(account.equity) ?? numeric(account.buyingPower) ?? 0;
  const recommendations: PaperPortfolioRecommendation[] = [];
  const leapsExitEvaluations: LeapsExitEvaluation[] = [];

  for (const position of positions) {
    const symbol = position.symbol.toUpperCase();
    const qty = Math.abs(numeric(position.qty) ?? 0);
    const marketValue = numeric(position.marketValue);
    const unrealizedPl = numeric(position.unrealizedPl);
    const unrealizedPlPercent = pctFromPosition(position.unrealizedPlpc);

    if (isOptionPosition(position)) {
      const leapsEvaluation = (deps.evaluateLeapsExit ?? evaluateLeapsExit)(position, {
        now: () => generatedAt
      });
      if (leapsEvaluation?.classification === "LEAPS") {
        leapsExitEvaluations.push(leapsEvaluation);
        if (leapsEvaluation.reviewOnly || (leapsEvaluation.hardExit && !leapsEvaluation.executable)) {
          warnings.push(...leapsEvaluation.reasons);
        }
        const reason = primaryLeapsReason(leapsEvaluation);
        const reasonCodes = leapsEvaluation.reasons;
        addRecommendation(recommendations, {
          recommendation: leapsEvaluation.hardExit ? "SELL_TO_CLOSE_OPTION" : "HOLD_OPTION",
          symbol,
          assetClass: "option",
          currentQuantity: qty,
          currentMarketValue: marketValue,
          unrealizedPl,
          unrealizedPlPercent,
          signalRank: null,
          reason,
          reasonCodes,
          confidence: null,
          eligiblePayload: leapsEvaluation.executable
            ? optionExitPayload({
                symbol,
                qty: leapsEvaluation.exitQuantity ?? qty,
                limitPrice: leapsEvaluation.limitPrice,
                reason,
                reasonCodes,
                leapsExitEvaluation: leapsEvaluation,
                reviewId
              })
            : null,
          skippedReason: leapsEvaluation.executable ? null : firstLeapsSkipReason(leapsEvaluation),
          leapsExitEvaluation: leapsEvaluation
        });
        continue;
      }

      const metadata = optionSymbolMetadata(symbol);
      const isZeroDte = metadata?.expirationDate === todayEt(generatedAt);
      const lateDayForced =
        input.moment === "late_day" ||
        (isZeroDte &&
          afterLateDayExitWindow(
            generatedAt,
            cfg.optionLateDayForcedExitHourEt,
            cfg.optionLateDayForcedExitMinuteEt
          ));
      const stopLoss =
        unrealizedPlPercent !== null && unrealizedPlPercent <= -cfg.optionStopLossPct;
      const profitTarget =
        unrealizedPlPercent !== null && unrealizedPlPercent >= cfg.optionProfitTargetPct;
      const reason = stopLoss
        ? "OPTION_STOP_LOSS_REVIEW"
        : profitTarget
          ? "OPTION_PROFIT_TARGET_REVIEW"
          : lateDayForced && isZeroDte
            ? "OPTION_0DTE_LATE_DAY_FORCED_EXIT_REVIEW"
            : isZeroDte
              ? "OPTION_0DTE_HOLD_REVIEW"
              : "OPTION_HOLD_REVIEW";
      const shouldExit = cfg.optionExitReviewEnabled && (stopLoss || profitTarget || (lateDayForced && isZeroDte));
      addRecommendation(recommendations, {
        recommendation: shouldExit ? "SELL_TO_CLOSE_OPTION" : "HOLD_OPTION",
        symbol,
        assetClass: "option",
        currentQuantity: qty,
        currentMarketValue: marketValue,
        unrealizedPl,
        unrealizedPlPercent,
        signalRank: null,
        reason,
        confidence: null,
        eligiblePayload: shouldExit
          ? optionExitPayload({
              symbol,
              qty,
              limitPrice: numeric(position.currentPrice),
              reason,
              reviewId
            })
          : null,
        skippedReason: shouldExit ? null : cfg.optionExitReviewEnabled ? "NO_OPTION_EXIT_TRIGGER" : "OPTION_EXIT_REVIEW_DISABLED"
      });
      continue;
    }

    const candidate = candidateMap.get(symbol);
    const rank = candidate?.rank ?? null;
    const confidence = candidate?.confidence ?? null;
    const lossTriggered =
      unrealizedPlPercent !== null && unrealizedPlPercent <= -cfg.equitySellMaxLossPct;
    if (lossTriggered && qty > 0) {
      const reason = "EQUITY_MAX_LOSS_REVIEW";
      addRecommendation(recommendations, {
        recommendation: "SELL_EQUITY",
        symbol,
        assetClass: "equity",
        currentQuantity: qty,
        currentMarketValue: marketValue,
        unrealizedPl,
        unrealizedPlPercent,
        signalRank: rank,
        reason,
        confidence,
        eligiblePayload: equityPayload({
          action: "SELL",
          symbol,
          qty,
          reason,
          reviewId
        }),
        skippedReason: null
      });
      continue;
    }

    const maxPositionValue =
      accountEquity > 0 ? (accountEquity * cfg.equityMaxPositionPct) / 100 : null;
    const scaleInAllowed =
      cfg.equityScaleInEnabled &&
      candidate !== undefined &&
      rank !== null &&
      rank <= cfg.equityScaleInMaxRank &&
      buyingPower >= cfg.equityScaleInNotional &&
      (maxPositionValue === null ||
        marketValue === null ||
        marketValue + cfg.equityScaleInNotional <= maxPositionValue);

    if (scaleInAllowed) {
      const reason = "EQUITY_SCALE_IN_RULES_ALLOW_ADD";
      addRecommendation(recommendations, {
        recommendation: "ADD_TO_EQUITY",
        symbol,
        assetClass: "equity",
        currentQuantity: qty,
        currentMarketValue: marketValue,
        unrealizedPl,
        unrealizedPlPercent,
        signalRank: rank,
        reason,
        confidence,
        eligiblePayload: equityPayload({
          action: "BUY",
          symbol,
          notional: cfg.equityScaleInNotional,
          reason,
          reviewId
        }),
        skippedReason: null
      });
      continue;
    }

    addRecommendation(recommendations, {
      recommendation: "HOLD_EQUITY",
      symbol,
      assetClass: "equity",
      currentQuantity: qty,
      currentMarketValue: marketValue,
      unrealizedPl,
      unrealizedPlPercent,
      signalRank: rank,
      reason: candidate ? "EQUITY_HELD_WITH_ACTIVE_CANDIDATE" : "EQUITY_HELD_NO_EXIT_TRIGGER",
      confidence,
      eligiblePayload: null,
      skippedReason: cfg.equityScaleInEnabled ? "SCALE_IN_RULES_NOT_MET" : "SCALE_IN_DISABLED"
    });
  }

  for (const candidate of candidates) {
    const symbol = candidate.symbol.toUpperCase();
    if (heldSymbols.has(symbol) || candidate.preferred_expression !== "shares") {
      continue;
    }
    const notional = Math.min(cfg.equityScaleInNotional, buyingPower);
    const eligible = notional > 0;
    const reason = "NEW_EQUITY_CANDIDATE_REVIEW";
    addRecommendation(recommendations, {
      recommendation: "BUY_NEW_EQUITY",
      symbol,
      assetClass: "equity",
      currentQuantity: 0,
      currentMarketValue: null,
      unrealizedPl: null,
      unrealizedPlPercent: null,
      signalRank: candidate.rank,
      reason,
      confidence: candidate.confidence,
      eligiblePayload: eligible
        ? equityPayload({
            action: "BUY",
            symbol,
            notional,
            reason,
            reviewId
          })
        : null,
      skippedReason: eligible ? null : "BUYING_POWER_UNAVAILABLE"
    });
  }

  const counts = emptyCounts();
  for (const recommendation of recommendations) {
    counts[recommendation.recommendation] += 1;
  }
  const eligiblePayloads = recommendations.filter((entry) => entry.eligiblePayload).length;

  return {
    paperOnly: true,
    environment: state.alpacaEnv,
    generatedAt,
    reviewOnly: true,
    nonMutating: true,
    status: blockers.length ? "blocked" : warnings.length ? "warning" : "success",
    moment: input.moment || "manual",
    reviewId,
    summary: {
      positionsReviewed: positions.length,
      equityPositions: positions.filter((position) => !isOptionPosition(position)).length,
      optionPositions: positions.filter(isOptionPosition).length,
      recommendations: counts,
      eligiblePayloads
    },
    config: cfg,
    recommendations,
    leapsExitEvaluations,
    warnings: [...new Set(warnings)],
    blockers
  };
};

export const formatPaperPortfolioReviewReportAsTable = (report: PaperPortfolioReviewReport) => {
  const lines: string[] = [];
  lines.push("Paper Portfolio Review");
  lines.push(`Status: ${report.status}`);
  lines.push(`Moment: ${report.moment}`);
  lines.push(`Review ID: ${report.reviewId}`);
  lines.push(`Positions reviewed: ${report.summary.positionsReviewed}`);
  lines.push(`Eligible payloads: ${report.summary.eligiblePayloads}`);
  if (report.blockers.length) {
    lines.push(`Blockers: ${report.blockers.join(", ")}`);
  }
  if (!report.recommendations.length) {
    lines.push("No positions or candidates to review.");
    return lines.join("\n");
  }
  for (const entry of report.recommendations) {
    lines.push(
      [
        entry.recommendation,
        entry.symbol,
        entry.assetClass,
        `qty=${entry.currentQuantity}`,
        entry.signalRank === null ? "rank=-" : `rank=${entry.signalRank}`,
        entry.eligiblePayload ? "payload=yes" : `skip=${entry.skippedReason || "none"}`,
        entry.reason
      ].join(" | ")
    );
  }
  lines.push("Review-only. No orders were submitted.");
  return lines.join("\n");
};
