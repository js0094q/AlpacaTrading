import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import { getDb, queryAll } from "../../lib/db.js";
import { redactSensitiveText } from "../../lib/securityRedaction.js";
import { nowIso } from "../../lib/utils.js";
import { atr, ema, rollingStd } from "../indicators.js";
import {
  createAlpacaZeroDteMarketDataProvider,
  collectZeroDteMarketContexts,
  type ZeroDteMarketContext,
  type ZeroDteMarketDataProvider,
  type ZeroDteOptionQuote
} from "./zeroDteMarketDataService.js";
import {
  evaluateZeroDtePlaybooks,
  type PlaybookEvaluation,
  type ZeroDtePlaybookContext
} from "./zeroDtePlaybookService.js";
import {
  classifyZeroDteRegime,
  type ZeroDteIndicators
} from "./zeroDteRegimeService.js";
import { summarizeZeroDteSignal } from "./zeroDteSignalService.js";
import { loadZeroDteConfig } from "./zeroDteConfigService.js";
import {
  appendZeroDteCandidateObservation,
  insertZeroDtePlaybookEvaluation,
  listZeroDteQueue,
  readZeroDteSummary,
  runInZeroDtePersistenceTransaction,
  upsertZeroDteCandidate,
  type ZeroDteCandidate,
  type ZeroDteQueueCandidate
} from "./zeroDtePersistenceService.js";
import {
  buildZeroDteCandidateId,
  buildZeroDteDecisionId
} from "./zeroDteIdentityService.js";
import {
  insertZeroDteDecisionRow,
  insertZeroDteLifecycleEventRow
} from "./zeroDteLifecycleService.js";
import {
  createZeroDteShadowTrade,
  markZeroDteShadowTrades,
  readZeroDteShadowTrades,
  type ZeroDteShadowTrade,
  type ZeroDteMarkResult
} from "./zeroDteShadowService.js";
import {
  captureZeroDteOutcomes,
  readZeroDteDailyOutcomeSummary,
  type ZeroDteDailyOutcomeSummary,
  type ZeroDteMissedCandidate,
  type ZeroDteOutcomeResult
} from "./zeroDteOutcomeService.js";
import {
  executeZeroDteCandidate,
  reconcileZeroDtePaperOrders,
  type ZeroDteExecutionResult,
  type ZeroDteOrderReconciliationResult,
  type ZeroDtePaperMutationProvider
} from "./zeroDteExecutionService.js";
import type {
  ZeroDteConfig,
  ZeroDteDirection,
  ZeroDteRuntimeSnapshot
} from "./zeroDteTypes.js";

export type { ZeroDteMarketContext } from "./zeroDteMarketDataService.js";

export interface ZeroDteEngineProvider extends Partial<ZeroDteMarketDataProvider> {
  collectContexts?: (input: {
    now: string;
    config: ZeroDteConfig;
  }) => Promise<ZeroDteMarketContext[]>;
  mutationProvider?: ZeroDtePaperMutationProvider;
}

export type ZeroDteEngineStatus = "completed" | "closed" | "blocked" | "partial" | "failed";

export interface ZeroDteEngineRunResult {
  paperOnly: true;
  environment: "paper" | "live";
  status: ZeroDteEngineStatus;
  runId: string;
  tradingDate: string;
  accountMode: "paper" | "shadow" | "dry_run";
  configurationVersionId: string;
  contexts: number;
  candidatesDiscovered: number;
  candidatesEvaluated: number;
  candidatesEligible: number;
  selectedCount: number;
  executedCount: number;
  shadowCount: number;
  errors: Array<{ code: string; message: string; underlying?: string }>;
  executionResults: ZeroDteExecutionResult[];
}

export interface ZeroDtePaperMarkResult {
  paperOnly: true;
  marked: number;
  blocked: number;
}

export interface ZeroDteReconciliationResult {
  paperOnly: true;
  environment: "paper" | "live";
  tradingDate: string;
  generatedAt: string;
  mutationAttempted: false;
  contexts: number;
  paperOrders: ZeroDteOrderReconciliationResult;
  paperMarks: ZeroDtePaperMarkResult;
  shadowMarks: ZeroDteMarkResult;
  outcomes: ZeroDteOutcomeResult;
  errors: Array<{ code: string; message: string }>;
}

export interface ZeroDteSummary extends ReturnType<typeof readZeroDteSummary> {
  engine: {
    lastRunId: string | null;
    lastStatus: string | null;
    lastCompletedAt: string | null;
    staleDataCount: number;
  };
  outcomes: ZeroDteDailyOutcomeSummary | null;
}

export interface ZeroDteEodSummary extends ZeroDteDailyOutcomeSummary {
  reconciliation: ZeroDteReconciliationResult;
}

export interface ZeroDtePaperPosition {
  paperTradeId: string;
  candidateId: string;
  optionSymbol: string;
  playbook: string;
  direction: string;
  status: string;
  quantity: number;
  entryPremium: number | null;
  currentMark: number | null;
  unrealizedPnl: number | null;
  mfe: number | null;
  mae: number | null;
  exitReasonCode: string | null;
  brokerOrderId: string | null;
}

export interface ZeroDteDashboardSummary {
  paperOnly: true;
  generatedAt: string;
  tradingDate: string | null;
  engine: {
    enabled: boolean;
    lastRunAt: string | null;
    status: string;
    queueSize: number;
    staleDataCount: number;
  };
  queue: ZeroDteQueueCandidate[];
  paperPositions: ZeroDtePaperPosition[];
  shadowTrades: Array<Pick<ZeroDteShadowTrade,
    | "shadowTradeId"
    | "decisionGroupId"
    | "decisionId"
    | "candidateId"
    | "tradingDate"
    | "underlyingSymbol"
    | "optionSymbol"
    | "playbook"
    | "direction"
    | "alternativeType"
    | "status"
    | "quantity"
    | "entryPremium"
    | "exitPremium"
    | "fees"
    | "slippage"
    | "mfe"
    | "mae"
    | "realizedPnl"
    | "returnPct"
    | "terminalState"
    | "exitReasonCode"
    | "openedAt"
    | "closedAt"
    | "updatedAt"
  > & { simulated: true }>;
  lifecycle: ReturnType<typeof readZeroDteSummary>["lifecycle"];
  learning: ZeroDteDailyOutcomeSummary | null;
  blockers: string[];
}

type ExtendedMarketContext = ZeroDteMarketContext & Record<string, unknown>;

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

const finite = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const normalizedSymbol = (value: unknown) => String(value || "").trim().toUpperCase();

const isPaperRuntime = (): boolean => {
  const environment = String(process.env.ALPACA_ENV || "paper").trim().toLowerCase();
  const tradingMode = String(process.env.TRADING_MODE || "paper").trim().toLowerCase();
  const live = [process.env.LIVE_TRADING_ENABLED, process.env.ALPACA_LIVE_TRADE]
    .some((value) => value === "true" || value === "1");
  return environment === "paper" && tradingMode === "paper" && !live;
};

const environmentName = (): "paper" | "live" =>
  String(process.env.ALPACA_ENV || "paper").trim().toLowerCase() === "live" ? "live" : "paper";

