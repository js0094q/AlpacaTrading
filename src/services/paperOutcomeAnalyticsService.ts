import { getDb, queryAll } from "../lib/db.js";

export const PAPER_OUTCOME_ANALYTICS_DISCLAIMER =
  "Paper-only research analytics. Not live-trading advice.";

export const DEFAULT_ANALYTICS_THRESHOLDS = {
  minEvaluationsForPromotion: 5,
  minWinRateForPromotion: 0.55,
  minAvgReturnPctForPromotion: 0,
  minEvaluationsForDemotion: 5,
  maxWinRateForDemotion: 0.4,
  maxAvgReturnPctForDemotion: 0
} as const;

export const PAPER_RECOMMENDATION_SNAPSHOT_SOURCE_PAPER_ANALYTICS = "paper:analytics";

export const SUPPORTED_ANALYTICS_GROUP_BY = [
  "symbol",
  "riskProfile",
  "optionsEnabled",
  "horizon",
  "rankBucket",
  "expression"
] as const;

export const ANALYTICS_RANKING_SLICE_METRICS = [
  "winRate",
  "avgReturnPct",
  "medianReturnPct",
  "bestReturnPct",
  "worstReturnPct",
  "candidateCount",
  "evaluatedCount",
  "avgRank"
] as const;

export type PaperAnalyticsGroupBy = (typeof SUPPORTED_ANALYTICS_GROUP_BY)[number];
export type AnalyticsSliceMetric = (typeof ANALYTICS_RANKING_SLICE_METRICS)[number];

export type RecommendationFlag =
  | "PROMOTE_FOR_MORE_PAPER_TESTING"
  | "KEEP_MONITORING"
  | "DEMOTE_OR_EXCLUDE_FROM_NEXT_LOOP"
  | "INSUFFICIENT_DATA";

interface CandidateAnalyticsRow {
  id: string;
  symbol: string;
  risk_profile: string;
  options_enabled: number;
  rank: number;
  preferred_expression: string;
  horizon: string;
  as_of: string;
}

interface EvaluationAnalyticsRow {
  candidate_id: string;
  horizon: string;
  return_pct: number | null;
  outcome: string;
  evaluated_at: string;
}

export interface PaperOutcomeAnalyticsGroup {
  key: string;
  candidateCount: number;
  evaluatedCount: number;
  unevaluatedCount: number;
  winRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  bestReturnPct: number;
  worstReturnPct: number;
  avgRank: number;
  recommendationFlag: RecommendationFlag;
}

export interface PaperOutcomeAnalyticsFilters {
  since: string | null;
  until: string | null;
  minEvaluations: number;
}

export interface PaperOutcomeUnevaluatedBacklog {
  asOf: string;
  totalUnevaluated: number;
  buckets: Array<{ bucket: string; count: number }>;
}

export interface PaperOutcomeRankingPoint {
  key: string;
  value: number;
  recommendationFlag: RecommendationFlag;
}

export interface PaperOutcomeRankingSlice {
  metric: AnalyticsSliceMetric;
  top: PaperOutcomeRankingPoint[];
  bottom: PaperOutcomeRankingPoint[];
}

export interface PaperOutcomeRankingSlices {
  topN: number;
  bottomN: number;
  slices: PaperOutcomeRankingSlice[];
}

interface PaperOutcomeAnalyticsSuccessPayload {
  paperOnly: true;
  disclaimer: string;
  groupBy: PaperAnalyticsGroupBy;
  filters: PaperOutcomeAnalyticsFilters;
  supported: true;
  groups: PaperOutcomeAnalyticsGroup[];
  rankingSlices?: PaperOutcomeRankingSlices;
  backlogAging?: PaperOutcomeUnevaluatedBacklog;
}

interface PaperOutcomeAnalyticsUnsupportedPayload {
  paperOnly: true;
  disclaimer: string;
  groupBy: string;
  filters: PaperOutcomeAnalyticsFilters;
  supported: false;
  supportedGroupBy: readonly PaperAnalyticsGroupBy[];
  reason: string;
  groups: [];
}

export type PaperOutcomeAnalyticsResult =
  | PaperOutcomeAnalyticsSuccessPayload
  | PaperOutcomeAnalyticsUnsupportedPayload;

interface BuildInput {
  groupBy?: string;
  since?: string;
  until?: string;
  minEvaluations?: number;
  topN?: number;
  bottomN?: number;
  includeRankingSlices?: boolean;
  includeBacklogAging?: boolean;
}

