import { queryAll } from "../lib/db.js";
import { getTradingSafetyState, type TradingSafetyState } from "./tradingSafetyService.js";

export type PaperTrendType = "new" | "persistent" | "fading" | "inactive";

export interface PaperTrendRecord {
  symbol: string;
  appearances: number;
  firstSeen: string;
  lastSeen: string;
  latestRank: number | null;
  bestRank: number | null;
  averageRank: number | null;
  trend: PaperTrendType;
  riskProfiles: string[];
  optionsEnabledModes: boolean[];
}

export interface PaperTrendsQueryInput {
  symbol?: string;
  riskProfile?: string;
  optionsEnabled?: boolean;
  from?: string;
  to?: string;
  limit?: number;
}

export interface PaperTrendsReport {
  paperOnly: true;
  environment: TradingSafetyState["alpacaEnv"];
  filters: {
    symbol?: string;
    riskProfile?: string;
    optionsEnabled?: boolean;
    from?: string;
    to?: string;
    limit?: number;
  };
  trends: PaperTrendRecord[];
}

interface SnapshotRow {
  id: number;
  snapshot_run_id: string;
  created_at: string;
  group_key: string;
  avg_rank: number;
}

interface SnapshotMetaRow {
  snapshot_run_id: string;
  group_by: string;
  group_key: string;
}

const KNOWN_SNAPSHOT_SOURCE_OPTIONS = [
  "options-aware",
  "equity-only"
];

const optionsFilterValue = (value: boolean) =>
  value ? KNOWN_SNAPSHOT_SOURCE_OPTIONS[0] : KNOWN_SNAPSHOT_SOURCE_OPTIONS[1];

const normalizeLimit = (value: number | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.max(1, Math.floor(parsed));
};

