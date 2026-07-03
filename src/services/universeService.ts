import { nowIso, dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import { queryAll, queryOne, getDb } from "../lib/db.js";
import { seedUniverse } from "../config/universe.seed.js";
import type { UniverseSymbolRow } from "../types.js";
import * as alpacaProvider from "./providers/alpaca.js";

const now = () => nowIso();

const parseUniverseRow = (row: Record<string, unknown>): UniverseSymbolRow => ({
  symbol: String(row.symbol),
  assetClass: String(row.asset_class),
  enabled: Number(row.enabled) as 0 | 1,
  source: String(row.source),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  tradable: Number(row.tradable) as 0 | 1
});

export const getAllUniverse = (): UniverseSymbolRow[] =>
  queryAll<Record<string, unknown>>(
    "SELECT symbol, asset_class, enabled, source, created_at, updated_at, tradable FROM universe_symbols ORDER BY symbol ASC"
  ).map(parseUniverseRow);

export const getActiveUniverse = (): UniverseSymbolRow[] =>
  queryAll<Record<string, unknown>>(
    "SELECT symbol, asset_class, enabled, source, created_at, updated_at, tradable FROM universe_symbols WHERE enabled = 1 AND tradable = 1 ORDER BY symbol ASC"
  ).map(parseUniverseRow);

export const getActiveSymbols = (): string[] =>
  getActiveUniverse().map((row) => row.symbol);

export const addTicker = async (symbol: string, assetClass = "stock", source = "manual_seed_2026_07_02") => {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return null;
  }
  const existing = queryOne<Record<string, unknown>>(
    "SELECT symbol FROM universe_symbols WHERE symbol = ?",
    [normalized]
  );
  let tradable = 1;
  try {
    tradable = (await alpacaProvider.validateAsset(normalized)) ? 1 : 0;
  } catch {
    tradable = 1;
  }
  const nowTs = now();
  if (existing) {
    getDb()
      .prepare(
        `
      UPDATE universe_symbols
      SET asset_class = ?, enabled = 1, source = ?, tradable = ?, updated_at = ?
      WHERE symbol = ?
      `
      )
      .run(assetClass, source, tradable, nowTs, normalized);
  } else {
    getDb()
      .prepare(
        `
      INSERT INTO universe_symbols(symbol, asset_class, enabled, source, tradable, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      `
      )
      .run(normalized, assetClass, source, tradable, nowTs, nowTs);
  }
  return getUniverseSymbol(normalized);
};

export const removeTicker = (symbol: string): void => {
  const normalized = normalizeSymbol(symbol);
  getDb()
    .prepare("DELETE FROM universe_symbols WHERE symbol = ?")
    .run(normalized);
};

export const setTickerEnabled = async (symbol: string, enabled: boolean) => {
  const normalized = normalizeSymbol(symbol);
  const nowTs = now();
  const row = queryOne<Record<string, unknown>>(
    "SELECT symbol FROM universe_symbols WHERE symbol = ?",
    [normalized]
  );
  if (!row) {
    throw new Error(`Ticker ${normalized} not found`);
  }
  let tradable = Number(row.tradable ?? 1);
  if (enabled) {
    try {
      tradable = (await alpacaProvider.validateAsset(normalized)) ? 1 : 0;
    } catch {
      tradable = Number(row.tradable ?? 1);
    }
  }
  getDb()
    .prepare(
      `
    UPDATE universe_symbols
    SET enabled = ?, tradable = ?, updated_at = ?
    WHERE symbol = ?
    `
    )
    .run(enabled ? 1 : 0, tradable, nowTs, normalized);
};

export const getUniverseSymbol = (symbol: string): UniverseSymbolRow | null => {
  const row = queryOne<Record<string, unknown>>(
    "SELECT symbol, asset_class, enabled, source, created_at, updated_at, tradable FROM universe_symbols WHERE symbol = ?",
    [normalizeSymbol(symbol)]
  );
  return row ? parseUniverseRow(row) : null;
};

export const seedInitialUniverse = async () => {
  const nowTs = now();
  const symbols = dedupeSymbols(seedUniverse);
  const normalizedExisting = new Set(getAllUniverse().map((row) => row.symbol));
  const statement = getDb().prepare(
    `
    INSERT INTO universe_symbols(symbol, asset_class, enabled, source, tradable, created_at, updated_at)
    VALUES (?, 'stock', 1, 'manual_seed_2026_07_02', 1, ?, ?)
    ON CONFLICT(symbol) DO NOTHING
    `
  );
  symbols.forEach((symbol) => {
    if (!normalizedExisting.has(symbol)) {
      statement.run(symbol, nowTs, nowTs);
    }
  });
  const seeded = getAllUniverse().map((r) => r.symbol);
  return { symbols: seeded };
};