const configJson = (config: ZeroDteConfig) => JSON.stringify(config);

const tradingDateFor = (now: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const normalizeError = (error: unknown) =>
  redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500);

const engineRunIdFor = (
  tradingDate: string,
  now: string,
  config: ZeroDteConfig,
  mode: string
) => `zrun_${canonicalJsonHash({ tradingDate, now, configurationVersionId: config.configurationVersionId, mode }).slice(0, 40)}`;

const decisionGroupIdFor = (runId: string) =>
  `zgrp_${canonicalJsonHash({ runId }).slice(0, 40)}`;

const ensureConfigurationVersion = (config: ZeroDteConfig, asOf: string) => {
  getDb().prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    config.configurationVersionId,
    config.strategyVersion,
    config.configurationVersionId,
    configJson(config),
    asOf
  );
};

const ensureEngineRun = (input: {
  runId: string;
  tradingDate: string;
  mode: string;
  accountMode: string;
  config: ZeroDteConfig;
  asOf: string;
}) => {
  ensureConfigurationVersion(input.config, input.asOf);
  getDb().prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, session_id, mode, account_mode, status,
       strategy_version, configuration_version_id, market_timestamp,
       started_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.tradingDate,
    `${input.tradingDate}:regular`,
    input.mode,
    input.accountMode,
    input.config.strategyVersion,
    input.config.configurationVersionId,
    input.asOf,
    input.asOf,
    input.asOf
  );
};

const existingRun = (runId: string) => getDb().prepare(
  `SELECT status, completed_at, candidates_discovered, candidates_evaluated,
          candidates_eligible, selected_count, executed_count, shadow_count,
          trading_date, account_mode, configuration_version_id
   FROM zero_dte_engine_runs
   WHERE run_id = ?`
).get(runId) as {
  status: ZeroDteEngineStatus;
  completed_at: string | null;
  candidates_discovered: number;
  candidates_evaluated: number;
  candidates_eligible: number;
  selected_count: number;
  executed_count: number;
  shadow_count: number;
  trading_date: string;
  account_mode: "paper" | "shadow" | "dry_run";
  configuration_version_id: string;
} | undefined;

const finishEngineRun = (input: {
  runId: string;
  status: ZeroDteEngineStatus;
  completedAt: string;
  counts: {
    discovered: number;
    evaluated: number;
    eligible: number;
    selected: number;
    executed: number;
    shadow: number;
  };
  errors: Array<{ code: string; message: string; underlying?: string }>;
}) => {
  getDb().prepare(
    `UPDATE zero_dte_engine_runs
     SET status = ?, completed_at = ?, candidates_discovered = ?,
         candidates_evaluated = ?, candidates_eligible = ?, selected_count = ?,
         executed_count = ?, shadow_count = ?, error_code = ?,
         error_summary_json = ?, summary_json = ?
     WHERE run_id = ?`
  ).run(
    input.status,
    input.completedAt,
    input.counts.discovered,
    input.counts.evaluated,
    input.counts.eligible,
    input.counts.selected,
    input.counts.executed,
    input.counts.shadow,
    input.errors[0]?.code ?? null,
    JSON.stringify(input.errors),
    JSON.stringify({ counts: input.counts, errors: input.errors }),
    input.runId
  );
};

const sortedBars = (context: ExtendedMarketContext) => {
  const byTimeframe = context.barsByTimeframe ?? {};
  const bars = byTimeframe["1Min"] ?? byTimeframe["5Min"] ?? byTimeframe["15Min"] ?? [];
  return [...bars].filter((bar) =>
    [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value))
  ).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
};

const average = (values: number[]) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

const directionFrom = (value: number | null, reference: number | null): ZeroDteDirection => {
  if (value === null || reference === null || value === reference) return "neutral";
  return value > reference ? "bullish" : "bearish";
};

const deriveIndicators = (context: ExtendedMarketContext): ZeroDteIndicators => {
  const supplied = context.indicators && typeof context.indicators === "object"
    ? context.indicators as ZeroDteIndicators
    : {};
  const bars = sortedBars(context);
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const volumes = bars.map((bar) => finite(bar.volume)).filter((value): value is number => value !== null);
  const last = closes.at(-1) ?? null;
  const fast = supplied.emaFast ?? ema(closes, 9);
  const slow = supplied.emaSlow ?? ema(closes, 20);
  const currentAtr = supplied.atr ?? atr(highs, lows, closes, 14);
  const typicalVwap = bars
    .map((bar) => finite(bar.vwap) ?? (bar.high + bar.low + bar.close) / 3)
    .filter((value) => Number.isFinite(value));
  const vwap = supplied.vwap ?? average(typicalVwap);
  const returnSeries = closes.slice(1).map((close, index) => {
    const prior = closes[index];
    return prior ? (close - prior) / prior : 0;
  });
  const realized = supplied.realizedVolatility ?? rollingStd(returnSeries, Math.min(20, returnSeries.length));
  const baseline = supplied.realizedVolatilityBaseline ?? rollingStd(returnSeries, Math.min(10, returnSeries.length));
  const avgVolume = average(volumes.slice(-20));
  const relativeVolume = supplied.relativeVolume ?? (avgVolume && volumes.at(-1) ? volumes.at(-1)! / avgVolume : null);
  const trendDirection = supplied.trendDirection ?? directionFrom(last, slow);
  const trendStrength = supplied.trendStrength ?? (
    last !== null && slow !== null && currentAtr !== null && currentAtr > 0
      ? Math.min(1, Math.abs(last - slow) / currentAtr)
      : null
  );
  const timeframeDirections: Record<string, ZeroDteDirection> = {};
  for (const [timeframe, timeframeBars] of Object.entries(context.barsByTimeframe ?? {})) {
    const rows = timeframeBars.filter((bar) => Number.isFinite(bar.close));
    const timeframeCloses = rows.map((bar) => bar.close);
    timeframeDirections[timeframe] = directionFrom(timeframeCloses.at(-1) ?? null, ema(timeframeCloses, Math.min(9, timeframeCloses.length)));
  }
  const firstRange = bars.slice(0, Math.min(15, bars.length));
  const openingRangeHigh = firstRange.length ? Math.max(...firstRange.map((bar) => bar.high)) : null;
  const openingRangeLow = firstRange.length ? Math.min(...firstRange.map((bar) => bar.low)) : null;
  return {
    ...supplied,
    vwap,
    emaFast: fast,
    emaSlow: slow,
    atr: currentAtr,
    relativeVolume,
    realizedVolatility: realized,
    realizedVolatilityBaseline: baseline,
    atrAcceleration: supplied.atrAcceleration ?? (currentAtr !== null && currentAtr > 0 && bars.length > 15 ? currentAtr / Math.max(0.0001, atr(highs.slice(0, -5), lows.slice(0, -5), closes.slice(0, -5), 14) ?? currentAtr) : null),
    impliedVolatility: supplied.impliedVolatility ?? finite(context.option.impliedVolatility),
    velocity: supplied.velocity ?? (closes.length >= 2 && currentAtr ? ((closes.at(-1)! - closes.at(-2)!) / currentAtr) : null),
    trendDirection,
    trendStrength,
    multiTimeframeDirection: supplied.multiTimeframeDirection ?? timeframeDirections,
    openingRangeHigh: supplied.openingRangeHigh ?? openingRangeHigh,
    openingRangeLow: supplied.openingRangeLow ?? openingRangeLow,
    openingRangeMinutes: supplied.openingRangeMinutes ?? 15,
    breadth: supplied.breadth ?? null,
    crossIndexConfirmation: supplied.crossIndexConfirmation ?? null
  };
};

