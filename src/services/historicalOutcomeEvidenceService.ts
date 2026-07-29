import {
  OUTCOME_LEARNING_SCHEMA_VERSION,
  type OutcomeEnvironment,
  type OutcomeLane
} from "./outcomeLearningModel.js";
import type { OutcomeLearningQueryExecutor } from "./postgresOutcomeLearningService.js";

export type HistoricalOutcomeEvidenceConfig = {
  enabled: boolean;
  lookbackDays: number;
  minimumSample: number;
  maximumIncompleteJoinRatio: number;
  staleAfterMs: number;
  maximumRows: number;
  schemaVersion: number;
};

const envBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value.trim() === "") return fallback;
  return ["true", "1"].includes(value.trim().toLowerCase());
};

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

const boundedRatio = (
  value: string | undefined,
  fallback: number
) => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
};

export const historicalOutcomeEvidenceConfig = (
  env: NodeJS.ProcessEnv = process.env
): HistoricalOutcomeEvidenceConfig => ({
  enabled: envBoolean(env.OUTCOME_LEARNING_EVIDENCE_ENABLED, false),
  lookbackDays: boundedInteger(
    env.OUTCOME_LEARNING_LOOKBACK_DAYS,
    31,
    1,
    31
  ),
  minimumSample: boundedInteger(
    env.OUTCOME_LEARNING_MINIMUM_SAMPLE,
    5,
    1,
    500
  ),
  maximumIncompleteJoinRatio: boundedRatio(
    env.OUTCOME_LEARNING_MAX_INCOMPLETE_JOIN_RATIO,
    0.25
  ),
  staleAfterMs: boundedInteger(
    env.OUTCOME_LEARNING_STALE_AFTER_SECONDS,
    86_400,
    60,
    604_800
  ) * 1_000,
  maximumRows: 500,
  schemaVersion: OUTCOME_LEARNING_SCHEMA_VERSION
});

export type HistoricalOutcomeEvidenceIndex = {
  state: "disabled" | "available" | "unavailable";
  reasonCode:
    | "HISTORICAL_OUTCOME_EVIDENCE_DISABLED"
    | "HISTORICAL_OUTCOME_EVIDENCE_LOADED"
    | "HISTORICAL_OUTCOME_QUERY_UNAVAILABLE";
  rows: Record<string, unknown>[];
  config: HistoricalOutcomeEvidenceConfig;
};

export type HistoricalOutcomeEvidence = {
  state: "available";
  reasonCode: "HISTORICAL_OUTCOME_EVIDENCE_AVAILABLE";
  aggregateId: string;
  environment: OutcomeEnvironment;
  lane: OutcomeLane;
  dimension: string;
  groupingKey: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  sampleCount: number;
  filledCount: number;
  rejectedCount: number;
  canceledCount: number;
  averageTimeToFirstFillMs: number | null;
  averageSlippageBps: number | null;
  realizedReturnAverage: number | null;
  winRate: number | null;
  missingJoinCount: number;
  ambiguousJoinCount: number;
  unsupportedMetricCount: number;
  sourceWatermark: string;
  calculatedAt: string;
  schemaVersion: number;
  contentHash: string;
};

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const count = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : null;
};

const timestamp = (value: unknown): string | null => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export const loadHistoricalOutcomeEvidence = async (input: {
  query: OutcomeLearningQueryExecutor;
  now: Date;
  environment: OutcomeEnvironment;
  config?: HistoricalOutcomeEvidenceConfig;
}): Promise<HistoricalOutcomeEvidenceIndex> => {
  const config = input.config ?? historicalOutcomeEvidenceConfig();
  if (!config.enabled) {
    return {
      state: "disabled",
      reasonCode: "HISTORICAL_OUTCOME_EVIDENCE_DISABLED",
      rows: [],
      config
    };
  }
  const lookbackStart = new Date(
    input.now.getTime() - config.lookbackDays * 86_400_000
  ).toISOString();
  const freshAfter = new Date(
    input.now.getTime() - config.staleAfterMs
  ).toISOString();
  try {
    const result = await input.query.query(
      `SELECT
         id, environment, lane, dimension, grouping_key,
         date_range_start, date_range_end, source_truncated, sample_count,
         filled_count, rejected_count, canceled_count,
         average_time_to_first_fill_ms, average_slippage_bps,
         realized_return_average, win_rate, missing_join_count,
         ambiguous_join_count, unsupported_metric_count, usable_as_evidence,
         source_watermark, calculated_at, schema_version, content_hash
       FROM historical_outcome_aggregates
       WHERE environment = $1
         AND usable_as_evidence
         AND NOT source_truncated
         AND calculated_at >= $2
         AND date_range_start >= $3
         AND date_range_end <= $4
         AND schema_version = $5
         AND dimension = ANY($6::text[])
       ORDER BY calculated_at DESC, lane, dimension, grouping_key
       LIMIT $7`,
      [
        input.environment,
        freshAfter,
        lookbackStart,
        input.now.toISOString(),
        config.schemaVersion,
        ["symbol", "underlying", "lane"],
        config.maximumRows
      ]
    );
    return {
      state: "available",
      reasonCode: "HISTORICAL_OUTCOME_EVIDENCE_LOADED",
      rows: result.rows,
      config
    };
  } catch {
    return {
      state: "unavailable",
      reasonCode: "HISTORICAL_OUTCOME_QUERY_UNAVAILABLE",
      rows: [],
      config
    };
  }
};

