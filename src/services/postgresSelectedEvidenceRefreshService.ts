import type { SchedulerFence } from "../repositories/contracts/common.js";
import { PostgresMarketDataRepository } from "../repositories/postgres/postgresMarketDataRepository.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import { optionsQuoteConfig } from "./optionQuoteNormalizer.js";
import { refreshPostgresMarketData } from "./postgresMarketDataService.js";

export type PostgresSelectedEvidenceRefreshQuery = {
  telemetryEnabled?: boolean;
  query: (sql: string, values?: readonly unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

type SelectedEvidenceRefreshDependencies = {
  refreshMarketData: (input: Parameters<typeof refreshPostgresMarketData>[0]) =>
    Promise<Pick<
      Awaited<ReturnType<typeof refreshPostgresMarketData>>,
      "summary" | "optionSnapshots"
    >>;
};

const dependencies: SelectedEvidenceRefreshDependencies = {
  refreshMarketData: refreshPostgresMarketData
};

const SELECTED_OPTION_UNDERLYINGS_SQL = `WITH selected_research AS (
  SELECT id
  FROM research_runs
  WHERE status = 'completed'
    AND ($1::text IS NULL OR id = $1)
  ORDER BY completed_at DESC, id DESC
  LIMIT 1
)
SELECT candidate.symbol, candidate.option_symbol
FROM candidates candidate
JOIN selected_research research ON research.id = candidate.research_run_id
WHERE candidate.decision = 'selected'
  AND (
    candidate.lifecycle_status = 'selected'
    OR (
      $1::text IS NOT NULL
      AND candidate.lifecycle_status = 'blocked'
      AND candidate.decision_reason LIKE 'POSTGRES_REVIEW_MARKET_EVIDENCE_STALE:%'
    )
  )
  AND candidate.asset_class = 'option'
  AND candidate.option_symbol IS NOT NULL
ORDER BY candidate.rank, candidate.id
LIMIT $2`;

const normalizedSymbol = (value: unknown) =>
  String(value ?? "").trim().toUpperCase();

export const refreshPostgresSelectedCandidateEvidence = async (input: {
  query: PostgresSelectedEvidenceRefreshQuery;
  fence: SchedulerFence;
  now?: Date;
  researchRunId?: string;
  maxCandidates?: number;
  maxQuoteAgeMs?: number;
  clock?: () => Date;
  signal?: AbortSignal;
  emitTelemetry?: (event: Record<string, unknown>) => void;
  dependencies?: Partial<SelectedEvidenceRefreshDependencies>;
}) => {
  const now = input.now ?? new Date();
  const researchRunId = String(input.researchRunId ?? "").trim() || null;
  if (researchRunId && researchRunId.length > 200) {
    throw new Error("POSTGRES_SELECTED_EVIDENCE_RESEARCH_RUN_ID_INVALID");
  }
  const maxCandidates = Math.max(
    1,
    Math.min(
      25,
      Number.isSafeInteger(input.maxCandidates) ? input.maxCandidates! : 25
    )
  );
  const selected = (await input.query.query(
    SELECTED_OPTION_UNDERLYINGS_SQL,
    [researchRunId, maxCandidates]
  )).rows;
  const optionSymbols = Array.from(new Set(
    selected
      .map((row) => normalizedSymbol(row.option_symbol))
      .filter(Boolean)
  ));
  const underlyings = Array.from(new Set(
    selected
      .map((row) => normalizedSymbol(row.symbol))
      .filter(Boolean)
  )).sort();
  if (!optionSymbols.length || !underlyings.length) {
    return {
      status: "no_op" as const,
      code: "NO_SELECTED_OPTION_EVIDENCE_TO_REFRESH" as const,
      selectedOptionCount: 0,
      freshSelectedOptionCount: 0,
      staleSelectedOptionSymbols: [] as string[],
      underlyingCount: 0,
      underlyings: [] as string[],
      optionDataStatus: "not_applicable" as const,
      optionDataRejectionReasons: [] as string[],
      brokerMutationPerformed: false as const
    };
  }

  const maxQuoteAgeMs = input.maxQuoteAgeMs ?? optionsQuoteConfig().maxAgeMs;
  if (!Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) {
    throw new Error("POSTGRES_SELECTED_EVIDENCE_MAX_AGE_INVALID");
  }
  const deps = { ...dependencies, ...input.dependencies };
  const repository = new PostgresMarketDataRepository();
  const context = {
    transaction: input.query,
    operationId: `selected-option-evidence:${input.fence.runId}`,
    actorId: input.fence.ownerId,
    schedulerFence: input.fence,
    emitTelemetry: input.emitTelemetry,
    profileOptionReadbackQuery: input.query.telemetryEnabled === true
  } as unknown as FencedPostgresRepositoryContext;
  const end = now.toISOString();
  const market = await deps.refreshMarketData({
    symbols: underlyings,
    timeframe: "1Day",
    start: new Date(now.getTime() - 365 * 86_400_000).toISOString(),
    end,
    optionsEnabled: true,
    requiredOptionUnderlyings: underlyings,
    selectedOptionSymbols: optionSymbols,
    now,
    maxOptionSnapshotAgeSeconds: maxQuoteAgeMs / 1_000,
    signal: input.signal,
    repository,
    context
  });
  const completedAt = input.clock?.() ?? new Date();
  const completedAtMs = completedAt.getTime();
  if (!Number.isFinite(completedAtMs)) {
    throw new Error("POSTGRES_SELECTED_EVIDENCE_COMPLETION_TIME_INVALID");
  }
  const snapshotsBySymbol = new Map(
    market.optionSnapshots.map((row) => [normalizedSymbol(row.optionSymbol), row])
  );
  const staleSelectedOptionSymbols: string[] = [];
  const completionRejectionReasons: string[] = [];
  for (const optionSymbol of optionSymbols) {
    const snapshot = snapshotsBySymbol.get(optionSymbol);
    const quoteTimestampMs = snapshot?.quoteTimestamp
      ? Date.parse(snapshot.quoteTimestamp)
      : Number.NaN;
    const ageMs = completedAtMs - quoteTimestampMs;
    const provenanceValid = snapshot?.requestedFeed?.toLowerCase() === "opra" &&
      (
        snapshot.effectiveFeed?.toLowerCase() === "opra" ||
        (!snapshot.effectiveFeed?.trim() &&
          snapshot.validationBasis === "request_feed_opra")
      );
    const quoteValid = snapshot?.freshnessStatus === "fresh" &&
      snapshot.bid !== null && snapshot.bid !== undefined && snapshot.bid > 0 &&
      snapshot.ask !== null && snapshot.ask !== undefined && snapshot.ask >= snapshot.bid;
    const timeValid = Number.isFinite(quoteTimestampMs) &&
      ageMs >= -60_000 && ageMs <= maxQuoteAgeMs;
    if (provenanceValid && quoteValid && timeValid) continue;
    staleSelectedOptionSymbols.push(optionSymbol);
    completionRejectionReasons.push(
      Number.isFinite(quoteTimestampMs) && ageMs > maxQuoteAgeMs
        ? `POSTGRES_SELECTED_OPTION_EVIDENCE_STALE:${optionSymbol}`
        : `POSTGRES_SELECTED_OPTION_EVIDENCE_UNUSABLE:${optionSymbol}`
    );
  }
  if (staleSelectedOptionSymbols.length > 0) {
    input.emitTelemetry?.({
      event: "postgres_selected_option_evidence_deferred",
      selectedOptionCount: optionSymbols.length,
      freshSelectedOptionCount: optionSymbols.length - staleSelectedOptionSymbols.length,
      staleSelectedOptionSymbols,
      optionDataRejectionReasons: completionRejectionReasons,
      brokerMutationPerformed: false
    });
    return {
      status: "deferred" as const,
      code: "POSTGRES_SELECTED_OPTION_EVIDENCE_REFRESH_INCOMPLETE" as const,
      selectedOptionCount: optionSymbols.length,
      freshSelectedOptionCount: optionSymbols.length - staleSelectedOptionSymbols.length,
      staleSelectedOptionSymbols,
      underlyingCount: underlyings.length,
      underlyings,
      optionDataStatus: "degraded" as const,
      optionDataRejectionReasons: completionRejectionReasons,
      brokerMutationPerformed: false as const
    };
  }
  input.emitTelemetry?.({
    event: "postgres_selected_option_evidence_refreshed",
    selectedOptionCount: optionSymbols.length,
    underlyingCount: underlyings.length,
    optionDataStatus: market.summary.optionDataStatus,
    optionDataRejectionReasons: market.summary.optionDataRejectionReasons,
    brokerMutationPerformed: false
  });
  return {
    status: "completed" as const,
    selectedOptionCount: optionSymbols.length,
    freshSelectedOptionCount: optionSymbols.length,
    staleSelectedOptionSymbols,
    underlyingCount: underlyings.length,
    underlyings,
    optionDataStatus: market.summary.optionDataStatus,
    optionDataRejectionReasons: market.summary.optionDataRejectionReasons,
    brokerMutationPerformed: false as const
  };
};
