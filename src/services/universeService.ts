import { nowIso, dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import { queryAll, queryOne, getDb } from "../lib/db.js";
import { seedUniverse } from "../config/universe.seed.js";
import type { UniverseSymbolRow } from "../types.js";
import * as alpacaProvider from "./providers/alpaca.js";
import {
  getAlpacaAsset,
  type AlpacaAssetSnapshot
} from "./alpacaAssetService.js";

const now = () => nowIso();

const universeSelect = `
  symbol,
  asset_class,
  enabled,
  source,
  created_at,
  updated_at,
  tradable,
  asset_id,
  asset_status,
  exchange,
  fractionable,
  shortable,
  marginable,
  options_enabled,
  asset_attributes_json,
  asset_validated_at,
  asset_request_id
`;

const nullableFlag = (value: unknown): 0 | 1 | null =>
  value === null || value === undefined ? null : Number(value) === 1 ? 1 : 0;

const parseAttributes = (value: unknown): string[] => {
  if (typeof value !== "string" || !value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};

const parseUniverseRow = (row: Record<string, unknown>): UniverseSymbolRow => ({
  symbol: String(row.symbol),
  assetClass: String(row.asset_class),
  enabled: Number(row.enabled) as 0 | 1,
  source: String(row.source),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  tradable: Number(row.tradable) as 0 | 1,
  assetId: row.asset_id === null || row.asset_id === undefined ? null : String(row.asset_id),
  assetStatus: row.asset_status === null || row.asset_status === undefined
    ? null
    : String(row.asset_status),
  exchange: row.exchange === null || row.exchange === undefined ? null : String(row.exchange),
  fractionable: nullableFlag(row.fractionable),
  shortable: nullableFlag(row.shortable),
  marginable: nullableFlag(row.marginable),
  optionsEnabled: nullableFlag(row.options_enabled),
  assetAttributes: parseAttributes(row.asset_attributes_json),
  assetValidatedAt: row.asset_validated_at === null || row.asset_validated_at === undefined
    ? null
    : String(row.asset_validated_at),
  assetRequestId: row.asset_request_id === null || row.asset_request_id === undefined
    ? null
    : String(row.asset_request_id)
});

export const getAllUniverse = (): UniverseSymbolRow[] =>
  queryAll<Record<string, unknown>>(
    `SELECT ${universeSelect} FROM universe_symbols ORDER BY symbol ASC`
  ).map(parseUniverseRow);

export const getActiveUniverse = (): UniverseSymbolRow[] =>
  queryAll<Record<string, unknown>>(
    `SELECT ${universeSelect} FROM universe_symbols WHERE enabled = 1 AND tradable = 1 ORDER BY symbol ASC`
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
    `SELECT ${universeSelect} FROM universe_symbols WHERE symbol = ?`,
    [normalizeSymbol(symbol)]
  );
  return row ? parseUniverseRow(row) : null;
};

const hasOptionsAttribute = (attributes: string[] | undefined): 0 | 1 | null => {
  if (!attributes) {
    return null;
  }
  const normalized = attributes.map((attribute) => attribute.trim().toLowerCase());
  return normalized.some((attribute) => ["has_options", "options_enabled", "options-enabled"].includes(attribute))
    ? 1
    : 0;
};

const flagFromBoolean = (value: boolean | undefined): 0 | 1 | null =>
  value === undefined ? null : value ? 1 : 0;

const safeAssetFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  return message.length > 160 ? `${message.slice(0, 160)}...` : message;
};

export const refreshUniverseAssetMetadata = async (input: {
  symbols?: string[];
  maxAgeMs?: number;
  getAsset?: (symbol: string) => Promise<AlpacaAssetSnapshot>;
} = {}) => {
  const getAsset = input.getAsset ?? getAlpacaAsset;
  const maxAgeMs = input.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const requested = dedupeSymbols(input.symbols?.length ? input.symbols : getAllUniverse().map((row) => row.symbol));
  const result = {
    checked: 0,
    active: 0,
    disabled: 0,
    failed: [] as Array<{ symbol: string; reason: string }>
  };

  for (const symbol of requested) {
    const existing = getUniverseSymbol(symbol);
    if (!existing) {
      result.failed.push({ symbol, reason: "universe_symbol_not_found" });
      continue;
    }
    if (existing.assetValidatedAt && maxAgeMs > 0) {
      const validatedAt = new Date(existing.assetValidatedAt).getTime();
      if (Number.isFinite(validatedAt) && Date.now() - validatedAt < maxAgeMs) {
        continue;
      }
    }

    result.checked += 1;
    try {
      const asset = await getAsset(symbol);
      const status = asset.status ?? null;
      const active = status === "active" && asset.tradable === true;
      const validatedAt = now();
      getDb()
        .prepare(`
          UPDATE universe_symbols
          SET
            enabled = ?,
            tradable = ?,
            asset_id = ?,
            asset_status = ?,
            exchange = ?,
            fractionable = ?,
            shortable = ?,
            marginable = ?,
            options_enabled = ?,
            asset_attributes_json = ?,
            asset_validated_at = ?,
            asset_request_id = ?,
            updated_at = ?
          WHERE symbol = ?
        `)
        .run(
          active ? 1 : 0,
          asset.tradable === true ? 1 : 0,
          asset.id ?? null,
          status,
          asset.exchange ?? null,
          flagFromBoolean(asset.fractionable),
          flagFromBoolean(asset.shortable),
          flagFromBoolean(asset.marginable),
          hasOptionsAttribute(asset.attributes),
          asset.attributes ? JSON.stringify(asset.attributes) : null,
          validatedAt,
          asset.requestId ?? null,
          validatedAt,
          symbol
        );
      if (active) {
        result.active += 1;
      } else {
        result.disabled += 1;
      }
    } catch (error) {
      result.failed.push({ symbol, reason: safeAssetFailure(error) });
    }
  }

  return result;
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
