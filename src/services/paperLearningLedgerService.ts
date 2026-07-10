import { randomUUID } from "node:crypto";
import { getDb, queryAll } from "../lib/db.js";

export type PaperStrategyFamily =
  | "zero_dte_spy"
  | "leaps"
  | "standard_option"
  | "equity"
  | "portfolio_hedge";
export type PaperLearningDecision = "submitted" | "skipped" | "rejected" | "no_op";
export type PaperLearningStatus = "pending" | "evaluated" | "promoted" | "rejected";

export interface QuoteSnapshotModel {
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  spreadPct: number | null;
  quoteAgeSeconds: number | null;
}

export interface PaperFillModel {
  submittedLimitPrice?: number;
  assumedFillPrice?: number;
  source: "paper_order" | "midpoint" | "ask" | "askFallback" | "model";
}

export interface LiveLikeFillModel {
  assumedEntryPrice: number;
  method: "ask" | "midpoint_plus_spread_fraction" | "configured_slippage";
  slippageBps?: number;
  spreadPenaltyPct?: number;
}

export interface RiskModel {
  maxPremium: number;
  maxPremiumPerContract?: number;
  maxOrderNotional?: number;
  capUsed?: number;
  contracts: number;
  notionalPremium: number;
  maxLoss: number;
  priceSource?: "midpoint" | "askFallback" | "unavailable";
  selectionRank?: number | null;
  selectionReason?: string | null;
  expectedHoldPeriod: "intraday" | "swing" | "long_horizon";
}

export interface PaperLearningRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  strategyFamily: PaperStrategyFamily;
  symbol: string;
  underlyingSymbol: string | null;
  optionSymbol: string | null;
  decision: PaperLearningDecision;
  skipReason: string | null;
  blockReason: string | null;
  hypothesis: string;
  signalInputsJson: string;
  optionMetadataJson: string | null;
  quoteSnapshotJson: string | null;
  paperFillModelJson: string | null;
  liveLikeFillModelJson: string | null;
  riskModelJson: string | null;
  outcomeJson: string | null;
  evaluationReason: string | null;
  learningStatus: PaperLearningStatus;
  promotionEligible: boolean;
  promotionBlockReason: string | null;
  sourceResearchRunId: string | null;
  sourceCandidateId: string | null;
  sourcePlanTimestamp: string | null;
}

interface PaperLearningRow {
  id: string;
  created_at: string;
  updated_at: string;
  strategy_family: PaperStrategyFamily;
  symbol: string;
  underlying_symbol: string | null;
  option_symbol: string | null;
  decision: PaperLearningDecision;
  skip_reason: string | null;
  block_reason: string | null;
  hypothesis: string;
  signal_inputs_json: string;
  option_metadata_json: string | null;
  quote_snapshot_json: string | null;
  paper_fill_model_json: string | null;
  live_like_fill_model_json: string | null;
  risk_model_json: string | null;
  outcome_json: string | null;
  evaluation_reason: string | null;
  learning_status: PaperLearningStatus;
  promotion_eligible: number;
  promotion_block_reason: string | null;
  source_research_run_id: string | null;
  source_candidate_id: string | null;
  source_plan_timestamp: string | null;
}

interface LatestOptionSnapshotRow {
  timestamp: string;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  executable_price: number | null;
}

interface LearningInsertInput {
  id?: string;
  createdAt?: string;
  strategyFamily: PaperStrategyFamily;
  symbol: string;
  underlyingSymbol?: string | null;
  optionSymbol?: string | null;
  decision: PaperLearningDecision;
  skipReason?: string | null;
  blockReason?: string | null;
  hypothesis: string;
  signalInputs: Record<string, unknown>;
  optionMetadata?: Record<string, unknown> | null;
  quoteSnapshot?: QuoteSnapshotModel | null;
  paperFillModel?: PaperFillModel | null;
  liveLikeFillModel?: LiveLikeFillModel | null;
  riskModel?: RiskModel | null;
  learningStatus?: PaperLearningStatus;
  promotionEligible?: boolean;
  promotionBlockReason?: string | null;
  sourceResearchRunId?: string | null;
  sourceCandidateId?: string | null;
  sourcePlanTimestamp?: string | null;
}

export interface PaperLearningEvaluationResult {
  paperOnly: true;
  generatedAt: string;
  evaluated: number;
  stillPending: number;
  pendingReasons: Array<{ id: string; reason: string }>;
}

