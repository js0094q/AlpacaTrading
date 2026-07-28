import { dedupeSymbols } from "../../lib/utils.js";
import type { SchedulerFence } from "../contracts/common.js";
import {
  normalizeResearchImport,
  type NormalizedResearchSignal,
  type ResearchContradictionStatus,
  type ResearchHorizon,
  type ResearchImportNormalizationResult,
  type ResearchSignalRejection,
  type ResearchThesisDirection
} from "../../services/researchSignalAdapterService.js";

export type ResearchSignalQuery = {
  query: (
    sql: string,
    values?: readonly unknown[]
  ) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

export interface ResearchSignalImportResult {
  readonly status: "completed" | "completed_with_rejections" | "rejected";
  readonly attempted: number;
  readonly imported: number;
  readonly existing: number;
  readonly signalIds: readonly string[];
  readonly rejections: readonly ResearchSignalRejection[];
}

const fenceSql = (start: number) => `EXISTS (
  SELECT 1 FROM scheduler_leases lease
  WHERE lease.job_name = $${start} AND lease.workstream = $${start + 1}
    AND lease.owner_id = $${start + 2} AND lease.run_id = $${start + 3}
    AND lease.fencing_token = $${start + 4} AND lease.status = 'held'
    AND lease.expires_at > now()
)`;

const fenceValues = (fence: SchedulerFence) => [
  fence.jobName,
  fence.workstream,
  fence.ownerId,
  fence.runId,
  fence.fencingToken
];

const INSERT_SIGNAL_SQL = `INSERT INTO research_signals(
  id, provider, provider_signal_id, symbol, as_of, horizon, thesis_summary,
  thesis_direction, confidence, catalysts, catalyst_dates, risks,
  invalidation_conditions, source_references, contradiction_status,
  contradiction_reason, expires_or_review_at, ingestion_timestamp,
  content_hash, valuation_summary, schema_version
) SELECT
  $1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9,
  $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
  $15, $16, $17::timestamptz, $18::timestamptz, $19, $20, $21
WHERE ${fenceSql(22)}
ON CONFLICT (id) DO NOTHING
RETURNING id`;

const asIso = (value: unknown) => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("POSTGRES_RESEARCH_SIGNAL_TIMESTAMP_INVALID");
  }
  return parsed.toISOString();
};

const nullableIso = (value: unknown) =>
  value === null || value === undefined ? null : asIso(value);

const jsonArray = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("POSTGRES_RESEARCH_SIGNAL_ARRAY_INVALID");
  }
  return [...parsed];
};

const projectResearchSignal = (
  row: Record<string, unknown>
): NormalizedResearchSignal => ({
  id: String(row.id),
  provider: String(row.provider),
  providerSignalId:
    row.provider_signal_id === null || row.provider_signal_id === undefined
      ? null
      : String(row.provider_signal_id),
  symbol: String(row.symbol),
  asOf: asIso(row.as_of),
  horizon: String(row.horizon) as ResearchHorizon,
  thesisSummary:
    row.thesis_summary === null || row.thesis_summary === undefined
      ? null
      : String(row.thesis_summary),
  thesisDirection:
    row.thesis_direction === null || row.thesis_direction === undefined
      ? null
      : String(row.thesis_direction) as ResearchThesisDirection,
  confidence:
    row.confidence === null || row.confidence === undefined
      ? null
      : Number(row.confidence),
  catalysts: jsonArray(row.catalysts),
  catalystDates: jsonArray(row.catalyst_dates),
  risks: jsonArray(row.risks),
  invalidationConditions: jsonArray(row.invalidation_conditions),
  contradictionStatus:
    row.contradiction_status === null || row.contradiction_status === undefined
      ? null
      : String(row.contradiction_status) as ResearchContradictionStatus,
  contradictionReason:
    row.contradiction_reason === null || row.contradiction_reason === undefined
      ? null
      : String(row.contradiction_reason),
  valuationSummary:
    row.valuation_summary === null || row.valuation_summary === undefined
      ? null
      : String(row.valuation_summary),
  sourceReferences: jsonArray(row.source_references),
  expiresOrReviewAt: nullableIso(row.expires_or_review_at),
  ingestionTimestamp: asIso(row.ingestion_timestamp),
  contentHash: String(row.content_hash),
  schemaVersion: Number(row.schema_version)
});

const insertValues = (
  signal: NormalizedResearchSignal,
  fence: SchedulerFence
) => [
  signal.id,
  signal.provider,
  signal.providerSignalId,
  signal.symbol,
  signal.asOf,
  signal.horizon,
  signal.thesisSummary,
  signal.thesisDirection,
  signal.confidence,
  JSON.stringify(signal.catalysts),
  JSON.stringify(signal.catalystDates),
  JSON.stringify(signal.risks),
  JSON.stringify(signal.invalidationConditions),
  JSON.stringify(signal.sourceReferences),
  signal.contradictionStatus,
  signal.contradictionReason,
  signal.expiresOrReviewAt,
  signal.ingestionTimestamp,
  signal.contentHash,
  signal.valuationSummary,
  signal.schemaVersion,
  ...fenceValues(fence)
];

