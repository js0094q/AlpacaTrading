import { queryAll } from "../lib/db.js";

const KNOWN_SNAPSHOT_SOURCE_OPTIONS = [
  "options-aware",
  "equity-only"
];

type SnapshotDateFilter = string | undefined;

export interface PaperSnapshotMetadata {
  candidateCount: number;
  evaluatedCount: number;
  unevaluatedCount: number;
  winRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  bestReturnPct: number;
  worstReturnPct: number;
  recommendationFlag: string;
}

export interface PaperRecommendationSnapshotHistoryRecord {
  snapshotId: number;
  snapshotRunId: string;
  snapshotSource: string;
  createdAt: string;
  symbol?: string;
  riskProfile?: string;
  optionsEnabled?: boolean;
  rank?: number;
  score?: number;
  horizon?: string;
  candidateMetadata: PaperSnapshotMetadata;
}

export interface PaperRecommendationSnapshotQueryInput {
  runId?: string;
  source?: string;
  symbol?: string;
  riskProfile?: string;
  optionsEnabled?: boolean;
  from?: SnapshotDateFilter;
  to?: SnapshotDateFilter;
  limit?: number;
}

interface SnapshotRow {
  id: number;
  snapshot_run_id: string;
  created_at: string;
  source: string;
  group_by: string;
  group_key: string;
  candidate_count: number;
  evaluated_count: number;
  unevaluated_count: number;
  win_rate: number;
  avg_return_pct: number;
  median_return_pct: number;
  best_return_pct: number;
  worst_return_pct: number;
  avg_rank: number;
  recommendation_flag: string;
}

const toNumber = (value: number | null | undefined): number =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

const normalizeSnapshotLimit = (value: number | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.max(1, Math.floor(parsed));
};

