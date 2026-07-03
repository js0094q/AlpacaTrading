import { getDb } from "../lib/db.js";
import { nowIso, dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import { getActiveSymbols, seedInitialUniverse } from "./universeService.js";
import {
  fetchOptionContracts,
  fetchOptionSnapshots,
  type OptionContractRaw,
  type OptionSnapshotRaw
} from "./providers/alpaca.js";

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
  optionSymbol: contract.symbol,
  type: contract.type,
  expirationDate: contract.expiration_date,
  strike: contract.strike_price,
  multiplier: contract.multiplier ?? 100,
  tradable: contract.tradable ? 1 : 0
});

export const toSnapshotRow = (optionSymbol: string, symbolData: OptionSnapshotRaw) => ({
  optionSymbol,
  underlyingSymbol: normalizeSymbol(symbolData.underlying_symbol || optionSymbol),
  timestamp: nowIso(),
  bid: symbolData.latest_quote?.b ?? null,
  ask: symbolData.latest_quote?.a ?? null,
  midpoint:
    symbolData.latest_quote?.b != null && symbolData.latest_quote?.a != null
      ? (symbolData.latest_quote.b + symbolData.latest_quote.a) / 2
      : null,
  last: symbolData.latest_quote?.p ?? null,
  volume:
    typeof symbolData.volume === "number" ? Math.round(symbolData.volume) : null,
  openInterest:
    typeof symbolData.open_interest === "number" ? Math.round(symbolData.open_interest) : null,
  impliedVolatility: symbolData.implied_volatility ?? null,
  delta: symbolData.Greeks?.delta ?? null,
  gamma: symbolData.Greeks?.gamma ?? null,
  theta: symbolData.Greeks?.theta ?? null,
  vega: symbolData.Greeks?.vega ?? null,
  rho: symbolData.Greeks?.rho ?? null
});

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
      tradable = excluded.tradable,
      expiration_date = excluded.expiration_date,
      strike = excluded.strike
  `);

  let inserted = 0;
  try {
    const contracts = await fetchOptionContracts({
      underlyingSymbols: symbols,
      minDaysToExpiration: params?.minDaysToExpiration,
      maxDaysToExpiration: params?.maxDaysToExpiration
    });
    for (const raw of contracts) {
      const row = toContractRow(raw);
      if (!row.underlyingSymbol) {
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
  const insert = getDb().prepare(`
    INSERT INTO option_snapshots(
      option_symbol, underlying_symbol, timestamp, bid, ask, midpoint, last,
      volume, open_interest, implied_volatility, delta, gamma, theta, vega, rho, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'alpaca')
    ON CONFLICT(option_symbol, timestamp) DO NOTHING
  `);

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
    const snapshots = await fetchOptionSnapshots(optionSymbols);
    for (const { symbol, raw } of snapshots) {
      if (params?.minDelta !== undefined && params.minDelta !== null) {
        const delta = raw.Greeks?.delta;
        if (typeof delta !== "number" || delta < params.minDelta) {
          continue;
        }
      }
      if (params?.maxDelta !== undefined && params.maxDelta !== null) {
        const delta = raw.Greeks?.delta;
        if (typeof delta !== "number" || delta > params.maxDelta) {
          continue;
        }
      }
      const row = toSnapshotRow(symbol, raw);
      const result = insert.run(
        row.optionSymbol,
        row.underlyingSymbol,
        row.timestamp,
        row.bid,
        row.ask,
        row.midpoint,
        row.last,
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