const completedOutcome = new Set([
  "winner",
  "loser",
  "flat",
  "expired_worthless",
  "hit_stop",
  "hit_take_profit"
]);

const normalizeMinEvaluations = (value: number | undefined) => {
  const fallback = 1;
  if (value === undefined) {
    return fallback;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized) || Number.isNaN(normalized)) {
    return fallback;
  }

  return Math.max(0, Math.floor(normalized));
};

const normalizeTopBottom = (value: number | undefined) => {
  if (value === undefined) {
    return 0;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized) || Number.isNaN(normalized)) {
    return 0;
  }

  return Math.max(0, Math.floor(normalized));
};

const toNumber = (value: number | string | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isSupportedGroupBy = (value: string | undefined): value is PaperAnalyticsGroupBy =>
  typeof value === "string" &&
  SUPPORTED_ANALYTICS_GROUP_BY.includes(value as PaperAnalyticsGroupBy);

const normalizeIsoDate = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  const candidate = new Date(value);
  if (Number.isNaN(candidate.getTime())) {
    throw new Error("Invalid date filter. Use ISO date strings such as 2026-07-01.");
  }
  return candidate.toISOString();
};

const groupByRankBucket = (rank: number) => {
  if (rank <= 3) {
    return "top-1-3";
  }
  if (rank <= 6) {
    return "4-6";
  }
  if (rank <= 10) {
    return "7-10";
  }
  if (rank <= 20) {
    return "11-20";
  }
  return "21+";
};

const resolveGroupKey = (
  candidate: CandidateAnalyticsRow,
  groupBy: PaperAnalyticsGroupBy,
  latestEval: EvaluationAnalyticsRow | undefined
) => {
  if (groupBy === "symbol") {
    return candidate.symbol;
  }
  if (groupBy === "riskProfile") {
    return candidate.risk_profile;
  }
  if (groupBy === "optionsEnabled") {
    return candidate.options_enabled ? "options-aware" : "equity-only";
  }
  if (groupBy === "horizon") {
    return latestEval?.horizon ?? candidate.horizon;
  }
  if (groupBy === "rankBucket") {
    return groupByRankBucket(candidate.rank);
  }
  return candidate.preferred_expression;
};

const median = (values: number[]) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const classifyRecommendation = (
  group: Pick<
    PaperOutcomeAnalyticsGroup,
    "evaluatedCount" | "winRate" | "avgReturnPct"
  >,
  thresholds: typeof DEFAULT_ANALYTICS_THRESHOLDS
) => {
  if (
    group.evaluatedCount < thresholds.minEvaluationsForPromotion &&
    group.evaluatedCount < thresholds.minEvaluationsForDemotion
  ) {
    return "INSUFFICIENT_DATA";
  }

  if (
    group.evaluatedCount >= thresholds.minEvaluationsForPromotion &&
    group.winRate >= thresholds.minWinRateForPromotion &&
    group.avgReturnPct >= thresholds.minAvgReturnPctForPromotion
  ) {
    return "PROMOTE_FOR_MORE_PAPER_TESTING";
  }

  if (
    group.evaluatedCount >= thresholds.minEvaluationsForDemotion &&
    group.winRate <= thresholds.maxWinRateForDemotion &&
    group.avgReturnPct <= thresholds.maxAvgReturnPctForDemotion
  ) {
    return "DEMOTE_OR_EXCLUDE_FROM_NEXT_LOOP";
  }

  return "KEEP_MONITORING";
};

