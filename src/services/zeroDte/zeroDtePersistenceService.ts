import type { DatabaseSync } from "node:sqlite";

import { getDb, queryAll, queryOne } from "../../lib/db.js";
import { nowIso, normalizeSymbol, uuid } from "../../lib/utils.js";
import { buildZeroDteCandidateId } from "./zeroDteIdentityService.js";
import {
  insertZeroDteLifecycleEventRow,
  serializeZeroDteJson,
  type ZeroDteLifecycleContext,
  type ZeroDteLifecycleEvent,
  type ZeroDteLifecycleEventInput
} from "./zeroDteLifecycleService.js";
import { rankZeroDteQueue } from "./zeroDteRankingService.js";
import {
  ZERO_DTE_CANDIDATE_STATES,
  ZERO_DTE_PLAYBOOKS,
  type ZeroDteCandidateState,
  type ZeroDteDirection,
  type ZeroDtePlaybook
} from "./zeroDteTypes.js";

export interface ZeroDteCandidateUpsert {
  candidateId?: string;
  tradingDate: string;
  underlyingSymbol: string;
  optionSymbol: string;
  playbook: ZeroDtePlaybook;
  direction: ZeroDteDirection;
  expirationDate: string;
  strike: number;
  state: ZeroDteCandidateState;
  rank?: number | null;
  score?: number | null;
  playbookScore?: number | null;
  signalStrengthAdjustment?: number | null;
  liquidityAdjustment?: number | null;
  regimeAdjustment?: number | null;
  executionQualityAdjustment?: number | null;
  riskPenalty?: number | null;
  staleDataPenalty?: number | null;
  confidence?: number | null;
  signalSlope?: number | null;
  shortWindowSlope?: number | null;
  mediumWindowSlope?: number | null;
  liquidityScore?: number | null;
  freshnessScore?: number | null;
  setupAgeSeconds?: number | null;
  quoteBid?: number | null;
  quoteAsk?: number | null;
  quoteMidpoint?: number | null;
  premium?: number | null;
  spreadPct?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  impliedVolatility?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  marketTimestamp?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  stateChangedAt?: string;
  stateReasonCode?: string | null;
  stateReason?: unknown;
  blockerCodes?: string[];
  reappeared?: boolean;
  lifecycleContext?: ZeroDteLifecycleContext | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ZeroDteCandidate {
  candidateId: string;
  tradingDate: string;
  underlyingSymbol: string;
  optionSymbol: string;
  playbook: ZeroDtePlaybook;
  direction: ZeroDteDirection;
  expirationDate: string;
  strike: number;
  state: ZeroDteCandidateState;
  rank: number | null;
  score: number | null;
  playbookScore: number | null;
  signalStrengthAdjustment: number | null;
  liquidityAdjustment: number | null;
  regimeAdjustment: number | null;
  executionQualityAdjustment: number | null;
  riskPenalty: number | null;
  staleDataPenalty: number | null;
  confidence: number | null;
  signalSlope: number | null;
  shortWindowSlope: number | null;
  mediumWindowSlope: number | null;
  liquidityScore: number | null;
  freshnessScore: number | null;
  setupAgeSeconds: number | null;
  quoteBid: number | null;
  quoteAsk: number | null;
  quoteMidpoint: number | null;
  premium: number | null;
  spreadPct: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  marketTimestamp: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  stateChangedAt: string;
  stateReasonCode: string | null;
  stateReason: Record<string, unknown>;
  reappearanceCount: number;
  blockerCodes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ZeroDteObservationInput {
  observationId?: string;
  candidateId: string;
  engineRunId: string;
  observedAt: string;
  marketTimestamp?: string | null;
  state: ZeroDteCandidateState;
  totalScore?: number | null;
  playbookScore?: number | null;
  confidence?: number | null;
  signalSlope?: number | null;
  shortWindowSlope?: number | null;
  mediumWindowSlope?: number | null;
  liquidityScore?: number | null;
  freshnessScore?: number | null;
  quoteBid?: number | null;
  quoteAsk?: number | null;
  quoteMidpoint?: number | null;
  premium?: number | null;
  spreadPct?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  impliedVolatility?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  peakScore?: number | null;
  drawdownScore?: number | null;
  setupAgeSeconds?: number | null;
  dataQualityFlags?: string[];
  supportingSignals?: unknown[];
  opposingSignals?: unknown[];
  blockerCodes?: string[];
  evidence?: unknown;
  createdAt?: string;
}

export interface PlaybookEvaluationInput {
  evaluationId?: string;
  candidateId: string;
  engineRunId: string;
  playbook: ZeroDtePlaybook;
  score: number;
  confidence: number;
  direction: ZeroDteDirection;
  eligible: boolean;
  supportingSignals?: unknown[];
  opposingSignals?: unknown[];
  blockerCodes?: string[];
  missingInputs?: string[];
  evidence?: unknown;
  evaluatedAt: string;
  createdAt?: string;
}

export interface ZeroDteQueueCandidate extends Record<string, unknown> {
  candidateId: string;
  tradingDate: string;
  underlyingSymbol: string;
  optionSymbol: string;
  playbook: ZeroDtePlaybook;
  direction: ZeroDteDirection;
  expirationDate: string;
  strike: number;
  state: ZeroDteCandidateState;
  eligible: boolean;
  executable: boolean;
  rank: number;
  totalScore: number | null;
  score: number | null;
  playbookScore: number | null;
  signalStrengthAdjustment: number | null;
  liquidityAdjustment: number | null;
  regimeAdjustment: number | null;
  executionQualityAdjustment: number | null;
  riskPenalty: number | null;
  staleDataPenalty: number | null;
  confidence: number | null;
  signalSlope: number | null;
  shortWindowSlope: number | null;
  mediumWindowSlope: number | null;
  liquidityScore: number | null;
  freshnessScore: number | null;
  setupAgeSeconds: number | null;
  quote: {
    bid: number | null;
    ask: number | null;
    midpoint: number | null;
    premium: number | null;
    spreadPct: number | null;
    volume: number | null;
    openInterest: number | null;
    impliedVolatility: number | null;
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    marketTimestamp: string | null;
  };
  componentScores: {
    playbook: number | null;
    signalStrength: number | null;
    liquidity: number | null;
    regime: number | null;
    executionQuality: number | null;
    riskPenalty: number | null;
    staleDataPenalty: number | null;
  };
  blockers: string[];
  reappearanceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ZeroDteSummary {
  paperOnly: true;
  generatedAt: string;
  tradingDate: string | null;
  queue: ZeroDteQueueCandidate[];
  counts: {
    candidates: number;
    active: number;
    eligible: number;
    byState: Record<string, number>;
    byPlaybook: Record<string, number>;
  };
  lifecycle: {
    counts: Record<string, number>;
    recent: ZeroDteLifecycleEvent[];
  };
}

const REAPPEARANCE_STATES = new Set<ZeroDteCandidateState>([
  "weakening",
  "expired",
  "invalidated"
]);
const TERMINAL_QUEUE_STATES = [
  "closed",
  "expired",
  "invalidated",
  "rejected",
  "skipped"
] as const;
const TERMINAL_QUEUE_STATE_SET = new Set<ZeroDteCandidateState>(TERMINAL_QUEUE_STATES);

const requiredText = (value: string | null | undefined, field: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`0DTE ${field} is required`);
  }
  return value.trim();
};

const optionalText = (value: string | null | undefined) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isoTimestamp = (value: string | null | undefined, field: string) => {
  const candidate = value ?? nowIso();
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`0DTE ${field} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
};

const optionalIsoTimestamp = (value: string | null | undefined, field: string) =>
  value === null || value === undefined ? null : isoTimestamp(value, field);

const finiteOrNull = (value: number | null | undefined, field: string) => {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) throw new RangeError(`0DTE ${field} must be finite`);
  return value;
};

const integerOrNull = (value: number | null | undefined, field: string) => {
  const normalized = finiteOrNull(value, field);
  if (normalized !== null && !Number.isInteger(normalized)) {
    throw new RangeError(`0DTE ${field} must be an integer`);
  }
  return normalized;
};

const dbNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : null;
};

const dbInteger = (value: unknown): number | null => {
  const normalized = dbNumber(value);
  return normalized !== null && Number.isInteger(normalized) ? normalized : null;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const recordJson = (value: unknown): Record<string, unknown> => {
  const parsed = parseJson<unknown>(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
};

const stringArrayJson = (value: unknown): string[] => {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const withTransaction = <T>(db: DatabaseSync, operation: () => T): T => {
  if (db.isTransaction) return operation();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
};

export const runInZeroDtePersistenceTransaction = <T>(operation: () => T): T =>
  withTransaction(getDb(), operation);

const validateCandidateIdentity = (input: ZeroDteCandidateUpsert) => {
  const tradingDate = requiredText(input.tradingDate, "trading date");
  const underlyingSymbol = normalizeSymbol(
    requiredText(input.underlyingSymbol, "underlying symbol")
  );
  const optionSymbol = normalizeSymbol(requiredText(input.optionSymbol, "option symbol"));
  const expirationDate = requiredText(input.expirationDate, "expiration date");
  if (!ZERO_DTE_PLAYBOOKS.includes(input.playbook)) {
    throw new RangeError(`Unsupported 0DTE playbook: ${input.playbook}`);
  }
  if (!(["bullish", "bearish", "neutral"] as const).includes(input.direction)) {
    throw new RangeError(`Unsupported 0DTE direction: ${input.direction}`);
  }
  if (!ZERO_DTE_CANDIDATE_STATES.includes(input.state)) {
    throw new RangeError(`Unsupported 0DTE candidate state: ${input.state}`);
  }
  if (!Number.isFinite(input.strike)) throw new RangeError("0DTE strike must be finite");
  return { tradingDate, underlyingSymbol, optionSymbol, expirationDate };
};

const stateEventType = (state: ZeroDteCandidateState): ZeroDteLifecycleEventInput["eventType"] => {
  switch (state) {
    case "discovered": return "candidate_discovered";
    case "strengthening": return "candidate_strengthened";
    case "weakening": return "candidate_weakened";
    case "eligible": return "candidate_became_eligible";
    case "selected": return "candidate_selected";
    case "skipped": return "candidate_skipped";
    case "rejected": return "candidate_rejected";
    case "expired": return "candidate_expired";
    case "invalidated": return "candidate_invalidated";
    default: return "candidate_observed";
  }
};

const rowToCandidate = (row: Record<string, unknown>): ZeroDteCandidate => ({
  candidateId: String(row.candidate_id),
  tradingDate: String(row.trading_date),
  underlyingSymbol: String(row.underlying_symbol),
  optionSymbol: String(row.option_symbol),
  playbook: String(row.playbook) as ZeroDtePlaybook,
  direction: String(row.direction) as ZeroDteDirection,
  expirationDate: String(row.expiration_date),
  strike: dbNumber(row.strike) ?? 0,
  state: String(row.state) as ZeroDteCandidateState,
  rank: dbInteger(row.rank),
  score: dbNumber(row.score),
  playbookScore: dbNumber(row.playbook_score),
  signalStrengthAdjustment: dbNumber(row.signal_strength_adjustment),
  liquidityAdjustment: dbNumber(row.liquidity_adjustment),
  regimeAdjustment: dbNumber(row.regime_adjustment),
  executionQualityAdjustment: dbNumber(row.execution_quality_adjustment),
  riskPenalty: dbNumber(row.risk_penalty),
  staleDataPenalty: dbNumber(row.stale_data_penalty),
  confidence: dbNumber(row.confidence),
  signalSlope: dbNumber(row.signal_slope),
  shortWindowSlope: dbNumber(row.short_window_slope),
  mediumWindowSlope: dbNumber(row.medium_window_slope),
  liquidityScore: dbNumber(row.liquidity_score),
  freshnessScore: dbNumber(row.freshness_score),
  setupAgeSeconds: dbInteger(row.setup_age_seconds),
  quoteBid: dbNumber(row.quote_bid),
  quoteAsk: dbNumber(row.quote_ask),
  quoteMidpoint: dbNumber(row.quote_midpoint),
  premium: dbNumber(row.premium),
  spreadPct: dbNumber(row.spread_pct),
  volume: dbInteger(row.volume),
  openInterest: dbInteger(row.open_interest),
  impliedVolatility: dbNumber(row.implied_volatility),
  delta: dbNumber(row.delta),
  gamma: dbNumber(row.gamma),
  theta: dbNumber(row.theta),
  vega: dbNumber(row.vega),
  marketTimestamp: row.market_timestamp === null ? null : String(row.market_timestamp),
  firstSeenAt: String(row.first_seen_at),
  lastSeenAt: String(row.last_seen_at),
  stateChangedAt: String(row.state_changed_at),
  stateReasonCode: row.state_reason_code === null ? null : String(row.state_reason_code),
  stateReason: recordJson(row.state_reason_json),
  reappearanceCount: dbInteger(row.reappearance_count) ?? 0,
  blockerCodes: stringArrayJson(row.blocker_codes_json),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

const rowToQueueCandidate = (row: Record<string, unknown>): ZeroDteQueueCandidate => {
  const candidate = rowToCandidate(row);
  const eligible = candidate.state === "eligible";
  const blockers = candidate.blockerCodes.filter(
    (code) => code.trim() !== "" && code !== "NONE"
  );
  const executableQuote =
    candidate.quoteBid !== null &&
    candidate.quoteAsk !== null &&
    candidate.quoteMidpoint !== null &&
    candidate.quoteBid > 0 &&
    candidate.quoteAsk >= candidate.quoteBid &&
    candidate.quoteMidpoint > 0;
  const executable =
    eligible &&
    candidate.direction !== "neutral" &&
    blockers.length === 0 &&
    executableQuote;
  return {
    ...candidate,
    eligible,
    executable,
    totalScore: candidate.score,
    quote: {
      bid: candidate.quoteBid,
      ask: candidate.quoteAsk,
      midpoint: candidate.quoteMidpoint,
      premium: candidate.premium,
      spreadPct: candidate.spreadPct,
      volume: candidate.volume,
      openInterest: candidate.openInterest,
      impliedVolatility: candidate.impliedVolatility,
      delta: candidate.delta,
      gamma: candidate.gamma,
      theta: candidate.theta,
      vega: candidate.vega,
      marketTimestamp: candidate.marketTimestamp
    },
    componentScores: {
      playbook: candidate.playbookScore,
      signalStrength: candidate.signalStrengthAdjustment,
      liquidity: candidate.liquidityAdjustment,
      regime: candidate.regimeAdjustment,
      executionQuality: candidate.executionQualityAdjustment,
      riskPenalty: candidate.riskPenalty,
      staleDataPenalty: candidate.staleDataPenalty
    },
    blockers: [...candidate.blockerCodes],
    rank: candidate.rank ?? 0
  };
};

const queueRows = (tradingDate: string) => {
  const placeholders = TERMINAL_QUEUE_STATES.map(() => "?").join(", ");
  return queryAll<Record<string, unknown>>(
    `SELECT *
     FROM zero_dte_candidates
     WHERE trading_date = ?
       AND state NOT IN (${placeholders})`,
    [tradingDate, ...TERMINAL_QUEUE_STATES]
  );
};

export const upsertZeroDteCandidate = (input: ZeroDteCandidateUpsert): ZeroDteCandidate => {
  const identity = validateCandidateIdentity(input);
  const db = getDb();
  return withTransaction(db, () => {
    const existing = db.prepare(
      `SELECT *
       FROM zero_dte_candidates
       WHERE trading_date = ? AND underlying_symbol = ? AND option_symbol = ?
         AND playbook = ? AND direction = ? AND expiration_date = ? AND strike = ?`
    ).get(
      identity.tradingDate,
      identity.underlyingSymbol,
      identity.optionSymbol,
      input.playbook,
      input.direction,
      identity.expirationDate,
      input.strike
    ) as Record<string, unknown> | undefined;

    const canonicalCandidateId = buildZeroDteCandidateId({
      tradingDate: identity.tradingDate,
      underlying: identity.underlyingSymbol,
      optionSymbol: identity.optionSymbol,
      playbook: input.playbook,
      direction: input.direction,
      expirationDate: identity.expirationDate,
      strike: input.strike
    });
    if (input.candidateId && input.candidateId !== canonicalCandidateId) {
      throw new RangeError("0DTE candidate ID does not match canonical identity");
    }
    if (existing && String(existing.candidate_id) !== canonicalCandidateId) {
      throw new RangeError("0DTE persisted candidate ID does not match canonical identity");
    }
    const candidateId = String(existing?.candidate_id ?? input.candidateId ?? canonicalCandidateId);
    const previousState = existing ? String(existing.state) as ZeroDteCandidateState : null;
    const stateChanged = !existing || previousState !== input.state;
    const validReappearance = Boolean(
      existing && previousState &&
      REAPPEARANCE_STATES.has(previousState) &&
      previousState !== input.state &&
      !TERMINAL_QUEUE_STATE_SET.has(input.state)
    );
    if (input.reappeared && !validReappearance) {
      throw new Error("ZERO_DTE_REAPPEARANCE_TRANSITION_REQUIRED");
    }
    if (
      existing && previousState &&
      TERMINAL_QUEUE_STATE_SET.has(previousState) &&
      previousState !== input.state &&
      !input.reappeared
    ) {
      throw new Error("ZERO_DTE_TERMINAL_CANDIDATE_REAPPEARANCE_REQUIRED");
    }
    const reappeared = Boolean(input.reappeared);
    const previousReappearanceCount = dbInteger(existing?.reappearance_count) ?? 0;
    const reappearanceCount = previousReappearanceCount + (reappeared ? 1 : 0);
    const lastSeenAt = isoTimestamp(input.lastSeenAt, "last seen timestamp");
    const firstSeenAt = existing
      ? String(existing.first_seen_at)
      : isoTimestamp(input.firstSeenAt ?? input.lastSeenAt, "first seen timestamp");
    const stateChangedAt = stateChanged
      ? isoTimestamp(input.stateChangedAt ?? input.lastSeenAt, "state changed timestamp")
      : String(existing?.state_changed_at ?? lastSeenAt);
    const createdAt = existing
      ? String(existing.created_at)
      : isoTimestamp(input.createdAt ?? lastSeenAt, "created timestamp");
    const updatedAt = isoTimestamp(input.updatedAt ?? lastSeenAt, "updated timestamp");
    const lifecycleContext = input.lifecycleContext ?? null;
    if ((stateChanged || reappeared) && !lifecycleContext) {
      throw new Error("ZERO_DTE_LIFECYCLE_CONTEXT_REQUIRED_FOR_STATE_CHANGE");
    }

    const numeric = {
      rank: integerOrNull(input.rank, "rank"),
      score: finiteOrNull(input.score, "score"),
      playbookScore: finiteOrNull(input.playbookScore, "playbook score"),
      signalStrengthAdjustment: finiteOrNull(input.signalStrengthAdjustment, "signal strength adjustment"),
      liquidityAdjustment: finiteOrNull(input.liquidityAdjustment, "liquidity adjustment"),
      regimeAdjustment: finiteOrNull(input.regimeAdjustment, "regime adjustment"),
      executionQualityAdjustment: finiteOrNull(input.executionQualityAdjustment, "execution quality adjustment"),
      riskPenalty: finiteOrNull(input.riskPenalty, "risk penalty"),
      staleDataPenalty: finiteOrNull(input.staleDataPenalty, "stale data penalty"),
      confidence: finiteOrNull(input.confidence, "confidence"),
      signalSlope: finiteOrNull(input.signalSlope, "signal slope"),
      shortWindowSlope: finiteOrNull(input.shortWindowSlope, "short window slope"),
      mediumWindowSlope: finiteOrNull(input.mediumWindowSlope, "medium window slope"),
      liquidityScore: finiteOrNull(input.liquidityScore, "liquidity score"),
      freshnessScore: finiteOrNull(input.freshnessScore, "freshness score"),
      setupAgeSeconds: integerOrNull(input.setupAgeSeconds, "setup age seconds"),
      quoteBid: finiteOrNull(input.quoteBid, "quote bid"),
      quoteAsk: finiteOrNull(input.quoteAsk, "quote ask"),
      quoteMidpoint: finiteOrNull(input.quoteMidpoint, "quote midpoint"),
      premium: finiteOrNull(input.premium, "premium"),
      spreadPct: finiteOrNull(input.spreadPct, "spread percentage"),
      volume: integerOrNull(input.volume, "volume"),
      openInterest: integerOrNull(input.openInterest, "open interest"),
      impliedVolatility: finiteOrNull(input.impliedVolatility, "implied volatility"),
      delta: finiteOrNull(input.delta, "delta"),
      gamma: finiteOrNull(input.gamma, "gamma"),
      theta: finiteOrNull(input.theta, "theta"),
      vega: finiteOrNull(input.vega, "vega")
    };

    db.prepare(
      `INSERT INTO zero_dte_candidates
        (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
         direction, expiration_date, strike, state, rank, score, playbook_score,
         signal_strength_adjustment, liquidity_adjustment, regime_adjustment,
         execution_quality_adjustment, risk_penalty, stale_data_penalty,
         confidence, signal_slope, short_window_slope, medium_window_slope,
         liquidity_score, freshness_score, setup_age_seconds, quote_bid,
         quote_ask, quote_midpoint, premium, spread_pct, volume, open_interest,
         implied_volatility, delta, gamma, theta, vega, market_timestamp,
         first_seen_at, last_seen_at, state_changed_at, state_reason_code,
         state_reason_json, reappearance_count, blocker_codes_json, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trading_date, underlying_symbol, option_symbol, playbook,
                   direction, expiration_date, strike)
       DO UPDATE SET
         state = excluded.state,
         rank = excluded.rank,
         score = excluded.score,
         playbook_score = excluded.playbook_score,
         signal_strength_adjustment = excluded.signal_strength_adjustment,
         liquidity_adjustment = excluded.liquidity_adjustment,
         regime_adjustment = excluded.regime_adjustment,
         execution_quality_adjustment = excluded.execution_quality_adjustment,
         risk_penalty = excluded.risk_penalty,
         stale_data_penalty = excluded.stale_data_penalty,
         confidence = excluded.confidence,
         signal_slope = excluded.signal_slope,
         short_window_slope = excluded.short_window_slope,
         medium_window_slope = excluded.medium_window_slope,
         liquidity_score = excluded.liquidity_score,
         freshness_score = excluded.freshness_score,
         setup_age_seconds = excluded.setup_age_seconds,
         quote_bid = excluded.quote_bid,
         quote_ask = excluded.quote_ask,
         quote_midpoint = excluded.quote_midpoint,
         premium = excluded.premium,
         spread_pct = excluded.spread_pct,
         volume = excluded.volume,
         open_interest = excluded.open_interest,
         implied_volatility = excluded.implied_volatility,
         delta = excluded.delta,
         gamma = excluded.gamma,
         theta = excluded.theta,
         vega = excluded.vega,
         market_timestamp = excluded.market_timestamp,
         last_seen_at = excluded.last_seen_at,
         state_changed_at = excluded.state_changed_at,
         state_reason_code = excluded.state_reason_code,
         state_reason_json = excluded.state_reason_json,
         reappearance_count = excluded.reappearance_count,
         blocker_codes_json = excluded.blocker_codes_json,
         updated_at = excluded.updated_at`
    ).run(
      candidateId,
      identity.tradingDate,
      identity.underlyingSymbol,
      identity.optionSymbol,
      input.playbook,
      input.direction,
      identity.expirationDate,
      input.strike,
      input.state,
      numeric.rank,
      numeric.score,
      numeric.playbookScore,
      numeric.signalStrengthAdjustment,
      numeric.liquidityAdjustment,
      numeric.regimeAdjustment,
      numeric.executionQualityAdjustment,
      numeric.riskPenalty,
      numeric.staleDataPenalty,
      numeric.confidence,
      numeric.signalSlope,
      numeric.shortWindowSlope,
      numeric.mediumWindowSlope,
      numeric.liquidityScore,
      numeric.freshnessScore,
      numeric.setupAgeSeconds,
      numeric.quoteBid,
      numeric.quoteAsk,
      numeric.quoteMidpoint,
      numeric.premium,
      numeric.spreadPct,
      numeric.volume,
      numeric.openInterest,
      numeric.impliedVolatility,
      numeric.delta,
      numeric.gamma,
      numeric.theta,
      numeric.vega,
      optionalIsoTimestamp(input.marketTimestamp, "market timestamp"),
      firstSeenAt,
      lastSeenAt,
      stateChangedAt,
      optionalText(input.stateReasonCode),
      serializeZeroDteJson(input.stateReason ?? {}, "{}"),
      reappearanceCount,
      serializeZeroDteJson(input.blockerCodes ?? [], "[]"),
      createdAt,
      updatedAt
    );

    if (lifecycleContext) {
      const eventBase: Omit<ZeroDteLifecycleEventInput, "eventType"> = {
        reasonCode: optionalText(input.stateReasonCode) ?? (reappeared ? "CANDIDATE_REAPPEARED" : null),
        engineRunId: lifecycleContext.engineRunId ?? null,
        candidateId,
        decisionId: lifecycleContext.decisionId ?? null,
        decisionGroupId: lifecycleContext.decisionGroupId ?? null,
        accountMode: lifecycleContext.accountMode,
        strategyVersion: lifecycleContext.strategyVersion,
        configurationVersionId: lifecycleContext.configurationVersionId,
        marketTimestamp: input.marketTimestamp ?? lifecycleContext.marketTimestamp ?? null,
        occurredAt: lifecycleContext.occurredAt ?? stateChangedAt,
        details: {
          previousState,
          currentState: input.state,
          previousScore: dbNumber(existing?.score),
          currentScore: numeric.score,
          reappearanceCount,
          stateReason: input.stateReason ?? {}
        }
      };
      if (reappeared) {
        insertZeroDteLifecycleEventRow(db, {
          ...eventBase,
          eventType: "candidate_reappeared",
          reasonCode: optionalText(input.stateReasonCode) ?? "CANDIDATE_REAPPEARED"
        });
      }
      if (stateChanged) {
        insertZeroDteLifecycleEventRow(db, {
          ...eventBase,
          eventType: existing ? stateEventType(input.state) : "candidate_discovered"
        });
      }
    }

    return rowToCandidate(
      db.prepare("SELECT * FROM zero_dte_candidates WHERE candidate_id = ?").get(candidateId) as Record<string, unknown>
    );
  });
};

export const appendZeroDteCandidateObservation = (input: ZeroDteObservationInput): void => {
  if (!ZERO_DTE_CANDIDATE_STATES.includes(input.state)) {
    throw new RangeError(`Unsupported 0DTE observation state: ${input.state}`);
  }
  const candidateId = requiredText(input.candidateId, "candidate ID");
  const engineRunId = requiredText(input.engineRunId, "engine run ID");
  const observedAt = isoTimestamp(input.observedAt, "observation timestamp");
  const createdAt = isoTimestamp(input.createdAt ?? observedAt, "created timestamp");
  const db = getDb();
  withTransaction(db, () => {
    const numeric = {
      totalScore: finiteOrNull(input.totalScore, "total score"),
      playbookScore: finiteOrNull(input.playbookScore, "playbook score"),
      confidence: finiteOrNull(input.confidence, "confidence"),
      signalSlope: finiteOrNull(input.signalSlope, "signal slope"),
      shortWindowSlope: finiteOrNull(input.shortWindowSlope, "short window slope"),
      mediumWindowSlope: finiteOrNull(input.mediumWindowSlope, "medium window slope"),
      liquidityScore: finiteOrNull(input.liquidityScore, "liquidity score"),
      freshnessScore: finiteOrNull(input.freshnessScore, "freshness score"),
      quoteBid: finiteOrNull(input.quoteBid, "quote bid"),
      quoteAsk: finiteOrNull(input.quoteAsk, "quote ask"),
      quoteMidpoint: finiteOrNull(input.quoteMidpoint, "quote midpoint"),
      premium: finiteOrNull(input.premium, "premium"),
      spreadPct: finiteOrNull(input.spreadPct, "spread percentage"),
      volume: integerOrNull(input.volume, "volume"),
      openInterest: integerOrNull(input.openInterest, "open interest"),
      impliedVolatility: finiteOrNull(input.impliedVolatility, "implied volatility"),
      delta: finiteOrNull(input.delta, "delta"),
      gamma: finiteOrNull(input.gamma, "gamma"),
      theta: finiteOrNull(input.theta, "theta"),
      vega: finiteOrNull(input.vega, "vega"),
      peakScore: finiteOrNull(input.peakScore, "peak score"),
      drawdownScore: finiteOrNull(input.drawdownScore, "drawdown score"),
      setupAgeSeconds: integerOrNull(input.setupAgeSeconds, "setup age seconds")
    };
    db.prepare(
      `INSERT INTO zero_dte_candidate_observations
        (observation_id, candidate_id, engine_run_id, observed_at,
         market_timestamp, state, total_score, playbook_score, confidence,
         signal_slope, short_window_slope, medium_window_slope, liquidity_score,
         freshness_score, quote_bid, quote_ask, quote_midpoint, premium,
         spread_pct, volume, open_interest, implied_volatility, delta, gamma,
         theta, vega, peak_score, drawdown_score, setup_age_seconds,
         data_quality_flags_json, supporting_signals_json, opposing_signals_json,
         blocker_codes_json, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      requiredText(input.observationId ?? uuid(), "observation ID"),
      candidateId,
      engineRunId,
      observedAt,
      optionalIsoTimestamp(input.marketTimestamp, "market timestamp"),
      input.state,
      numeric.totalScore,
      numeric.playbookScore,
      numeric.confidence,
      numeric.signalSlope,
      numeric.shortWindowSlope,
      numeric.mediumWindowSlope,
      numeric.liquidityScore,
      numeric.freshnessScore,
      numeric.quoteBid,
      numeric.quoteAsk,
      numeric.quoteMidpoint,
      numeric.premium,
      numeric.spreadPct,
      numeric.volume,
      numeric.openInterest,
      numeric.impliedVolatility,
      numeric.delta,
      numeric.gamma,
      numeric.theta,
      numeric.vega,
      numeric.peakScore,
      numeric.drawdownScore,
      numeric.setupAgeSeconds,
      serializeZeroDteJson(input.dataQualityFlags ?? [], "[]"),
      serializeZeroDteJson(input.supportingSignals ?? [], "[]"),
      serializeZeroDteJson(input.opposingSignals ?? [], "[]"),
      serializeZeroDteJson(input.blockerCodes ?? [], "[]"),
      serializeZeroDteJson(input.evidence ?? {}, "{}"),
      createdAt
    );
  });
};