const normalizeIsoDate = (value?: string, isEnd = false) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Date filter cannot be empty.");
  }
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const parsed = isDateOnly
    ? new Date(`${trimmed}T00:00:00.000Z`)
    : new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date filter '${trimmed}'. Use YYYY-MM-DD or ISO date strings.`);
  }
  if (isDateOnly && isEnd) {
    parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed.toISOString();
};

const assertValidDateRange = (from?: string | null, to?: string | null) => {
  if (!from || !to) {
    return;
  }
  if (new Date(from).getTime() > new Date(to).getTime()) {
    throw new Error("Date range is invalid: --from must be before --to.");
  }
};

const safeRank = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Number(value);
};

const toNumber = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Number(value);
};

const sortByCreatedAtDesc = (rows: SnapshotRow[]) =>
  [...rows].sort((left, right) =>
    new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );

const sortByCreatedAtAsc = (rows: SnapshotRow[]) =>
  [...rows].sort((left, right) =>
    new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );

const asSet = <T>(rows: T[]) => new Set(rows);

const buildRecentRunIds = (rows: SnapshotRow[], limit: number) => {
  const set = new Set<string>();
  const out: string[] = [];
  const cap = normalizeLimit(limit);
  for (const row of sortByCreatedAtDesc(rows)) {
    if (set.has(row.snapshot_run_id)) {
      continue;
    }
    set.add(row.snapshot_run_id);
    out.push(row.snapshot_run_id);
    if (out.length >= Math.min(3, cap)) {
      break;
    }
  }
  return out;
};

const mapRowsBySymbol = (rows: SnapshotRow[]) => {
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const symbol = row.group_key;
    const existing = grouped.get(symbol) || [];
    existing.push(row);
    grouped.set(symbol, existing);
  }

  const sorted: Record<string, SnapshotRow[]> = {};
  for (const [symbol, groupedRows] of grouped.entries()) {
    sorted[symbol] = sortByCreatedAtDesc(groupedRows);
  }
  return sorted;
};

const buildMetadataByRun = (runIds: string[]) => {
  if (!runIds.length) {
    return { riskProfiles: new Map<string, Set<string>>(), optionsEnabledModes: new Map<string, Set<boolean>>() };
  }

  const metaRows = queryAll<SnapshotMetaRow>(
    `
    SELECT snapshot_run_id, group_by, group_key
    FROM paper_recommendation_snapshots
    WHERE snapshot_run_id IN (${runIds.map(() => "?").join(",")})
      AND group_by IN ('riskProfile', 'optionsEnabled')
  `,
    runIds
  );

  const riskProfiles = new Map<string, Set<string>>();
  const optionsEnabledModes = new Map<string, Set<boolean>>();

  for (const row of metaRows) {
    if (row.group_by === "riskProfile") {
      const list = riskProfiles.get(row.snapshot_run_id) || new Set<string>();
      list.add(row.group_key);
      riskProfiles.set(row.snapshot_run_id, list);
      continue;
    }
    if (row.group_by === "optionsEnabled") {
      const value = row.group_key === KNOWN_SNAPSHOT_SOURCE_OPTIONS[0];
      const set = optionsEnabledModes.get(row.snapshot_run_id) || new Set<boolean>();
      set.add(value);
      optionsEnabledModes.set(row.snapshot_run_id, set);
    }
  }

  return { riskProfiles, optionsEnabledModes };
};

const buildSymbolTrend = (
  symbol: string,
  filteredRows: SnapshotRow[],
  allRows: SnapshotRow[],
  riskByRun: Map<string, Set<string>>,
  optionsByRun: Map<string, Set<boolean>>,
  recentRunIds: string[]
): PaperTrendRecord => {
  const rows = filteredRows;
  const historyRows = allRows;
  const recentSet = new Set(recentRunIds);
  const inRecentRows = rows.filter((row) => recentSet.has(row.snapshot_run_id));
  const appearedOutsideRecentWindow = allRows.some(
    (row) => !recentSet.has(row.snapshot_run_id)
  );
  const inAnyRecentRun = inRecentRows.length > 0;

  let trend: PaperTrendType;

  if (!inAnyRecentRun) {
    trend = "inactive";
  } else if (!appearedOutsideRecentWindow) {
    trend = "new";
  } else if (inRecentRows.length >= 2) {
    trend = "persistent";
  } else {
    trend = "fading";
  }

  if (!rows.length) {
    trend = "inactive";
  }

  const historyRanks = rows.length
    ? rows.map((row) => safeRank(row.avg_rank)).filter((rank): rank is number => rank !== null)
    : allRows
      .map((row) => safeRank(row.avg_rank))
      .filter((rank): rank is number => rank !== null);

  const latestRank = historyRows[0] ? safeRank(historyRows[0].avg_rank) : null;
  const bestRank = historyRanks.length
    ? Math.min(...historyRanks)
    : null;
  const averageRank = historyRanks.length
    ? historyRanks.reduce((sum, rank) => sum + rank, 0) / historyRanks.length
    : null;
  const seenRunIds = asSet((allRows.length ? allRows : rows).map((row) => row.snapshot_run_id));
  const uniqueRiskProfiles = new Set<string>();
  const uniqueOptions = new Set<boolean>();

  seenRunIds.forEach((runId) => {
    const rp = riskByRun.get(runId);
    rp?.forEach((entry) => uniqueRiskProfiles.add(entry));

    const op = optionsByRun.get(runId);
    op?.forEach((entry) => uniqueOptions.add(entry));
  });

  const allSeen = allRows.length ? allRows : rows;
  const sortedHistory = sortByCreatedAtAsc(allSeen);

  return {
    symbol,
    appearances: allSeen.length,
    firstSeen: sortedHistory[0]?.created_at || "",
    lastSeen: sortedHistory[sortedHistory.length - 1]?.created_at || "",
    latestRank,
    bestRank,
    averageRank,
    trend,
    riskProfiles: [...uniqueRiskProfiles].sort(),
    optionsEnabledModes: [...uniqueOptions].sort((left, right) => Number(left) - Number(right))
  };
};

export const queryPaperRecommendationTrends = (input: PaperTrendsQueryInput = {}): PaperTrendRecord[] => {
  const limit = normalizeLimit(input.limit);
  const filteredClauses: string[] = ["group_by = 'symbol'"];
  const allClauses: string[] = ["group_by = 'symbol'"];
  const params: Array<string | number> = [];
  const allParams: Array<string | number> = [];
  const from = normalizeIsoDate(input.from);
  const to = normalizeIsoDate(input.to, true);

  assertValidDateRange(from, to);

  if (input.symbol) {
    filteredClauses.push("group_key = ?");
    params.push(input.symbol);

    allClauses.push("group_key = ?");
    allParams.push(input.symbol);
  }

  if (input.riskProfile) {
    filteredClauses.push(
      "snapshot_run_id IN (SELECT DISTINCT snapshot_run_id FROM paper_recommendation_snapshots WHERE group_by = 'riskProfile' AND group_key = ?)"
    );
    params.push(input.riskProfile);

    allClauses.push(
      "snapshot_run_id IN (SELECT DISTINCT snapshot_run_id FROM paper_recommendation_snapshots WHERE group_by = 'riskProfile' AND group_key = ?)"
    );
    allParams.push(input.riskProfile);
  }

  if (input.optionsEnabled !== undefined) {
    filteredClauses.push(
      "snapshot_run_id IN (SELECT DISTINCT snapshot_run_id FROM paper_recommendation_snapshots WHERE group_by = 'optionsEnabled' AND group_key = ?)"
    );
    params.push(optionsFilterValue(input.optionsEnabled));

    allClauses.push(
      "snapshot_run_id IN (SELECT DISTINCT snapshot_run_id FROM paper_recommendation_snapshots WHERE group_by = 'optionsEnabled' AND group_key = ?)"
    );
    allParams.push(optionsFilterValue(input.optionsEnabled));
  }

  if (from) {
    filteredClauses.push("created_at >= ?");
    params.push(from);
  }

  if (to) {
    filteredClauses.push("created_at <= ?");
    params.push(to);
  }

  const filteredWhere = filteredClauses.length
    ? `WHERE ${filteredClauses.join(" AND ")}`
    : "";

  const allWhere = allClauses.length ? `WHERE ${allClauses.join(" AND ")}` : "";

  const filtered = queryAll<SnapshotRow>(
    `
    SELECT id, snapshot_run_id, created_at, group_key, avg_rank
    FROM paper_recommendation_snapshots
    ${filteredWhere}
    ORDER BY created_at DESC
  `,
    params
  );

  const allRows = queryAll<SnapshotRow>(
    `
    SELECT id, snapshot_run_id, created_at, group_key, avg_rank
    FROM paper_recommendation_snapshots
    ${allWhere}
    ORDER BY created_at DESC
  `,
    allParams
  );

  const bySymbolFiltered = mapRowsBySymbol(filtered);
  const bySymbolAll = mapRowsBySymbol(allRows);

  const recentRunIds = buildRecentRunIds(filtered, limit);
  const allRunIds = [...new Set(allRows.map((row) => row.snapshot_run_id))];
  const { riskProfiles, optionsEnabledModes } = buildMetadataByRun(allRunIds);

  const symbols = new Set<string>([
    ...Object.keys(bySymbolFiltered),
    ...input.symbol ? [input.symbol] : []
  ]);

  const output: PaperTrendRecord[] = [];

  for (const symbol of symbols) {
    const symbolFiltered = bySymbolFiltered[symbol] || [];
    const symbolAll = bySymbolAll[symbol] || [];

    if (!symbolFiltered.length && !symbolAll.length) {
      continue;
    }

    output.push(
      buildSymbolTrend(
        symbol,
        symbolFiltered,
        symbolAll,
        riskProfiles,
        optionsEnabledModes,
        recentRunIds
      )
    );
  }

  output.sort((left, right) => {
    const leftCount = left.appearances;
    const rightCount = right.appearances;
    if (rightCount !== leftCount) {
      return rightCount - leftCount;
    }
    return (left.averageRank ?? Number.MAX_SAFE_INTEGER) - (right.averageRank ?? Number.MAX_SAFE_INTEGER);
  });

  return output.slice(0, limit);
};

const padCell = (value: string, width: number, alignRight = false) => {
  const text = value ?? "";
  return alignRight ? text.padStart(width, " ") : text.padEnd(width, " ");
};

export const formatPaperRecommendationTrendsAsTable = (trends: PaperTrendRecord[]) => {
  if (!trends.length) {
    return "No trend data found for the selected filters.";
  }

  const lines: string[] = [];
  lines.push("Paper Recommendation Trends");
  const header = [
    padCell("Symbol", 8),
    padCell("Appear", 8, true),
    padCell("First Seen", 22),
    padCell("Last Seen", 22),
    padCell("Latest", 8, true),
    padCell("Best", 8, true),
    padCell("Avg", 8, true),
    padCell("Trend", 12),
    padCell("Risk Profiles", 16),
    padCell("Options", 12)
  ].join(" ");
  lines.push(header);

  for (const trend of trends) {
    const riskProfiles = trend.riskProfiles.join(",");
    const optionsEnabled = trend.optionsEnabledModes.map((mode) => (mode ? "true" : "false")).join(",");
    lines.push([
      padCell(trend.symbol, 8),
      padCell(String(trend.appearances), 8, true),
      padCell(trend.firstSeen, 22),
      padCell(trend.lastSeen, 22),
      padCell(toNumber(trend.latestRank)?.toFixed(2) ?? "", 8, true),
      padCell(toNumber(trend.bestRank)?.toFixed(2) ?? "", 8, true),
      padCell(toNumber(trend.averageRank)?.toFixed(2) ?? "", 8, true),
      padCell(trend.trend, 12),
      padCell(riskProfiles, 16),
      padCell(optionsEnabled, 12)
    ].join(" "));
  }

  return lines.join("\n");
};

export const buildPaperRecommendationTrends = (input: PaperTrendsQueryInput = {}): PaperTrendsReport => {
  const limit = normalizeLimit(input.limit);
  const trends = queryPaperRecommendationTrends({
    ...input,
    limit
  });

  return {
    paperOnly: true,
    environment: getTradingSafetyState().alpacaEnv,
    filters: {
      symbol: input.symbol,
      riskProfile: input.riskProfile,
      optionsEnabled: input.optionsEnabled,
      from: input.from,
      to: input.to,
      limit
    },
    trends
  };
};