const playbookContextFor = (context: ExtendedMarketContext): ZeroDtePlaybookContext => {
  const indicators = deriveIndicators(context);
  const verifiedEventRisk = context.verifiedEventRisk === true;
  const regime = classifyZeroDteRegime({ indicators, verifiedEventRisk });
  const eventCalendarEvidence = Array.isArray(context.eventCalendarEvidence)
    ? context.eventCalendarEvidence.filter((value): value is string => typeof value === "string")
    : [];
  const openingRange = context.openingRange && typeof context.openingRange === "object"
    ? context.openingRange as ZeroDtePlaybookContext["openingRange"]
      : typeof indicators.openingRangeHigh === "number" && typeof indicators.openingRangeLow === "number"
      ? {
          high: indicators.openingRangeHigh,
          low: indicators.openingRangeLow,
          minutes: indicators.openingRangeMinutes,
          source: "derived_from_direct_bars"
        }
      : undefined;
  return {
    underlying: context.underlying,
    price: context.price,
    barsByTimeframe: context.barsByTimeframe,
    option: context.option,
    indicators,
    regime: regime.regime,
    asOf: context.asOf,
    eventCalendarEvidence,
    direction: context.direction,
    ...(openingRange ? { openingRange } : {})
  };
};

const previousCandidate = (candidateId: string) => getDb().prepare(
  `SELECT candidate_id, state, first_seen_at, last_seen_at
   FROM zero_dte_candidates
   WHERE candidate_id = ?`
).get(candidateId) as {
  candidate_id: string;
  state: ZeroDteCandidate["state"];
  first_seen_at: string;
  last_seen_at: string;
} | undefined;

const priorScores = (candidateId: string) => queryAll<{ observed_at: string; total_score: number | null }>(
  `SELECT observed_at, total_score
   FROM zero_dte_candidate_observations
   WHERE candidate_id = ?
   ORDER BY observed_at ASC, observation_id ASC`,
  [candidateId]
);

const evaluationComponents = (evaluation: PlaybookEvaluation) => ({
  playbook: evaluation.components.playbook ?? evaluation.score,
  signalStrength: evaluation.componentContributions.signalStrength ?? 0,
  liquidity: evaluation.componentContributions.liquidity ?? 0,
  regime: evaluation.componentContributions.regime ?? 0,
  executionQuality: evaluation.componentContributions.executionQuality ?? 0,
  riskPenalty: evaluation.componentContributions.riskPenalty ?? 0,
  staleDataPenalty: evaluation.componentContributions.staleDataPenalty ?? 0
});

const persistEvaluation = (input: {
  context: ExtendedMarketContext;
  evaluation: PlaybookEvaluation;
  engineRunId: string;
  config: ZeroDteConfig;
  accountMode: "paper" | "shadow" | "dry_run";
  asOf: string;
}): { candidate: ZeroDteCandidate; eligible: boolean } => {
  const context = input.context;
  const evaluation = input.evaluation;
  const candidateId = buildZeroDteCandidateId({
    tradingDate: context.tradingDate,
    underlying: context.underlying,
    optionSymbol: context.option.symbol,
    playbook: evaluation.playbook,
    direction: evaluation.direction,
    expirationDate: context.contract.expirationDate,
    strike: context.contract.strike
  });
  const previous = previousCandidate(candidateId);
  const previousState = previous?.state ?? null;
  const scores = [
    ...priorScores(candidateId).map((row) => ({ observedAt: row.observed_at, score: row.total_score ?? 0 })),
    { observedAt: context.asOf, score: evaluation.score }
  ];
  const signal = summarizeZeroDteSignal({
    scores,
    previousState,
    minimumMovement: input.config.minScoreMovement,
    minimumConfirmationObservations: input.config.minConfirmationObservations,
    shortWindow: input.config.signalShortWindow,
    mediumWindow: input.config.signalMediumWindow
  });
  const confirmationReady = signal.observationCount >= Math.max(1, input.config.minConfirmationObservations);
  const evaluatedState = evaluation.eligible && confirmationReady ? "eligible" : signal.state;
  const preservedStates = new Set<ZeroDteCandidate["state"]>(["selected", "executed", "closed"]);
  const terminalStates = new Set<ZeroDteCandidate["state"]>(["skipped", "rejected", "closed"]);
  let state = preservedStates.has(previousState as ZeroDteCandidate["state"])
    ? previousState as ZeroDteCandidate["state"]
    : evaluatedState;
  if (previousState && terminalStates.has(previousState) && state !== previousState && !signal.reappeared) {
    state = previousState;
  }
  const blockers = unique([
    ...(context.blockers ?? []),
    ...evaluation.blockers,
    ...evaluation.missingInputs.map((inputName) => `MISSING_${inputName.toUpperCase()}`),
    ...(!evaluation.eligible && !evaluation.blockers.length ? ["BELOW_SCORE_THRESHOLD"] : []),
    ...(confirmationReady ? [] : ["INSUFFICIENT_CONFIRMATION"])
  ]);
  const components = evaluationComponents(evaluation);
  const lifecycleContext = {
    engineRunId: input.engineRunId,
    accountMode: input.accountMode,
    strategyVersion: input.config.strategyVersion,
    configurationVersionId: input.config.configurationVersionId,
    marketTimestamp: context.option.quoteTimestamp,
    occurredAt: context.asOf,
    details: { source: context.source, requestIds: context.requestIds }
  };
  const candidate = upsertZeroDteCandidate({
    candidateId,
    tradingDate: context.tradingDate,
    underlyingSymbol: context.underlying,
    optionSymbol: context.option.symbol,
    playbook: evaluation.playbook,
    direction: evaluation.direction,
    expirationDate: context.contract.expirationDate,
    strike: context.contract.strike,
    state,
    score: evaluation.score,
    playbookScore: evaluation.score,
    signalStrengthAdjustment: components.signalStrength,
    liquidityAdjustment: components.liquidity,
    regimeAdjustment: components.regime,
    executionQualityAdjustment: components.executionQuality,
    riskPenalty: components.riskPenalty,
    staleDataPenalty: components.staleDataPenalty,
    confidence: evaluation.confidence,
    signalSlope: signal.shortSlope,
    shortWindowSlope: signal.shortSlope,
    mediumWindowSlope: signal.mediumSlope,
    liquidityScore: context.option.volume,
    freshnessScore: signal.setupAgeMs >= 0 ? 100 : 0,
    setupAgeSeconds: Math.round(signal.setupAgeMs / 1000),
    quoteBid: context.option.bid,
    quoteAsk: context.option.ask,
    quoteMidpoint: context.option.midpoint,
    premium: context.option.midpoint,
    spreadPct: context.option.spreadPct,
    volume: context.option.volume,
    openInterest: context.option.openInterest,
    impliedVolatility: context.option.impliedVolatility,
    delta: context.option.delta,
    gamma: context.option.gamma,
    marketTimestamp: context.option.quoteTimestamp,
    firstSeenAt: previous?.first_seen_at ?? context.asOf,
    lastSeenAt: context.asOf,
    stateChangedAt: context.asOf,
    stateReasonCode: evaluation.blockers[0] ?? (state === "eligible" ? "CANDIDATE_BECAME_ELIGIBLE" : state.toUpperCase()),
    stateReason: {
      playbook: evaluation.playbook,
      status: evaluation.status,
      signalState: signal.state,
      scoreChange: signal.scoreChange,
      missingInputs: evaluation.missingInputs
    },
    blockerCodes: blockers,
    reappeared: Boolean(signal.reappeared && previousState !== state),
    lifecycleContext
  });
  appendZeroDteCandidateObservation({
    observationId: `zobs_${canonicalJsonHash({ engineRunId: input.engineRunId, candidateId }).slice(0, 40)}`,
    candidateId,
    engineRunId: input.engineRunId,
    observedAt: context.asOf,
    marketTimestamp: context.option.quoteTimestamp,
    state,
    totalScore: evaluation.score,
    playbookScore: evaluation.score,
    confidence: evaluation.confidence,
    signalSlope: signal.shortSlope,
    shortWindowSlope: signal.shortSlope,
    mediumWindowSlope: signal.mediumSlope,
    liquidityScore: context.option.volume,
    freshnessScore: 100,
    quoteBid: context.option.bid,
    quoteAsk: context.option.ask,
    quoteMidpoint: context.option.midpoint,
    premium: context.option.midpoint,
    spreadPct: context.option.spreadPct,
    volume: context.option.volume,
    openInterest: context.option.openInterest,
    impliedVolatility: context.option.impliedVolatility,
    delta: context.option.delta,
    gamma: context.option.gamma,
    peakScore: signal.peakScore,
    drawdownScore: signal.drawdownFromPeak,
    setupAgeSeconds: Math.round(signal.setupAgeMs / 1000),
    supportingSignals: evaluation.supportingSignals,
    opposingSignals: evaluation.opposingSignals,
    blockerCodes: blockers,
    evidence: { evaluation: evaluation.metadata ?? {}, context: context.source }
  });
  insertZeroDtePlaybookEvaluation({
    evaluationId: `zeval_${canonicalJsonHash({ engineRunId: input.engineRunId, candidateId, playbook: evaluation.playbook }).slice(0, 40)}`,
    candidateId,
    engineRunId: input.engineRunId,
    playbook: evaluation.playbook,
    score: evaluation.score,
    confidence: evaluation.confidence,
    direction: evaluation.direction,
    eligible: evaluation.eligible,
    supportingSignals: evaluation.supportingSignals,
    opposingSignals: evaluation.opposingSignals,
    blockerCodes: evaluation.blockers,
    missingInputs: evaluation.missingInputs,
    evidence: {
      ...(evaluation.metadata ?? {}),
      status: evaluation.status,
      componentContributions: evaluation.componentContributions
    },
    evaluatedAt: context.asOf
  });
  return { candidate, eligible: state === "eligible" };
};

