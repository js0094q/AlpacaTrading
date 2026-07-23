import type { JsonValue } from "../contracts/common.js";
import {
  postgresErrorTelemetry,
  readPostgresQueryTelemetry
} from "../../lib/database/postgresTelemetry.js";
import type { FencedPostgresRepositoryContext } from "./postgresRepositorySupport.js";
import {
  canonicalJson,
  fencePredicate,
  fenceValues,
  parseJsonValue,
  requireCurrentFence,
  stableRecordId
} from "./postgresRepositorySupport.js";

export type PostgresUniverseSymbol = {
  symbol: string;
  assetClass: "equity" | "option";
  source: string;
  enabled: boolean;
  observedAt: string;
};

export type PostgresMarketBar = {
  symbol: string;
  timeframe: string;
  observedAt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  requestId: string | null;
};

export type PostgresStockSnapshot = {
  id: string;
  symbol: string;
  observedAt: string;
  sourceTimestamp: string | null;
  requestedFeed: string;
  effectiveFeed: string;
  source: string;
  requestId: string | null;
  evidence: Readonly<Record<string, unknown>>;
};

export type PostgresOptionContract = {
  optionSymbol: string;
  underlyingSymbol: string;
  type: "call" | "put";
  expirationDate: string;
  strike: number;
  multiplier: number;
  tradable: boolean;
  source: string;
  requestId: string | null;
  observedAt: string;
  contractId?: string | null;
  status?: "active" | null;
  exerciseStyle?: string | null;
  openInterest?: number | null;
  openInterestDate?: string | null;
  closePrice?: number | null;
  closePriceDate?: string | null;
  evidence?: Readonly<Record<string, unknown>>;
};

export type PostgresOptionSnapshot = {
  optionSymbol: string;
  underlyingSymbol: string;
  observedAt: string;
  quoteTimestamp: string | null;
  tradeTimestamp?: string | null;
  snapshotTimestamp?: string | null;
  bid: number | null;
  ask: number | null;
  underlyingPrice?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  midpoint: number | null;
  spread?: number | null;
  spreadPct?: number | null;
  last?: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
  freshnessStatus?: "fresh" | "stale";
  requestedFeed?: string;
  effectiveFeed?: string;
  validationBasis?: "request_feed_opra" | null;
  endpoint?: string;
  pageToken?: string | null;
  retrievedAt?: string;
  persistedAt?: string;
  evidenceFingerprint?: string;
  source: string;
  requestId: string | null;
  evidence: Readonly<Record<string, unknown>>;
};

export type PostgresMarketDataIngestionRun = {
  cycleId: string | null;
  workstream: string;
  symbol: string;
  provider: string;
  endpoint: string | null;
  requestedFeed: string | null;
  effectiveFeed: string | null;
  requestStartedAt: string;
  requestCompletedAt: string;
  pagesRetrieved: number;
  rowsReceived: number;
  newestProviderTimestamp: string | null;
  oldestProviderTimestamp: string | null;
  newestProviderAgeSeconds: number | null;
  acceptedRows: number;
  staleRows: number;
  rejectedRows: number;
  freshnessThresholdSeconds: number;
  rejectionReason: string | null;
  persistenceResult: string;
  requestIds: readonly string[];
};

export type PostgresFeatureSnapshot = {
  symbol: string;
  observedAt: string;
  features: Readonly<Record<string, unknown>>;
  sourceFingerprint: string;
};

export type PostgresTargetSnapshot = {
  symbol: string;
  asOf: string;
  direction: "long" | "short" | "neutral";
  horizon: string;
  entryReference: number;
  upsideTarget: number;
  downsideRisk: number;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number;
  expectedReturn: number | null;
  volatilityAdjustedScore: number | null;
  riskProfile: string;
  preferredExpression: string;
  rationale: readonly string[];
  sourceFingerprint: string;
  optionsStrategy: Readonly<Record<string, unknown>> | null;
};

type PostgresOptionContractRow = {
  option_symbol: string;
  underlying_symbol: string;
  type: "call" | "put";
  expiration_date: Date | string;
  strike: string;
  multiplier: string;
  tradable: boolean;
  source: string;
  request_id: string | null;
  observed_at: Date | string;
  contract_id: string | null;
  status: string | null;
  exercise_style: string | null;
  open_interest: string | number | null;
  open_interest_date: Date | string | null;
  close_price: string | number | null;
  close_price_date: Date | string | null;
  evidence: unknown;
};

type PostgresOptionSnapshotRow = {
  option_symbol: string;
  underlying_symbol: string;
  observed_at: Date | string;
  quote_timestamp: Date | string | null;
  trade_timestamp: Date | string | null;
  snapshot_timestamp: Date | string | null;
  bid: string | null;
  ask: string | null;
  midpoint: string | null;
  last: string | null;
  volume: string | null;
  open_interest: string | null;
  implied_volatility: string | null;
  delta: string | null;
  gamma: string | null;
  theta: string | null;
  vega: string | null;
  rho: string | null;
  source: string;
  request_id: string | null;
  evidence: unknown;
  evidence_fingerprint: string;
  updated_at: Date | string;
};

type PostgresOptionSnapshotWriteRow = {
  inserted: boolean;
};

type MarketDataTelemetryContext = FencedPostgresRepositoryContext & {
  emitTelemetry?: (event: Record<string, unknown>) => void;
  profileOptionReadbackQuery?: boolean;
};

const normalizedSymbol = (value: string) => value.trim().toUpperCase();
const iso = (value: string) => new Date(value).toISOString();
const json = (value: unknown) => canonicalJson(parseJsonValue(value));
const record = (value: unknown): Record<string, unknown> => {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
};
const nullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const nullableString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const emitTelemetry = (
  context: FencedPostgresRepositoryContext,
  event: Record<string, unknown>
) => {
  (context as MarketDataTelemetryContext).emitTelemetry?.(event);
};

