import type { JsonValue } from "../contracts/common.js";
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
  endpoint?: string;
  pageToken?: string | null;
  retrievedAt?: string;
  persistedAt?: string;
  evidenceFingerprint?: string;
  source: string;
  requestId: string | null;
  evidence: Readonly<Record<string, unknown>>;
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

const optionSnapshotEvidenceJson = (row: PostgresOptionSnapshot) => json({
  ...row.evidence,
  underlyingPrice: row.underlyingPrice ?? null,
  bidSize: row.bidSize ?? null,
  askSize: row.askSize ?? null,
  spread: row.spread ?? null,
  spreadPct: row.spreadPct ?? null,
  freshnessStatus: row.freshnessStatus ?? null,
  requestedFeed: row.requestedFeed ?? null,
  effectiveFeed: row.effectiveFeed ?? null,
  endpoint: row.endpoint ?? null,
  pageToken: row.pageToken ?? null,
  retrievedAt: row.retrievedAt ?? null
});

export const optionSnapshotEvidenceFingerprint = (row: PostgresOptionSnapshot) =>
  stableRecordId("option_snapshot_evidence", optionSnapshotEvidenceJson(row));

const requireFence = async (context: FencedPostgresRepositoryContext) => {
  const result = await requireCurrentFence(context);
  if (!result.accepted) throw new Error("POSTGRES_MARKET_DATA_FENCE_REJECTED");
};

const assertWritten = (rowCount: number | null, code = "POSTGRES_MARKET_DATA_FENCE_REJECTED") => {
  if (rowCount !== 1) throw new Error(code);
};

