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
    Promise<Pick<Awaited<ReturnType<typeof refreshPostgresMarketData>>, "summary">>;
};

const dependencies: SelectedEvidenceRefreshDependencies = {
  refreshMarketData: refreshPostgresMarketData
};

const SELECTED_OPTION_UNDERLYINGS_SQL = `WITH latest_research AS (
  SELECT id
  FROM research_runs
  WHERE status = 'completed'
  ORDER BY completed_at DESC, id DESC
  LIMIT 1
)
SELECT candidate.symbol, candidate.option_symbol
FROM candidates candidate
JOIN latest_research research ON research.id = candidate.research_run_id
WHERE candidate.decision = 'selected'
  AND candidate.lifecycle_status = 'selected'
  AND candidate.asset_class = 'option'
  AND candidate.option_symbol IS NOT NULL
ORDER BY candidate.rank, candidate.id
LIMIT $1`;

const normalizedSymbol = (value: unknown) =>
  String(value ?? "").trim().toUpperCase();

export const refreshPostgresSelectedCandidateEvidence = async (input: {
  query: PostgresSelectedEvidenceRefreshQuery;
  fence: SchedulerFence;
  now?: Date;
  maxCandidates?: number;
  maxQuoteAgeMs?: number;
  signal?: AbortSignal;
  emitTelemetry?: (event: Record<string, unknown>) => void;
  dependencies?: Partial<SelectedEvidenceRefreshDependencies>;
}) => {
  const now = input.now ?? new Date();
  const maxCandidates = Math.max(
    1,
    Math.min(
      25,
      Number.isSafeInteger(input.maxCandidates) ? input.maxCandidates! : 25
    )
  );
  const selected = (await input.query.query(
    SELECTED_OPTION_UNDERLYINGS_SQL,
    [maxCandidates]
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
    now,
    maxOptionSnapshotAgeSeconds: maxQuoteAgeMs / 1_000,
    signal: input.signal,
    repository,
    context
  });
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
    underlyingCount: underlyings.length,
    underlyings,
    optionDataStatus: market.summary.optionDataStatus,
    optionDataRejectionReasons: market.summary.optionDataRejectionReasons,
    brokerMutationPerformed: false as const
  };
};