const candidateToUpsertInput = (
  candidate: ZeroDteQueueCandidate,
  state: ZeroDteCandidate["state"],
  reasonCode: string,
  lifecycleContext: Parameters<typeof upsertZeroDteCandidate>[0]["lifecycleContext"],
  stateChangedAt: string
) => ({
  candidateId: candidate.candidateId,
  tradingDate: candidate.tradingDate,
  underlyingSymbol: candidate.underlyingSymbol,
  optionSymbol: candidate.optionSymbol,
  playbook: candidate.playbook,
  direction: candidate.direction,
  expirationDate: candidate.expirationDate,
  strike: candidate.strike,
  state,
  rank: candidate.rank,
  score: candidate.score,
  playbookScore: candidate.playbookScore,
  signalStrengthAdjustment: candidate.signalStrengthAdjustment,
  liquidityAdjustment: candidate.liquidityAdjustment,
  regimeAdjustment: candidate.regimeAdjustment,
  executionQualityAdjustment: candidate.executionQualityAdjustment,
  riskPenalty: candidate.riskPenalty,
  staleDataPenalty: candidate.staleDataPenalty,
  confidence: candidate.confidence,
  signalSlope: candidate.signalSlope,
  shortWindowSlope: candidate.shortWindowSlope,
  mediumWindowSlope: candidate.mediumWindowSlope,
  liquidityScore: candidate.liquidityScore,
  freshnessScore: candidate.freshnessScore,
  setupAgeSeconds: candidate.setupAgeSeconds,
  quoteBid: candidate.quote.bid,
  quoteAsk: candidate.quote.ask,
  quoteMidpoint: candidate.quote.midpoint,
  premium: candidate.quote.premium,
  spreadPct: candidate.quote.spreadPct,
  volume: candidate.quote.volume,
  openInterest: candidate.quote.openInterest,
  impliedVolatility: candidate.quote.impliedVolatility,
  delta: candidate.quote.delta,
  gamma: candidate.quote.gamma,
  theta: candidate.quote.theta,
  vega: candidate.quote.vega,
  marketTimestamp: candidate.quote.marketTimestamp,
  firstSeenAt: candidate.firstSeenAt,
  lastSeenAt: candidate.lastSeenAt,
  stateChangedAt,
  stateReasonCode: reasonCode,
  stateReason: { reasonCode },
  blockerCodes: candidate.blockers,
  lifecycleContext
});

const ensureDecision = (input: {
  candidate: ZeroDteQueueCandidate;
  runId: string;
  decisionGroupId: string;
  accountMode: "paper" | "shadow" | "dry_run";
  config: ZeroDteConfig;
  action: "select" | "skip";
  asOf: string;
}) => {
  const decisionId = buildZeroDteDecisionId(input.runId, input.candidate.candidateId);
  if (!getDb().prepare("SELECT decision_id FROM zero_dte_decisions WHERE decision_id = ?").get(decisionId)) {
    insertZeroDteDecisionRow(getDb(), {
      decisionId,
      decisionGroupId: input.decisionGroupId,
      engineRunId: input.runId,
      candidateId: input.candidate.candidateId,
      tradingDate: input.candidate.tradingDate,
      action: input.action,
      accountMode: input.accountMode,
      strategyVersion: input.config.strategyVersion,
      configurationVersionId: input.config.configurationVersionId,
      marketTimestamp: input.candidate.quote.marketTimestamp,
      decidedAt: input.asOf,
      score: input.candidate.totalScore,
      scoreThreshold: null,
      appliedThresholds: {
        queueTopN: input.config.queueTopN,
        executionTopN: input.config.executionTopN,
        maxContractsPerTrade: input.config.maxContractsPerTrade,
        maxPremiumPerTrade: input.config.maxPremiumPerTrade
      },
      reasonCodes: input.action === "select" ? ["QUALIFIED"] : ["HIGHER_RANKED_CANDIDATE"],
      evidence: { rank: input.candidate.rank, executable: input.candidate.executable }
    });
  }
  return decisionId;
};