const optionSnapshotFromRow = (
  row: PostgresOptionSnapshotRow
): PostgresOptionSnapshot => {
  const evidence = record(row.evidence);
  const freshnessStatus = evidence.freshnessStatus === "fresh" ? "fresh" : "stale";
  return {
    optionSymbol: row.option_symbol,
    underlyingSymbol: row.underlying_symbol,
    observedAt: new Date(row.observed_at).toISOString(),
    quoteTimestamp: row.quote_timestamp ? new Date(row.quote_timestamp).toISOString() : null,
    tradeTimestamp: row.trade_timestamp ? new Date(row.trade_timestamp).toISOString() : null,
    snapshotTimestamp: row.snapshot_timestamp ? new Date(row.snapshot_timestamp).toISOString() : null,
    underlyingPrice: nullableNumber(evidence.underlyingPrice),
    bid: nullableNumber(row.bid),
    ask: nullableNumber(row.ask),
    bidSize: nullableNumber(evidence.bidSize),
    askSize: nullableNumber(evidence.askSize),
    midpoint: nullableNumber(row.midpoint),
    spread: nullableNumber(evidence.spread),
    spreadPct: nullableNumber(evidence.spreadPct),
    last: nullableNumber(row.last),
    volume: nullableNumber(row.volume),
    openInterest: nullableNumber(row.open_interest),
    impliedVolatility: nullableNumber(row.implied_volatility),
    delta: nullableNumber(row.delta),
    gamma: nullableNumber(row.gamma),
    theta: nullableNumber(row.theta),
    vega: nullableNumber(row.vega),
    rho: nullableNumber(row.rho),
    freshnessStatus,
    requestedFeed: nullableString(evidence.requestedFeed) ?? undefined,
    effectiveFeed: nullableString(evidence.effectiveFeed) ?? undefined,
    validationBasis: evidence.validationBasis === "request_feed_opra"
      ? "request_feed_opra"
      : null,
    endpoint: nullableString(evidence.endpoint) ?? undefined,
    pageToken: nullableString(evidence.pageToken),
    retrievedAt: nullableString(evidence.retrievedAt) ?? undefined,
    persistedAt: new Date(row.updated_at).toISOString(),
    evidenceFingerprint: row.evidence_fingerprint,
    source: row.source,
    requestId: row.request_id,
    evidence
  };
};

const OPTION_SNAPSHOT_READBACK_SQL = `SELECT option_symbol, underlying_symbol, observed_at, quote_timestamp,
       trade_timestamp, snapshot_timestamp, bid, ask, midpoint, last,
       volume, open_interest, implied_volatility, delta, gamma, theta,
       vega, rho, source, request_id, evidence, evidence_fingerprint,
       updated_at
FROM option_snapshots
WHERE (option_symbol, observed_at) IN (
  SELECT * FROM unnest($1::text[], $2::timestamptz[])
)
ORDER BY underlying_symbol, option_symbol, observed_at`;

const OPTION_SNAPSHOT_UPSERT_SQL = `INSERT INTO option_snapshots(
  option_symbol, underlying_symbol, observed_at, quote_timestamp, trade_timestamp,
  snapshot_timestamp, bid, ask, midpoint, last, volume, open_interest,
  implied_volatility, delta, gamma, theta, vega, rho, source, request_id,
  evidence, evidence_fingerprint, created_at, updated_at
) SELECT r.option_symbol, r.underlying_symbol, r.observed_at::timestamptz,
         r.quote_timestamp::timestamptz, r.trade_timestamp::timestamptz,
         r.snapshot_timestamp::timestamptz, r.bid::numeric, r.ask::numeric,
         r.midpoint::numeric, r.last::numeric, r.volume::numeric,
         r.open_interest::numeric, r.implied_volatility::numeric, r.delta::numeric,
         r.gamma::numeric, r.theta::numeric, r.vega::numeric, r.rho::numeric,
         r.source, r.request_id, r.evidence::jsonb, r.evidence_fingerprint, now(), now()
  FROM jsonb_to_recordset($1::jsonb) AS r(
    option_symbol text, underlying_symbol text, observed_at text, quote_timestamp text,
    trade_timestamp text, snapshot_timestamp text, bid numeric, ask numeric,
    midpoint numeric, last numeric, volume numeric, open_interest numeric,
    implied_volatility numeric, delta numeric, gamma numeric, theta numeric, vega numeric,
    rho numeric, source text, request_id text, evidence jsonb, evidence_fingerprint text)
  WHERE ${fencePredicate(2)}
ON CONFLICT (option_symbol, observed_at) DO UPDATE SET
  quote_timestamp = EXCLUDED.quote_timestamp, trade_timestamp = EXCLUDED.trade_timestamp,
  snapshot_timestamp = EXCLUDED.snapshot_timestamp, bid = EXCLUDED.bid, ask = EXCLUDED.ask,
  midpoint = EXCLUDED.midpoint, last = EXCLUDED.last, volume = EXCLUDED.volume,
  open_interest = EXCLUDED.open_interest, implied_volatility = EXCLUDED.implied_volatility,
  delta = EXCLUDED.delta, gamma = EXCLUDED.gamma, theta = EXCLUDED.theta,
  vega = EXCLUDED.vega, rho = EXCLUDED.rho, request_id = EXCLUDED.request_id,
  evidence = EXCLUDED.evidence, evidence_fingerprint = EXCLUDED.evidence_fingerprint,
  updated_at = now()
RETURNING (xmax = 0) AS inserted`;

const readbackPlanSummary = (value: unknown) => {
  const root = Array.isArray(value) ? value[0] as Record<string, unknown> | undefined : undefined;
  const plan = root?.Plan as Record<string, unknown> | undefined;
  const indexes = new Set<string>();
  const visit = (node: Record<string, unknown> | undefined) => {
    if (!node) return;
    if (typeof node["Index Name"] === "string") indexes.add(node["Index Name"]);
    const children = Array.isArray(node.Plans)
      ? node.Plans as Record<string, unknown>[]
      : [];
    for (const child of children) visit(child);
  };
  visit(plan);
  return {
    plannerTimeMs: nullableNumber(root?.["Planning Time"]),
    executionTimeMs: nullableNumber(root?.["Execution Time"]),
    rowsReturned: nullableNumber(plan?.["Actual Rows"]),
    indexUsage: [...indexes],
    planNode: nullableString(plan?.["Node Type"])
  };
};

