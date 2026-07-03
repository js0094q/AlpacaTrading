import { getDb, queryAll, queryOne } from "../lib/db.js";
import { normalizeSymbol, nowIso, uuid } from "../lib/utils.js";
import type {
  PaperTradeCandidateRow,
  PaperTradeEvaluationRow,
  PaperTradePlanRow,
  RiskProfile,
  TimeHorizon
} from "../types.js";
import type { RankedCandidate } from "./candidateRankingService.js";

interface PlanBuildInput {
  researchRunId: string;
  candidates: RankedCandidate[];
  riskProfile: RiskProfile;
}

interface EvaluationInput {
  asOf?: string;
  horizon?: TimeHorizon;
}

interface EvaluationPlanRow {
  id: string;
  research_run_id: string;
  candidate_id: string;
  symbol: string;
  created_at: string;
  status: "planned" | "entered" | "closed" | "expired" | "skipped";
  direction: "long" | "short" | "neutral";
  expression: string;
  entry_reference: number;
  stop_loss: number | null;
  take_profit: number | null;
  expiration_date: string | null;
  option_symbol: string | null;
  strike: number | null;
  short_strike: number | null;
  estimated_entry_cost: number | null;
  estimated_max_loss: number | null;
  estimated_max_profit: number | null;
  thesis: string;
  invalidation: string;
  learning_objective: string;
}

interface ResearchReportInput {
  runId?: string;
}

interface ReportPayload {
  run: {
    id: string;
    date: string;
    status: string;
    universeSize: number;
    targetsGenerated: number;
    candidatesSelected: number;
    riskProfile: RiskProfile;
    optionsEnabled: boolean;
    warnings: string[];
  };
  topCandidates: Array<{
    symbol: string;
    direction: string;
    expression: string;
    score: number;
    rank: number;
    rationale: string[];
  }>;
  bestLearningSignals: string[];
  paperTradePlans: Array<{
    symbol: string;
    direction: string;
    expression: string;
    status: string;
    thesis: string;
    invalidation: string;
    learningObjective: string;
  }>;
}

const mapTimeHorizonToDays = (horizon: TimeHorizon) =>
  ({ "1d": 1, "5d": 5, "20d": 20 } as const)[horizon];

const parseJsonArray = (raw: string | null | undefined) => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const safeParseFloat = (value: string | number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
};

const getBarAtOrBefore = (symbol: string, toIso: string) =>
  queryOne<{ close: number }>(
    `
    SELECT close
    FROM market_bars
    WHERE symbol = ? AND timeframe = '1Day' AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT 1
  `,
    [normalizeSymbol(symbol), toIso]
  );

const getOptionPriceAtOrBefore = (optionSymbol: string, toIso: string) =>
  queryOne<{ bid: number | null; ask: number | null; midpoint: number | null; last: number | null }>(
    `
    SELECT bid, ask, midpoint, last
    FROM option_snapshots
    WHERE option_symbol = ? AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT 1
  `,
    [optionSymbol, toIso]
  );

const getTargetRow = (symbol: string, asOf: string) =>
  queryOne<{
    entry_reference: number;
    stop_loss: number | null;
    take_profit: number | null;
  }>(
    `
    SELECT entry_reference, stop_loss, take_profit
    FROM target_snapshots
    WHERE symbol = ? AND as_of = ?
    LIMIT 1
  `,
    [normalizeSymbol(symbol), asOf]
  );

const getPlanInvalidationPriceText = (
  direction: "long" | "short" | "neutral",
  stopLoss: number | null,
  takeProfit: number | null
) => {
  if (direction === "long") {
    const stop = stopLoss !== null ? stopLoss : "stop-loss threshold";
    return `price closes below ${stop}`;
  }
  if (direction === "short") {
    const stop = takeProfit !== null ? takeProfit : "take-profit threshold";
    return `price rises above ${stop}`;
  }
  return "signal quality degrades";
};