const appendPaperMark = (input: {
  paperTradeId: string;
  candidateId: string;
  decisionId: string;
  engineRunId: string;
  decisionGroupId: string;
  strategyVersion: string;
  configurationVersionId: string;
  asOf: string;
  markPrice: number;
  quote: ZeroDteOptionQuote;
  quantity: number;
  entryPremium: number;
  fees: number;
}) => {
  const db = getDb();
  const markId = `zmark_${canonicalJsonHash({ paperTradeId: input.paperTradeId, asOf: input.asOf }).slice(0, 40)}`;
  const existing = db.prepare("SELECT mark_id FROM zero_dte_position_marks WHERE mark_id = ?").get(markId);
  if (existing) return false;
  const unrealizedPnl = Math.round(((input.markPrice - input.entryPremium) * 100 * input.quantity - input.fees) * 100) / 100;
  const previous = db.prepare(
    `SELECT MAX(mfe) AS mfe, MIN(mae) AS mae
     FROM zero_dte_position_marks
     WHERE paper_trade_id = ?`
  ).get(input.paperTradeId) as { mfe: number | null; mae: number | null };
  const mfe = Math.max(previous.mfe ?? 0, unrealizedPnl);
  const mae = Math.min(previous.mae ?? 0, unrealizedPnl);
  db.prepare(
    `INSERT INTO zero_dte_position_marks
      (mark_id, paper_trade_id, marked_at, market_timestamp, mark_price,
       bid, ask, midpoint, quote_quality, quantity, unrealized_pnl, return_pct,
       mfe, mae, source, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    markId,
    input.paperTradeId,
    input.asOf,
    input.quote.quoteTimestamp ?? input.asOf,
    input.markPrice,
    input.quote.bid ?? null,
    input.quote.ask ?? null,
    input.quote.midpoint ?? null,
    input.quantity,
    unrealizedPnl,
    input.entryPremium > 0 ? ((input.markPrice - input.entryPremium) / input.entryPremium) * 100 : null,
    mfe,
    mae,
    "zero-dte-reconcile",
    JSON.stringify({ quoteStatus: "valid" }),
    input.asOf
  );
  db.prepare(
    `UPDATE zero_dte_paper_trades
     SET mfe = ?, mae = ?, updated_at = ?
     WHERE paper_trade_id = ?`
  ).run(mfe, mae, input.asOf, input.paperTradeId);
  const eventId = `zlev_${canonicalJsonHash({ paperTradeId: input.paperTradeId, eventType: "position_marked", asOf: input.asOf }).slice(0, 40)}`;
  if (!db.prepare("SELECT event_id FROM zero_dte_lifecycle_events WHERE event_id = ?").get(eventId)) {
    insertZeroDteLifecycleEventRow(db, {
      eventId,
      eventType: "position_marked",
      reasonCode: "MARKED",
      engineRunId: input.engineRunId,
      candidateId: input.candidateId,
      decisionId: null,
      decisionGroupId: input.decisionGroupId,
      paperTradeId: input.paperTradeId,
      accountMode: "paper",
      strategyVersion: input.strategyVersion,
      configurationVersionId: input.configurationVersionId,
      marketTimestamp: input.quote.quoteTimestamp ?? input.asOf,
      occurredAt: input.asOf,
      details: { markPrice: input.markPrice, unrealizedPnl, mfe, mae }
    });
  }
  return true;
};

const markZeroDtePaperTrades = (
  asOf: string,
  quotes: Record<string, ZeroDteOptionQuote>
): ZeroDtePaperMarkResult => {
  const rows = queryAll<{
    paper_trade_id: string;
    candidate_id: string;
    decision_id: string;
    decision_group_id: string;
    engine_run_id: string;
    strategy_version: string;
    configuration_version_id: string;
    option_symbol: string;
    quantity: number;
    entry_premium: number | null;
    fees: number;
  }>(
    `SELECT t.paper_trade_id, t.candidate_id, t.decision_id,
            d.decision_group_id, d.engine_run_id, d.strategy_version,
            d.configuration_version_id, t.option_symbol, t.quantity,
            t.entry_premium, t.fees
     FROM zero_dte_paper_trades AS t
     JOIN zero_dte_decisions AS d ON d.decision_id = t.decision_id
     WHERE t.status IN ('partially_filled', 'open')`,
    []
  );
  let marked = 0;
  let blocked = 0;
  for (const row of rows) {
    const quote = quotes[normalizedSymbol(row.option_symbol)] ?? quotes[row.option_symbol];
    const bid = finite(quote?.bid);
    const ask = finite(quote?.ask);
    const midpoint = finite(quote?.midpoint);
    if (bid === null || ask === null || midpoint === null || bid <= 0 || ask < bid || midpoint < bid || midpoint > ask || row.entry_premium === null) {
      blocked += 1;
      continue;
    }
    if (appendPaperMark({
      paperTradeId: row.paper_trade_id,
      candidateId: row.candidate_id,
      decisionId: row.decision_id,
      engineRunId: row.engine_run_id,
      decisionGroupId: row.decision_group_id,
      strategyVersion: row.strategy_version,
      configurationVersionId: row.configuration_version_id,
      asOf,
      markPrice: bid,
      quote,
      quantity: row.quantity,
      entryPremium: row.entry_premium,
      fees: row.fees
    })) marked += 1;
  }
  return { paperOnly: true, marked, blocked };
};

const missedCandidatesFor = (tradingDate: string): ZeroDteMissedCandidate[] => queryAll<{
  candidate_id: string;
  trading_date: string;
  option_symbol: string;
  direction: ZeroDteDirection;
  premium: number | null;
  last_seen_at: string;
}>(
  `SELECT c.candidate_id, c.trading_date, c.option_symbol, c.direction,
          c.premium, c.last_seen_at
   FROM zero_dte_candidates AS c
   LEFT JOIN zero_dte_paper_trades AS p ON p.candidate_id = c.candidate_id
   LEFT JOIN zero_dte_shadow_trades AS s ON s.candidate_id = c.candidate_id
   WHERE c.trading_date = ?
     AND c.state IN ('skipped', 'rejected', 'eligible', 'selected')
     AND p.paper_trade_id IS NULL
     AND s.shadow_trade_id IS NULL`,
  [tradingDate]
).map((row) => ({
  candidateId: row.candidate_id,
  tradingDate: row.trading_date,
  optionSymbol: row.option_symbol,
  direction: row.direction,
  entryPremium: row.premium,
  observedAt: row.last_seen_at
}));

const quoteMapFor = (contexts: ZeroDteMarketContext[]) => Object.fromEntries(
  contexts.map((context) => [normalizedSymbol(context.option.symbol), {
    symbol: context.option.symbol,
    bid: context.option.bid,
    ask: context.option.ask,
    midpoint: context.option.midpoint,
    quoteTimestamp: context.option.quoteTimestamp,
    volume: context.option.volume,
    openInterest: context.option.openInterest,
    gamma: context.option.gamma,
    delta: context.option.delta,
    impliedVolatility: context.option.impliedVolatility
  }])
);

const getMarketContexts = async (input: {
  now: string;
  config: ZeroDteConfig;
  provider?: ZeroDteEngineProvider;
  errors: Array<{ code: string; message: string; underlying?: string }>;
}) => {
  const source = input.provider ?? createAlpacaZeroDteMarketDataProvider();
  if (input.provider?.collectContexts) {
    try {
      return await input.provider.collectContexts({ now: input.now, config: input.config });
    } catch (error) {
      input.errors.push({ code: "MARKET_CONTEXT_COLLECTION_FAILED", message: normalizeError(error) });
      return [];
    }
  }
  if (!source.getClock || !source.getStockSnapshot || !source.getBars || !source.listContracts || !source.getOptionSnapshots) {
    input.errors.push({ code: "MARKET_PROVIDER_INCOMPLETE", message: "0DTE market data provider is incomplete." });
    return [];
  }
  const contexts: ZeroDteMarketContext[] = [];
  for (const underlying of input.config.underlyings) {
    try {
      const rows = await collectZeroDteMarketContexts({
        now: input.now,
        config: { ...input.config, underlyings: [underlying] },
        provider: source as ZeroDteMarketDataProvider
      });
      contexts.push(...rows);
    } catch (error) {
      input.errors.push({
        code: "MARKET_CONTEXT_UNDERLYING_FAILED",
        message: normalizeError(error),
        underlying
      });
    }
  }
  return contexts.slice(0, input.config.queueMaxActive);
};

const clockFor = async (provider?: ZeroDteEngineProvider) => {
  if (!provider?.getClock) return null;
  return provider.getClock();
};

export const createZeroDteEngineMutationProvider = (
  config: ZeroDteConfig,
  provider?: ZeroDtePaperMutationProvider,
  executionClock: () => string = nowIso
): ZeroDtePaperMutationProvider => {
  if (!provider) return { config, now: executionClock };
  return {
    config: provider.config ?? config,
    runtime: typeof provider.runtime === "function"
      ? provider.runtime.bind(provider)
      : provider.runtime,
    account: provider.account,
    now: provider.now?.bind(provider) ?? executionClock,
    getAccount: provider.getAccount?.bind(provider),
    listPositions: provider.listPositions?.bind(provider),
    listOrders: provider.listOrders?.bind(provider),
    getOrder: provider.getOrder?.bind(provider),
    submitPaperOrder: provider.submitPaperOrder?.bind(provider)
  };
};

export const isActionableZeroDteCandidate = (
  candidate: Pick<ZeroDteQueueCandidate, "state" | "eligible" | "executable">
) =>
  candidate.state === "eligible" &&
  candidate.eligible === true &&
  candidate.executable === true;

export const runZeroDteEngine = async (input: {
  now?: string;
  dryRun?: boolean;
  confirmPaper?: boolean;
  provider?: ZeroDteEngineProvider;
} = {}): Promise<ZeroDteEngineRunResult> => {
  const asOf = new Date(input.now ?? nowIso()).toISOString();
  const config = loadZeroDteConfig();
  const dryRun = input.dryRun === true;
  const confirmPaper = input.confirmPaper === true && !dryRun;
  const mode = dryRun ? "dry_run" : confirmPaper ? "paper" : "shadow";
  const accountMode = mode as "paper" | "shadow" | "dry_run";
  const tradingDate = tradingDateFor(asOf);
  const runId = engineRunIdFor(tradingDate, asOf, config, mode);
  const errors: Array<{ code: string; message: string; underlying?: string }> = [];
  ensureEngineRun({ runId, tradingDate, mode, accountMode, config, asOf });
  if (!isPaperRuntime()) {
    errors.push({ code: "ACCOUNT_NOT_PAPER", message: "0DTE engine requires a paper Alpaca runtime." });
    finishEngineRun({ runId, status: "blocked", completedAt: asOf, counts: { discovered: 0, evaluated: 0, eligible: 0, selected: 0, executed: 0, shadow: 0 }, errors });
    return {
      paperOnly: true,
      environment: environmentName(),
      status: "blocked",
      runId,
      tradingDate,
      accountMode,
      configurationVersionId: config.configurationVersionId,
      contexts: 0,
      candidatesDiscovered: 0,
      candidatesEvaluated: 0,
      candidatesEligible: 0,
      selectedCount: 0,
      executedCount: 0,
      shadowCount: 0,
      errors,
      executionResults: []
    };
  }
  const prior = existingRun(runId);
  if (prior?.status === "completed" || prior?.status === "closed" || prior?.status === "blocked") {
    return {
      paperOnly: true,
      environment: "paper",
      status: prior.status,
      runId,
      tradingDate: prior.trading_date,
      accountMode: prior.account_mode,
      configurationVersionId: prior.configuration_version_id,
      contexts: 0,
      candidatesDiscovered: prior.candidates_discovered,
      candidatesEvaluated: prior.candidates_evaluated,
      candidatesEligible: prior.candidates_eligible,
      selectedCount: prior.selected_count,
      executedCount: prior.executed_count,
      shadowCount: prior.shadow_count,
      errors: [],
      executionResults: []
    };
  }
  if (!config.enabled) {
    errors.push({ code: "ENGINE_DISABLED", message: "ZERO_DTE_ENGINE_ENABLED is false." });
    finishEngineRun({ runId, status: "blocked", completedAt: asOf, counts: { discovered: 0, evaluated: 0, eligible: 0, selected: 0, executed: 0, shadow: 0 }, errors });
    return {
      paperOnly: true,
      environment: "paper",
      status: "blocked",
      runId,
      tradingDate,
      accountMode,
      configurationVersionId: config.configurationVersionId,
      contexts: 0,
      candidatesDiscovered: 0,
      candidatesEvaluated: 0,
      candidatesEligible: 0,
      selectedCount: 0,
      executedCount: 0,
      shadowCount: 0,
      errors,
      executionResults: []
    };
  }
  try {
    const clock = await clockFor(input.provider);
    if (clock && !clock.isOpen) {
      finishEngineRun({ runId, status: "closed", completedAt: asOf, counts: { discovered: 0, evaluated: 0, eligible: 0, selected: 0, executed: 0, shadow: 0 }, errors: [{ code: "MARKET_CLOSED", message: "Market session is closed." }] });
      return {
        paperOnly: true,
        environment: "paper",
        status: "closed",
        runId,
        tradingDate,
        accountMode,
        configurationVersionId: config.configurationVersionId,
        contexts: 0,
        candidatesDiscovered: 0,
        candidatesEvaluated: 0,
        candidatesEligible: 0,
        selectedCount: 0,
        executedCount: 0,
        shadowCount: 0,
        errors: [{ code: "MARKET_CLOSED", message: "Market session is closed." }],
        executionResults: []
      };
    }
  } catch (error) {
    errors.push({ code: "MARKET_CLOCK_FAILED", message: normalizeError(error) });
  }

  const contexts = await getMarketContexts({ now: asOf, config, provider: input.provider, errors });
  const evaluatedContexts: Array<{
    context: ExtendedMarketContext;
    evaluations: PlaybookEvaluation[];
  }> = [];
  let evaluatedCount = 0;
  for (const rawContext of contexts) {
    const context = rawContext as ExtendedMarketContext;
    try {
      const evaluations = evaluateZeroDtePlaybooks(playbookContextFor(context));
      evaluatedCount += evaluations.length;
      evaluatedContexts.push({ context, evaluations });
    } catch (error) {
      errors.push({
        code: "PLAYBOOK_EVALUATION_FAILED",
        message: normalizeError(error),
        underlying: context.underlying
      });
    }
  }

  const decisionGroupId = decisionGroupIdFor(runId);
  let batch: {
    persisted: Array<{ candidate: ZeroDteCandidate; eligible: boolean }>;
    eligibleCount: number;
    selected: ZeroDteQueueCandidate[];
    preparedActions: Array<{
      candidate: ZeroDteQueueCandidate;
      decisionId: string;
      isSelected: boolean;
    }>;
  };
  try {
    batch = runInZeroDtePersistenceTransaction(() => {
      const persistedRows: Array<{ candidate: ZeroDteCandidate; eligible: boolean }> = [];
      let eligibleRows = 0;
      for (const { context, evaluations } of evaluatedContexts) {
        for (const evaluation of evaluations) {
          const result = persistEvaluation({ context, evaluation, engineRunId: runId, config, accountMode, asOf });
          persistedRows.push(result);
          if (result.eligible) eligibleRows += 1;
        }
      }

      const rankedQueue = listZeroDteQueue({ tradingDate, limit: config.queueTopN });
      const rankCandidate = getDb().prepare(
        "UPDATE zero_dte_candidates SET rank = ? WHERE candidate_id = ?"
      );
      rankedQueue.forEach((candidate, index) => {
        rankCandidate.run(index + 1, candidate.candidateId);
      });
      const actionable = rankedQueue.filter(isActionableZeroDteCandidate);
      const selected = actionable.slice(0, config.executionTopN);
      const selectedIds = new Set(selected.map((candidate) => candidate.candidateId));
      const preparedActions = actionable.map((candidate) => {
        const isSelected = selectedIds.has(candidate.candidateId);
        const action = isSelected ? "select" : "skip";
        const decisionId = ensureDecision({ candidate, runId, decisionGroupId, accountMode, config, action, asOf });
        const state = isSelected ? "selected" : "skipped";
        const reasonCode = isSelected ? "CANDIDATE_SELECTED" : "HIGHER_RANKED_CANDIDATE";
        const updated = upsertZeroDteCandidate(candidateToUpsertInput(candidate, state, reasonCode, {
          engineRunId: runId,
          accountMode,
          strategyVersion: config.strategyVersion,
          configurationVersionId: config.configurationVersionId,
          marketTimestamp: candidate.quote.marketTimestamp,
          occurredAt: asOf,
          decisionId,
          decisionGroupId
        }, asOf));
        return {
          candidate: {
            ...candidate,
            ...updated,
            state,
            eligible: true,
            blockers: candidate.blockers
          } as unknown as ZeroDteQueueCandidate,
          decisionId,
          isSelected
        };
      });
      return {
        persisted: persistedRows,
        eligibleCount: eligibleRows,
        selected,
        preparedActions
      };
    });
  } catch (error) {
    errors.push({ code: "PERSISTENCE_BATCH_FAILED", message: normalizeError(error) });
    finishEngineRun({
      runId,
      status: "failed",
      completedAt: asOf,
      counts: {
        discovered: 0,
        evaluated: evaluatedCount,
        eligible: 0,
        selected: 0,
        executed: 0,
        shadow: 0
      },
      errors
    });
    return {
      paperOnly: true,
      environment: "paper",
      status: "failed",
      runId,
      tradingDate,
      accountMode,
      configurationVersionId: config.configurationVersionId,
      contexts: contexts.length,
      candidatesDiscovered: 0,
      candidatesEvaluated: evaluatedCount,
      candidatesEligible: 0,
      selectedCount: 0,
      executedCount: 0,
      shadowCount: 0,
      errors,
      executionResults: []
    };
  }

  const { persisted, eligibleCount, selected, preparedActions } = batch;
  const executionResults: ZeroDteExecutionResult[] = [];
  let shadowCount = 0;
  for (const { candidate, decisionId, isSelected } of preparedActions) {
    if (isSelected && confirmPaper) {
      const result = await executeZeroDteCandidate({
        candidate,
        decisionId,
        confirmPaper: true,
        provider: createZeroDteEngineMutationProvider(config, input.provider?.mutationProvider)
      });
      executionResults.push(result);
      if (result.status === "blocked" && config.shadowEnabled) {
        if (createZeroDteShadowTrade({ candidate, decisionGroupId, reasonCode: result.blockers[0] ?? "EXECUTION_DISABLED", asOf })) shadowCount += 1;
      }
    } else if (config.shadowEnabled) {
      if (createZeroDteShadowTrade({ candidate, decisionGroupId, reasonCode: isSelected ? "PAPER_CONFIRMATION_REQUIRED" : "HIGHER_RANKED_CANDIDATE", asOf })) shadowCount += 1;
    }
  }
  const executedCount = executionResults.filter((result) => ["submitted", "partial", "filled"].includes(result.status)).length;
  const status: ZeroDteEngineStatus = errors.length && contexts.length ? "partial" : errors.length ? "failed" : "completed";
  finishEngineRun({
    runId,
    status,
    completedAt: asOf,
    counts: {
      discovered: persisted.length,
      evaluated: evaluatedCount,
      eligible: eligibleCount,
      selected: selected.length,
      executed: executedCount,
      shadow: shadowCount
    },
    errors
  });
  return {
    paperOnly: true,
    environment: "paper",
    status,
    runId,
    tradingDate,
    accountMode,
    configurationVersionId: config.configurationVersionId,
    contexts: contexts.length,
    candidatesDiscovered: persisted.length,
    candidatesEvaluated: evaluatedCount,
    candidatesEligible: eligibleCount,
    selectedCount: selected.length,
    executedCount,
    shadowCount,
    errors,
    executionResults
  };
};

export const runZeroDteReconciliation = async (input: {
  now?: string;
  provider?: ZeroDteEngineProvider;
} = {}): Promise<ZeroDteReconciliationResult> => {
  const generatedAt = new Date(input.now ?? nowIso()).toISOString();
  const tradingDate = tradingDateFor(generatedAt);
  const config = loadZeroDteConfig();
  const errors: Array<{ code: string; message: string }> = [];
  const paperOrders = await reconcileZeroDtePaperOrders({
    now: generatedAt,
    provider: input.provider?.mutationProvider
  });
  errors.push(...paperOrders.errors.map(({ code, message }) => ({ code, message })));
  const contexts = await getMarketContexts({ now: generatedAt, config, provider: input.provider, errors });
  const quotes = quoteMapFor(contexts);
  const paperMarks = markZeroDtePaperTrades(generatedAt, quotes);
  const shadowMarks = markZeroDteShadowTrades({ asOf: generatedAt, quotes });
  const outcomes = captureZeroDteOutcomes({
    asOf: generatedAt,
    candidates: missedCandidatesFor(tradingDate),
    quotes,
    horizonsMinutes: config.outcomeHorizonsMinutes
  });
  return {
    paperOnly: true,
    environment: environmentName(),
    tradingDate,
    generatedAt,
    mutationAttempted: false,
    contexts: contexts.length,
    paperOrders,
    paperMarks,
    shadowMarks,
    outcomes,
    errors: errors.map((error) => ({ code: error.code, message: error.message }))
  };
};

export const runZeroDteEodSummary = async (input: {
  now?: string;
  provider?: ZeroDteEngineProvider;
} = {}): Promise<ZeroDteEodSummary> => {
  const reconciliation = await runZeroDteReconciliation(input);
  const summary = readZeroDteDailyOutcomeSummary(reconciliation.tradingDate);
  return { ...summary, reconciliation };
};

export const buildZeroDteSummary = (input: {
  tradingDate?: string;
  limit?: number;
} = {}): ZeroDteSummary => {
  const summary = readZeroDteSummary(input);
  const lastRun = getDb().prepare(
    `SELECT run_id, status, completed_at
     FROM zero_dte_engine_runs
     ORDER BY started_at DESC, run_id DESC
     LIMIT 1`
  ).get() as { run_id: string; status: string; completed_at: string | null } | undefined;
  const staleDataCount = queryAll<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM zero_dte_candidates
     WHERE trading_date = ?
       AND state NOT IN ('closed', 'expired', 'invalidated', 'rejected', 'skipped')
       AND (market_timestamp IS NULL OR market_timestamp < datetime('now', '-2 minutes'))`,
    [summary.tradingDate ?? ""]
  )[0]?.count ?? 0;
  return {
    ...summary,
    engine: {
      lastRunId: lastRun?.run_id ?? null,
      lastStatus: lastRun?.status ?? null,
      lastCompletedAt: lastRun?.completed_at ?? null,
      staleDataCount: Number(staleDataCount)
    },
    outcomes: summary.tradingDate
      ? readZeroDteDailyOutcomeSummary(summary.tradingDate)
      : null
  };
};