const matchesDimension = (
  row: Record<string, unknown>,
  input: {
    lane: OutcomeLane;
    symbol: string;
    underlyingSymbol: string;
  }
) => {
  const dimension = String(row.dimension ?? "");
  const key = String(row.grouping_key ?? "");
  if (dimension === "symbol") return key === input.symbol;
  if (dimension === "underlying") return key === input.underlyingSymbol;
  if (dimension === "lane") return key === input.lane;
  return false;
};

const dimensionPriority = (row: Record<string, unknown>) => {
  const dimension = String(row.dimension ?? "");
  if (dimension === "symbol") return 0;
  if (dimension === "underlying") return 1;
  if (dimension === "lane") return 2;
  return 3;
};

export const selectHistoricalOutcomeEvidence = (
  index: HistoricalOutcomeEvidenceIndex,
  input: {
    environment: OutcomeEnvironment;
    lane: OutcomeLane;
    symbol: string;
    underlyingSymbol: string;
    now: Date;
  }
): HistoricalOutcomeEvidence | null => {
  if (index.state !== "available" || !index.config.enabled) return null;
  const valid = index.rows
    .filter((row) => {
      const sampleCount = count(row.sample_count);
      const filled = count(row.filled_count);
      const rejected = count(row.rejected_count);
      const canceled = count(row.canceled_count);
      const missing = count(row.missing_join_count);
      const ambiguous = count(row.ambiguous_join_count);
      const unsupported = count(row.unsupported_metric_count);
      const start = timestamp(row.date_range_start);
      const end = timestamp(row.date_range_end);
      const sourceWatermark = timestamp(row.source_watermark);
      const calculatedAt = timestamp(row.calculated_at);
      if (
        row.environment !== input.environment ||
        row.lane !== input.lane ||
        row.source_truncated === true ||
        row.usable_as_evidence !== true ||
        Number(row.schema_version) !== index.config.schemaVersion ||
        sampleCount === null ||
        sampleCount < index.config.minimumSample ||
        filled === null ||
        rejected === null ||
        canceled === null ||
        missing === null ||
        ambiguous === null ||
        unsupported === null ||
        !start ||
        !end ||
        !sourceWatermark ||
        !calculatedAt ||
        !matchesDimension(row, input)
      ) {
        return false;
      }
      const incompleteRatio = (missing + ambiguous) / sampleCount;
      const span = Date.parse(end) - Date.parse(start);
      const age = input.now.getTime() - Date.parse(calculatedAt);
      return (
        incompleteRatio <= index.config.maximumIncompleteJoinRatio &&
        span > 0 &&
        span <= index.config.lookbackDays * 86_400_000 &&
        Date.parse(end) <= input.now.getTime() &&
        age >= 0 &&
        age <= index.config.staleAfterMs &&
        /^[a-f0-9]{64}$/.test(String(row.content_hash ?? ""))
      );
    })
    .sort((left, right) => {
      const priority = dimensionPriority(left) - dimensionPriority(right);
      if (priority !== 0) return priority;
      return String(right.calculated_at).localeCompare(
        String(left.calculated_at)
      );
    });
  const row = valid[0];
  if (!row) return null;
  return {
    state: "available",
    reasonCode: "HISTORICAL_OUTCOME_EVIDENCE_AVAILABLE",
    aggregateId: String(row.id),
    environment: input.environment,
    lane: input.lane,
    dimension: String(row.dimension),
    groupingKey: String(row.grouping_key),
    dateRangeStart: timestamp(row.date_range_start)!,
    dateRangeEnd: timestamp(row.date_range_end)!,
    sampleCount: count(row.sample_count)!,
    filledCount: count(row.filled_count)!,
    rejectedCount: count(row.rejected_count)!,
    canceledCount: count(row.canceled_count)!,
    averageTimeToFirstFillMs: finite(row.average_time_to_first_fill_ms),
    averageSlippageBps: finite(row.average_slippage_bps),
    realizedReturnAverage: finite(row.realized_return_average),
    winRate: finite(row.win_rate),
    missingJoinCount: count(row.missing_join_count)!,
    ambiguousJoinCount: count(row.ambiguous_join_count)!,
    unsupportedMetricCount: count(row.unsupported_metric_count)!,
    sourceWatermark: timestamp(row.source_watermark)!,
    calculatedAt: timestamp(row.calculated_at)!,
    schemaVersion: Number(row.schema_version),
    contentHash: String(row.content_hash)
  };
};

export const attachHistoricalOutcomeEvidence = <
  T extends Record<string, unknown>
>(
  signalInputs: T,
  evidence: HistoricalOutcomeEvidence | null
): T & { historicalOutcomeEvidence?: HistoricalOutcomeEvidence } => {
  if (!evidence) return signalInputs;
  return {
    ...signalInputs,
    historicalOutcomeEvidence: evidence
  };
};