const learningObjectiveText = (
  symbol: string,
  direction: string,
  expression: string
) => {
  if (direction === "long" && ["long_call", "call_spread", "collar"].includes(expression)) {
    return `Test whether high-relative-volume breakouts in ${symbol} outperform through ${expression} versus shares.`;
  }
  if (direction === "short" && ["long_put", "put_spread", "protective_put"].includes(expression)) {
    return `Test whether bearish momentum breaks in ${symbol} are better expressed through ${expression} than shares.`;
  }
  if (direction === "long" && ["cash_secured_put", "covered_call"].includes(expression)) {
    return `Test whether income-oriented ${expression} structures on ${symbol} improve outcome stability.`;
  }
  return `Test whether ${direction} direction on ${symbol} is more reliable than baseline share-only execution.`;
};

const buildThesis = (candidate: RankedCandidate, target: {
  entry_reference: number;
  stop_loss: number | null;
  take_profit: number | null;
}) => {
  const riskSignals = candidate.rationale.slice(0, 2).join(" • ");
  const stopText = getPlanInvalidationPriceText(
    candidate.direction,
    target.stop_loss,
    target.take_profit
  );
  return `${candidate.symbol} ${candidate.direction} ${candidate.preferredExpression}: ${riskSignals}. Invalidation trigger is ${stopText}.`;
};

const buildInvalidation = (candidate: RankedCandidate, target: {
  entry_reference: number;
  stop_loss: number | null;
  take_profit: number | null;
}) => {
  const core = getPlanInvalidationPriceText(candidate.direction, target.stop_loss, target.take_profit);
  return `Exit plan early if ${core}, or if the setup loses momentum and liquidity decays.`;
};

const resolveOutcome = (
  plan: EvaluationPlanRow,
  markPrice: number | null,
  due: boolean,
  outcomeAsOf: string
) => {
  if (!due) {
    return {
      outcome: "still_open" as const,
      estimatedExitValue: markPrice,
      returnPct: null,
      realizedPnl: null,
      unrealizedPnl: null,
      notes: ["Evaluation skipped: plan horizon not reached yet."],
      status: plan.status
    };
  }

  if (markPrice === null) {
    return {
      outcome: "insufficient_data" as const,
      estimatedExitValue: null,
      returnPct: null,
      realizedPnl: null,
      unrealizedPnl: null,
      notes: [
        `No price mark was available for ${plan.symbol} at ${outcomeAsOf}; outcome withheld until additional data is available.`
      ],
      status: "entered"
    };
  }

  const entry = plan.estimated_entry_cost || Math.abs(plan.entry_reference) || 0;
  const markDelta =
    plan.direction === "long"
      ? markPrice - plan.entry_reference
      : plan.direction === "short"
        ? plan.entry_reference - markPrice
        : 0;
  const returnPct = entry > 0 ? (markDelta / entry) * 100 : 0;
  const realizedPnl = markDelta;
  const unrealizedPnl = markDelta;

  if (plan.expression !== "shares" && markPrice <= 0) {
    return {
      outcome: "expired_worthless" as const,
      estimatedExitValue: markPrice,
      returnPct,
      realizedPnl,
      unrealizedPnl,
      notes: ["Option value reached zero before horizon."],
      status: "expired"
    };
  }

  if (plan.direction === "long") {
    if (plan.stop_loss !== null && markPrice <= plan.stop_loss) {
      return {
        outcome: "hit_stop" as const,
        estimatedExitValue: markPrice,
        returnPct,
        realizedPnl,
        unrealizedPnl,
        notes: ["Long plan hit stop-loss threshold."],
        status: "closed"
      };
    }
    if (plan.take_profit !== null && markPrice >= plan.take_profit) {
      return {
        outcome: "hit_take_profit" as const,
        estimatedExitValue: markPrice,
        returnPct,
        realizedPnl,
        unrealizedPnl,
        notes: ["Long plan hit take-profit threshold."],
        status: "closed"
      };
    }
  }

  if (plan.direction === "short") {
    if (plan.stop_loss !== null && markPrice >= plan.stop_loss) {
      return {
        outcome: "hit_stop" as const,
        estimatedExitValue: markPrice,
        returnPct,
        realizedPnl,
        unrealizedPnl,
        notes: ["Short plan stop-loss threshold hit."],
        status: "closed"
      };
    }
    if (plan.take_profit !== null && markPrice <= plan.take_profit) {
      return {
        outcome: "hit_take_profit" as const,
        estimatedExitValue: markPrice,
        returnPct,
        realizedPnl,
        unrealizedPnl,
        notes: ["Short plan take-profit threshold hit."],
        status: "closed"
      };
    }
  }

  if (returnPct > 0.5) {
    return {
      outcome: "winner" as const,
      estimatedExitValue: markPrice,
      returnPct,
      realizedPnl,
      unrealizedPnl,
      notes: ["Plan remains positive through horizon."],
      status: "closed"
    };
  }
  if (returnPct < -0.5) {
    return {
      outcome: "loser" as const,
      estimatedExitValue: markPrice,
      returnPct,
      realizedPnl,
      unrealizedPnl,
      notes: ["Plan is negative through horizon."],
      status: "closed"
    };
  }

  return {
    outcome: "flat" as const,
    estimatedExitValue: markPrice,
    returnPct,
    realizedPnl,
    unrealizedPnl,
    notes: ["Plan is near-flat by horizon check."],
    status: "closed"
  };
};

