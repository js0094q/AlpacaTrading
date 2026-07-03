import { getDb, queryOne, queryAll } from "../lib/db.js";
import { nowIso, normalizeSymbol } from "../lib/utils.js";
import { fetchAllBars } from "./providers/alpaca.js";
import type { Timeframe } from "../types.js";
import { addTicker, getActiveSymbols, getActiveUniverse, seedInitialUniverse } from "./universeService.js";

const ensureRunRow = (input: {
  runType: "bars" | "options_contracts" | "options_snapshots";
  symbols: string[];
  timeframe?: Timeframe | null;
  startDate?: string | null;
  endDate?: string | null;
  status: "running" | "completed" | "failed";
  rowsIngested?: number;
  notes?: string | null;
}) => {
  const now = nowIso();
  const statement = getDb().prepare(
    `
    INSERT INTO ingestion_runs(run_type, status, symbols, timeframe, start_date, end_date, started_at, completed_at, rows_ingested, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  );
  const result = statement.run(
    input.runType,
    input.status,
    input.symbols.join(","),
    input.timeframe || null,
    input.startDate || null,
    input.endDate || null,
    now,
    input.status === "running" ? null : now,
    input.rowsIngested || 0,
    input.notes || null
  );
  return Number(result.lastInsertRowid);
};

const updateRunRows = (runId: number, rowsIngested: number, status: "completed" | "failed", notes?: string) => {
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

export const getBars = (symbol: string, timeframe: Timeframe, startDate?: string, endDate?: string) => {
  return queryAll<{
    symbol: string;
    timeframe: string;
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>(
    `
    SELECT symbol, timeframe, timestamp, open, high, low, close, volume
    FROM market_bars
    WHERE symbol = ? AND timeframe = ?
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    ORDER BY timestamp ASC
    `,
    [symbol, timeframe, startDate ?? null, startDate ?? null, endDate ?? null, endDate ?? null]
  );
};

export const ingestBars = async (options?: {
  symbols?: string[];
  timeframe?: Timeframe;
  start?: string;
  end?: string;
}) => {
  await seedInitialUniverse();
  const symbols = (options?.symbols?.length ? options.symbols : getActiveSymbols()).map(
    (symbol) => normalizeSymbol(symbol)
  );
  const timeframe = options?.timeframe || "1Day";
  const runId = ensureRunRow({
    runType: "bars",
    symbols,
    timeframe,
    startDate: options?.start || null,
    endDate: options?.end || null,
    status: "running"
  });

  const prepared = getDb().prepare(
    `
    INSERT INTO market_bars(symbol, timeframe, timestamp, open, high, low, close, volume, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'alpaca')
    ON CONFLICT(symbol, timeframe, timestamp) DO NOTHING
    `
  );

  let inserted = 0;
  try {
    for (const symbol of symbols) {
      const symbolRows = await fetchAllBars({
        symbols: [symbol],
        timeframe,
        start: options?.start,
        end: options?.end
      });
      for (const item of symbolRows) {
        const bar = item.bar;
        const result = prepared.run(
          item.symbol,
          timeframe,
          bar.t,
          bar.o,
          bar.h,
          bar.l,
          bar.c,
          Math.round(Number(bar.v) || 0)
        );
        if (result.changes === 1) {
          inserted += 1;
        }
      }
    }
    updateRunRows(runId, inserted, "completed");
    return { runId, rowsIngested: inserted };
  } catch (error) {
    updateRunRows(
      runId,
      inserted,
      "failed",
      error instanceof Error ? error.message : "unknown"
    );
    throw error;
  }
};