export interface PromotionReadiness {
  strategyFamily: "zero_dte_spy" | "leaps";
  totalTrades: number;
  evaluatedTrades: number;
  winRatePaper: number;
  winRateLiveLike: number;
  profitFactorPaper: number;
  profitFactorLiveLike: number;
  maxDrawdownPct: number;
  avgSpreadPct: number;
  avgSlippagePenaltyPct: number;
  minTradesRequired: number;
  minDaysObservedRequired: number;
  eligibleForLiveReview: boolean;
  blockReasons: string[];
}

const mapRow = (row: PaperLearningRow): PaperLearningRecord => ({
  id: row.id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  strategyFamily: row.strategy_family,
  symbol: row.symbol,
  underlyingSymbol: row.underlying_symbol,
  optionSymbol: row.option_symbol,
  decision: row.decision,
  skipReason: row.skip_reason,
  blockReason: row.block_reason,
  hypothesis: row.hypothesis,
  signalInputsJson: row.signal_inputs_json,
  optionMetadataJson: row.option_metadata_json,
  quoteSnapshotJson: row.quote_snapshot_json,
  paperFillModelJson: row.paper_fill_model_json,
  liveLikeFillModelJson: row.live_like_fill_model_json,
  riskModelJson: row.risk_model_json,
  outcomeJson: row.outcome_json,
  evaluationReason: row.evaluation_reason,
  learningStatus: row.learning_status,
  promotionEligible: row.promotion_eligible === 1,
  promotionBlockReason: row.promotion_block_reason,
  sourceResearchRunId: row.source_research_run_id,
  sourceCandidateId: row.source_candidate_id,
  sourcePlanTimestamp: row.source_plan_timestamp
});

const jsonOrNull = (value: unknown | null | undefined) =>
  value === null || value === undefined ? null : JSON.stringify(value);

const safeParse = <T>(value: string | null): T | null => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const markPriceFromSnapshot = (row: LatestOptionSnapshotRow | null): number | null => {
  if (!row) {
    return null;
  }
  const midpoint = numberOrNull(row.midpoint);
  if (midpoint !== null && midpoint > 0) {
    return midpoint;
  }
  const executable = numberOrNull(row.executable_price);
  if (executable !== null && executable > 0) {
    return executable;
  }
  const last = numberOrNull(row.last);
  return last !== null && last >= 0 ? last : null;
};

const latestOptionSnapshot = (optionSymbol: string) => {
  return getDb()
    .prepare(
      `
      SELECT timestamp, bid, ask, midpoint, last, executable_price
      FROM option_snapshots
      WHERE option_symbol = ?
      ORDER BY timestamp DESC
      LIMIT 1
      `
    )
    .get(optionSymbol) as LatestOptionSnapshotRow | undefined;
};

