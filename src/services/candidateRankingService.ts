import { getDb, queryAll, queryOne } from "../lib/db.js";
import { normalizeSymbol, uuid } from "../lib/utils.js";
import { createDecisionId } from "./marketDecisionIdentityService.js";
import type {
  CandidateDecisionRecord,
  DecisionId,
  PaperTradeCandidateRow,
  PreferredExpression,
  RiskProfile,
  TargetSnapshotRow,
  TimeHorizon
} from "../types.js";

type CandidateDirection = "long" | "short" | "neutral";

interface LearningSnapshot {
  directionalAccuracy: number | null;
  optionOutperformanceAccuracy: number | null;
}

interface BacktestPerf {
  runId: string;
  maxDrawdown: number | null;
  byExpression: Record<string, { winRate: number; avgReturn: number; setups: number }>;
}

interface CandidateOptionsCandidate {
  optionSymbol?: string;
  strike?: number;
  shortStrike?: number;
  estimatedEntryPrice?: number;
  maxLoss?: number | null;
  maxProfit?: number | null;
  liquidityScore?: number;
}

interface CandidateSourceRow {
  id: number;
  symbol: string;
  as_of: string;
  direction: CandidateDirection;
  horizon: TimeHorizon;
  entry_reference: number;
  upside_target: number;
  downside_risk: number;
  stop_loss: number | null;
  take_profit: number | null;
  confidence: number;
  expected_return: number | null;
  volatility_adjusted_score: number | null;
  risk_profile: RiskProfile;
  preferred_expression: PreferredExpression;
  rationale: string;
}

interface CandidateRankingInput {
  researchRunId: string;
  riskProfile: RiskProfile;
  optionsEnabled: boolean;
  targets: TargetSnapshotRow[];
  maxCandidates: number;
  maxPerSymbol: number;
  maxPerDirection: number;
  maxPerExpression: number;
  requireSectorDiversity?: boolean;
}

export interface RankedCandidate extends Omit<PaperTradeCandidateRow, "researchRunId"> {}

export interface CandidateRankingResult {
  candidates: RankedCandidate[];
  decisions: CandidateDecisionRecord[];
  warnings: string[];
}

const parseCandidateRationale = (raw: string) => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

const parseLearningSummary = (): LearningSnapshot => {
  const row = queryOne<{
    metrics_json: string;
  }>(`
    SELECT metrics_json
    FROM learning_runs
    ORDER BY trained_at DESC
    LIMIT 1
  `);
  if (!row) {
    return {
      directionalAccuracy: null,
      optionOutperformanceAccuracy: null
    };
  }
  const parsed = JSON.parse(row.metrics_json) as {
    directionalAccuracy?: number;
    optionOutperformanceAccuracy?: number;
  };
  return {
    directionalAccuracy:
      typeof parsed.directionalAccuracy === "number" ? parsed.directionalAccuracy : null,
    optionOutperformanceAccuracy:
      typeof parsed.optionOutperformanceAccuracy === "number"
        ? parsed.optionOutperformanceAccuracy
        : null
  };
};