const optionSnapshotEvidenceJson = (row: PostgresOptionSnapshot) => json({
  ...row.evidence,
  optionSymbol: normalizedSymbol(row.optionSymbol),
  underlyingSymbol: normalizedSymbol(row.underlyingSymbol),
  observedAt: iso(row.observedAt),
  quoteTimestamp: row.quoteTimestamp ? iso(row.quoteTimestamp) : null,
  tradeTimestamp: row.tradeTimestamp ? iso(row.tradeTimestamp) : null,
  snapshotTimestamp: row.snapshotTimestamp ? iso(row.snapshotTimestamp) : null,
  underlyingPrice: row.underlyingPrice ?? null,
  bid: row.bid,
  ask: row.ask,
  bidSize: row.bidSize ?? null,
  askSize: row.askSize ?? null,
  midpoint: row.midpoint,
  spread: row.spread ?? null,
  spreadPct: row.spreadPct ?? null,
  last: row.last ?? null,
  volume: row.volume,
  openInterest: row.openInterest,
  impliedVolatility: row.impliedVolatility,
  delta: row.delta,
  gamma: row.gamma ?? null,
  theta: row.theta ?? null,
  vega: row.vega ?? null,
  rho: row.rho ?? null,
  freshnessStatus: row.freshnessStatus ?? null,
  requestedFeed: row.requestedFeed ?? null,
  effectiveFeed: row.effectiveFeed ?? null,
  validationBasis: row.validationBasis ?? null,
  endpoint: row.endpoint ?? null,
  pageToken: row.pageToken ?? null,
  retrievedAt: row.retrievedAt ?? null,
  source: row.source,
  requestId: row.requestId
});

export const optionSnapshotEvidenceFingerprint = (row: PostgresOptionSnapshot) =>
  stableRecordId("option_snapshot_evidence", optionSnapshotEvidenceJson(row));

const optionSnapshotPayload = (row: PostgresOptionSnapshot) => ({
  option_symbol: normalizedSymbol(row.optionSymbol),
  underlying_symbol: normalizedSymbol(row.underlyingSymbol),
  observed_at: iso(row.observedAt),
  quote_timestamp: row.quoteTimestamp ? iso(row.quoteTimestamp) : null,
  trade_timestamp: row.tradeTimestamp ? iso(row.tradeTimestamp) : null,
  snapshot_timestamp: row.snapshotTimestamp ? iso(row.snapshotTimestamp) : null,
  bid: row.bid,
  ask: row.ask,
  midpoint: row.midpoint,
  last: row.last ?? null,
  volume: row.volume,
  open_interest: row.openInterest,
  implied_volatility: row.impliedVolatility,
  delta: row.delta,
  gamma: row.gamma ?? null,
  theta: row.theta ?? null,
  vega: row.vega ?? null,
  rho: row.rho ?? null,
  source: row.source,
  request_id: row.requestId,
  evidence: JSON.parse(optionSnapshotEvidenceJson(row)),
  evidence_fingerprint: optionSnapshotEvidenceFingerprint(row)
});

const requireFence = async (context: FencedPostgresRepositoryContext) => {
  const result = await requireCurrentFence(context);
  if (!result.accepted) throw new Error("POSTGRES_MARKET_DATA_FENCE_REJECTED");
  return result;
};

const assertWritten = (rowCount: number | null, code = "POSTGRES_MARKET_DATA_FENCE_REJECTED") => {
  if (rowCount !== 1) throw new Error(code);
};

// Keep high-volume market ingestion bounded while using fenced, set-based writes.
export const POSTGRES_MARKET_DATA_WRITE_BATCH_SIZE = 250;
export const POSTGRES_OPTION_READ_BATCH_SIZE = 1_000;
const chunks = <T>(rows: readonly T[], size = POSTGRES_MARKET_DATA_WRITE_BATCH_SIZE) => {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size) as T[]);
  return result;
};
const dedupeStable = <T>(rows: readonly T[], keyOf: (row: T) => string) => {
  const unique = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const previous = unique.get(key);
    const fingerprint = canonicalJson(parseJsonValue(JSON.parse(JSON.stringify(row))));
    if (previous && canonicalJson(parseJsonValue(JSON.parse(JSON.stringify(previous)))) !== fingerprint) {
      throw new Error("POSTGRES_MARKET_DATA_DUPLICATE_IDENTITY_CONFLICT");
    }
    if (!previous) unique.set(key, row);
  }
  return [...unique.values()];
};

const writeOptionSnapshotBatch = (
  batch: readonly PostgresOptionSnapshot[],
  context: FencedPostgresRepositoryContext
) => context.transaction.query<PostgresOptionSnapshotWriteRow>(
  OPTION_SNAPSHOT_UPSERT_SQL,
  [
    JSON.stringify(batch.map(optionSnapshotPayload)),
    ...fenceValues(context.schedulerFence)
  ]
);

const readOptionSnapshotBatch = async (
  batch: readonly { optionSymbol: string; observedAt: string }[],
  context: FencedPostgresRepositoryContext
) => {
  const values: [string[], string[]] = [
    batch.map((entry) => normalizedSymbol(entry.optionSymbol)),
    batch.map((entry) => iso(entry.observedAt))
  ];
  const result = await context.transaction.query<PostgresOptionSnapshotRow>(
    OPTION_SNAPSHOT_READBACK_SQL,
    values
  );
  return {
    values,
    result,
    rows: result.rows.map(optionSnapshotFromRow)
  };
};