export const insertPaperLearningRecord = (input: LearningInsertInput): PaperLearningRecord => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const id = input.id ?? `plr_${randomUUID()}`;
  getDb()
    .prepare(
      `
      INSERT INTO paper_learning_records(
        id,
        created_at,
        updated_at,
        strategy_family,
        symbol,
        underlying_symbol,
        option_symbol,
        decision,
        skip_reason,
        block_reason,
        hypothesis,
        signal_inputs_json,
        option_metadata_json,
        quote_snapshot_json,
        paper_fill_model_json,
        live_like_fill_model_json,
        risk_model_json,
        learning_status,
        promotion_eligible,
        promotion_block_reason,
        source_research_run_id,
        source_candidate_id,
        source_plan_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      id,
      createdAt,
      createdAt,
      input.strategyFamily,
      input.symbol,
      input.underlyingSymbol ?? null,
      input.optionSymbol ?? null,
      input.decision,
      input.skipReason ?? null,
      input.blockReason ?? null,
      input.hypothesis,
      JSON.stringify(input.signalInputs),
      jsonOrNull(input.optionMetadata),
      jsonOrNull(input.quoteSnapshot),
      jsonOrNull(input.paperFillModel),
      jsonOrNull(input.liveLikeFillModel),
      jsonOrNull(input.riskModel),
      input.learningStatus ?? "pending",
      input.promotionEligible ? 1 : 0,
      input.promotionBlockReason ?? "NOT_EVALUATED",
      input.sourceResearchRunId ?? null,
      input.sourceCandidateId ?? null,
      input.sourcePlanTimestamp ?? null
    );

  return {
    id,
    createdAt,
    updatedAt: createdAt,
    strategyFamily: input.strategyFamily,
    symbol: input.symbol,
    underlyingSymbol: input.underlyingSymbol ?? null,
    optionSymbol: input.optionSymbol ?? null,
    decision: input.decision,
    skipReason: input.skipReason ?? null,
    blockReason: input.blockReason ?? null,
    hypothesis: input.hypothesis,
    signalInputsJson: JSON.stringify(input.signalInputs),
    optionMetadataJson: jsonOrNull(input.optionMetadata),
    quoteSnapshotJson: jsonOrNull(input.quoteSnapshot),
    paperFillModelJson: jsonOrNull(input.paperFillModel),
    liveLikeFillModelJson: jsonOrNull(input.liveLikeFillModel),
    riskModelJson: jsonOrNull(input.riskModel),
    outcomeJson: null,
    evaluationReason: null,
    learningStatus: input.learningStatus ?? "pending",
    promotionEligible: Boolean(input.promotionEligible),
    promotionBlockReason: input.promotionBlockReason ?? "NOT_EVALUATED",
    sourceResearchRunId: input.sourceResearchRunId ?? null,
    sourceCandidateId: input.sourceCandidateId ?? null,
    sourcePlanTimestamp: input.sourcePlanTimestamp ?? null
  };
};

export const listPaperLearningRecords = (input: {
  limit?: number;
  strategyFamily?: PaperStrategyFamily;
  learningStatus?: PaperLearningStatus;
} = {}): PaperLearningRecord[] => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.strategyFamily) {
    clauses.push("strategy_family = ?");
    params.push(input.strategyFamily);
  }
  if (input.learningStatus) {
    clauses.push("learning_status = ?");
    params.push(input.learningStatus);
  }
  const limit = Number.isFinite(input.limit) && input.limit && input.limit > 0
    ? Math.min(500, Math.floor(input.limit))
    : 50;
  params.push(limit);
  const rows = queryAll<PaperLearningRow>(
    `
    SELECT *
    FROM paper_learning_records
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
    `,
    params
  );
  return rows.map(mapRow);
};

const setPendingReason = (id: string, reason: string) => {
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE paper_learning_records
      SET updated_at = ?, evaluation_reason = ?, promotion_block_reason = ?
      WHERE id = ?
      `
    )
    .run(updatedAt, reason, reason, id);
};

