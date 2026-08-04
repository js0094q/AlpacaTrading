import {
  runPostgresPortfolioGreekReview,
  type PostgresPortfolioRiskQuery
} from "./postgresPortfolioRiskService.js";

const OPEN_LEAPS_REVIEW_SQL = `SELECT signal.id AS signal_id,
       signal.position_id, signal.option_symbol, signal.action,
       signal.suggested_quantity::text, signal.reasons, signal.evidence,
       signal.first_observed_at, signal.last_observed_at,
       signal.occurrences::text,
       (COUNT(*) OVER())::text AS total_open_count
FROM position_review_signals signal
WHERE signal.account_id = $1
  AND signal.status = 'open'
ORDER BY signal.last_observed_at DESC, signal.id
LIMIT $2`;

type OpenLeapsReviewRow = {
  signal_id: unknown;
  position_id: unknown;
  option_symbol: unknown;
  action: unknown;
  suggested_quantity: unknown;
  reasons: unknown;
  evidence: unknown;
  first_observed_at: unknown;
  last_observed_at: unknown;
  occurrences: unknown;
  total_open_count: unknown;
};

const textValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const numberValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isoValue = (value: unknown) => {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const objectValue = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const reasonsValue = (value: unknown) => {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return [];
        }
      })()
    : value;
  return Array.isArray(parsed)
    ? parsed.map(textValue).filter((reason): reason is string => reason !== null)
    : [];
};

const normalizeSignal = (row: OpenLeapsReviewRow) => {
  const evidence = objectValue(row.evidence);
  return {
    signalId: textValue(row.signal_id),
    positionId: textValue(row.position_id),
    optionSymbol: textValue(row.option_symbol),
    action: textValue(row.action),
    suggestedQuantity: numberValue(row.suggested_quantity),
    reasons: reasonsValue(row.reasons),
    firstObservedAt: isoValue(row.first_observed_at),
    lastObservedAt: isoValue(row.last_observed_at),
    occurrences: numberValue(row.occurrences),
    marketTimestamp: isoValue(evidence.marketTimestamp),
    directionalReturnPct: numberValue(evidence.directionalReturnPct),
    currentDte: numberValue(evidence.currentDte),
    observedPrice: numberValue(evidence.observedPrice),
    greeks: {
      delta: numberValue(evidence.delta),
      gamma: numberValue(evidence.gamma),
      theta: numberValue(evidence.theta),
      vega: numberValue(evidence.vega),
      rho: numberValue(evidence.rho)
    }
  };
};

export const readPostgresDashboardRisk = async (input: {
  readonly query: PostgresPortfolioRiskQuery;
  readonly now?: Date;
  readonly limit?: number;
}) => {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("POSTGRES_DASHBOARD_RISK_TIME_INVALID");
  const requestedLimit = input.limit ?? 25;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
    : 25;
  const portfolioReview = await runPostgresPortfolioGreekReview({
    command: "hedge:review",
    cycleId: `dashboard-risk-${now.toISOString()}`,
    query: input.query,
    now
  });
  const signalResult = await input.query.query(
    OPEN_LEAPS_REVIEW_SQL,
    [portfolioReview.accountId, limit]
  );
  const openLeapsReviewSignals = signalResult.rows.map((row) =>
    normalizeSignal(row as OpenLeapsReviewRow)
  );
  const reportedOpenCount = numberValue(
    (signalResult.rows[0] as OpenLeapsReviewRow | undefined)?.total_open_count
  );
  const openLeapsReviewCount = reportedOpenCount !== null &&
      Number.isSafeInteger(reportedOpenCount) &&
      reportedOpenCount >= openLeapsReviewSignals.length
    ? reportedOpenCount
    : openLeapsReviewSignals.length;
  const quality = portfolioReview.portfolioGreeks.quality;
  return {
    effectiveStatus: quality === "incomplete"
      ? "blocked" as const
      : openLeapsReviewSignals.length > 0
        ? "monitoring" as const
        : "current" as const,
    environment: "paper" as const,
    paperOnly: true as const,
    liveTradingEnabled: false as const,
    brokerMutationPerformed: false as const,
    decision: openLeapsReviewSignals.length > 0
      ? "review_required" as const
      : "observation_only" as const,
    asOf: portfolioReview.asOf,
    sourceSnapshotId: portfolioReview.accountSnapshotId,
    dataQualityStatus: quality,
    blockers: portfolioReview.portfolioGreeks.blockers,
    portfolioGreeks: portfolioReview.portfolioGreeks,
    openLeapsReviewCount,
    returnedLeapsReviewCount: openLeapsReviewSignals.length,
    openLeapsReviewTruncated: openLeapsReviewCount > openLeapsReviewSignals.length,
    openLeapsReviewSignals
  };
};