const parseBacktestPerformance = (): BacktestPerf | null => {
  const run = queryOne<{
    id: string;
    metrics_json: string;
  }>(`
    SELECT id, metrics_json
    FROM backtest_runs
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `);
  if (!run) {
    return null;
  }

  const parsedMetrics = JSON.parse(run.metrics_json || "{}") as {
    maxDrawdown?: number | null;
  };

  const shares = queryOne<{
    setup_count: number;
    win_rate: number;
    avg_return: number;
  }>(`
    SELECT
      COUNT(*) AS setup_count,
      CASE WHEN COUNT(*) = 0 THEN 0 ELSE SUM(CASE WHEN return_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) END AS win_rate,
      AVG(return_pct) AS avg_return
    FROM backtest_trades
    WHERE run_id = ?
  `, [run.id]);

  const optionsRows = queryAll<{
    strategy: string;
    setup_count: number;
    win_rate: number;
    avg_return: number;
  }>(`
    SELECT
      strategy,
      COUNT(*) AS setup_count,
      CASE WHEN COUNT(*) = 0 THEN 0 ELSE SUM(CASE WHEN return_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) END AS win_rate,
      AVG(return_pct) AS avg_return
    FROM backtest_options_trades
    WHERE run_id = ?
    GROUP BY strategy
  `, [run.id]);

  const byExpression: Record<string, { winRate: number; avgReturn: number; setups: number }> = {};
  if (shares) {
    byExpression.shares = {
      winRate: Number(shares.win_rate) || 0,
      avgReturn: Number(shares.avg_return) || 0,
      setups: Number(shares.setup_count) || 0
    };
  }
  for (const row of optionsRows) {
    byExpression[row.strategy] = {
      winRate: Number(row.win_rate) || 0,
      avgReturn: Number(row.avg_return) || 0,
      setups: Number(row.setup_count) || 0
    };
  }

  return {
    runId: run.id,
    maxDrawdown:
      parsedMetrics.maxDrawdown === undefined ? null : parsedMetrics.maxDrawdown,
    byExpression
  };
};

const isLeveragedCandidate = (symbol: string) =>
  /^(TQQQ|SQQQ|SOXL|SOXS|FAS|FAZ|TNA|TZA|UPRO|SPXU|SPXL)$/i.test(symbol);

const getLatestFeatureSnapshot = (symbol: string, asOf: string) => {
  const row = queryOne<{ features: string }>(`
    SELECT features
    FROM feature_snapshots
    WHERE symbol = ? AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT 1
  `, [normalizeSymbol(symbol), asOf]);
  if (!row) {
    return {};
  }
  try {
    return JSON.parse(row.features) as Record<string, string | number | null>;
  } catch {
    return {};
  }
};