const latestEvaluationsQuery = (
  candidateIds: string[],
  filters: { since: string | null; until: string | null }
) => {
  if (!candidateIds.length) {
    return [] as EvaluationAnalyticsRow[];
  }

  const placeholders = candidateIds.map(() => "?").join(",");
  const clauses: string[] = [];
  const params: string[] = [...candidateIds];

  if (filters.since) {
    clauses.push("AND evaluated_at >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push("AND evaluated_at <= ?");
    params.push(filters.until);
  }

  const rows = queryAll<EvaluationAnalyticsRow>(
    `
    WITH filtered AS (
      SELECT candidate_id, horizon, return_pct, outcome, evaluated_at
      FROM paper_trade_evaluations
      WHERE candidate_id IN (${placeholders})
      ${clauses.join(" ")}
    ),
    latest AS (
      SELECT candidate_id, MAX(evaluated_at) AS latest_evaluated_at
      FROM filtered
      GROUP BY candidate_id
    )
    SELECT
      f.candidate_id,
      f.horizon,
      f.return_pct,
      f.outcome,
      f.evaluated_at
    FROM filtered f
    JOIN latest l
      ON l.candidate_id = f.candidate_id
      AND l.latest_evaluated_at = f.evaluated_at
    ORDER BY f.evaluated_at DESC
    `,
    params
  );

  return rows;
};

const buildLatestEvaluationByCandidate = (evaluations: EvaluationAnalyticsRow[]) => {
  const map = new Map<string, EvaluationAnalyticsRow>();
  for (const row of evaluations) {
    const current = map.get(row.candidate_id);
    if (!current || row.evaluated_at > current.evaluated_at) {
      map.set(row.candidate_id, row);
    }
  }
  return map;
};

const buildGroups = (
  groupBy: PaperAnalyticsGroupBy,
  candidates: CandidateAnalyticsRow[],
  latestEvaluationMap: Map<string, EvaluationAnalyticsRow>,
  minEvaluations: number
) => {
  const grouped = new Map<
    string,
    {
      candidateIds: Set<string>;
      ranks: number[];
      returns: number[];
    }
  >();

  for (const candidate of candidates) {
    const latestEval = latestEvaluationMap.get(candidate.id);
    const key = resolveGroupKey(candidate, groupBy, latestEval);
    const bucket = grouped.get(key) ?? {
      candidateIds: new Set<string>(),
      ranks: [],
      returns: []
    };

    bucket.candidateIds.add(candidate.id);
    bucket.ranks.push(candidate.rank);

    if (
      latestEval &&
      latestEval.return_pct !== null &&
      completedOutcome.has(latestEval.outcome)
    ) {
      bucket.returns.push(latestEval.return_pct);
    }

    grouped.set(key, bucket);
  }

  const outputGroups: PaperOutcomeAnalyticsGroup[] = [];

  for (const [key, bucket] of grouped.entries()) {
    const candidateCount = bucket.candidateIds.size;
    const evaluatedCount = bucket.returns.length;
    const unevaluatedCount = Math.max(0, candidateCount - evaluatedCount);
    const avgRank = bucket.ranks.length
      ? toNumber(bucket.ranks.reduce((sum, value) => sum + value, 0) / bucket.ranks.length)
      : 0;
    const avgReturnPct = bucket.returns.length
      ? toNumber(bucket.returns.reduce((sum, value) => sum + value, 0) / bucket.returns.length)
      : 0;
    const medianReturnPct = median(bucket.returns);
    const bestReturnPct = bucket.returns.length
      ? toNumber(Math.max(...bucket.returns))
      : 0;
    const worstReturnPct = bucket.returns.length
      ? toNumber(Math.min(...bucket.returns))
      : 0;
    const winRate = bucket.returns.length
      ? bucket.returns.filter((entry) => entry > 0).length / bucket.returns.length
      : 0;

    if (evaluatedCount < minEvaluations) {
      continue;
    }

    const recommendationFlag = classifyRecommendation(
      {
        evaluatedCount,
        winRate,
        avgReturnPct
      },
      DEFAULT_ANALYTICS_THRESHOLDS
    );

    outputGroups.push({
      key,
      candidateCount,
      evaluatedCount,
      unevaluatedCount,
      winRate,
      avgReturnPct,
      medianReturnPct,
      bestReturnPct,
      worstReturnPct,
      avgRank,
      recommendationFlag
    });
  }

  outputGroups.sort((left, right) => {
    if (right.avgReturnPct !== left.avgReturnPct) {
      return right.avgReturnPct - left.avgReturnPct;
    }
    if (right.winRate !== left.winRate) {
      return right.winRate - left.winRate;
    }
    return right.candidateCount - left.candidateCount;
  });

  return outputGroups;
};

const buildBucketValue = (metric: AnalyticsSliceMetric, group: PaperOutcomeAnalyticsGroup) => {
  if (metric === "candidateCount") {
    return group.candidateCount;
  }
  if (metric === "evaluatedCount") {
    return group.evaluatedCount;
  }
  if (metric === "winRate") {
    return group.winRate;
  }
  if (metric === "avgReturnPct") {
    return group.avgReturnPct;
  }
  if (metric === "medianReturnPct") {
    return group.medianReturnPct;
  }
  if (metric === "bestReturnPct") {
    return group.bestReturnPct;
  }
  if (metric === "worstReturnPct") {
    return group.worstReturnPct;
  }
  return group.avgRank;
};

const buildRankingSlices = (
  groups: PaperOutcomeAnalyticsGroup[],
  topN: number,
  bottomN: number
): PaperOutcomeRankingSlices => {
  const slices: PaperOutcomeRankingSlice[] = ANALYTICS_RANKING_SLICE_METRICS.map((metric) => {
    const allPoints = groups.map((group): PaperOutcomeRankingPoint => ({
      key: group.key,
      value: buildBucketValue(metric, group),
      recommendationFlag: group.recommendationFlag
    }));

    const top = [...allPoints]
      .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key))
      .slice(0, topN);
    const bottom = [...allPoints]
      .sort((left, right) => left.value - right.value || left.key.localeCompare(right.key))
      .slice(0, bottomN);

    return { metric, top, bottom };
  });

  return { topN, bottomN, slices };
};