const nullableNumber = (value: unknown) =>
  value === null || value === undefined ? null : finite(value);

const readZeroDtePaperPositions = (tradingDate: string | null, limit: number) => {
  if (!tradingDate || limit === 0) return [];
  const rows = queryAll<{
    paper_trade_id: string;
    candidate_id: string;
    option_symbol: string;
    playbook: string;
    direction: string;
    status: string;
    quantity: number;
    entry_premium: number | null;
    current_mark: number | null;
    unrealized_pnl: number | null;
    mfe: number | null;
    mae: number | null;
    exit_reason_code: string | null;
    broker_order_id: string | null;
  }>(
    `SELECT t.paper_trade_id, t.candidate_id, t.option_symbol, t.playbook,
            t.direction, t.status, t.quantity, t.entry_premium,
            m.mark_price AS current_mark, m.unrealized_pnl,
            COALESCE(m.mfe, t.mfe) AS mfe, COALESCE(m.mae, t.mae) AS mae,
            t.exit_reason_code, t.broker_order_id
     FROM zero_dte_paper_trades AS t
     LEFT JOIN zero_dte_position_marks AS m
       ON m.paper_trade_id = t.paper_trade_id
      AND m.marked_at = (
        SELECT MAX(marked_at)
        FROM zero_dte_position_marks
        WHERE paper_trade_id = t.paper_trade_id
      )
     WHERE t.trading_date = ?
       AND t.status IN ('partially_filled', 'open', 'exit_requested')
     ORDER BY t.updated_at DESC, t.paper_trade_id DESC
     LIMIT ?`,
    [tradingDate, limit]
  );
  return rows.map((row) => ({
    paperTradeId: row.paper_trade_id,
    candidateId: row.candidate_id,
    optionSymbol: row.option_symbol,
    playbook: row.playbook,
    direction: row.direction,
    status: row.status,
    quantity: Number(row.quantity),
    entryPremium: nullableNumber(row.entry_premium),
    currentMark: nullableNumber(row.current_mark),
    unrealizedPnl: nullableNumber(row.unrealized_pnl),
    mfe: nullableNumber(row.mfe),
    mae: nullableNumber(row.mae),
    exitReasonCode: row.exit_reason_code,
    brokerOrderId: row.broker_order_id
  }));
};

