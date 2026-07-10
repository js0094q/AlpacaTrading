import { getDb } from "../lib/db.js";
import { nowIso, dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import { getActiveSymbols, seedInitialUniverse } from "./universeService.js";
import {
  fetchOptionContracts,
  fetchOptionQuotes,
  fetchOptionSnapshots,
  type OptionContractRaw,
  type OptionQuoteRaw,
  type OptionSnapshotRaw
} from "./providers/alpaca.js";
import {
  normalizeOptionQuote,
  optionsQuoteConfig
} from "./optionQuoteNormalizer.js";
import { parseOptionSymbol } from "./optionSymbolService.js";

const ensureRunRow = (input: {
  runType: "options_contracts" | "options_snapshots";
  symbols: string[];
  status: "running" | "completed" | "failed";
  rowsIngested?: number;
  notes?: string | null;
}) => {
  const now = nowIso();
  const result = getDb()
    .prepare(
      `
      INSERT INTO ingestion_runs(run_type, status, symbols, timeframe, start_date, end_date, started_at, completed_at, rows_ingested, notes)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?)
    `
    )
    .run(
      input.runType,
      input.status,
      input.symbols.join(","),
      now,
      input.rowsIngested || 0,
      input.notes || null
    );
  return Number(result.lastInsertRowid);
};

const finishRun = (runId: number, rowsIngested: number, status: "completed" | "failed", notes?: string) => {
  getDb()
    .prepare(
      `
      UPDATE ingestion_runs
      SET status = ?, completed_at = ?, rows_ingested = ?, notes = COALESCE(?, notes)
      WHERE rowid = ?
    `
    )
    .run(status, nowIso(), rowsIngested, notes || null, runId);
};

export const toContractRow = (contract: OptionContractRaw) => ({
  underlyingSymbol: normalizeSymbol(contract.underlying_symbol || ""),
  optionSymbol: normalizeSymbol(contract.symbol || ""),
  type: contract.type === "put" ? "put" : "call",
  expirationDate: contract.expiration_date,
  strike: toNullableNumber(contract.strike_price),
  multiplier: toNullableNumber(contract.multiplier ?? contract.size) ?? 100,
  tradable:
    contract.tradable === true ||
    contract.tradeable === true ||
    contract.status === "active"
      ? 1
      : 0
});

const toNullableNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const snapshotQuote = (snapshot: OptionSnapshotRaw) =>
  snapshot.latestQuote ?? snapshot.latest_quote;

const snapshotTrade = (snapshot: OptionSnapshotRaw) =>
  snapshot.latestTrade ?? snapshot.latest_trade;

const snapshotGreeks = (snapshot: OptionSnapshotRaw) =>
  snapshot.greeks ?? snapshot.Greeks;

const quoteBid = (quote: OptionQuoteRaw | null | undefined, snapshot: OptionSnapshotRaw) =>
  quote?.bp ?? quote?.b ?? snapshotQuote(snapshot)?.bp ?? snapshotQuote(snapshot)?.b ?? null;

const quoteAsk = (quote: OptionQuoteRaw | null | undefined, snapshot: OptionSnapshotRaw) =>
  quote?.ap ?? quote?.a ?? snapshotQuote(snapshot)?.ap ?? snapshotQuote(snapshot)?.a ?? null;

const quoteTimestamp = (quote: OptionQuoteRaw | null | undefined, snapshot: OptionSnapshotRaw) =>
  quote?.t ?? snapshotQuote(snapshot)?.t ?? snapshotTrade(snapshot)?.t ?? null;

const quoteLast = (snapshot: OptionSnapshotRaw) =>
  snapshotTrade(snapshot)?.p ?? snapshotQuote(snapshot)?.p ?? null;

export const toSnapshotRow = (
  optionSymbol: string,
  symbolData: OptionSnapshotRaw,
  quoteData?: OptionQuoteRaw | null
) => {
  const timestamp = nowIso();
  const parsedSymbol = parseOptionSymbol(optionSymbol);
  const quoteCfg = optionsQuoteConfig();
  const normalizedQuote = normalizeOptionQuote(
    {
      optionSymbol,
      bid: quoteBid(quoteData, symbolData),
      ask: quoteAsk(quoteData, symbolData),
      last: quoteLast(symbolData),
      timestamp: quoteTimestamp(quoteData, symbolData)
    },
    new Date(timestamp),
    quoteCfg.maxAgeMs,
    {
      allowLastPriceFallback: quoteCfg.allowLastPriceFallback
    }
  );

  return {
    optionSymbol,
    underlyingSymbol: normalizeSymbol(
      symbolData.underlying_symbol || (parsedSymbol.ok ? parsedSymbol.underlying : optionSymbol)
    ),
    timestamp,
    bid: normalizedQuote.bid,
    ask: normalizedQuote.ask,
    midpoint: normalizedQuote.midpoint,
    last: normalizedQuote.last,
    quoteStatus: normalizedQuote.quoteStatus,
    executable: normalizedQuote.executable ? 1 : 0,
    executablePrice: normalizedQuote.executablePrice,
    executablePriceSource: normalizedQuote.executablePriceSource,
    rejectionReason: normalizedQuote.rejectionReason,
    quoteTimestamp: normalizedQuote.quoteTimestamp,
    volume:
      typeof symbolData.volume === "number" ? Math.round(symbolData.volume) : null,
    openInterest:
      typeof (symbolData.openInterest ?? symbolData.open_interest) === "number"
        ? Math.round(symbolData.openInterest ?? symbolData.open_interest ?? 0)
        : null,
    impliedVolatility:
      symbolData.impliedVolatility ?? symbolData.implied_volatility ?? null,
    delta: snapshotGreeks(symbolData)?.delta ?? null,
    gamma: snapshotGreeks(symbolData)?.gamma ?? null,
    theta: snapshotGreeks(symbolData)?.theta ?? null,
    vega: snapshotGreeks(symbolData)?.vega ?? null,
    rho: snapshotGreeks(symbolData)?.rho ?? null
  };
};

export const ingestOptionContracts = async (params?: {
  underlyingSymbols?: string[];
  minDaysToExpiration?: number;
  maxDaysToExpiration?: number;
}) => {
  await seedInitialUniverse();
  const symbols = dedupeSymbols(
    params?.underlyingSymbols?.length ? params.underlyingSymbols : getActiveSymbols()
  );
  const runId = ensureRunRow({
    runType: "options_contracts",
    symbols,
    status: "running"
  });
  const insert = getDb().prepare(`
    INSERT INTO option_contracts(
      underlying_symbol, option_symbol, type, expiration_date, strike, multiplier, tradable, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'alpaca')
    ON CONFLICT(option_symbol) DO UPDATE SET
      underlying_symbol = excluded.underlying_symbol,
      type = excluded.type,
      tradable = excluded.tradable,
      expiration_date = excluded.expiration_date,
      strike = excluded.strike,
      multiplier = excluded.multiplier,
      source = 'alpaca'
  `);

  let inserted = 0;
  try {
    const contracts = await fetchOptionContracts({
      underlyingSymbols: symbols,
      minDaysToExpiration: params?.minDaysToExpiration,
      maxDaysToExpiration: params?.maxDaysToExpiration
    });
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const raw of contracts) {
        const row = toContractRow(raw);
        if (!row.underlyingSymbol || !row.optionSymbol || !row.expirationDate || row.strike === null) {
          continue;
        }
        const result = insert.run(
          row.underlyingSymbol,
          row.optionSymbol,
          row.type,
          row.expirationDate,
          row.strike,
          row.multiplier,
          row.tradable
        );
        if (result.changes === 1) {
          inserted += 1;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    finishRun(runId, inserted, "completed");
    return { runId, rowsIngested: inserted };
  } catch (error) {
    finishRun(
      runId,
      inserted,
      "failed",
      error instanceof Error ? error.message : "unknown"
    );
    throw error;
  }
};

const insertOptionSnapshotRows = async (
  optionSymbols: string[],
  params?: {
    minDelta?: number;
    maxDelta?: number;
  }
) => {
  if (!optionSymbols.length) {
    return 0;
  }
  const insert = getDb().prepare(`
    INSERT INTO option_snapshots(
      option_symbol, underlying_symbol, timestamp, bid, ask, midpoint, last,
      quote_status, executable, executable_price, executable_price_source, rejection_reason, quote_timestamp,
      volume, open_interest, implied_volatility, delta, gamma, theta, vega, rho, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'alpaca')
    ON CONFLICT(option_symbol, timestamp) DO NOTHING
  `);

  let inserted = 0;
  const [snapshots, quotes] = await Promise.all([
    fetchOptionSnapshots(optionSymbols),
    fetchOptionQuotes(optionSymbols)
  ]);
  const quotesBySymbol = new Map(quotes.map((row) => [row.symbol, row.raw]));
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { symbol, raw } of snapshots) {
      if (params?.minDelta !== undefined && params.minDelta !== null) {
        const delta = snapshotGreeks(raw)?.delta;
        if (typeof delta !== "number" || delta < params.minDelta) {
          continue;
        }
      }
      if (params?.maxDelta !== undefined && params.maxDelta !== null) {
        const delta = snapshotGreeks(raw)?.delta;
        if (typeof delta !== "number" || delta > params.maxDelta) {
          continue;
        }
      }
      const row = toSnapshotRow(symbol, raw, quotesBySymbol.get(symbol));
      const result = insert.run(
        row.optionSymbol,
        row.underlyingSymbol,
        row.timestamp,
        row.bid,
        row.ask,
        row.midpoint,
        row.last,
        row.quoteStatus,
        row.executable,
        row.executablePrice,
        row.executablePriceSource,
        row.rejectionReason,
        row.quoteTimestamp,
        row.volume,
        row.openInterest,
        row.impliedVolatility,
        row.delta,
        row.gamma,
        row.theta,
        row.vega,
        row.rho
      );
      if (result.changes === 1) {
        inserted += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return inserted;
};

export const ingestOptionSnapshots = async (params?: {
  underlyingSymbols?: string[];
  minDaysToExpiration?: number;
  maxDaysToExpiration?: number;
  minDelta?: number;
  maxDelta?: number;
}) => {
  await seedInitialUniverse();
  const symbols = dedupeSymbols(
    params?.underlyingSymbols?.length ? params.underlyingSymbols : getActiveSymbols()
  );
  if (!symbols.length) {
    return { runId: null, rowsIngested: 0 };
  }
  const runId = ensureRunRow({
    runType: "options_snapshots",
    symbols,
    status: "running"
  });

  let inserted = 0;
  try {
    const options = getDb()
      .prepare(
        `
      SELECT option_symbol FROM option_contracts
      WHERE underlying_symbol IN (${symbols.map(() => "?").join(",") || "''"})
      `
      )
      .all(...symbols) as Array<{ option_symbol: string }>;
    const optionSymbols = options.map((row) => row.option_symbol);
    inserted = await insertOptionSnapshotRows(optionSymbols, params);
    finishRun(runId, inserted, "completed");
    return { runId, rowsIngested: inserted };
  } catch (error) {
    finishRun(
      runId,
      inserted,
      "failed",
      error instanceof Error ? error.message : "unknown"
    );
    throw error;
  }
};

export const ingestOptionSnapshotsForSymbols = async (optionSymbols: string[]) => {
  const symbols = dedupeSymbols(optionSymbols);
  if (!symbols.length) {
    return { runId: null, rowsIngested: 0 };
  }

  const runId = ensureRunRow({
    runType: "options_snapshots",
    symbols,
    status: "running"
  });

  let inserted = 0;
  try {
    inserted = await insertOptionSnapshotRows(symbols);
    finishRun(runId, inserted, "completed");
    return { runId, rowsIngested: inserted };
  } catch (error) {
    finishRun(
      runId,
      inserted,
      "failed",
      error instanceof Error ? error.message : "unknown"
    );
    throw error;
  }
};