const BACKLOG_BUCKETS = [
  "0-1 days",
  "2-3 days",
  "4-7 days",
  "8-14 days",
  "15-30 days",
  "31+ days"
] as const;

const backlogBucketForAgeInDays = (ageInDays: number) => {
  if (ageInDays <= 1) {
    return "0-1 days";
  }
  if (ageInDays <= 3) {
    return "2-3 days";
  }
  if (ageInDays <= 7) {
    return "4-7 days";
  }
  if (ageInDays <= 14) {
    return "8-14 days";
  }
  if (ageInDays <= 30) {
    return "15-30 days";
  }
  return "31+ days";
};

const buildUnevaluatedBacklogAging = (
  candidates: CandidateAnalyticsRow[],
  latestEvaluationMap: Map<string, EvaluationAnalyticsRow>,
  asOf: string
): PaperOutcomeUnevaluatedBacklog => {
  const bucketCounts: Record<string, number> = {};
  for (const bucket of BACKLOG_BUCKETS) {
    bucketCounts[bucket] = 0;
  }

  const asOfTime = new Date(asOf).getTime();
  if (Number.isNaN(asOfTime)) {
    return {
      asOf,
      totalUnevaluated: 0,
      buckets: BACKLOG_BUCKETS.map((bucket) => ({ bucket, count: 0 }))
    };
  }

  let totalUnevaluated = 0;
  for (const candidate of candidates) {
    if (latestEvaluationMap.has(candidate.id)) {
      continue;
    }

    const candidateAsOf = new Date(candidate.as_of).getTime();
    if (Number.isNaN(candidateAsOf)) {
      continue;
    }

    const ageInDays = Math.max(
      0,
      Math.floor((asOfTime - candidateAsOf) / (24 * 60 * 60 * 1000))
    );
    const bucket = backlogBucketForAgeInDays(ageInDays);
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
    totalUnevaluated += 1;
  }

  return {
    asOf,
    totalUnevaluated,
    buckets: BACKLOG_BUCKETS.map((bucket) => ({
      bucket,
      count: bucketCounts[bucket] ?? 0
    }))
  };
};

const createSnapshotRunId = () =>
  `paper-analytics-${new Date().toISOString()}`;

export interface RecommendationSnapshotInput {
  result: PaperOutcomeAnalyticsSuccessPayload;
  snapshotRunId?: string;
  source?: string;
}

export interface RecommendationSnapshotResult {
  snapshotRunId: string;
  persistedCount: number;
}