const toIsoDateFilter = (rawValue: string, isEnd = false) => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Date filter cannot be empty.");
  }

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const date = isDateOnly
    ? new Date(`${trimmed}T00:00:00.000Z`)
    : new Date(trimmed);

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid date filter '${trimmed}'. Use YYYY-MM-DD or ISO date strings.`
    );
  }

  if (isDateOnly && isEnd) {
    date.setUTCHours(23, 59, 59, 999);
  }

  return date.toISOString();
};

const optionsFilterValue = (value: boolean) =>
  value ? KNOWN_SNAPSHOT_SOURCE_OPTIONS[0] : KNOWN_SNAPSHOT_SOURCE_OPTIONS[1];

const deriveDimensions = (
  row: SnapshotRow
): Pick<
  PaperRecommendationSnapshotHistoryRecord,
  "symbol" | "riskProfile" | "optionsEnabled" | "horizon"
> => {
  if (row.group_by === "symbol") {
    return { symbol: row.group_key };
  }
  if (row.group_by === "riskProfile") {
    return { riskProfile: row.group_key };
  }
  if (row.group_by === "optionsEnabled") {
    return {
      optionsEnabled: row.group_key === KNOWN_SNAPSHOT_SOURCE_OPTIONS[0]
    };
  }
  if (row.group_by === "horizon") {
    return { horizon: row.group_key };
  }
  return {};
};

const buildCandidateMetadata = (row: SnapshotRow): PaperSnapshotMetadata => ({
  candidateCount: toNumber(row.candidate_count),
  evaluatedCount: toNumber(row.evaluated_count),
  unevaluatedCount: toNumber(row.unevaluated_count),
  winRate: toNumber(row.win_rate),
  avgReturnPct: toNumber(row.avg_return_pct),
  medianReturnPct: toNumber(row.median_return_pct),
  bestReturnPct: toNumber(row.best_return_pct),
  worstReturnPct: toNumber(row.worst_return_pct),
  recommendationFlag: row.recommendation_flag
});

const mapSnapshotRow = (
  row: SnapshotRow
): PaperRecommendationSnapshotHistoryRecord => {
  const dimensions = deriveDimensions(row);
  return {
    snapshotId: row.id,
    snapshotRunId: row.snapshot_run_id,
    snapshotSource: row.source,
    createdAt: row.created_at,
    ...dimensions,
    rank: toNumber(row.avg_rank),
    score: toNumber(row.avg_return_pct),
    candidateMetadata: buildCandidateMetadata(row)
  };
};

export const listPaperRecommendationSnapshots = (
  input: PaperRecommendationSnapshotQueryInput = {}
): PaperRecommendationSnapshotHistoryRecord[] => {
  const limit = normalizeSnapshotLimit(input.limit);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const runFilters: string[] = [];
  const runFilterParams: Array<string | number> = [];

  if (input.runId) {
    clauses.push("snapshot_run_id = ?");
    params.push(input.runId);
  }

  if (input.source) {
    clauses.push("source = ?");
    params.push(input.source);
  }

  if (input.symbol) {
    clauses.push("group_by = 'symbol' AND group_key = ?");
    params.push(input.symbol);
  }

  if (input.riskProfile) {
    runFilters.push(
      "snapshot_run_id IN (SELECT DISTINCT snapshot_run_id FROM paper_recommendation_snapshots WHERE group_by = 'riskProfile' AND group_key = ?)"
    );
    runFilterParams.push(input.riskProfile);
  }

  if (input.optionsEnabled !== undefined) {
    runFilters.push(
      "snapshot_run_id IN (SELECT DISTINCT snapshot_run_id FROM paper_recommendation_snapshots WHERE group_by = 'optionsEnabled' AND group_key = ?)"
    );
    runFilterParams.push(optionsFilterValue(input.optionsEnabled));
  }

  if (runFilters.length) {
    clauses.push(...runFilters);
    params.push(...runFilterParams);
  }

  if (input.from) {
    clauses.push("created_at >= ?");
    params.push(toIsoDateFilter(input.from));
  }

  if (input.to) {
    clauses.push("created_at <= ?");
    params.push(toIsoDateFilter(input.to, true));
  }

  if (input.to && input.from) {
    const from = toIsoDateFilter(input.from);
    const to = toIsoDateFilter(input.to, true);
    if (new Date(from).getTime() > new Date(to).getTime()) {
      throw new Error("Date range is invalid: --from must be before --to.");
    }
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = queryAll<SnapshotRow>(
    `
    SELECT
      id,
      snapshot_run_id,
      created_at,
      source,
      group_by,
      group_key,
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
    FROM paper_recommendation_snapshots
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `,
    params
  );

  return rows.map(mapSnapshotRow);
};

const padCell = (value: string, width: number, alignRight = false) => {
  const text = value ?? "";
  return alignRight ? text.padStart(width, " ") : text.padEnd(width, " ");
};

export const formatPaperRecommendationSnapshotsAsTable = (
  rows: PaperRecommendationSnapshotHistoryRecord[]
) => {
  if (!rows.length) {
    return "No persisted recommendation snapshots found.";
  }

  const lines: string[] = [];
  lines.push("Paper Recommendation Snapshot History");
  const header = [
    padCell("Snapshot ID", 11),
    padCell("Run ID", 24),
    padCell("Source", 12),
    padCell("Symbol", 8),
    padCell("Risk", 10),
    padCell("Options", 8),
    padCell("Horizon", 10),
    padCell("Rank", 8, true),
    padCell("Score", 9, true),
    padCell("Cand.", 8, true),
    padCell("Win%", 8, true),
    padCell("AvgRet%", 10, true),
    padCell("Flag", 32),
    padCell("Created At", 24)
  ].join(" ");
  lines.push(header);

  for (const row of rows) {
    const symbol = row.symbol ?? "";
    const riskProfile = row.riskProfile ?? "";
    const optionsEnabled = row.optionsEnabled === undefined
      ? ""
      : row.optionsEnabled
        ? "true"
        : "false";
    const horizon = row.horizon ?? "";
    const rank = row.rank === undefined ? "" : row.rank.toFixed(2);
    const score = row.score === undefined ? "" : row.score.toFixed(2);
    const candidates = String(row.candidateMetadata.candidateCount);
    const winRate = `${(row.candidateMetadata.winRate * 100).toFixed(1)}%`;
    const avgReturn = `${row.candidateMetadata.avgReturnPct.toFixed(2)}%`;
    const flag = row.candidateMetadata.recommendationFlag;

    lines.push([
      padCell(String(row.snapshotId), 11),
      padCell(row.snapshotRunId, 24),
      padCell(row.snapshotSource, 12),
      padCell(symbol, 8),
      padCell(riskProfile, 10),
      padCell(optionsEnabled, 8),
      padCell(horizon, 10),
      padCell(rank, 8, true),
      padCell(score, 9, true),
      padCell(candidates, 8, true),
      padCell(winRate, 8, true),
      padCell(avgReturn, 10, true),
      padCell(flag, 32),
      padCell(row.createdAt, 24)
    ].join(" "));
  }

  return lines.join("\n");
};