export class PostgresMarketDataRepository {
  async recordMarketDataIngestionRun(
    run: PostgresMarketDataIngestionRun,
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    const id = `ingestion_${stableRecordId(
      "market_data_ingestion",
      `${run.cycleId ?? context.schedulerFence.runId}:${run.workstream}:${run.symbol}:${run.requestStartedAt}`
    )}`;
    const completed = run.persistenceResult === "persisted";
    const result = await context.transaction.query(
      `INSERT INTO market_data_ingestion_runs(
         id, ingestion_type, status, source, requested_feed, effective_feed,
         requested_symbols, request_ids, records_received, records_persisted,
         error_code, error_message, scheduler_job_name, scheduler_fencing_token,
         started_at, completed_at, cycle_id, workstream, symbol,
         provider_endpoint, pages_retrieved, newest_provider_timestamp,
         oldest_provider_timestamp, newest_provider_age_seconds,
         records_accepted, records_stale, records_rejected,
         freshness_threshold_seconds, rejection_reason, persistence_result,
         created_at, updated_at
       ) SELECT $1, 'option_snapshots', $2, $3, $4, $5, $6::jsonb, $7::jsonb,
                $8, $9, $10, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $14, $14
         WHERE ${fencePredicate(29)}
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         effective_feed = EXCLUDED.effective_feed,
         request_ids = EXCLUDED.request_ids,
         records_received = EXCLUDED.records_received,
         records_persisted = EXCLUDED.records_persisted,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message,
         completed_at = EXCLUDED.completed_at,
         pages_retrieved = EXCLUDED.pages_retrieved,
         newest_provider_timestamp = EXCLUDED.newest_provider_timestamp,
         oldest_provider_timestamp = EXCLUDED.oldest_provider_timestamp,
         newest_provider_age_seconds = EXCLUDED.newest_provider_age_seconds,
         records_accepted = EXCLUDED.records_accepted,
         records_stale = EXCLUDED.records_stale,
         records_rejected = EXCLUDED.records_rejected,
         rejection_reason = EXCLUDED.rejection_reason,
         persistence_result = EXCLUDED.persistence_result,
         updated_at = EXCLUDED.updated_at`,
      [
        id,
        completed ? "completed" : "failed",
        run.provider,
        run.requestedFeed,
        run.effectiveFeed,
        JSON.stringify([run.symbol]),
        JSON.stringify(run.requestIds),
        run.rowsReceived,
        completed ? run.acceptedRows : 0,
        run.rejectionReason?.split(":", 1)[0] ?? null,
        context.schedulerFence.jobName,
        context.schedulerFence.fencingToken,
        run.requestStartedAt,
        run.requestCompletedAt,
        run.cycleId,
        run.workstream,
        run.symbol,
        run.endpoint,
        run.pagesRetrieved,
        run.newestProviderTimestamp,
        run.oldestProviderTimestamp,
        run.newestProviderAgeSeconds,
        run.acceptedRows,
        run.staleRows,
        run.rejectedRows,
        run.freshnessThresholdSeconds,
        run.rejectionReason,
        run.persistenceResult,
        ...fenceValues(context.schedulerFence)
      ]
    );
    assertWritten(result.rowCount);
    return { stored: 1 };
  }

