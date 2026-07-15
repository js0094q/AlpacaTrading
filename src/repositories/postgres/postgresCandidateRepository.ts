import type { PoolClient } from "pg";

import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import type {
  CandidateInsertResult,
  CandidateLifecycleEvent,
  CandidateLifecycleEventRepository,
  CandidateRecord,
  CandidateRepository
} from "../contracts/candidateRepository.js";
import type { JsonValue, VersionedWriteResult } from "../contracts/common.js";
import {
  asIsoString,
  asNumber,
  currentFenceToken,
  fencePredicate,
  fenceValues,
  parseJsonValue,
  requireCurrentFence,
  type FencedPostgresRepositoryContext,
  type PostgresRepositoryContext
} from "./postgresRepositorySupport.js";

type CandidateRow = Record<string, unknown> & {
  id: string;
  decision_id: CandidateRecord["decisionId"];
  research_run_id: string;
  symbol: string;
  as_of: Date | string;
  rank: number;
  direction: CandidateRecord["direction"];
  horizon: CandidateRecord["horizon"];
  risk_profile: CandidateRecord["riskProfile"];
  preferred_expression: CandidateRecord["preferredExpression"];
  decision: CandidateRecord["decision"];
  lifecycle_status: CandidateRecord["lifecycleStatus"];
  decision_reason: string | null;
  strategy_family: string | null;
  data_quality_status: string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

const candidateColumns = `
  id, decision_id, research_run_id, symbol, as_of, rank, direction, horizon,
  risk_profile, preferred_expression, score, confidence, expected_return,
  estimated_max_loss, estimated_max_profit, rationale, relevant_backtest_run_id,
  historical_win_rate, historical_avg_return, historical_max_drawdown,
  similar_setup_count, option_liquidity_score, volatility_score,
  signal_freshness_days, recent_learning_adjustment, directional_accuracy,
  option_outperformance_accuracy, option_symbol, strike, short_strike,
  decision, lifecycle_status, decision_reason, strategy_family, signal_inputs,
  data_quality_status, version, created_at, updated_at
`;

const nullableNumber = (row: CandidateRow, key: string) =>
  asNumber(row[key] as number | string | null | undefined);

const mapCandidate = (row: CandidateRow): CandidateRecord => ({
  id: row.id,
  decisionId: row.decision_id,
  researchRunId: row.research_run_id,
  symbol: row.symbol,
  asOf: asIsoString(row.as_of)!,
  rank: Number(row.rank),
  direction: row.direction,
  horizon: row.horizon,
  riskProfile: row.risk_profile,
  preferredExpression: row.preferred_expression,
  score: Number(row.score),
  confidence: Number(row.confidence),
  expectedReturn: nullableNumber(row, "expected_return"),
  estimatedMaxLoss: nullableNumber(row, "estimated_max_loss"),
  estimatedMaxProfit: nullableNumber(row, "estimated_max_profit"),
  rationale: parseJsonValue(row.rationale) as string[],
  relevantBacktestRunId: (row.relevant_backtest_run_id as string | null) || null,
  historicalWinRate: nullableNumber(row, "historical_win_rate"),
  historicalAvgReturn: nullableNumber(row, "historical_avg_return"),
  historicalMaxDrawdown: nullableNumber(row, "historical_max_drawdown"),
  similarSetupCount: nullableNumber(row, "similar_setup_count"),
  optionLiquidityScore: nullableNumber(row, "option_liquidity_score"),
  volatilityAdjustedScore: nullableNumber(row, "volatility_score"),
  signalFreshnessDays: nullableNumber(row, "signal_freshness_days"),
  recentLearningAdjustment: nullableNumber(row, "recent_learning_adjustment"),
  directionalAccuracy: nullableNumber(row, "directional_accuracy"),
  optionOutperformanceAccuracy: nullableNumber(row, "option_outperformance_accuracy"),
  optionSymbol: (row.option_symbol as string | null) || null,
  strike: nullableNumber(row, "strike"),
  shortStrike: nullableNumber(row, "short_strike"),
  decision: row.decision,
  lifecycleStatus: row.lifecycle_status,
  decisionReason: row.decision_reason || "LEGACY_UNSPECIFIED",
  strategyFamily: row.strategy_family || row.preferred_expression,
  signalInputs: parseJsonValue(row.signal_inputs) as Record<string, string | number | null>,
  dataQualityStatus: row.data_quality_status,
  version: Number(row.version),
  createdAt: asIsoString(row.created_at)!,
  updatedAt: asIsoString(row.updated_at)!
});

type CandidateEventRow = {
  event_id: string;
  candidate_id: string;
  run_id: string | null;
  sequence_number: number | string;
  prior_status: CandidateLifecycleEvent["fromStatus"];
  status: CandidateLifecycleEvent["toStatus"];
  reason_codes: unknown;
  occurred_at: Date | string;
  produced_at: Date | string;
  event_type: string;
  schema_version?: number;
  request_id: string | null;
  correlation_id: string | null;
  evidence: unknown;
  idempotency_key?: string;
};

const candidateReplayFingerprint = (candidate: CandidateRecord) => canonicalJsonHash({
  id: candidate.id,
  decisionId: candidate.decisionId ?? null,
  researchRunId: candidate.researchRunId,
  symbol: candidate.symbol,
  asOf: candidate.asOf,
  rank: candidate.rank,
  direction: candidate.direction,
  horizon: candidate.horizon,
  riskProfile: candidate.riskProfile,
  preferredExpression: candidate.preferredExpression,
  score: candidate.score,
  confidence: candidate.confidence,
  expectedReturn: candidate.expectedReturn,
  estimatedMaxLoss: candidate.estimatedMaxLoss,
  estimatedMaxProfit: candidate.estimatedMaxProfit,
  rationale: candidate.rationale,
  relevantBacktestRunId: candidate.relevantBacktestRunId,
  historicalWinRate: candidate.historicalWinRate,
  historicalAvgReturn: candidate.historicalAvgReturn,
  historicalMaxDrawdown: candidate.historicalMaxDrawdown,
  similarSetupCount: candidate.similarSetupCount,
  optionLiquidityScore: candidate.optionLiquidityScore,
  volatilityAdjustedScore: candidate.volatilityAdjustedScore,
  signalFreshnessDays: candidate.signalFreshnessDays,
  recentLearningAdjustment: candidate.recentLearningAdjustment,
  directionalAccuracy: candidate.directionalAccuracy,
  optionOutperformanceAccuracy: candidate.optionOutperformanceAccuracy,
  optionSymbol: candidate.optionSymbol ?? null,
  strike: candidate.strike ?? null,
  shortStrike: candidate.shortStrike ?? null,
  decision: candidate.decision,
  lifecycleStatus: candidate.lifecycleStatus,
  decisionReason: candidate.decisionReason,
  strategyFamily: candidate.strategyFamily,
  signalInputs: candidate.signalInputs,
  dataQualityStatus: candidate.dataQualityStatus
});

const expectedCandidateReplayFingerprint = (
  candidate: Parameters<CandidateRepository<PoolClient>["insertMany"]>[0]["candidates"][number],
  researchRunId: string
) => candidateReplayFingerprint({
  ...candidate,
  decisionId: candidate.decisionId ?? null,
  researchRunId,
  lifecycleStatus: candidate.decision,
  version: 1,
  createdAt: candidate.asOf,
  updatedAt: candidate.asOf
});

const mapEvent = (row: CandidateEventRow): CandidateLifecycleEvent => ({
  eventId: row.event_id,
  candidateId: row.candidate_id,
  researchRunId: row.run_id || "",
  sequence: Number(row.sequence_number),
  fromStatus: row.prior_status,
  toStatus: row.status,
  reasonCode: String((parseJsonValue(row.reason_codes) as JsonValue[])[0] || row.event_type),
  occurredAt: asIsoString(row.occurred_at)!,
  producedAt: asIsoString(row.produced_at)!,
  source: row.event_type,
  schemaVersion: row.schema_version || 1,
  requestId: row.request_id,
  correlationId: row.correlation_id,
  evidence: parseJsonValue(row.evidence)
});

const candidateMutationMiss = async (
  candidateId: string,
  expectedVersion: number,
  context: FencedPostgresRepositoryContext
): Promise<VersionedWriteResult> => {
  const token = await currentFenceToken(context.transaction, context.schedulerFence);
  if (token !== context.schedulerFence.fencingToken) {
    return { status: "fence_rejected", currentFencingToken: token };
  }
  const result = await context.transaction.query<{ version: number | string }>(
    "SELECT version FROM candidates WHERE id = $1",
    [candidateId]
  );
  if (!result.rows[0]) return { status: "not_found" };
  const version = Number(result.rows[0].version);
  return version === expectedVersion
    ? { status: "not_found" }
    : { status: "version_conflict", currentVersion: version };
};

export class PostgresCandidateRepository implements CandidateRepository<PoolClient> {
  async findById(
    input: { readonly candidateId: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<CandidateRow>(
      `SELECT ${candidateColumns} FROM candidates WHERE id = $1`,
      [input.candidateId]
    );
    return result.rows[0] ? mapCandidate(result.rows[0]) : null;
  }

  async listByResearchRun(
    input: { readonly researchRunId: string },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<CandidateRow>(
      `SELECT ${candidateColumns}
       FROM candidates WHERE research_run_id = $1 ORDER BY rank, id`,
      [input.researchRunId]
    );
    return result.rows.map(mapCandidate);
  }

  async insertMany(
    input: Parameters<CandidateRepository<PoolClient>["insertMany"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<readonly CandidateInsertResult[]> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return input.candidates.map(() => ({
        status: "fence_rejected" as const,
        currentFencingToken: fence.currentFencingToken
      }));
    }
    const results: CandidateInsertResult[] = [];
    for (const candidate of input.candidates) {
      const params = [
        candidate.id,
        candidate.decisionId ?? null,
        input.researchRunId,
        candidate.symbol,
        candidate.optionSymbol ? "option" : "equity",
        candidate.optionSymbol ? candidate.symbol : null,
        candidate.optionSymbol ?? null,
        candidate.asOf,
        candidate.rank,
        candidate.direction,
        candidate.horizon,
        candidate.riskProfile,
        candidate.preferredExpression,
        candidate.strategyFamily,
        candidate.score,
        candidate.confidence,
        candidate.expectedReturn,
        candidate.estimatedMaxLoss,
        candidate.estimatedMaxProfit,
        candidate.historicalWinRate,
        candidate.historicalAvgReturn,
        candidate.historicalMaxDrawdown,
        candidate.similarSetupCount,
        candidate.optionLiquidityScore,
        candidate.volatilityAdjustedScore,
        candidate.signalFreshnessDays,
        candidate.recentLearningAdjustment,
        candidate.directionalAccuracy,
        candidate.optionOutperformanceAccuracy,
        candidate.strike ?? null,
        candidate.shortStrike ?? null,
        candidate.decision,
        candidate.decisionReason,
        JSON.stringify(candidate.rationale),
        JSON.stringify(candidate.signalInputs),
        candidate.dataQualityStatus,
        candidate.relevantBacktestRunId,
        input.createdAt,
        ...fenceValues(context.schedulerFence)
      ];
      const inserted = await context.transaction.query<CandidateRow>(
        `INSERT INTO candidates(
           id, decision_id, research_run_id, candidate_key, symbol, asset_class,
           underlying_symbol, option_symbol, as_of, rank, direction, horizon,
           risk_profile, preferred_expression, strategy_family, score, confidence,
           expected_return, estimated_max_loss, estimated_max_profit,
           historical_win_rate, historical_avg_return, historical_max_drawdown,
           similar_setup_count, option_liquidity_score, volatility_score,
           signal_freshness_days, recent_learning_adjustment, directional_accuracy,
           option_outperformance_accuracy, strike, short_strike, decision,
           lifecycle_status, decision_reason, rationale, signal_inputs,
           data_quality_status, relevant_backtest_run_id, created_at, updated_at
         )
         SELECT $1, $2, $3, $1, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                $25, $26, $27, $28, $29, $30, $31, $32, $32, $33, $34::jsonb,
                $35::jsonb, $36, $37, $38, $38
         WHERE ${fencePredicate(39)}
         ON CONFLICT (id) DO NOTHING
         RETURNING ${candidateColumns}`,
        params
      );
      if (inserted.rows[0]) {
        results.push({ status: "inserted", candidate: mapCandidate(inserted.rows[0]) });
        continue;
      }
      const token = await currentFenceToken(context.transaction, context.schedulerFence);
      if (token !== context.schedulerFence.fencingToken) {
        results.push({ status: "fence_rejected", currentFencingToken: token });
        continue;
      }
      const existing = await this.findById({ candidateId: candidate.id }, context);
      if (!existing) throw new Error(`POSTGRES_CANDIDATE_UNIQUE_CONFLICT:${candidate.id}`);
      if (
        candidateReplayFingerprint(existing) !==
        expectedCandidateReplayFingerprint(candidate, input.researchRunId)
      ) {
        throw new Error(`POSTGRES_CANDIDATE_ID_CONFLICT:${candidate.id}`);
      }
      results.push({ status: "duplicate", candidate: existing });
    }
    return results;
  }

  async transition(
    input: Parameters<CandidateRepository<PoolClient>["transition"]>[0],
    context: FencedPostgresRepositoryContext
  ): Promise<VersionedWriteResult> {
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected", currentFencingToken: fence.currentFencingToken };
    }
    const result = await context.transaction.query<{ version: number | string }>(
      `UPDATE candidates
       SET lifecycle_status = $3, decision_reason = $4,
           updated_at = $5, version = version + 1
       WHERE id = $1 AND version = $2 AND ${fencePredicate(6)}
       RETURNING version`,
      [
        input.candidateId,
        input.expectedVersion,
        input.lifecycleStatus,
        input.decisionReason,
        input.updatedAt,
        ...fenceValues(context.schedulerFence)
      ]
    );
    if (!result.rows[0]) {
      return candidateMutationMiss(input.candidateId, input.expectedVersion, context);
    }
    const lifecycle = new PostgresCandidateLifecycleEventRepository();
    const appended = await lifecycle.append(input.lifecycleEvent, context);
    if (appended.status === "fence_rejected" || appended.status === "sequence_conflict") {
      throw new Error(`POSTGRES_CANDIDATE_EVENT_REJECTED:${appended.status}`);
    }
    return { status: "updated", version: Number(result.rows[0].version) };
  }
}

export class PostgresCandidateLifecycleEventRepository
implements CandidateLifecycleEventRepository<PoolClient> {
  async append(
    event: CandidateLifecycleEvent,
    context: FencedPostgresRepositoryContext
  ) {
    if (event.schemaVersion !== 1) {
      throw new Error("POSTGRES_CANDIDATE_EVENT_SCHEMA_VERSION_UNSUPPORTED");
    }
    const fence = await requireCurrentFence(context);
    if (!fence.accepted) {
      return { status: "fence_rejected" as const, currentFencingToken: fence.currentFencingToken };
    }
    try {
      const result = await context.transaction.query<{ event_id: string }>(
        `INSERT INTO candidate_lifecycle_events(
           event_id, candidate_id, sequence_number, event_type, prior_status,
           status, reason_codes, evidence, idempotency_key, occurred_at,
           produced_at, run_id, request_id, correlation_id,
           scheduler_job_name, scheduler_fencing_token
         )
         SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $1, $9, $10,
                $11, $12, $13, $14, $18
         WHERE ${fencePredicate(14)}
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          event.eventId,
          event.candidateId,
          event.sequence,
          event.source,
          event.fromStatus,
          event.toStatus,
          JSON.stringify([event.reasonCode]),
          JSON.stringify(event.evidence),
          event.occurredAt,
          event.producedAt,
          event.researchRunId,
          event.requestId,
          event.correlationId,
          ...fenceValues(context.schedulerFence)
        ]
      );
      if (result.rows[0]) return { status: "inserted" as const };
      const token = await currentFenceToken(context.transaction, context.schedulerFence);
      if (token !== context.schedulerFence.fencingToken) {
        return { status: "fence_rejected" as const, currentFencingToken: token };
      }
      const existing = await context.transaction.query<CandidateEventRow>(
        `SELECT event_id, candidate_id, run_id, sequence_number, event_type,
                prior_status, status, reason_codes, evidence, idempotency_key,
                occurred_at, produced_at, request_id, correlation_id
         FROM candidate_lifecycle_events WHERE event_id = $1`,
        [event.eventId]
      );
      const row = existing.rows[0];
      if (!row) throw new Error("POSTGRES_CANDIDATE_EVENT_CONFLICT_ROW_MISSING");
      const replayMatches = canonicalJsonHash({
        eventId: row.event_id,
        candidateId: row.candidate_id,
        researchRunId: row.run_id || "",
        sequence: Number(row.sequence_number),
        fromStatus: row.prior_status,
        toStatus: row.status,
        reasonCodes: parseJsonValue(row.reason_codes),
        occurredAt: asIsoString(row.occurred_at),
        producedAt: asIsoString(row.produced_at),
        source: row.event_type,
        requestId: row.request_id,
        correlationId: row.correlation_id,
        evidence: parseJsonValue(row.evidence),
        idempotencyKey: row.idempotency_key
      }) === canonicalJsonHash({
        eventId: event.eventId,
        candidateId: event.candidateId,
        researchRunId: event.researchRunId,
        sequence: event.sequence,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reasonCodes: [event.reasonCode],
        occurredAt: event.occurredAt,
        producedAt: event.producedAt,
        source: event.source,
        requestId: event.requestId,
        correlationId: event.correlationId,
        evidence: event.evidence,
        idempotencyKey: event.eventId
      });
      if (!replayMatches) {
        throw new Error(`POSTGRES_CANDIDATE_EVENT_ID_CONFLICT:${event.eventId}`);
      }
      return { status: "duplicate" as const };
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "23505") throw error;
      const latest = await context.transaction.query<{ sequence_number: number | string }>(
        `SELECT COALESCE(MAX(sequence_number), -1) AS sequence_number
         FROM candidate_lifecycle_events WHERE candidate_id = $1`,
        [event.candidateId]
      );
      return {
        status: "sequence_conflict" as const,
        latestSequence: Number(latest.rows[0]?.sequence_number ?? -1)
      };
    }
  }

  async listByCandidate(
    input: { readonly candidateId: string; readonly afterSequence?: number },
    context: PostgresRepositoryContext
  ) {
    const result = await context.transaction.query<CandidateEventRow>(
      `SELECT event_id, candidate_id, run_id, sequence_number, prior_status,
              status, reason_codes, occurred_at, produced_at, event_type,
              request_id, correlation_id, evidence
       FROM candidate_lifecycle_events
       WHERE candidate_id = $1 AND sequence_number > $2
       ORDER BY sequence_number`,
      [input.candidateId, input.afterSequence ?? -1]
    );
    return result.rows.map(mapEvent);
  }
}