export class PostgresMarketDataRepository {
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
    for (const row of rows) {
      const result = await context.transaction.query(
        `INSERT INTO market_bars(
           symbol, timeframe, observed_at, open, high, low, close, volume,
           source, request_id, ingested_at, created_at, updated_at
         ) SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now(), now()
           WHERE ${fencePredicate(11)}
         ON CONFLICT (symbol, timeframe, observed_at) DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
           close = EXCLUDED.close, volume = EXCLUDED.volume,
           source = EXCLUDED.source, request_id = EXCLUDED.request_id,
           ingested_at = EXCLUDED.ingested_at, updated_at = now()`,
        [
          normalizedSymbol(row.symbol), row.timeframe, iso(row.observedAt),
          row.open, row.high, row.low, row.close, row.volume, row.source,
          row.requestId, ...fenceValues(context.schedulerFence)
        ]
      );
      assertWritten(result.rowCount);
    }
    return { stored: rows.length };
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
    for (const row of rows) {
      const evidence = json({
        ...(row.evidence ?? {}),
        contractId: row.contractId ?? null,
        status: row.status ?? null,
        exerciseStyle: row.exerciseStyle ?? null,
        openInterest: row.openInterest ?? null,
        openInterestDate: row.openInterestDate ?? null,
        closePrice: row.closePrice ?? null,
        closePriceDate: row.closePriceDate ?? null
      });
      const result = await context.transaction.query(
        `INSERT INTO option_contracts(
           option_symbol, underlying_symbol, type, expiration_date, strike,
           multiplier, tradable, source, request_id, observed_at, evidence,
           created_at, updated_at
         ) SELECT $1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11::jsonb,
                  now(), now()
           WHERE ${fencePredicate(12)}
         ON CONFLICT (option_symbol) DO UPDATE SET
           underlying_symbol = EXCLUDED.underlying_symbol,
           type = EXCLUDED.type, expiration_date = EXCLUDED.expiration_date,
           strike = EXCLUDED.strike, multiplier = EXCLUDED.multiplier,
           tradable = EXCLUDED.tradable, request_id = EXCLUDED.request_id,
           observed_at = EXCLUDED.observed_at, evidence = EXCLUDED.evidence,
           updated_at = now()`,
        [
          normalizedSymbol(row.optionSymbol), normalizedSymbol(row.underlyingSymbol),
          row.type, row.expirationDate, row.strike, row.multiplier, row.tradable,
          row.source, row.requestId, iso(row.observedAt), evidence,
          ...fenceValues(context.schedulerFence)
        ]
      );
      assertWritten(result.rowCount);
    }
    return { stored: rows.length };
  }

  async upsertOptionSnapshots(
    rows: readonly PostgresOptionSnapshot[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    for (const row of rows) {
      const evidence = optionSnapshotEvidenceJson(row);
      const result = await context.transaction.query(
        `INSERT INTO option_snapshots(
           option_symbol, underlying_symbol, observed_at, quote_timestamp,
           trade_timestamp, snapshot_timestamp, bid, ask, midpoint, last,
           volume, open_interest, implied_volatility, delta, gamma, theta,
           vega, rho, source, request_id, evidence, evidence_fingerprint,
           created_at, updated_at
         ) SELECT
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21::jsonb, $22, now(), now()
           WHERE ${fencePredicate(23)}
         ON CONFLICT (option_symbol, observed_at) DO UPDATE SET
           quote_timestamp = EXCLUDED.quote_timestamp,
           trade_timestamp = EXCLUDED.trade_timestamp,
           snapshot_timestamp = EXCLUDED.snapshot_timestamp,
           bid = EXCLUDED.bid, ask = EXCLUDED.ask, midpoint = EXCLUDED.midpoint,
           last = EXCLUDED.last, volume = EXCLUDED.volume,
           open_interest = EXCLUDED.open_interest,
           implied_volatility = EXCLUDED.implied_volatility,
           delta = EXCLUDED.delta, gamma = EXCLUDED.gamma, theta = EXCLUDED.theta,
           vega = EXCLUDED.vega, rho = EXCLUDED.rho,
           request_id = EXCLUDED.request_id, evidence = EXCLUDED.evidence,
           evidence_fingerprint = EXCLUDED.evidence_fingerprint,
           updated_at = now()`,
        [
          normalizedSymbol(row.optionSymbol), normalizedSymbol(row.underlyingSymbol),
          iso(row.observedAt), row.quoteTimestamp ? iso(row.quoteTimestamp) : null,
          row.tradeTimestamp ? iso(row.tradeTimestamp) : null,
          row.snapshotTimestamp ? iso(row.snapshotTimestamp) : null,
          row.bid, row.ask, row.midpoint, row.last ?? null, row.volume,
          row.openInterest, row.impliedVolatility, row.delta, row.gamma ?? null,
          row.theta ?? null, row.vega ?? null, row.rho ?? null, row.source,
          row.requestId, evidence,
          optionSnapshotEvidenceFingerprint(row),
          ...fenceValues(context.schedulerFence)
        ]
      );
      assertWritten(result.rowCount);
    }
    return { stored: rows.length };
  }

  async listOptionContractsBySymbols(
    input: { optionSymbols: readonly string[] },
    context: FencedPostgresRepositoryContext
  ): Promise<PostgresOptionContract[]> {
    await requireFence(context);
    if (!input.optionSymbols.length) return [];
    const result = await context.transaction.query<{
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
      evidence: unknown;
    }>(
      `SELECT option_symbol, underlying_symbol, type, expiration_date, strike,
              multiplier, tradable, source, request_id, observed_at, evidence
       FROM option_contracts
       WHERE option_symbol = ANY($1::text[])
       ORDER BY underlying_symbol, expiration_date, strike, option_symbol`,
      [input.optionSymbols.map(normalizedSymbol)]
    );
    return result.rows.map((row) => {
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
        contractId: nullableString(evidence.contractId),
        status: evidence.status === "active" ? "active" : null,
        exerciseStyle: nullableString(evidence.exerciseStyle),
        openInterest: nullableNumber(evidence.openInterest),
        openInterestDate: nullableString(evidence.openInterestDate),
        closePrice: nullableNumber(evidence.closePrice),
        closePriceDate: nullableString(evidence.closePriceDate),
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
    const result = await context.transaction.query<{
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
    }>(
      `SELECT option_symbol, underlying_symbol, observed_at, quote_timestamp,
              trade_timestamp, snapshot_timestamp, bid, ask, midpoint, last,
              volume, open_interest, implied_volatility, delta, gamma, theta,
              vega, rho, source, request_id, evidence, evidence_fingerprint,
              updated_at
       FROM option_snapshots
       WHERE (option_symbol, observed_at) IN (
         SELECT * FROM unnest($1::text[], $2::timestamptz[])
       )
       ORDER BY underlying_symbol, option_symbol, observed_at`,
      [
        input.identities.map((entry) => normalizedSymbol(entry.optionSymbol)),
        input.identities.map((entry) => iso(entry.observedAt))
      ]
    );
    return result.rows.map((row) => {
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
        endpoint: nullableString(evidence.endpoint) ?? undefined,
        pageToken: nullableString(evidence.pageToken),
        retrievedAt: nullableString(evidence.retrievedAt) ?? undefined,
        persistedAt: new Date(row.updated_at).toISOString(),
        evidenceFingerprint: row.evidence_fingerprint,
        source: row.source,
        requestId: row.request_id,
        evidence
      };
    });
  }

  async upsertFeatureSnapshots(
    rows: readonly PostgresFeatureSnapshot[],
    context: FencedPostgresRepositoryContext
  ) {
    await requireFence(context);
    for (const row of rows) {
      const result = await context.transaction.query(
        `INSERT INTO feature_snapshots(
           symbol, observed_at, features, source_fingerprint, created_at, updated_at
         ) SELECT $1, $2, $3::jsonb, $4, $2, $2
           WHERE ${fencePredicate(5)}
         ON CONFLICT (symbol, observed_at) DO UPDATE SET
           features = EXCLUDED.features,
           source_fingerprint = EXCLUDED.source_fingerprint,
           updated_at = EXCLUDED.updated_at`,
        [
          normalizedSymbol(row.symbol), iso(row.observedAt), json(row.features),
          row.sourceFingerprint, ...fenceValues(context.schedulerFence)
        ]
      );
      assertWritten(result.rowCount);
    }
    return { stored: rows.length };
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