  async upsertUniverseSymbols(
    rows: readonly PostgresUniverseSymbol[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    for (const row of rows) {
      const result = await context.transaction.query(
        `INSERT INTO universe_symbols(
           symbol, asset_class, enabled, source, observed_at, created_at, updated_at
         ) SELECT $1, $2, $3, $4, $5, $5, $5
           WHERE ${fencePredicate(6)}
         ON CONFLICT (symbol) DO UPDATE SET
           asset_class = EXCLUDED.asset_class,
           enabled = EXCLUDED.enabled,
           source = EXCLUDED.source,
           observed_at = EXCLUDED.observed_at,
           updated_at = EXCLUDED.updated_at`,
        [
          normalizedSymbol(row.symbol), row.assetClass, row.enabled, row.source,
          iso(row.observedAt), ...fenceValues(context.schedulerFence)
        ]
      );
      assertWritten(result.rowCount);
    }
    return { stored: rows.length };
  }

  async upsertBars(
    rows: readonly PostgresMarketBar[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    if (!rows.length) return { stored: 0 };
    const unique = dedupeStable(rows, (row) => `${normalizedSymbol(row.symbol)}\0${row.timeframe}\0${iso(row.observedAt)}`);
    for (const batch of chunks(unique)) {
      const payload = batch.map((row) => ({
        symbol: normalizedSymbol(row.symbol), timeframe: row.timeframe, observed_at: iso(row.observedAt),
        open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
        source: row.source, request_id: row.requestId
      }));
      const result = await context.transaction.query(
        `INSERT INTO market_bars(
           symbol, timeframe, observed_at, open, high, low, close, volume,
           source, request_id, ingested_at, created_at, updated_at
         ) SELECT r.symbol, r.timeframe, r.observed_at::timestamptz, r.open::numeric,
                  r.high::numeric, r.low::numeric, r.close::numeric, r.volume::numeric,
                  r.source, r.request_id, now(), now(), now()
           FROM jsonb_to_recordset($1::jsonb) AS r(
             symbol text, timeframe text, observed_at text, open numeric, high numeric,
             low numeric, close numeric, volume numeric, source text, request_id text)
           WHERE ${fencePredicate(2)}
         ON CONFLICT (symbol, timeframe, observed_at) DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
           close = EXCLUDED.close, volume = EXCLUDED.volume, source = EXCLUDED.source,
           request_id = EXCLUDED.request_id, ingested_at = EXCLUDED.ingested_at, updated_at = now()`,
        [JSON.stringify(payload), ...fenceValues(context.schedulerFence)]
      );
      if (result.rowCount !== batch.length) throw new Error("POSTGRES_MARKET_DATA_PERSISTENCE_FAILED");
    }
    return { stored: unique.length };
  }

  async upsertStockSnapshots(
    rows: readonly PostgresStockSnapshot[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    for (const row of rows) {
      const evidence = json(row.evidence);
      const result = await context.transaction.query(
        `INSERT INTO stock_snapshots(
           id, symbol, observed_at, source_timestamp, requested_feed,
           effective_feed, source, request_id, evidence, evidence_fingerprint,
           created_at, updated_at
         ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $3, $3
           WHERE ${fencePredicate(11)}
         ON CONFLICT (id) DO UPDATE SET
           observed_at = EXCLUDED.observed_at,
           source_timestamp = EXCLUDED.source_timestamp,
           effective_feed = EXCLUDED.effective_feed,
           request_id = EXCLUDED.request_id,
           evidence = EXCLUDED.evidence,
           evidence_fingerprint = EXCLUDED.evidence_fingerprint,
           updated_at = EXCLUDED.updated_at`,
        [
          row.id, normalizedSymbol(row.symbol), iso(row.observedAt),
          row.sourceTimestamp ? iso(row.sourceTimestamp) : null,
          row.requestedFeed, row.effectiveFeed, row.source, row.requestId,
          evidence, stableRecordId("stock_snapshot_evidence", evidence),
          ...fenceValues(context.schedulerFence)
        ]
      );
      assertWritten(result.rowCount);
    }
    return { stored: rows.length };
  }

  async upsertOptionContracts(
    rows: readonly PostgresOptionContract[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    if (!rows.length) return { stored: 0 };
    const unique = dedupeStable(rows, (row) => normalizedSymbol(row.optionSymbol));
    for (const batch of chunks(unique)) {
      const payload = batch.map((row) => ({
        option_symbol: normalizedSymbol(row.optionSymbol), underlying_symbol: normalizedSymbol(row.underlyingSymbol),
        type: row.type, expiration_date: row.expirationDate, strike: row.strike, multiplier: row.multiplier,
        tradable: row.tradable, source: row.source, request_id: row.requestId, observed_at: iso(row.observedAt),
        contract_id: row.contractId ?? null, status: row.status ?? null, exercise_style: row.exerciseStyle ?? null,
        open_interest: row.openInterest ?? null, open_interest_date: row.openInterestDate ?? null,
        close_price: row.closePrice ?? null, close_price_date: row.closePriceDate ?? null,
        evidence: {
          ...(row.evidence ?? {}), contractId: row.contractId ?? null, status: row.status ?? null,
          exerciseStyle: row.exerciseStyle ?? null, openInterest: row.openInterest ?? null,
          openInterestDate: row.openInterestDate ?? null, closePrice: row.closePrice ?? null,
          closePriceDate: row.closePriceDate ?? null
        }
      }));
      const result = await context.transaction.query(
        `INSERT INTO option_contracts(
           option_symbol, underlying_symbol, type, expiration_date, strike,
           multiplier, tradable, source, request_id, observed_at,
           contract_id, status, exercise_style, open_interest, open_interest_date,
           close_price, close_price_date, evidence, created_at, updated_at
         ) SELECT r.option_symbol, r.underlying_symbol, r.type, r.expiration_date::date,
                  r.strike::numeric, r.multiplier::numeric, r.tradable::boolean, r.source,
                  r.request_id, r.observed_at::timestamptz, r.contract_id, r.status,
                  r.exercise_style, r.open_interest::numeric, r.open_interest_date::date,
                  r.close_price::numeric, r.close_price_date::date, r.evidence::jsonb, now(), now()
           FROM jsonb_to_recordset($1::jsonb) AS r(
             option_symbol text, underlying_symbol text, type text, expiration_date text,
             strike numeric, multiplier numeric, tradable boolean, source text, request_id text,
             observed_at text, contract_id text, status text, exercise_style text,
             open_interest numeric, open_interest_date text, close_price numeric,
             close_price_date text, evidence jsonb)
           WHERE ${fencePredicate(2)}
         ON CONFLICT (option_symbol) DO UPDATE SET
           underlying_symbol = EXCLUDED.underlying_symbol, type = EXCLUDED.type,
           expiration_date = EXCLUDED.expiration_date, strike = EXCLUDED.strike,
           multiplier = EXCLUDED.multiplier, tradable = EXCLUDED.tradable,
           request_id = EXCLUDED.request_id, observed_at = EXCLUDED.observed_at,
           contract_id = EXCLUDED.contract_id, status = EXCLUDED.status,
           exercise_style = EXCLUDED.exercise_style, open_interest = EXCLUDED.open_interest,
           open_interest_date = EXCLUDED.open_interest_date, close_price = EXCLUDED.close_price,
           close_price_date = EXCLUDED.close_price_date, evidence = EXCLUDED.evidence, updated_at = now()`,
        [JSON.stringify(payload), ...fenceValues(context.schedulerFence)]
      );
      if (result.rowCount !== batch.length) throw new Error("POSTGRES_MARKET_DATA_PERSISTENCE_FAILED");
    }
    return { stored: unique.length };
  }

  async upsertOptionSnapshots(
    rows: readonly PostgresOptionSnapshot[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    if (!rows.length) return { stored: 0 };
    const unique = dedupeStable(rows, (row) => `${normalizedSymbol(row.optionSymbol)}\0${iso(row.observedAt)}`);
    for (const batch of chunks(unique)) {
      const result = await writeOptionSnapshotBatch(batch, context);
      if (result.rowCount !== batch.length) throw new Error("POSTGRES_MARKET_DATA_PERSISTENCE_FAILED");
    }
    return { stored: unique.length };
  }

  async persistOptionSnapshotsWithReadback(
    rows: readonly PostgresOptionSnapshot[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    if (!rows.length) return { stored: 0, persistedRows: [] as PostgresOptionSnapshot[] };
    const unique = dedupeStable(
      rows,
      (row) => `${normalizedSymbol(row.optionSymbol)}\0${iso(row.observedAt)}`
    );
    const byUnderlying = new Map<string, PostgresOptionSnapshot[]>();
    for (const row of unique) {
      const underlying = normalizedSymbol(row.underlyingSymbol);
      const symbolRows = byUnderlying.get(underlying);
      if (symbolRows) {
        symbolRows.push(row);
      } else {
        byUnderlying.set(underlying, [row]);
      }
    }
    const batches = [...byUnderlying.entries()].flatMap(([symbol, symbolRows]) =>
      chunks(symbolRows).map((batch) => ({ symbol, batch }))
    );
    const persistedRows: PostgresOptionSnapshot[] = [];
    let profiledReadback = false;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const { symbol, batch } = batches[batchIndex]!;
      const batchNumber = batchIndex + 1;
      const fence = await requireFence(context);
      const transactionStartedAt = performance.now();
      let writeResult: Awaited<ReturnType<typeof writeOptionSnapshotBatch>>;
      try {
        writeResult = await writeOptionSnapshotBatch(batch, context);
      } catch (error) {
        const writeTelemetry = readPostgresQueryTelemetry(error);
        emitTelemetry(context, {
          event: "postgres_option_snapshot_batch",
          batchNumber,
          batchCount: batches.length,
          batchSize: batch.length,
          symbol,
          optionContractCount: new Set(batch.map((row) => row.optionSymbol)).size,
          rowsAttempted: batch.length,
          rowsInserted: 0,
          rowsUpdated: 0,
          rowsSkipped: 0,
          rowsRejected: batch.length,
          rowsCommitted: 0,
          rowsReadBack: 0,
          transactionDurationMs: performance.now() - transactionStartedAt,
          readbackDurationMs: 0,
          connectionAcquisitionMs: writeTelemetry.connectionAcquisitionMs,
          poolWaitMs: writeTelemetry.poolWaitMs,
          leaseOwner: fence.leaseOwner,
          remainingLeaseMs: fence.remainingLeaseMs,
          fencingToken: context.schedulerFence.fencingToken,
          outcome: "failed"
        });
        emitTelemetry(context, postgresErrorTelemetry(error, {
          failingStatement: OPTION_SNAPSHOT_UPSERT_SQL,
          batchNumber,
          symbol
        }));
        throw error;
      }
      const transactionDurationMs = performance.now() - transactionStartedAt;
      const commitCompletedAt = new Date().toISOString();
      const committed = writeResult.rowCount ?? 0;
      const insertedRows = writeResult.rows.length === committed
        ? writeResult.rows.filter((row) => row.inserted).length
        : Math.min(writeResult.rows.filter((row) => row.inserted).length, committed);
      const writeTelemetry = readPostgresQueryTelemetry(writeResult);
      if (committed !== batch.length) {
        const error = new Error(
          `POSTGRES_OPTION_SNAPSHOT_BATCH_COMMIT_MISMATCH:batch=${batchNumber}:symbol=${symbol}:expected=${batch.length}:committed=${committed}`
        );
        emitTelemetry(context, {
          event: "postgres_option_snapshot_batch",
          batchNumber,
          batchCount: batches.length,
          batchSize: batch.length,
          symbol,
          optionContractCount: new Set(batch.map((row) => row.optionSymbol)).size,
          rowsAttempted: batch.length,
          rowsInserted: insertedRows,
          rowsUpdated: committed - insertedRows,
          rowsSkipped: batch.length - committed,
          rowsRejected: batch.length - committed,
          rowsCommitted: committed,
          rowsReadBack: 0,
          transactionDurationMs,
          readbackDurationMs: 0,
          connectionAcquisitionMs: writeTelemetry.connectionAcquisitionMs,
          poolWaitMs: writeTelemetry.poolWaitMs,
          leaseOwner: fence.leaseOwner,
          remainingLeaseMs: fence.remainingLeaseMs,
          fencingToken: context.schedulerFence.fencingToken,
          outcome: "commit_mismatch"
        });
        throw error;
      }

      const readbackStartedAt = new Date().toISOString();
      const readbackTimer = performance.now();
      let readback: Awaited<ReturnType<typeof readOptionSnapshotBatch>>;
      try {
        readback = await readOptionSnapshotBatch(
          batch.map((row) => ({
            optionSymbol: row.optionSymbol,
            observedAt: row.observedAt
          })),
          context
        );
      } catch (error) {
        const readbackDurationMs = performance.now() - readbackTimer;
        const readTelemetry = readPostgresQueryTelemetry(error);
        emitTelemetry(context, {
          event: "postgres_option_snapshot_batch",
          batchNumber,
          batchCount: batches.length,
          batchSize: batch.length,
          symbol,
          optionContractCount: new Set(batch.map((row) => row.optionSymbol)).size,
          rowsAttempted: batch.length,
          rowsInserted: insertedRows,
          rowsUpdated: committed - insertedRows,
          rowsSkipped: 0,
          rowsRejected: batch.length,
          rowsCommitted: committed,
          rowsReadBack: 0,
          transactionDurationMs,
          readbackDurationMs,
          connectionAcquisitionMs:
            writeTelemetry.connectionAcquisitionMs +
            readTelemetry.connectionAcquisitionMs,
          poolWaitMs: writeTelemetry.poolWaitMs + readTelemetry.poolWaitMs,
          leaseOwner: fence.leaseOwner,
          remainingLeaseMs: fence.remainingLeaseMs,
          fencingToken: context.schedulerFence.fencingToken,
          commitCompletedAt,
          readbackStartedAt,
          outcome: "readback_failed"
        });
        emitTelemetry(context, postgresErrorTelemetry(error, {
          failingStatement: OPTION_SNAPSHOT_READBACK_SQL,
          batchNumber,
          symbol
        }));
        throw error;
      }
      const readbackDurationMs = performance.now() - readbackTimer;
      const readTelemetry = readPostgresQueryTelemetry(readback.result);
      if (readback.rows.length !== committed) {
        const error = new Error(
          `POSTGRES_OPTION_SNAPSHOT_BATCH_READBACK_MISMATCH:batch=${batchNumber}:symbol=${symbol}:expected=${batch.length}:committed=${committed}:read=${readback.rows.length}`
        );
        emitTelemetry(context, {
          event: "postgres_option_snapshot_batch",
          batchNumber,
          batchCount: batches.length,
          batchSize: batch.length,
          symbol,
          optionContractCount: new Set(batch.map((row) => row.optionSymbol)).size,
          rowsAttempted: batch.length,
          rowsInserted: insertedRows,
          rowsUpdated: committed - insertedRows,
          rowsSkipped: 0,
          rowsRejected: batch.length,
          rowsCommitted: committed,
          rowsReadBack: readback.rows.length,
          transactionDurationMs,
          readbackDurationMs,
          connectionAcquisitionMs:
            writeTelemetry.connectionAcquisitionMs +
            readTelemetry.connectionAcquisitionMs,
          poolWaitMs: writeTelemetry.poolWaitMs + readTelemetry.poolWaitMs,
          leaseOwner: fence.leaseOwner,
          remainingLeaseMs: fence.remainingLeaseMs,
          fencingToken: context.schedulerFence.fencingToken,
          commitCompletedAt,
          readbackStartedAt,
          outcome: "readback_count_mismatch"
        });
        throw error;
      }
      const expectedFingerprints = new Map(batch.map((row) => [
        `${normalizedSymbol(row.optionSymbol)}:${iso(row.observedAt)}`,
        optionSnapshotEvidenceFingerprint(row)
      ]));
      const mismatched = readback.rows.find((row) =>
        expectedFingerprints.get(`${normalizedSymbol(row.optionSymbol)}:${iso(row.observedAt)}`) !==
          row.evidenceFingerprint
      );
      if (mismatched) {
        const error = new Error(
          `POSTGRES_OPTION_SNAPSHOT_BATCH_EVIDENCE_MISMATCH:batch=${batchNumber}:symbol=${symbol}:option=${mismatched.optionSymbol}`
        );
        emitTelemetry(context, {
          event: "postgres_option_snapshot_batch",
          batchNumber,
          batchCount: batches.length,
          batchSize: batch.length,
          symbol,
          optionContractCount: new Set(batch.map((row) => row.optionSymbol)).size,
          rowsAttempted: batch.length,
          rowsInserted: insertedRows,
          rowsUpdated: committed - insertedRows,
          rowsSkipped: 0,
          rowsRejected: batch.length,
          rowsCommitted: committed,
          rowsReadBack: readback.rows.length,
          transactionDurationMs,
          readbackDurationMs,
          connectionAcquisitionMs:
            writeTelemetry.connectionAcquisitionMs +
            readTelemetry.connectionAcquisitionMs,
          poolWaitMs: writeTelemetry.poolWaitMs + readTelemetry.poolWaitMs,
          leaseOwner: fence.leaseOwner,
          remainingLeaseMs: fence.remainingLeaseMs,
          fencingToken: context.schedulerFence.fencingToken,
          commitCompletedAt,
          readbackStartedAt,
          outcome: "readback_evidence_mismatch"
        });
        throw error;
      }
      persistedRows.push(...readback.rows);

      if (
        !profiledReadback &&
        (context as MarketDataTelemetryContext).profileOptionReadbackQuery
      ) {
        profiledReadback = true;
        const profileStartedAt = performance.now();
        try {
          const profile = await context.transaction.query<{ "QUERY PLAN": unknown }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${OPTION_SNAPSHOT_READBACK_SQL}`,
            [...readback.values]
          );
          emitTelemetry(context, {
            event: "postgres_option_snapshot_readback_query_profile",
            batchNumber,
            symbol,
            queryExecutionDurationMs: performance.now() - profileStartedAt,
            failingStatement: "option_snapshot_batch_readback",
            ...readbackPlanSummary(profile.rows[0]?.["QUERY PLAN"]),
            ...readPostgresQueryTelemetry(profile)
          });
        } catch (error) {
          emitTelemetry(context, postgresErrorTelemetry(error, {
            failingStatement:
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${OPTION_SNAPSHOT_READBACK_SQL}`,
            batchNumber,
            symbol
          }));
        }
      }

      emitTelemetry(context, {
        event: "postgres_option_snapshot_batch",
        batchNumber,
        batchCount: batches.length,
        batchSize: batch.length,
        symbol,
        optionContractCount: new Set(batch.map((row) => row.optionSymbol)).size,
        rowsAttempted: batch.length,
        rowsInserted: insertedRows,
        rowsUpdated: committed - insertedRows,
        rowsSkipped: batch.length - committed,
        rowsRejected: 0,
        rowsCommitted: committed,
        rowsReadBack: readback.rows.length,
        transactionDurationMs,
        readbackDurationMs,
        connectionAcquisitionMs:
          writeTelemetry.connectionAcquisitionMs +
          readTelemetry.connectionAcquisitionMs,
        poolWaitMs: writeTelemetry.poolWaitMs + readTelemetry.poolWaitMs,
        writeConnectionAcquisitionMs: writeTelemetry.connectionAcquisitionMs,
        readbackConnectionAcquisitionMs: readTelemetry.connectionAcquisitionMs,
        writePoolWaitMs: writeTelemetry.poolWaitMs,
        readbackPoolWaitMs: readTelemetry.poolWaitMs,
        leaseOwner: fence.leaseOwner,
        leaseHeartbeatAt: fence.heartbeatAt,
        leaseExpiresAt: fence.expiresAt,
        remainingLeaseMs: fence.remainingLeaseMs,
        fencingToken: context.schedulerFence.fencingToken,
        commitCompletedAt,
        readbackStartedAt,
        outcome: "committed_and_read_back"
      });
    }
    return { stored: unique.length, persistedRows };
  }

  async listOptionContractsBySymbols(
    input: { optionSymbols: readonly string[] },
    context: FencedPostgresRepositoryContext
  ): Promise<PostgresOptionContract[]> {
    await requireFence(context);
    if (!input.optionSymbols.length) return [];
    const rows: PostgresOptionContractRow[] = [];
    for (const batch of chunks(input.optionSymbols, POSTGRES_OPTION_READ_BATCH_SIZE)) {
      const result = await context.transaction.query<PostgresOptionContractRow>(
        `SELECT option_symbol, underlying_symbol, type, expiration_date, strike,
                multiplier, tradable, source, request_id, observed_at,
                contract_id, status, exercise_style, open_interest, open_interest_date,
                close_price, close_price_date, evidence
         FROM option_contracts
         WHERE option_symbol = ANY($1::text[])
         ORDER BY underlying_symbol, expiration_date, strike, option_symbol`,
        [batch.map(normalizedSymbol)]
      );
      rows.push(...result.rows);
    }
    return rows.map((row) => {
      const evidence = record(row.evidence);
      return {
        optionSymbol: row.option_symbol,
        underlyingSymbol: row.underlying_symbol,
        type: row.type,
        expirationDate: new Date(row.expiration_date).toISOString().slice(0, 10),
        strike: Number(row.strike),
        multiplier: Number(row.multiplier),
        tradable: row.tradable,
        source: row.source,
        requestId: row.request_id,
        observedAt: new Date(row.observed_at).toISOString(),
        contractId: nullableString(row.contract_id) ?? nullableString(evidence.contractId),
        status: row.status === "active" ? "active" : null,
        exerciseStyle: nullableString(row.exercise_style) ?? nullableString(evidence.exerciseStyle),
        openInterest: nullableNumber(row.open_interest) ?? nullableNumber(evidence.openInterest),
        openInterestDate: nullableString(row.open_interest_date) ?? nullableString(evidence.openInterestDate),
        closePrice: nullableNumber(row.close_price) ?? nullableNumber(evidence.closePrice),
        closePriceDate: nullableString(row.close_price_date) ?? nullableString(evidence.closePriceDate),
        evidence
      };
    });
  }

  async listOptionSnapshotsByIdentity(
    input: { identities: readonly { optionSymbol: string; observedAt: string }[] },
    context: FencedPostgresRepositoryContext
  ): Promise<PostgresOptionSnapshot[]> {
    await requireFence(context);
    if (!input.identities.length) return [];
    const rows: PostgresOptionSnapshotRow[] = [];
    for (const batch of chunks(input.identities, POSTGRES_OPTION_READ_BATCH_SIZE)) {
      const readback = await readOptionSnapshotBatch(batch, context);
      rows.push(...readback.result.rows);
    }
    return rows.map(optionSnapshotFromRow);
  }

  async upsertFeatureSnapshots(
    rows: readonly PostgresFeatureSnapshot[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    if (!rows.length) return { stored: 0 };
    const unique = dedupeStable(rows, (row) => `${normalizedSymbol(row.symbol)}\0${iso(row.observedAt)}`);
    for (const batch of chunks(unique)) {
      const payload = batch.map((row) => ({
        symbol: normalizedSymbol(row.symbol), observed_at: iso(row.observedAt),
        features: JSON.parse(json(row.features)), source_fingerprint: row.sourceFingerprint
      }));
      const result = await context.transaction.query(
        `INSERT INTO feature_snapshots(
           symbol, observed_at, features, source_fingerprint, created_at, updated_at
         ) SELECT r.symbol, r.observed_at::timestamptz, r.features::jsonb,
                  r.source_fingerprint, r.observed_at::timestamptz, r.observed_at::timestamptz
           FROM jsonb_to_recordset($1::jsonb) AS r(
             symbol text, observed_at text, features jsonb, source_fingerprint text)
           WHERE ${fencePredicate(2)}
         ON CONFLICT (symbol, observed_at) DO UPDATE SET
           features = EXCLUDED.features, source_fingerprint = EXCLUDED.source_fingerprint,
           updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(payload), ...fenceValues(context.schedulerFence)]
      );
      if (result.rowCount !== batch.length) throw new Error("POSTGRES_MARKET_DATA_PERSISTENCE_FAILED");
    }
    return { stored: unique.length };
  }

  async upsertTargetSnapshots(
    rows: readonly PostgresTargetSnapshot[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    for (const row of rows) {
      const values = [
        normalizedSymbol(row.symbol), iso(row.asOf), row.direction, row.horizon,
        row.entryReference, row.upsideTarget, row.downsideRisk, row.stopLoss,
        row.takeProfit, row.confidence, row.expectedReturn,
        row.volatilityAdjustedScore, row.riskProfile, row.preferredExpression,
        json(row.rationale), row.sourceFingerprint
      ];
      const result = await context.transaction.query(
        `INSERT INTO target_snapshots(
           symbol, as_of, direction, horizon, entry_reference, upside_target,
           downside_risk, stop_loss, take_profit, confidence, expected_return,
           volatility_adjusted_score, risk_profile, preferred_expression,
           rationale, source_fingerprint, created_at, updated_at
         ) SELECT
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15::jsonb, $16, $2, $2
           WHERE ${fencePredicate(17)}
         ON CONFLICT (symbol, as_of, risk_profile) DO UPDATE SET
           direction = EXCLUDED.direction, horizon = EXCLUDED.horizon,
           entry_reference = EXCLUDED.entry_reference,
           upside_target = EXCLUDED.upside_target,
           downside_risk = EXCLUDED.downside_risk,
           stop_loss = EXCLUDED.stop_loss, take_profit = EXCLUDED.take_profit,
           confidence = EXCLUDED.confidence,
           expected_return = EXCLUDED.expected_return,
           volatility_adjusted_score = EXCLUDED.volatility_adjusted_score,
           preferred_expression = EXCLUDED.preferred_expression,
           rationale = EXCLUDED.rationale,
           source_fingerprint = EXCLUDED.source_fingerprint,
           updated_at = EXCLUDED.updated_at`,
        [...values, ...fenceValues(context.schedulerFence)]
      );
      assertWritten(result.rowCount);
      if (row.optionsStrategy) {
        const strategy = row.optionsStrategy;
        const strategyResult = await context.transaction.query(
          `INSERT INTO options_strategy_snapshots(
             symbol, as_of, risk_profile, direction, preferred_expression,
             alternatives, rationale, options_candidate, source_fingerprint,
             created_at, updated_at
           ) SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $2, $2
             WHERE ${fencePredicate(10)}
           ON CONFLICT (symbol, as_of, risk_profile) DO UPDATE SET
             direction = EXCLUDED.direction,
             preferred_expression = EXCLUDED.preferred_expression,
             alternatives = EXCLUDED.alternatives,
             rationale = EXCLUDED.rationale,
             options_candidate = EXCLUDED.options_candidate,
             source_fingerprint = EXCLUDED.source_fingerprint,
             updated_at = EXCLUDED.updated_at`,
          [
            normalizedSymbol(row.symbol), iso(row.asOf), row.riskProfile,
            row.direction, row.preferredExpression,
            json(strategy.alternatives ?? []), json(strategy.rationale ?? []),
            json(strategy.optionsCandidate ?? null), row.sourceFingerprint,
            ...fenceValues(context.schedulerFence)
          ]
        );
        assertWritten(strategyResult.rowCount);
      }
    }
    return { stored: rows.length };
  }

  async listBars(input: {
    symbols: readonly string[];
    timeframe: string;
    start: string;
    end: string;
    limit: number;
  }, context: FencedPostgresRepositoryContext): Promise<PostgresMarketBar[]> {
    await requireFence(context);
    const limit = Math.max(1, Math.min(100_000, Math.floor(input.limit)));
    const result = await context.transaction.query<{
      symbol: string;
      timeframe: string;
      observed_at: Date | string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      source: string;
      request_id: string | null;
    }>(
      `SELECT symbol, timeframe, observed_at, open, high, low, close, volume,
              source, request_id
       FROM market_bars
       WHERE symbol = ANY($1::text[]) AND timeframe = $2
         AND observed_at >= $3 AND observed_at <= $4
       ORDER BY symbol, observed_at
       LIMIT $5`,
      [
        input.symbols.map(normalizedSymbol), input.timeframe, iso(input.start),
        iso(input.end), limit
      ]
    );
    return result.rows.map((row) => ({
      symbol: row.symbol,
      timeframe: row.timeframe,
      observedAt: new Date(row.observed_at).toISOString(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      source: row.source,
      requestId: row.request_id
    }));
  }
}