export const buildPaperTradePlans = (input: PlanBuildInput): PaperTradePlanRow[] => {
  const insert = getDb().prepare(`
    INSERT INTO paper_trade_plans(
      id,
      research_run_id,
      candidate_id,
      symbol,
      created_at,
      status,
      direction,
      expression,
      entry_reference,
      stop_loss,
      take_profit,
      expiration_date,
      option_symbol,
      strike,
      short_strike,
      estimated_entry_cost,
      estimated_max_loss,
      estimated_max_profit,
      thesis,
      invalidation,
      learning_objective
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const out: PaperTradePlanRow[] = [];
  for (const candidate of input.candidates) {
    const target = getTargetRow(candidate.symbol, candidate.asOf);
    if (!target) {
      continue;
    }
    const entryReference = Number(target.entry_reference);
    const stopLoss = safeParseFloat(target.stop_loss);
    const takeProfit = safeParseFloat(target.take_profit);
    const thesis = buildThesis(candidate, {
      entry_reference: entryReference,
      stop_loss: stopLoss,
      take_profit: takeProfit
    });
    const invalidation = buildInvalidation(candidate, {
      entry_reference: entryReference,
      stop_loss: stopLoss,
      take_profit: takeProfit
    });
    const learningObjective = learningObjectiveText(
      candidate.symbol,
      candidate.direction,
      candidate.preferredExpression
    );

    const exposureMultiplier = input.riskProfile === "aggressive" ? 3 : input.riskProfile === "moderate" ? 2 : 1;
    const baseEntry = candidate.preferredExpression === "shares"
      ? Math.max(1, Math.abs(entryReference) * 10)
      : Math.max(1, Math.abs(candidate.estimatedMaxLoss ?? candidate.expectedReturn ?? 1) * 5);

    const planId = `plan_${uuid()}`;
    const plan: PaperTradePlanRow = {
      id: planId,
      researchRunId: input.researchRunId,
      candidateId: candidate.id,
      symbol: candidate.symbol,
      createdAt: nowIso(),
      status: "planned",
      direction: candidate.direction,
      expression: candidate.preferredExpression,
      entryReference: entryReference,
      stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
      takeProfit: Number.isFinite(takeProfit) ? takeProfit : null,
      expirationDate: null,
      optionSymbol: candidate.optionSymbol ?? null,
      strike: candidate.strike ?? null,
      shortStrike: candidate.shortStrike ?? null,
      estimatedEntryCost: Number(baseEntry * exposureMultiplier),
      estimatedMaxLoss: candidate.estimatedMaxLoss,
      estimatedMaxProfit: candidate.estimatedMaxProfit,
      thesis,
      invalidation,
      learningObjective,
      lastEvaluatedAt: null,
      lastOutcome: null,
      lastReturnPct: null
    };

    insert.run(
      plan.id,
      plan.researchRunId,
      plan.candidateId,
      plan.symbol,
      plan.createdAt,
      plan.status,
      plan.direction,
      plan.expression,
      plan.entryReference,
      plan.stopLoss,
      plan.takeProfit,
      plan.expirationDate,
      plan.optionSymbol,
      plan.strike,
      plan.shortStrike,
      plan.estimatedEntryCost,
      plan.estimatedMaxLoss,
      plan.estimatedMaxProfit,
      plan.thesis,
      plan.invalidation,
      plan.learningObjective
    );

    out.push(plan);
  }

  return out;
};

export const evaluatePaperTrades = (input?: EvaluationInput) => {
  const horizon = input?.horizon || "5d";
  const asOf = input?.asOf || nowIso();
  const asOfDate = new Date(asOf);
  const horizonDays = mapTimeHorizonToDays(horizon);
  const dueToleranceMs = 60_000;

  const plans = queryAll<EvaluationPlanRow>(`
    SELECT *
    FROM paper_trade_plans
    WHERE status IN ('planned', 'entered')
    ORDER BY created_at ASC
  `);

  const insert = getDb().prepare(`
    INSERT INTO paper_trade_evaluations(
      id,
      research_run_id,
      candidate_id,
      plan_id,
      horizon,
      evaluated_at,
      mark_price,
      estimated_exit_value,
      unrealized_pnl,
      realized_pnl,
      return_pct,
      outcome,
      notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updatePlan = getDb().prepare(`
    UPDATE paper_trade_plans
    SET status = ?, last_evaluated_at = ?, last_outcome = ?, last_return_pct = ?
    WHERE id = ?
  `);

  const results: Array<PaperTradeEvaluationRow & { planId: string }> = [];

  for (const plan of plans) {
    const createdAt = new Date(plan.created_at);
    const dueAt = new Date(createdAt.getTime() + horizonDays * 24 * 60 * 60 * 1000);
    const due = asOfDate.getTime() + dueToleranceMs >= dueAt.getTime();
    const dueAsIso = dueAt.toISOString();

    const markPrice = plan.option_symbol
      ? getOptionPriceAtOrBefore(plan.option_symbol, dueAsIso)?.midpoint ??
        getOptionPriceAtOrBefore(plan.option_symbol, dueAsIso)?.last ??
        getOptionPriceAtOrBefore(plan.option_symbol, dueAsIso)?.ask ??
        getOptionPriceAtOrBefore(plan.option_symbol, dueAsIso)?.bid ??
        null
      : getBarAtOrBefore(plan.symbol, dueAsIso)?.close ?? null;

    const outcome = resolveOutcome(plan, markPrice, due, dueAsIso);

    insert.run(
      `eval_${uuid()}`,
      plan.research_run_id,
      plan.candidate_id,
      plan.id,
      horizon,
      asOf,
      markPrice,
      outcome.estimatedExitValue,
      outcome.unrealizedPnl,
      due ? outcome.realizedPnl : null,
      outcome.returnPct,
      outcome.outcome,
      JSON.stringify(outcome.notes)
    );

    const nextStatus =
      outcome.status === "entered"
        ? "entered"
        : outcome.outcome === "expired_worthless"
          ? "expired"
          : "closed";

    updatePlan.run(
      nextStatus,
      asOf,
      outcome.outcome,
      outcome.returnPct,
      plan.id
    );

    results.push({
      id: `eval_${uuid()}`,
      researchRunId: plan.research_run_id,
      candidateId: plan.candidate_id,
      planId: plan.id,
      evaluatedAt: asOf,
      markPrice,
      estimatedExitValue: outcome.estimatedExitValue,
      unrealizedPnl: outcome.unrealizedPnl,
      realizedPnl: due ? outcome.realizedPnl : null,
      returnPct: outcome.returnPct,
      outcome: outcome.outcome,
      notes: outcome.notes,
      horizon
    });
  }

  return { evaluated: results.length, evaluations: results };
};

export const buildResearchReport = (input?: ResearchReportInput): ReportPayload => {
  const run = input?.runId
    ? queryOne<{
        id: string;
        started_at: string;
        status: string;
        risk_profile: RiskProfile;
        options_enabled: number;
        universe_size: number;
        targets_generated: number;
        candidates_selected: number;
        summary_json: string | null;
      }>(`SELECT * FROM research_runs WHERE id = ? LIMIT 1`, [input.runId])
    : queryOne<{
        id: string;
        started_at: string;
        status: string;
        risk_profile: RiskProfile;
        options_enabled: number;
        universe_size: number;
        targets_generated: number;
        candidates_selected: number;
        summary_json: string | null;
      }>(`SELECT * FROM research_runs ORDER BY started_at DESC LIMIT 1`);

  if (!run) {
    throw new Error("No research run found.");
  }

  const parsedSummary = run.summary_json
    ? (() => {
        try {
          return JSON.parse(run.summary_json) as { warnings?: string[] };
        } catch {
          return {} as { warnings?: string[] };
        }
      })()
    : {};

  const warnings = Array.isArray(parsedSummary.warnings) ? parsedSummary.warnings : [];

  const topCandidates = queryAll<{
    symbol: string;
    direction: string;
    preferred_expression: string;
    score: number;
    rank: number;
    rationale: string;
  }>(
    `
    SELECT symbol, direction, preferred_expression, score, rank, rationale
    FROM paper_trade_candidates
    WHERE research_run_id = ?
    ORDER BY rank ASC
    LIMIT 10
  `,
    [run.id]
  ).map((row) => ({
    symbol: row.symbol,
    direction: row.direction,
    expression: row.preferred_expression,
    score: Number(row.score),
    rank: Number(row.rank),
    rationale: parseJsonArray(row.rationale)
  }));

  const plans = queryAll<{
    symbol: string;
    direction: string;
    expression: string;
    status: string;
    thesis: string;
    invalidation: string;
    learning_objective: string;
  }>(
    `
    SELECT symbol, direction, expression, status, thesis, invalidation, learning_objective
    FROM paper_trade_plans
    WHERE research_run_id = ?
    ORDER BY created_at ASC
    `,
    [run.id]
  );

  const latestLearning = queryOne<{
    model_name: string;
    metrics_json: string;
  }>(
    `
    SELECT model_name, metrics_json
    FROM learning_runs
    ORDER BY trained_at DESC
    LIMIT 1
    `
  );

  const metrics = latestLearning
    ? (JSON.parse(latestLearning.metrics_json) as {
        directionalAccuracy?: number;
        optionOutperformanceAccuracy?: number;
      })
    : null;

  const bestLearningSignals = [
    latestLearning
      ? `Model ${latestLearning.model_name} directional accuracy ${(metrics?.directionalAccuracy ?? 0).toFixed(2)}`
      : "No learning model available yet",
    latestLearning
      ? `Option outperformance signal ${(metrics?.optionOutperformanceAccuracy ?? 0).toFixed(2)}`
      : "No options performance signal available"
  ];

  return {
    run: {
      id: run.id,
      date: run.started_at,
      status: run.status,
      universeSize: Number(run.universe_size),
      targetsGenerated: Number(run.targets_generated),
      candidatesSelected: Number(run.candidates_selected),
      riskProfile: run.risk_profile,
      optionsEnabled: Number(run.options_enabled) === 1,
      warnings
    },
    topCandidates,
    bestLearningSignals,
    paperTradePlans: plans.map((plan) => ({
      symbol: plan.symbol,
      direction: plan.direction,
      expression: plan.expression,
      status: plan.status,
      thesis: plan.thesis,
      invalidation: plan.invalidation,
      learningObjective: plan.learning_objective
    }))
  };
};