export const persistRecommendationSnapshots = (
  input: RecommendationSnapshotInput
): RecommendationSnapshotResult => {
  if (!input.result.supported || input.result.groups.length === 0) {
    return {
      snapshotRunId: input.snapshotRunId ?? createSnapshotRunId(),
      persistedCount: 0
    };
  }

  const snapshotRunId = input.snapshotRunId ?? createSnapshotRunId();
  const source = input.source || PAPER_RECOMMENDATION_SNAPSHOT_SOURCE_PAPER_ANALYTICS;
  const now = new Date().toISOString();
  const filtersJson = JSON.stringify({
    groupBy: input.result.groupBy,
    filters: input.result.filters
  });
  const statement = getDb().prepare(
    `
    INSERT INTO paper_recommendation_snapshots(
      snapshot_run_id,
      created_at,
      source,
      group_by,
      group_key,
      filters_json,
      candidate_count,
      evaluated_count,
      unevaluated_count,
      win_rate,
      avg_return_pct,
      median_return_pct,
      best_return_pct,
      worst_return_pct,
      avg_rank,
      recommendation_flag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  let persistedCount = 0;
  for (const row of input.result.groups) {
    statement.run(
      snapshotRunId,
      now,
      source,
      input.result.groupBy,
      row.key,
      filtersJson,
      row.candidateCount,
      row.evaluatedCount,
      row.unevaluatedCount,
      row.winRate,
      row.avgReturnPct,
      row.medianReturnPct,
      row.bestReturnPct,
      row.worstReturnPct,
      row.avgRank,
      row.recommendationFlag
    );
    persistedCount += 1;
  }

  return { snapshotRunId, persistedCount };
};

export const buildPaperOutcomeAnalytics = (
  input: BuildInput = {}
): PaperOutcomeAnalyticsResult => {
  const requestedGroupBy = input.groupBy ?? "symbol";
  if (!isSupportedGroupBy(requestedGroupBy)) {
    return {
      paperOnly: true,
      disclaimer: PAPER_OUTCOME_ANALYTICS_DISCLAIMER,
      groupBy: requestedGroupBy,
      filters: {
        since: input.since ?? null,
        until: input.until ?? null,
        minEvaluations: normalizeMinEvaluations(input.minEvaluations)
      },
      supported: false,
      supportedGroupBy: SUPPORTED_ANALYTICS_GROUP_BY,
      reason: `Unsupported groupBy value: ${requestedGroupBy}`,
      groups: []
    };
  }

  const groupBy = requestedGroupBy;
  const since = normalizeIsoDate(input.since);
  const until = normalizeIsoDate(input.until);
  const minEvaluations = normalizeMinEvaluations(input.minEvaluations);
  const topN = normalizeTopBottom(input.topN);
  const bottomN = normalizeTopBottom(input.bottomN);
  const includeRankingSlices = input.includeRankingSlices && (topN > 0 || bottomN > 0);
  const includeBacklogAging = input.includeBacklogAging !== false;

  const clauses: string[] = ["c.decision = 'selected'"];
  const params: string[] = [];
  if (since) {
    clauses.push("r.started_at >= ?");
    params.push(since);
  }
  if (until) {
    clauses.push("r.started_at <= ?");
    params.push(until);
  }

  const runFilter = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const candidates = queryAll<CandidateAnalyticsRow>(
    `
    SELECT
      c.id,
      c.symbol,
      c.risk_profile,
      r.options_enabled,
      c.rank,
      c.preferred_expression,
      c.horizon,
      c.as_of
    FROM paper_trade_candidates c
    JOIN research_runs r ON r.id = c.research_run_id
    ${runFilter}
    ORDER BY c.id
    `,
    params
  );

  if (!candidates.length) {
    const filters = {
      since,
      until,
      minEvaluations
    };
    return {
      paperOnly: true,
      disclaimer: PAPER_OUTCOME_ANALYTICS_DISCLAIMER,
      groupBy,
      filters,
      supported: true,
      groups: [],
      rankingSlices: includeRankingSlices
        ? {
            topN,
            bottomN,
            slices: []
          }
        : undefined,
      backlogAging: includeBacklogAging
        ? {
            asOf: until ?? new Date().toISOString(),
            totalUnevaluated: 0,
            buckets: BACKLOG_BUCKETS.map((bucket) => ({
              bucket,
              count: 0
            }))
          }
        : undefined
    };
  }

  const evaluations = latestEvaluationsQuery(
    candidates.map((candidate) => candidate.id),
    { since, until }
  );
  const evaluationByCandidate = buildLatestEvaluationByCandidate(evaluations);
  const groups = buildGroups(groupBy, candidates, evaluationByCandidate, minEvaluations);
  const rankingSlices = includeRankingSlices
    ? buildRankingSlices(groups, topN, bottomN)
    : undefined;
  const backlogAging = includeBacklogAging
    ? buildUnevaluatedBacklogAging(
        candidates,
        evaluationByCandidate,
        until ?? new Date().toISOString()
      )
    : undefined;

  return {
    paperOnly: true,
    disclaimer: PAPER_OUTCOME_ANALYTICS_DISCLAIMER,
    groupBy,
    filters: {
      since,
      until,
      minEvaluations
    },
    supported: true,
    groups,
    rankingSlices,
    backlogAging
  };
};

const formatNumber = (value: number) => value.toFixed(2);
const formatPercent = (value: number) => `${formatNumber(value * 100)}%`;

const formatSliceMetricValue = (metric: AnalyticsSliceMetric, value: number) => {
  if (metric === "winRate") {
    return formatPercent(value);
  }
  if (
    metric === "avgReturnPct" ||
    metric === "medianReturnPct" ||
    metric === "bestReturnPct" ||
    metric === "worstReturnPct"
  ) {
    return `${formatNumber(value)}%`;
  }
  if (metric === "avgRank") {
    return formatNumber(value);
  }
  return String(value);
};

export const formatPaperOutcomeAnalyticsTable = (result: PaperOutcomeAnalyticsResult): string => {
  if (result.supported === false) {
    return [
      "PAPER OUTCOME ANALYTICS",
      result.disclaimer,
      "",
      `Unsupported groupBy: ${result.groupBy}`,
      `Supported: ${result.supportedGroupBy.join(", ")}`,
      ""
    ].join("\n");
  }

  const lines: string[] = [
    "PAPER OUTCOME ANALYTICS",
    result.disclaimer,
    `Group by: ${result.groupBy}`,
    ""
  ];

  if (!result.groups.length) {
    lines.push("No analytics groups met the configured criteria.");
    if (result.backlogAging) {
      lines.push(`Unevaluated backlog aging (as of ${result.backlogAging.asOf}):`);
      lines.push(`Total unevaluated: ${result.backlogAging.totalUnevaluated}`);
      for (const bucket of result.backlogAging.buckets) {
        lines.push(`  ${bucket.bucket}: ${bucket.count}`);
      }
    }
    return lines.join("\n");
  }

  const headers = [
    "Key",
    "Evaluated",
    "Win Rate",
    "Avg Return",
    "Median",
    "Best",
    "Worst",
    "Flag"
  ];
  const widths = headers.map((entry) => entry.length);
  const rows = result.groups.map((group) => [
    group.key,
    String(group.evaluatedCount),
    formatPercent(group.winRate),
    `${formatNumber(group.avgReturnPct)}%`,
    `${formatNumber(group.medianReturnPct)}%`,
    `${formatNumber(group.bestReturnPct)}%`,
    `${formatNumber(group.worstReturnPct)}%`,
    group.recommendationFlag
  ]);

  rows.forEach((row) =>
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], cell.length);
    })
  );

  const formatRow = (cells: string[]) =>
    cells
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index])
      )
      .join("  ");

  lines.push(formatRow(headers));
  lines.push(widths.map((count) => "-".repeat(count)).join("  "));
  rows.forEach((row) => lines.push(formatRow(row)));

  if (result.rankingSlices && (result.rankingSlices.topN > 0 || result.rankingSlices.bottomN > 0)) {
    lines.push("");
    lines.push(`Ranking slices (top=${result.rankingSlices.topN}, bottom=${result.rankingSlices.bottomN})`);
    for (const slice of result.rankingSlices.slices) {
      lines.push(`Top by ${slice.metric}:`);
      if (!slice.top.length) {
        lines.push("  No data");
      } else {
        slice.top.forEach((entry, index) => {
          lines.push(
            `  ${index + 1}. ${entry.key} | ${formatSliceMetricValue(slice.metric, entry.value)} | ${entry.recommendationFlag}`
          );
        });
      }
      lines.push(`Bottom by ${slice.metric}:`);
      if (!slice.bottom.length) {
        lines.push("  No data");
      } else {
        slice.bottom.forEach((entry, index) => {
          lines.push(
            `  ${index + 1}. ${entry.key} | ${formatSliceMetricValue(slice.metric, entry.value)} | ${entry.recommendationFlag}`
          );
        });
      }
    }
  }

  if (result.backlogAging) {
    lines.push("");
    lines.push(`Unevaluated backlog aging (as of ${result.backlogAging.asOf}):`);
    lines.push(`Total unevaluated: ${result.backlogAging.totalUnevaluated}`);
    for (const bucket of result.backlogAging.buckets) {
      lines.push(`  ${bucket.bucket}: ${bucket.count}`);
    }
  }

  return lines.join("\n");
};