export const buildZeroDteDashboardSummary = (input: {
  tradingDate?: string;
  limit?: number;
} = {}): ZeroDteDashboardSummary => {
  const limit = Math.min(100, Math.max(0, Math.floor(input.limit ?? 25)));
  const config = loadZeroDteConfig();
  const summary = buildZeroDteSummary({ tradingDate: input.tradingDate, limit });
  const paperPositions = readZeroDtePaperPositions(summary.tradingDate, limit);
  const shadowTrades = summary.tradingDate
    ? readZeroDteShadowTrades({ tradingDate: summary.tradingDate, limit })
      .map((trade) => ({
        shadowTradeId: trade.shadowTradeId,
        decisionGroupId: trade.decisionGroupId,
        decisionId: trade.decisionId,
        candidateId: trade.candidateId,
        tradingDate: trade.tradingDate,
        underlyingSymbol: trade.underlyingSymbol,
        optionSymbol: trade.optionSymbol,
        playbook: trade.playbook,
        direction: trade.direction,
        alternativeType: trade.alternativeType,
        status: trade.status,
        quantity: trade.quantity,
        entryPremium: trade.entryPremium,
        exitPremium: trade.exitPremium,
        fees: trade.fees,
        slippage: trade.slippage,
        mfe: trade.mfe,
        mae: trade.mae,
        realizedPnl: trade.realizedPnl,
        returnPct: trade.returnPct,
        terminalState: trade.terminalState,
        exitReasonCode: trade.exitReasonCode,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        updatedAt: trade.updatedAt,
        simulated: true as const
      }))
    : [];
  const lastRunError = getDb().prepare(
    `SELECT error_code
     FROM zero_dte_engine_runs
     ORDER BY started_at DESC, run_id DESC
     LIMIT 1`
  ).get() as { error_code: string | null } | undefined;
  const blockers = unique([
    ...(config.enabled ? [] : ["ENGINE_DISABLED"]),
    ...(lastRunError?.error_code ? [lastRunError.error_code] : []),
    ...summary.queue.flatMap((candidate) => candidate.blockers)
  ]);
  return {
    paperOnly: true,
    generatedAt: summary.generatedAt,
    tradingDate: summary.tradingDate,
    engine: {
      enabled: config.enabled,
      lastRunAt: summary.engine.lastCompletedAt,
      status: summary.engine.lastStatus ?? "never_run",
      queueSize: summary.queue.length,
      staleDataCount: summary.engine.staleDataCount
    },
    queue: summary.queue,
    paperPositions,
    shadowTrades,
    lifecycle: summary.lifecycle,
    learning: summary.outcomes,
    blockers
  };
};
