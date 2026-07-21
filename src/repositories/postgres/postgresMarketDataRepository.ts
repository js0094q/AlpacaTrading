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
  midpoint: number | null;
  last?: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
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
      const result = await context.transaction.query(
        `INSERT INTO option_contracts(
           option_symbol, underlying_symbol, type, expiration_date, strike,
           multiplier, tradable, source, request_id, observed_at, created_at, updated_at
         ) SELECT $1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $10, $10
           WHERE ${fencePredicate(11)}
         ON CONFLICT (option_symbol) DO UPDATE SET
           underlying_symbol = EXCLUDED.underlying_symbol,
           type = EXCLUDED.type, expiration_date = EXCLUDED.expiration_date,
           strike = EXCLUDED.strike, multiplier = EXCLUDED.multiplier,
           tradable = EXCLUDED.tradable, request_id = EXCLUDED.request_id,
           observed_at = EXCLUDED.observed_at, updated_at = EXCLUDED.updated_at`,
        [
          normalizedSymbol(row.optionSymbol), normalizedSymbol(row.underlyingSymbol),
          row.type, row.expirationDate, row.strike, row.multiplier, row.tradable,
          row.source, row.requestId, iso(row.observedAt),
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
      const evidence = json(row.evidence);
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
           $21::jsonb, $22, $3, $3
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
           updated_at = EXCLUDED.updated_at`,
        [
          normalizedSymbol(row.optionSymbol), normalizedSymbol(row.underlyingSymbol),
          iso(row.observedAt), row.quoteTimestamp ? iso(row.quoteTimestamp) : null,
          row.tradeTimestamp ? iso(row.tradeTimestamp) : null,
          row.snapshotTimestamp ? iso(row.snapshotTimestamp) : null,
          row.bid, row.ask, row.midpoint, row.last ?? null, row.volume,
          row.openInterest, row.impliedVolatility, row.delta, row.gamma ?? null,
          row.theta ?? null, row.vega ?? null, row.rho ?? null, row.source,
          row.requestId, evidence,
          stableRecordId("option_snapshot_evidence", evidence),
          ...fenceValues(context.schedulerFence)
        ]
      );
      assertWritten(result.rowCount);
    }
    return { stored: rows.length };
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
