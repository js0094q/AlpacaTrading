import { queryOne } from "../lib/db.js";
import { parseOptionSymbol } from "./optionSymbolService.js";

export interface OptionRiskEvidence {
  symbol: string;
  underlying: string;
  expirationDate: string;
  strikePrice: number;
  optionType: "call" | "put";
  multiplier: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  impliedVolatility: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  quoteTimestamp: string | null;
  snapshotTimestamp: string | null;
  quoteStatus: string | null;
  source: string | null;
  normalizationPath: "current" | "legacy" | "mixed" | "none" | null;
}

export interface UnderlyingPriceEvidence {
  symbol: string;
  price: number | null;
  timestamp: string | null;
}

interface OptionEvidenceRow {
  multiplier: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  implied_volatility: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  quote_timestamp: string | null;
  snapshot_timestamp: string | null;
  quote_status: string | null;
  source: string | null;
  normalization_path: OptionRiskEvidence["normalizationPath"];
}

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

export const readOptionRiskEvidence = (symbol: string): OptionRiskEvidence => {
  const parsed = parseOptionSymbol(symbol);
  if (!parsed.ok) {
    throw new Error(`${parsed.code}: ${parsed.message}`);
  }
  const contract = queryOne<{ multiplier: number | null }>(
    `SELECT multiplier FROM option_contracts WHERE option_symbol = ? LIMIT 1`,
    [parsed.normalizedSymbol]
  );
  const row = queryOne<OptionEvidenceRow>(
    `
    SELECT delta, gamma, theta, vega, rho, implied_volatility,
           bid, ask, midpoint, quote_timestamp, snapshot_timestamp,
           quote_status, source, normalization_path
    FROM option_snapshots
    WHERE option_symbol = ?
    ORDER BY timestamp DESC
    LIMIT 1
    `,
    [parsed.normalizedSymbol]
  );
  return {
    symbol: parsed.normalizedSymbol,
    underlying: parsed.underlying,
    expirationDate: parsed.expirationDate,
    strikePrice: parsed.strikePrice,
    optionType: parsed.optionType,
    multiplier: finiteOrNull(contract?.multiplier),
    delta: finiteOrNull(row?.delta),
    gamma: finiteOrNull(row?.gamma),
    theta: finiteOrNull(row?.theta),
    vega: finiteOrNull(row?.vega),
    rho: finiteOrNull(row?.rho),
    impliedVolatility: finiteOrNull(row?.implied_volatility),
    bid: finiteOrNull(row?.bid),
    ask: finiteOrNull(row?.ask),
    midpoint: finiteOrNull(row?.midpoint),
    quoteTimestamp: textOrNull(row?.quote_timestamp),
    snapshotTimestamp: textOrNull(row?.snapshot_timestamp),
    quoteStatus: textOrNull(row?.quote_status),
    source: textOrNull(row?.source),
    normalizationPath: row?.normalization_path ?? null
  };
};

export const readUnderlyingPriceEvidence = (symbol: string): UnderlyingPriceEvidence => {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const row = queryOne<{ close: number | null; timestamp: string | null }>(
    `SELECT close, timestamp FROM market_bars
     WHERE symbol = ? AND timeframe = '1Day'
     ORDER BY timestamp DESC LIMIT 1`,
    [normalizedSymbol]
  );
  return {
    symbol: normalizedSymbol,
    price: finiteOrNull(row?.close),
    timestamp: textOrNull(row?.timestamp)
  };
};