const rejectionForUnsupportedSymbol = (
  normalized: NormalizedResearchSignal,
  accepted: readonly NormalizedResearchSignal[]
): ResearchSignalRejection => ({
  index: accepted.indexOf(normalized),
  reasonCode: "RESEARCH_SYMBOL_UNSUPPORTED",
  message: `RESEARCH_SYMBOL_UNSUPPORTED: ${normalized.symbol} is not enabled in the PostgreSQL universe.`
});

const conflictRejection = (
  signal: NormalizedResearchSignal,
  accepted: readonly NormalizedResearchSignal[]
): ResearchSignalRejection => ({
  index: accepted.indexOf(signal),
  reasonCode: "RESEARCH_SIGNAL_IDENTITY_CONFLICT",
  message: "RESEARCH_SIGNAL_IDENTITY_CONFLICT: provider signal identity already has different content."
});

const attemptedCount = (
  payload: unknown,
  normalized: ResearchImportNormalizationResult
) => {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Array.isArray((payload as Record<string, unknown>).signals)
  ) {
    return ((payload as Record<string, unknown>).signals as unknown[]).length;
  }
  return normalized.accepted.length + normalized.rejected.length;
};

export const importResearchSignals = async (input: {
  readonly query: ResearchSignalQuery;
  readonly fence: SchedulerFence;
  readonly payload: unknown;
  readonly now?: Date;
}): Promise<ResearchSignalImportResult> => {
  const normalized = normalizeResearchImport(input.payload, {
    ingestedAt: input.now
  });
  const rejections = [...normalized.rejected];
  const supported = new Set<string>();
  if (normalized.accepted.length > 0) {
    const symbols = dedupeSymbols(normalized.accepted.map(({ symbol }) => symbol));
    const result = await input.query.query(
      `SELECT symbol
       FROM universe_symbols
       WHERE symbol = ANY($1::text[]) AND enabled = true
       ORDER BY symbol`,
      [symbols]
    );
    for (const row of result.rows) supported.add(String(row.symbol));
  }

  let imported = 0;
  let existing = 0;
  const signalIds: string[] = [];
  for (const signal of normalized.accepted) {
    if (!supported.has(signal.symbol)) {
      rejections.push(rejectionForUnsupportedSymbol(signal, normalized.accepted));
      continue;
    }
    try {
      const inserted = await input.query.query(
        INSERT_SIGNAL_SQL,
        insertValues(signal, input.fence)
      );
      if (inserted.rowCount === 1) {
        imported += 1;
        signalIds.push(signal.id);
        continue;
      }
      if (inserted.rowCount !== 0) {
        throw new Error("POSTGRES_RESEARCH_SIGNAL_PERSISTENCE_FAILED");
      }
      const replay = await input.query.query(
        `SELECT id, content_hash
         FROM research_signals
         WHERE id = $1`,
        [signal.id]
      );
      if (
        replay.rowCount === 1 &&
        replay.rows[0]?.content_hash === signal.contentHash
      ) {
        existing += 1;
        signalIds.push(signal.id);
        continue;
      }
      const held = await input.query.query(
        `SELECT 1 AS held WHERE ${fenceSql(1)}`,
        fenceValues(input.fence)
      );
      if (held.rowCount !== 1) {
        throw new Error("POSTGRES_RESEARCH_SIGNAL_FENCE_REJECTED");
      }
      throw new Error("POSTGRES_RESEARCH_SIGNAL_PERSISTENCE_FAILED");
    } catch (error) {
      if ((error as { code?: unknown })?.code === "23505") {
        rejections.push(conflictRejection(signal, normalized.accepted));
        continue;
      }
      throw error;
    }
  }

  const status = imported + existing === 0 && rejections.length > 0
    ? "rejected"
    : rejections.length > 0
      ? "completed_with_rejections"
      : "completed";
  return {
    status,
    attempted: attemptedCount(input.payload, normalized),
    imported,
    existing,
    signalIds,
    rejections
  };
};

export const loadResearchSignalsForSymbols = async (input: {
  readonly query: ResearchSignalQuery;
  readonly symbols: readonly string[];
}): Promise<readonly NormalizedResearchSignal[]> => {
  const symbols = dedupeSymbols([...input.symbols]);
  if (symbols.length === 0) return [];
  const result = await input.query.query(
    `SELECT *
     FROM (
       SELECT research_signals.*,
              row_number() OVER (PARTITION BY symbol
                ORDER BY as_of DESC, ingestion_timestamp DESC, id) AS signal_ordinal
       FROM research_signals
       WHERE symbol = ANY($1::text[])
     ) bounded
     WHERE signal_ordinal <= 10
     ORDER BY symbol, as_of DESC, ingestion_timestamp DESC, id`,
    [symbols]
  );
  return result.rows.map(projectResearchSignal);
};