const getOptionCandidate = (symbol: string, asOf: string): CandidateOptionsCandidate | null => {
  const row = queryOne<{ options_candidate: string | null }>(`
    SELECT options_candidate
    FROM options_strategy_snapshots
    WHERE symbol = ? AND as_of = ?
    LIMIT 1
  `, [symbol, asOf]);
  if (!row?.options_candidate) {
    return null;
  }
  try {
    const candidate = JSON.parse(row.options_candidate) as CandidateOptionsCandidate;
    return candidate;
  } catch {
    return null;
  }
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const calculateFreshnessPenalty = (asOf: string) => {
  const nowMs = Date.now();
  const asOfMs = new Date(asOf).getTime();
  if (Number.isNaN(asOfMs)) {
    return 0;
  }
  const ageDays = (nowMs - asOfMs) / (24 * 60 * 60 * 1000);
  return ageDays > 0 ? clamp(ageDays * 0.8, 0, 15) : 0;
};

const asymmetrySignal = (direction: CandidateDirection, expression: PreferredExpression) => {
  if (["call_spread", "put_spread", "collar", "protective_put", "cash_secured_put"].includes(expression)) {
    return direction === "long" ? 7 : 6;
  }
  if (["long_call", "long_put"].includes(expression)) {
    return 3;
  }
  return 0;
};

const estimateCandidatePnlRange = (
  direction: CandidateDirection,
  row: CandidateSourceRow,
  optionCandidate: CandidateOptionsCandidate | null
) => {
  if (row.preferred_expression === "shares" || row.preferred_expression === "none") {
    const stopLoss =
      typeof row.stop_loss === "number" ? Math.abs(row.entry_reference - row.stop_loss) : null;
    const takeProfit =
      typeof row.take_profit === "number" ? Math.abs(row.take_profit - row.entry_reference) : null;
    if (direction === "short") {
      return {
        estimatedMaxLoss: takeProfit,
        estimatedMaxProfit: stopLoss
      };
    }
    return {
      estimatedMaxLoss: stopLoss,
      estimatedMaxProfit: takeProfit
    };
  }

  return {
    estimatedMaxLoss:
      typeof optionCandidate?.maxLoss === "number" ? optionCandidate.maxLoss : null,
    estimatedMaxProfit:
      typeof optionCandidate?.maxProfit === "number" ? optionCandidate.maxProfit : null
  };
};

const pickRiskProfileDefaults = (riskProfile: RiskProfile) => {
  if (riskProfile === "aggressive") {
    return {
      maxPerSymbol: 3,
      maxPerDirection: 8,
      maxPerExpression: 6
    };
  }
  if (riskProfile === "conservative") {
    return {
      maxPerSymbol: 1,
      maxPerDirection: 3,
      maxPerExpression: 2
    };
  }
  return {
    maxPerSymbol: 2,
    maxPerDirection: 5,
    maxPerExpression: 4
  };
};

const computeScore = (
  row: CandidateSourceRow,
  optionsCandidate: CandidateOptionsCandidate | null,
  freshnessPenalty: number,
  learning: LearningSnapshot,
  backtest: BacktestPerf | null,
  riskProfile: RiskProfile,
  optionsEnabled: boolean
) => {
  const direction = row.direction;
  const expression = row.preferred_expression;
  const expectedReturn = row.expected_return ?? 0;
  const volatilityScore = row.volatility_adjusted_score ?? 1;
  const optionLiquidity = Number(
    optionsCandidate?.liquidityScore ??
      getLatestFeatureSnapshot(row.symbol, row.as_of).preferredContractLiquidityScore ??
      0
  );

  let score = 0;
  const rationale: string[] = [];
  const confidenceScore = row.confidence * 42;
  score += confidenceScore;
  const expectedScore = clamp(expectedReturn * 100, -10, 20) * 1.7;
  score += expectedScore;

  score += clamp(volatilityScore * 3, -4, 8);

  if (row.preferred_expression !== "shares") {
    score += clamp(optionLiquidity * 18, 0, 18);
    if (optionsEnabled) {
      score += 4;
      rationale.push(`Options candidate was considered with liquidity score ${optionLiquidity.toFixed(2)}`);
    } else {
      score -= 2;
      rationale.push(`Options candidate exists but optionsEnabled=false; share alternatives preferred`);
    }
  }

  const asymmetry = asymmetrySignal(direction, expression);
  if (asymmetry) {
    score += asymmetry;
    rationale.push(`Asymmetric expression ${expression} receives payoff tilt credit`);
  }

  const freshness = clamp(15 - freshnessPenalty, 0, 15);
  score += freshness;

  if (learning.directionalAccuracy !== null && learning.directionalAccuracy > 0.55) {
    score += 5;
    rationale.push(
      `Recent directional learning accuracy ${(learning.directionalAccuracy * 100).toFixed(1)}%`
    );
  }
  if (learning.optionOutperformanceAccuracy !== null && learning.optionOutperformanceAccuracy > 0.55 && expression !== "shares") {
    score += 5;
    rationale.push(
      `Options learning outperformance ${(learning.optionOutperformanceAccuracy * 100).toFixed(1)}%`
    );
  }
  const falsePositiveRate =
    learning.directionalAccuracy === null ? 0 : Math.max(0, 1 - learning.directionalAccuracy);
  if (falsePositiveRate > 0.6) {
    score -= 8;
    rationale.push(
      `High recent false-positive rate ${(falsePositiveRate * 100).toFixed(1)}% reduced score`
    );
  }

  if (backtest && backtest.byExpression[expression]) {
    const strategyPerf = backtest.byExpression[expression];
    score += strategyPerf.setups >= 2 ? 3 : 0;
    if (strategyPerf.winRate >= 0.55) {
      score += (strategyPerf.winRate - 0.55) * 12;
      rationale.push(`Backtest wins ${(strategyPerf.winRate * 100).toFixed(1)}% for ${expression}`);
    } else if (strategyPerf.setups > 1) {
      score -= 4;
      rationale.push(
        `Limited backtest confirmation for ${expression}: ${strategyPerf.setups} examples, ${
          (strategyPerf.winRate * 100).toFixed(1)
        }% wins`
      );
    }
  } else {
    rationale.push("No relevant backtest found. Candidate selected based on current signal and learning value.");
  }

  if (riskProfile === "aggressive" && row.risk_profile === "aggressive") {
    score += 6;
    rationale.push("Aggressive profile allows higher-risk candidate selection.");
  }
  if (riskProfile === "aggressive" && isLeveragedCandidate(row.symbol)) {
    score += 3;
    rationale.push(`Leveraged candidate ${row.symbol} receives aggressive preference.`);
  }
  if (riskProfile === "aggressive" && row.preferred_expression === "shares") {
    score -= 1;
    rationale.push("Aggressive run prefers options structure when signals support it.");
  }
  if (riskProfile === "conservative") {
    score -= row.confidence < 0.45 ? 0 : 2;
  }

  score = clamp(score, 0, 100);

  return { score, rationale };
};

const sourceFromTargets = (targets: TargetSnapshotRow[]): CandidateSourceRow[] =>
  targets
    .filter((target) => target.preferredExpression !== "none")
    .map((target) => ({
      id: 0,
      symbol: normalizeSymbol(target.symbol),
      as_of: target.asOf,
      direction: target.direction,
      horizon: target.horizon,
      entry_reference: target.entryReference,
      upside_target: target.upsideTarget,
      downside_risk: target.downsideRisk,
      stop_loss: target.stopLoss,
      take_profit: target.takeProfit,
      confidence: target.confidence,
      expected_return: target.expectedReturn,
      volatility_adjusted_score: target.volatilityAdjustedScore,
      risk_profile: target.riskProfile,
      preferred_expression: target.preferredExpression,
      rationale: JSON.stringify(target.rationale)
    }));

export const rankResearchCandidates = (input: CandidateRankingInput): CandidateRankingResult => {
  const config = pickRiskProfileDefaults(input.riskProfile);
  const maxCandidates = input.maxCandidates;
  const maxPerSymbol = input.maxPerSymbol || config.maxPerSymbol;
  const maxPerDirection = input.maxPerDirection || config.maxPerDirection;
  const maxPerExpression = input.maxPerExpression || config.maxPerExpression;
  const warnings: string[] = [];
  const learning = parseLearningSummary();
  const backtest = parseBacktestPerformance();
  const signalInputsByCandidate = new Map<string, Record<string, string | number | null>>();

  const scored = sourceFromTargets(input.targets).map((target) => {
    const optionCandidate = getOptionCandidate(target.symbol, target.as_of);
    const freshnessPenalty = calculateFreshnessPenalty(target.as_of);
    const scoring = computeScore(
      target,
      optionCandidate,
      freshnessPenalty,
      learning,
      backtest,
      input.riskProfile,
      input.optionsEnabled
    );
    const options = optionCandidate;
    const pnl = estimateCandidatePnlRange(target.direction, target, options);
    const featureSnapshot = getLatestFeatureSnapshot(target.symbol, target.as_of);
    const optionLiquidity =
      typeof options?.liquidityScore === "number"
        ? options.liquidityScore
        : typeof featureSnapshot.preferredContractLiquidityScore === "number"
          ? featureSnapshot.preferredContractLiquidityScore
          : 0;

    const rationale = [
      ...parseCandidateRationale(target.rationale),
      ...scoring.rationale
    ];
    const falsePositiveRate =
      learning.directionalAccuracy === null ? null : Math.max(0, 1 - learning.directionalAccuracy);

    const candidatePerf = backtest?.byExpression[target.preferred_expression];
    const id = uuid();
    signalInputsByCandidate.set(id, featureSnapshot);
    return {
      id,
      symbol: target.symbol,
      asOf: target.as_of,
      rank: 0,
      direction: target.direction,
      horizon: target.horizon,
      riskProfile: input.riskProfile,
      preferredExpression: target.preferred_expression,
      score: scoring.score,
      confidence: target.confidence,
      expectedReturn: target.expected_return,
      estimatedMaxLoss: pnl.estimatedMaxLoss,
      estimatedMaxProfit: pnl.estimatedMaxProfit,
      rationale,
      relevantBacktestRunId: backtest?.runId ?? null,
      historicalWinRate: candidatePerf ? candidatePerf.winRate : null,
      historicalAvgReturn: candidatePerf ? candidatePerf.avgReturn : null,
      historicalMaxDrawdown: backtest?.maxDrawdown ?? null,
      similarSetupCount: candidatePerf ? candidatePerf.setups : null,
      optionLiquidityScore: optionLiquidity,
      volatilityAdjustedScore: target.volatility_adjusted_score,
      signalFreshnessDays: freshnessPenalty > 0 ? Math.round(freshnessPenalty / 0.8) : 0,
      recentLearningAdjustment:
        learning.directionalAccuracy !== null && learning.directionalAccuracy > 0.55 ? 5 : 0,
      directionalAccuracy: learning.directionalAccuracy,
      optionOutperformanceAccuracy: learning.optionOutperformanceAccuracy,
      estimatedExitValue: null,
      optionSymbol: options?.optionSymbol ?? null,
      strike: options?.strike,
      shortStrike: options?.shortStrike
    };
  });

  const sorted = scored.sort((left, right) => right.score - left.score);
  const bySymbol = new Map<string, number>();
  const byDirection = new Map<CandidateDirection, number>();
  const byExpression = new Map<PreferredExpression, number>();
  const skippedReasons = new Map<string, string>();
  const selected: RankedCandidate[] = [];

  for (const candidate of sorted) {
    if (selected.length >= maxCandidates) {
      skippedReasons.set(candidate.id, "MAX_CANDIDATES_REACHED");
      continue;
    }

    const symbolCount = bySymbol.get(candidate.symbol) ?? 0;
    const directionCount = byDirection.get(candidate.direction) ?? 0;
    const expressionCount = byExpression.get(candidate.preferredExpression) ?? 0;

    if (symbolCount >= maxPerSymbol) {
      skippedReasons.set(candidate.id, "MAX_PER_SYMBOL_REACHED");
      continue;
    }
    if (directionCount >= maxPerDirection) {
      skippedReasons.set(candidate.id, "MAX_PER_DIRECTION_REACHED");
      continue;
    }
    if (expressionCount >= maxPerExpression) {
      skippedReasons.set(candidate.id, "MAX_PER_EXPRESSION_REACHED");
      continue;
    }

    bySymbol.set(candidate.symbol, symbolCount + 1);
    byDirection.set(candidate.direction, directionCount + 1);
    byExpression.set(candidate.preferredExpression, expressionCount + 1);
    selected.push(candidate);
  }

  if (!selected.length && sorted.length && input.riskProfile === "aggressive") {
    selected.push(...sorted.slice(0, maxCandidates));
    selected.forEach((candidate) => skippedReasons.delete(candidate.id));
    warnings.push(
      `Aggressive mode relaxed diversity constraints to avoid empty selection after strict filtering.`
    );
  }

  selected.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });
  const selectedRankById = new Map(selected.map((candidate) => [candidate.id, candidate.rank]));
  const decisions: CandidateDecisionRecord[] = sorted.map((candidate, index) => {
    const signalInputs = signalInputsByCandidate.get(candidate.id) ?? {};
    const selectedRank = selectedRankById.get(candidate.id);
    return {
      ...candidate,
      rank: selectedRank ?? index + 1,
      decision: selectedRank === undefined ? "skipped" : "selected",
      decisionReason:
        selectedRank === undefined
          ? skippedReasons.get(candidate.id) ?? "RANKING_CONSTRAINT"
          : "RANKED_SELECTED",
      strategyFamily: candidate.preferredExpression,
      signalInputs,
      dataQualityStatus:
        typeof signalInputs.observatoryDataQualityStatus === "string"
          ? signalInputs.observatoryDataQualityStatus
          : "UNOBSERVED"
    };
  });

  if (selected.length >= 4) {
    const topSymbol = [...bySymbol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topSymbol) {
      const topCount = bySymbol.get(topSymbol) ?? 0;
      if (topCount >= Math.ceil(selected.length * 0.6)) {
        warnings.push(
          `Candidate list is concentrated: ${topCount} of ${selected.length} candidates are symbol-linked (${topSymbol}).`
        );
      }
    }
  }
  if (input.requireSectorDiversity && selected.length >= 4) {
    const distinctSymbols = new Set(selected.map((entry) => entry.symbol)).size;
    if (distinctSymbols < Math.max(2, Math.floor(selected.length * 0.5))) {
      warnings.push(
        `Sector-diversity request could not be fully enforced: insufficient diversity in ranked candidates.`
      );
    }
  }

  return { candidates: selected, decisions, warnings };
};