export const insertZeroDtePlaybookEvaluation = (input: PlaybookEvaluationInput): void => {
  if (!ZERO_DTE_PLAYBOOKS.includes(input.playbook)) {
    throw new RangeError(`Unsupported 0DTE playbook: ${input.playbook}`);
  }
  if (!("bullish" === input.direction || "bearish" === input.direction || "neutral" === input.direction)) {
    throw new RangeError(`Unsupported 0DTE direction: ${input.direction}`);
  }
  if (!Number.isFinite(input.score) || !Number.isFinite(input.confidence)) {
    throw new RangeError("0DTE playbook score and confidence must be finite");
  }
  const candidateId = requiredText(input.candidateId, "candidate ID");
  const engineRunId = requiredText(input.engineRunId, "engine run ID");
  const evaluatedAt = isoTimestamp(input.evaluatedAt, "evaluation timestamp");
  const createdAt = isoTimestamp(input.createdAt ?? evaluatedAt, "created timestamp");
  const db = getDb();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO zero_dte_playbook_evaluations
        (evaluation_id, candidate_id, engine_run_id, playbook, score, confidence,
         direction, eligible, supporting_signals_json, opposing_signals_json,
         blocker_codes_json, missing_inputs_json, evidence_json, evaluated_at,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(candidate_id, engine_run_id, playbook) DO NOTHING`
    ).run(
      requiredText(input.evaluationId ?? uuid(), "evaluation ID"),
      candidateId,
      engineRunId,
      input.playbook,
      input.score,
      input.confidence,
      input.direction,
      input.eligible ? 1 : 0,
      serializeZeroDteJson(input.supportingSignals ?? [], "[]"),
      serializeZeroDteJson(input.opposingSignals ?? [], "[]"),
      serializeZeroDteJson(input.blockerCodes ?? [], "[]"),
      serializeZeroDteJson(input.missingInputs ?? [], "[]"),
      serializeZeroDteJson(input.evidence ?? {}, "{}"),
      evaluatedAt,
      createdAt
    );
  });
};

const validateLimit = (value: number | undefined, fallback: number) => {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 0 || limit > 1_000) {
    throw new RangeError("0DTE queue limit must be an integer from 0 through 1000");
  }
  return limit;
};

export const listZeroDteQueue = (input: {
  tradingDate: string;
  limit: number;
}): ZeroDteQueueCandidate[] => {
  const tradingDate = requiredText(input.tradingDate, "trading date");
  const limit = validateLimit(input.limit, 20);
  if (limit === 0) return [];
  const ranked = rankZeroDteQueue(queueRows(tradingDate).map(rowToQueueCandidate));
  return ranked.slice(0, limit);
};

const resolveSummaryTradingDate = (requested?: string) => {
  if (requested) return requiredText(requested, "trading date");
  const row = queryOne<{ trading_date: string }>(
    "SELECT trading_date FROM zero_dte_candidates ORDER BY last_seen_at DESC LIMIT 1"
  );
  return row?.trading_date ?? null;
};

const increment = (target: Record<string, number>, key: string, amount = 1) => {
  target[key] = (target[key] ?? 0) + amount;
};

export const readZeroDteSummary = (input: {
  tradingDate?: string;
  limit?: number;
} = {}): ZeroDteSummary => {
  const tradingDate = resolveSummaryTradingDate(input.tradingDate);
  const limit = validateLimit(input.limit, 20);
  const queue = tradingDate
    ? listZeroDteQueue({ tradingDate, limit })
    : [];
  const candidateRows = tradingDate
    ? queryAll<Record<string, unknown>>(
      "SELECT state, playbook FROM zero_dte_candidates WHERE trading_date = ?",
      [tradingDate]
    )
    : [];
  const byState: Record<string, number> = {};
  const byPlaybook: Record<string, number> = {};
  for (const row of candidateRows) {
    increment(byState, String(row.state));
    increment(byPlaybook, String(row.playbook));
  }
  const lifecycleRows = tradingDate
    ? queryAll<Record<string, unknown>>(
      `SELECT event_type
       FROM zero_dte_lifecycle_events
       WHERE candidate_id IN (
         SELECT candidate_id FROM zero_dte_candidates WHERE trading_date = ?
       )`,
      [tradingDate]
    )
    : [];
  const lifecycleCounts: Record<string, number> = {};
  for (const row of lifecycleRows) increment(lifecycleCounts, String(row.event_type));
  const recentRows = tradingDate
    ? queryAll<Record<string, unknown>>(
      `SELECT e.*
       FROM zero_dte_lifecycle_events AS e
       WHERE e.candidate_id IN (
         SELECT candidate_id FROM zero_dte_candidates WHERE trading_date = ?
       )
       ORDER BY e.occurred_at DESC, e.event_id DESC
       LIMIT 50`,
      [tradingDate]
    )
    : [];
  const recent = recentRows.map((row) => ({
    eventId: String(row.event_id),
    eventType: String(row.event_type) as ZeroDteLifecycleEvent["eventType"],
    reasonCode: row.reason_code === null ? null : String(row.reason_code),
    engineRunId: row.engine_run_id === null ? null : String(row.engine_run_id),
    candidateId: row.candidate_id === null ? null : String(row.candidate_id),
    decisionId: row.decision_id === null ? null : String(row.decision_id),
    decisionGroupId: row.decision_group_id === null ? null : String(row.decision_group_id),
    paperTradeId: row.paper_trade_id === null ? null : String(row.paper_trade_id),
    shadowTradeId: row.shadow_trade_id === null ? null : String(row.shadow_trade_id),
    accountMode: String(row.account_mode),
    strategyVersion: String(row.strategy_version),
    configurationVersionId: String(row.configuration_version_id),
    marketTimestamp: row.market_timestamp === null ? null : String(row.market_timestamp),
    occurredAt: String(row.occurred_at),
    details: recordJson(row.details_json),
    createdAt: String(row.created_at)
  }));

  return {
    paperOnly: true,
    generatedAt: nowIso(),
    tradingDate,
    queue,
    counts: {
      candidates: candidateRows.length,
      active: queueRows(tradingDate ?? "").length,
      eligible: candidateRows.filter((row) => row.state === "eligible").length,
      byState,
      byPlaybook
    },
    lifecycle: {
      counts: lifecycleCounts,
      recent
    }
  };
};

export type {
  ZeroDteDecision,
  ZeroDteDecisionInput,
  ZeroDteLifecycleEvent,
  ZeroDteLifecycleEventInput,
  ZeroDteLifecycleEventType
} from "./zeroDteLifecycleService.js";
export {
  appendZeroDteLifecycleEvent,
  insertZeroDteDecision
} from "./zeroDteLifecycleService.js";