const setEvaluatedOutcome = (id: string, outcome: Record<string, unknown>) => {
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE paper_learning_records
      SET
        updated_at = ?,
        outcome_json = ?,
        evaluation_reason = NULL,
        learning_status = 'evaluated',
        promotion_eligible = 0,
        promotion_block_reason = 'ANALYTICS_GATE_NOT_REVIEWED'
      WHERE id = ?
      `
    )
    .run(updatedAt, JSON.stringify(outcome), id);
};

export const evaluatePaperLearningRecords = (input: {
  limit?: number;
  asOf?: string;
} = {}): PaperLearningEvaluationResult => {
  const generatedAt = new Date().toISOString();
  const limit = Number.isFinite(input.limit) && input.limit && input.limit > 0
    ? Math.min(500, Math.floor(input.limit))
    : 100;
  const rows = queryAll<PaperLearningRow>(
    `
    SELECT *
    FROM paper_learning_records
    WHERE learning_status = 'pending'
      AND decision = 'submitted'
      AND strategy_family IN ('zero_dte_spy', 'leaps', 'standard_option')
    ORDER BY created_at ASC
    LIMIT ?
    `,
    [limit]
  );

  let evaluated = 0;
  let stillPending = 0;
  const pendingReasons: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const record = mapRow(row);
    if (!record.optionSymbol) {
      const reason = "MISSING_OPTION_SYMBOL";
      setPendingReason(record.id, reason);
      stillPending += 1;
      pendingReasons.push({ id: record.id, reason });
      continue;
    }

    const paperFill = safeParse<PaperFillModel>(record.paperFillModelJson);
    const liveLikeFill = safeParse<LiveLikeFillModel>(record.liveLikeFillModelJson);
    const riskModel = safeParse<RiskModel>(record.riskModelJson);
    const optionMetadata = safeParse<{ expirationDate?: string }>(record.optionMetadataJson);
    const entryPrice = numberOrNull(paperFill?.assumedFillPrice);
    const liveLikeEntryPrice = numberOrNull(liveLikeFill?.assumedEntryPrice);
    const contracts = Math.max(1, Math.floor(numberOrNull(riskModel?.contracts) ?? 1));
    const multiplier = 100;

    if (entryPrice === null || liveLikeEntryPrice === null) {
      const reason = "MISSING_ENTRY_FILL_MODEL";
      setPendingReason(record.id, reason);
      stillPending += 1;
      pendingReasons.push({ id: record.id, reason });
      continue;
    }

    const snapshot = latestOptionSnapshot(record.optionSymbol) ?? null;
    let markPrice = markPriceFromSnapshot(snapshot);
    const today = (input.asOf ?? generatedAt).slice(0, 10);
    const expirationDate = optionMetadata?.expirationDate;
    const expiredWorthless =
      expirationDate !== undefined &&
      expirationDate < today &&
      (markPrice === null || markPrice <= 0);
    if (expiredWorthless) {
      markPrice = 0;
    }

    if (markPrice === null) {
      const reason = "MISSING_MARK_DATA";
      setPendingReason(record.id, reason);
      stillPending += 1;
      pendingReasons.push({ id: record.id, reason });
      continue;
    }

    const pnlPaper = Number(((markPrice - entryPrice) * contracts * multiplier).toFixed(2));
    const pnlLiveLike = Number(((markPrice - liveLikeEntryPrice) * contracts * multiplier).toFixed(2));
    const daysHeld = Math.max(
      0,
      Math.floor(
        ((snapshot ? Date.parse(snapshot.timestamp) : Date.parse(generatedAt)) -
          Date.parse(record.createdAt)) /
          (24 * 60 * 60 * 1000)
      )
    );

    if (record.strategyFamily === "leaps") {
      setEvaluatedOutcome(record.id, {
        entryPrice,
        liveLikeEntryPrice,
        latestMarkPrice: markPrice,
        pnlPaper,
        pnlLiveLike,
        daysHeld,
        thesisStillValid: pnlLiveLike >= 0,
        maxDrawdownPct: pnlLiveLike < 0 && riskModel?.maxLoss
          ? Number(Math.abs((pnlLiveLike / riskModel.maxLoss) * 100).toFixed(2))
          : 0
      });
    } else {
      setEvaluatedOutcome(record.id, {
        entryPrice,
        liveLikeEntryPrice,
        currentOrExitPrice: markPrice,
        endOfDayPrice: record.strategyFamily === "zero_dte_spy" ? markPrice : undefined,
        pnlPaper,
        pnlLiveLike,
        maxFavorableExcursion: Math.max(0, Number(((markPrice - entryPrice) * multiplier).toFixed(2))),
        maxAdverseExcursion: Math.min(0, Number(((markPrice - entryPrice) * multiplier).toFixed(2))),
        takeProfitWouldHaveHit: pnlPaper > 0,
        stopLossWouldHaveHit: pnlPaper < 0,
        expiredWorthless
      });
    }

    evaluated += 1;
  }

  return {
    paperOnly: true,
    generatedAt,
    evaluated,
    stillPending,
    pendingReasons
  };
};

const profitFactor = (values: number[]) => {
  const gains = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (losses === 0) {
    return gains > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return Number((gains / losses).toFixed(2));
};

const maxDrawdownPct = (pnlValues: number[], riskValues: number[]) => {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of pnlValues) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  const denominator = riskValues.reduce((sum, value) => sum + Math.max(0, value), 0);
  return denominator > 0 ? Number(((maxDrawdown / denominator) * 100).toFixed(2)) : 0;
};

const average = (values: number[]) =>
  values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : 0;

export const buildPromotionReadinessAnalytics = (): PromotionReadiness[] => {
  const records = listPaperLearningRecords({ limit: 500 }).filter(
    (record) =>
      (record.strategyFamily === "zero_dte_spy" || record.strategyFamily === "leaps") &&
      record.decision === "submitted"
  );
  const families = ["zero_dte_spy", "leaps"] as const;

  return families.map((family) => {
    const familyRecords = records.filter((record) => record.strategyFamily === family);
    const evaluated = familyRecords.filter((record) => record.learningStatus === "evaluated" && record.outcomeJson);
    const paperPnl = evaluated.map((record) => numberOrNull(safeParse<Record<string, unknown>>(record.outcomeJson)?.pnlPaper) ?? 0);
    const liveLikePnl = evaluated.map((record) => numberOrNull(safeParse<Record<string, unknown>>(record.outcomeJson)?.pnlLiveLike) ?? 0);
    const risks = evaluated.map((record) => numberOrNull(safeParse<RiskModel>(record.riskModelJson)?.maxLoss) ?? 0);
    const spreads = familyRecords
      .map((record) => numberOrNull(safeParse<QuoteSnapshotModel>(record.quoteSnapshotJson)?.spreadPct))
      .filter((value): value is number => value !== null);
    const slippagePenaltyPct = familyRecords
      .map((record) => {
        const paper = safeParse<PaperFillModel>(record.paperFillModelJson);
        const liveLike = safeParse<LiveLikeFillModel>(record.liveLikeFillModelJson);
        const paperPrice = numberOrNull(paper?.assumedFillPrice);
        const livePrice = numberOrNull(liveLike?.assumedEntryPrice);
        return paperPrice !== null && paperPrice > 0 && livePrice !== null
          ? ((livePrice - paperPrice) / paperPrice) * 100
          : null;
      })
      .filter((value): value is number => value !== null);
    const observedDays = new Set(
      familyRecords.map((record) => record.createdAt.slice(0, 10))
    ).size;
    const holdingDays = Math.max(
      0,
      ...evaluated.map((record) => {
        const outcome = safeParse<Record<string, unknown>>(record.outcomeJson);
        return numberOrNull(outcome?.daysHeld) ?? 0;
      })
    );
    const minTradesRequired = family === "zero_dte_spy" ? 100 : 25;
    const minDaysObservedRequired = family === "zero_dte_spy" ? 20 : 30;
    const maxAllowedDrawdownPct = family === "zero_dte_spy" ? 15 : 20;
    const maxAllowedAvgSpreadPct = family === "zero_dte_spy" ? 12 : Number.POSITIVE_INFINITY;
    const liveLikePf = profitFactor(liveLikePnl);
    const drawdown = maxDrawdownPct(liveLikePnl, risks);
    const avgSpreadPct = average(spreads);
    const observedMetric = family === "zero_dte_spy" ? observedDays : holdingDays;
    const blockReasons: string[] = [];

    if (familyRecords.length < minTradesRequired) {
      blockReasons.push("INSUFFICIENT_TRADE_COUNT");
    }
    if (observedMetric < minDaysObservedRequired) {
      blockReasons.push(
        family === "zero_dte_spy" ? "INSUFFICIENT_OBSERVED_TRADING_DAYS" : "INSUFFICIENT_OBSERVED_HOLDING_DAYS"
      );
    }
    if (liveLikePf < 1.05) {
      blockReasons.push("WEAK_LIVE_LIKE_PROFIT_FACTOR");
    }
    if (drawdown > maxAllowedDrawdownPct) {
      blockReasons.push("DRAWDOWN_TOO_HIGH");
    }
    if (avgSpreadPct > maxAllowedAvgSpreadPct) {
      blockReasons.push("AVERAGE_SPREAD_TOO_WIDE");
    }

    return {
      strategyFamily: family,
      totalTrades: familyRecords.length,
      evaluatedTrades: evaluated.length,
      winRatePaper: paperPnl.length ? paperPnl.filter((value) => value > 0).length / paperPnl.length : 0,
      winRateLiveLike: liveLikePnl.length ? liveLikePnl.filter((value) => value > 0).length / liveLikePnl.length : 0,
      profitFactorPaper: profitFactor(paperPnl),
      profitFactorLiveLike: liveLikePf,
      maxDrawdownPct: drawdown,
      avgSpreadPct,
      avgSlippagePenaltyPct: average(slippagePenaltyPct),
      minTradesRequired,
      minDaysObservedRequired,
      eligibleForLiveReview: blockReasons.length === 0,
      blockReasons
    };
  });
};

export const paperLearningSummary = () => {
  const rows = queryAll<{
    learning_status: PaperLearningStatus;
    count: number;
  }>(
    `
    SELECT learning_status, COUNT(*) AS count
    FROM paper_learning_records
    GROUP BY learning_status
    `
  );
  const counts = new Map(rows.map((row) => [row.learning_status, Number(row.count)]));
  return {
    pending: counts.get("pending") ?? 0,
    evaluated: counts.get("evaluated") ?? 0,
    promoted: counts.get("promoted") ?? 0,
    rejected: counts.get("rejected") ?? 0
  };
};