export const persistCandidateDecisions = (input: {
  researchRunId: string;
  decisions: CandidateDecisionRecord[];
}) => {
  const rows = input.decisions.map((decision) => ({
    ...decision,
    researchRunId: input.researchRunId
  }));
  const insert = getDb().prepare(`
    INSERT INTO paper_trade_candidates(
      id,
      decision_id,
      decision_linkage_status,
      research_run_id,
      symbol,
      as_of,
      rank,
      direction,
      horizon,
      risk_profile,
      preferred_expression,
      score,
      confidence,
      expected_return,
      estimated_max_loss,
      estimated_max_profit,
      rationale,
      relevant_backtest_run_id,
      historical_win_rate,
      historical_avg_return,
      historical_max_drawdown,
      similar_setup_count,
      option_liquidity_score,
      volatility_score,
      signal_freshness_days,
      recent_learning_adjustment,
      directional_accuracy,
      option_outperformance_accuracy,
      option_symbol,
      strike,
      short_strike,
      decision,
      decision_reason,
      strategy_family,
      signal_inputs_json,
      data_quality_status
    ) VALUES (
      ?, ?, 'EXACT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?
    ) ON CONFLICT(id) DO NOTHING
  `);
  const persistedRows: Array<(typeof rows)[number] & { decisionId: DecisionId }> = [];
  for (const row of rows) {
    const existing = getDb()
      .prepare("SELECT decision_id FROM paper_trade_candidates WHERE id = ?")
      .get(row.id) as { decision_id: string | null } | undefined;
    const decisionId = existing?.decision_id ?? createDecisionId();
    insert.run(
      row.id,
      decisionId,
      row.researchRunId,
      row.symbol,
      row.asOf,
      row.rank,
      row.direction,
      row.horizon,
      row.riskProfile,
      row.preferredExpression,
      row.score,
      row.confidence,
      row.expectedReturn,
      row.estimatedMaxLoss,
      row.estimatedMaxProfit,
      JSON.stringify(row.rationale),
      row.relevantBacktestRunId ?? null,
      row.historicalWinRate,
      row.historicalAvgReturn,
      row.historicalMaxDrawdown,
      row.similarSetupCount,
      row.optionLiquidityScore,
      row.volatilityAdjustedScore,
      row.signalFreshnessDays,
      row.recentLearningAdjustment,
      row.directionalAccuracy,
      row.optionOutperformanceAccuracy,
      row.optionSymbol ?? null,
      row.strike ?? null,
      row.shortStrike ?? null,
      row.decision,
      row.decisionReason,
      row.strategyFamily,
      JSON.stringify(row.signalInputs),
      row.dataQualityStatus
    );
    const persisted = getDb()
      .prepare("SELECT decision_id FROM paper_trade_candidates WHERE id = ?")
      .get(row.id) as { decision_id: string };
    persistedRows.push({ ...row, decisionId: persisted.decision_id as DecisionId });
  }
  return persistedRows;
};

export const persistRankedCandidates = (input: {
  researchRunId: string;
  candidates: Omit<PaperTradeCandidateRow, "researchRunId">[];
}): PaperTradeCandidateRow[] =>
  persistCandidateDecisions({
    researchRunId: input.researchRunId,
    decisions: input.candidates.map((candidate) => ({
      ...candidate,
      decision: "selected",
      decisionReason: "RANKED_SELECTED",
      strategyFamily: candidate.preferredExpression,
      signalInputs: {},
      dataQualityStatus: "UNOBSERVED"
    }))
  });
