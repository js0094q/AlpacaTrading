import { getDb } from "../lib/db.js";
import { runWithSqliteBusyRetry } from "../lib/sqliteConcurrency.js";
import { nowIso, dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import { config } from "../config.js";
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
import { normalizeOptionSnapshot } from "./optionSnapshotNormalizer.js";
import { ResearchRunLeaseLostError } from "./researchRunLifecycleService.js";
import {
  withHeavyPersistenceLease,
  type HeavyPersistenceLease
} from "./sqliteWriteLeaseService.js";

const OPTION_PERSISTENCE_BATCH_SIZE = 250;

const assertResearchRunActive = (researchRunId?: string) => {
  if (!researchRunId) return;
  const row = getDb()
    .prepare("SELECT status FROM research_runs WHERE id = ?")
    .get(researchRunId) as { status: string } | undefined;
  if (!row || row.status !== "running") {
    throw new ResearchRunLeaseLostError(researchRunId);
  }
};

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

const finishRun = (
  runId: number,
  rowsIngested: number,
  status: "completed" | "failed",
  notes?: string,
  context?: { researchRunId?: string | null; correlationId?: string | null }
) => {
  runWithSqliteBusyRetry(
    () => {
      getDb()
        .prepare(
          `
          UPDATE ingestion_runs
          SET status = ?, completed_at = ?, rows_ingested = ?, notes = COALESCE(?, notes)
          WHERE rowid = ?
        `
        )
        .run(status, nowIso(), rowsIngested, notes || null, runId);
    },
    {
      operation: "options_ingestion.finish",
      transaction: "options_ingestion_finish",
      runId: context?.researchRunId || `ingestion:${runId}`,
      correlationId: context?.correlationId || null,
      idempotent: true
    }
  );
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

export const toSnapshotRow = (
  optionSymbol: string,
  symbolData: OptionSnapshotRaw,
  quoteData?: OptionQuoteRaw | null,
  context?: { researchRunId?: string | null }
) => {
  const timestamp = nowIso();
  const canonical = normalizeOptionSnapshot(optionSymbol, symbolData, {
    latestQuote: quoteData
  });
  const quoteCfg = optionsQuoteConfig();
  const normalizedQuote = normalizeOptionQuote(
    {
      optionSymbol: canonical.symbol,
      bid: canonical.latestQuote?.bidPrice ?? null,
      ask: canonical.latestQuote?.askPrice ?? null,
      last: canonical.latestTrade?.price ?? null,
      timestamp: canonical.latestQuote?.timestamp ?? null
    },
    new Date(timestamp),
    quoteCfg.maxAgeMs,
    {
      allowLastPriceFallback: quoteCfg.allowLastPriceFallback
    }
  );
  const volume = toNullableNumber(symbolData.volume);
  const openInterest = toNullableNumber(symbolData.openInterest ?? symbolData.open_interest);
  const quoteAgeMs = canonical.latestQuote?.timestamp
    ? Math.max(0, Date.parse(timestamp) - Date.parse(canonical.latestQuote.timestamp))
    : null;
  const spreadPercentage =
    normalizedQuote.bid !== null &&
    normalizedQuote.ask !== null &&
    normalizedQuote.midpoint !== null &&
    normalizedQuote.midpoint > 0
      ? ((normalizedQuote.ask - normalizedQuote.bid) / normalizedQuote.midpoint) * 100
      : null;
  const expirationTimestamp = Date.parse(`${canonical.expiration}T00:00:00.000Z`);
  const decisionTimestamp = Date.parse(timestamp);
  const daysToExpiration =
    Number.isFinite(expirationTimestamp) && Number.isFinite(decisionTimestamp)
      ? Math.max(0, Math.round((expirationTimestamp - decisionTimestamp) / (24 * 60 * 60 * 1000)))
      : null;

  return {
    optionSymbol: canonical.symbol,
    underlyingSymbol: canonical.underlying,
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
    volume: volume === null ? null : Math.round(volume),
    openInterest: openInterest === null ? null : Math.round(openInterest),
    bidSize: canonical.latestQuote?.bidSize ?? null,
    askSize: canonical.latestQuote?.askSize ?? null,
    tradeSize: canonical.latestTrade?.size ?? null,
    tradeTimestamp: canonical.latestTrade?.timestamp ?? null,
    impliedVolatility: canonical.impliedVolatility,
    delta: canonical.greeks.delta,
    gamma: canonical.greeks.gamma,
    theta: canonical.greeks.theta,
    vega: canonical.greeks.vega,
    rho: canonical.greeks.rho,
    snapshotTimestamp: canonical.snapshotTimestamp,
    normalizationPath: canonical.normalizationPath,
    researchRunId: context?.researchRunId ?? null,
    sourceFeed: config.alpaca.optionDataFeed,
    quoteAgeMs,
    spreadPercentage,
    daysToExpiration
  };
};

export const ingestOptionContracts = async (params?: {
  underlyingSymbols?: string[];
  minDaysToExpiration?: number;
  maxDaysToExpiration?: number;
  researchRunId?: string;
  correlationId?: string;
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
    const normalizedRows = contracts.flatMap((raw) => {
      const row = toContractRow(raw);
      if (!row.underlyingSymbol || !row.optionSymbol || !row.expirationDate || row.strike === null) {
        return [];
      }
      return [row];
    });
    const db = getDb();
    const persistContracts = (lease?: HeavyPersistenceLease) => {
      let total = 0;
      for (let offset = 0; offset < normalizedRows.length; offset += OPTION_PERSISTENCE_BATCH_SIZE) {
        const batch = normalizedRows.slice(offset, offset + OPTION_PERSISTENCE_BATCH_SIZE);
        assertResearchRunActive(params?.researchRunId);
        lease?.assertOwnership();
        total += runWithSqliteBusyRetry(
          () => {
            let transactionStarted = false;
            let rowsInserted = 0;
            try {
              db.exec("BEGIN IMMEDIATE");
              transactionStarted = true;
              for (const row of batch) {
                const result = insert.run(
                  row.underlyingSymbol,
                  row.optionSymbol,
                  row.type,
                  row.expirationDate!,
                  row.strike,
                  row.multiplier,
                  row.tradable
                );
                if (result.changes === 1) rowsInserted += 1;
              }
              db.exec("COMMIT");
              transactionStarted = false;
              return rowsInserted;
            } catch (error) {
              if (transactionStarted) {
                try {
                  db.exec("ROLLBACK");
                } catch {
                  // Preserve the original batch failure.
                }
              }
              throw error;
            }
          },
          {
            operation: "options_contracts.persist_batch",
            transaction: "options_contract_batch",
            runId: params?.researchRunId || null,
            correlationId: params?.correlationId || null,
            idempotent: true
          }
        );
        lease?.renew();
      }
      return total;
    };
    inserted = params?.researchRunId
      ? withHeavyPersistenceLease({
          runId: params.researchRunId,
          correlationId: params.correlationId || null,
          operation: persistContracts
        })
      : persistContracts();
    finishRun(runId, inserted, "completed", undefined, params);
    return { runId, rowsIngested: inserted };
  } catch (error) {
    finishRun(
      runId,
      inserted,
      "failed",
      error instanceof Error ? error.message : "unknown",
      params
    );
    throw error;
  }
};

const insertOptionSnapshotRows = async (
  optionSymbols: string[],
  params?: {
    minDelta?: number;
    maxDelta?: number;
    researchRunId?: string;
    correlationId?: string;
  }
) => {
  if (!optionSymbols.length) {
    return 0;
  }
  const insert = getDb().prepare(`
    INSERT INTO option_snapshots(
      option_symbol, underlying_symbol, timestamp, bid, ask, midpoint, last,
      quote_status, executable, executable_price, executable_price_source, rejection_reason, quote_timestamp,
      volume, open_interest, bid_size, ask_size, trade_size, trade_timestamp,
      implied_volatility, delta, gamma, theta, vega, rho, snapshot_timestamp, normalization_path,
      research_run_id, source_feed, quote_age_ms, spread_percentage, days_to_expiration, source
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, 'alpaca'
    )
    ON CONFLICT(option_symbol, timestamp) DO NOTHING
  `);

  let inserted = 0;
  const [snapshots, quotes] = await Promise.all([
    fetchOptionSnapshots(optionSymbols),
    fetchOptionQuotes(optionSymbols)
  ]);
  const quotesBySymbol = new Map(quotes.map((row) => [row.symbol, row.raw]));
  const normalizedRows = snapshots.flatMap(({ symbol, raw }) => {
    const row = toSnapshotRow(symbol, raw, quotesBySymbol.get(symbol), {
      researchRunId: params?.researchRunId ?? null
    });
    if (params?.minDelta !== undefined && params.minDelta !== null) {
      if (row.delta === null || row.delta < params.minDelta) return [];
    }
    if (params?.maxDelta !== undefined && params.maxDelta !== null) {
      if (row.delta === null || row.delta > params.maxDelta) return [];
    }
    return [row];
  });

  const db = getDb();
  const persistSnapshots = (lease?: HeavyPersistenceLease) => {
    let inserted = 0;
    for (let offset = 0; offset < normalizedRows.length; offset += OPTION_PERSISTENCE_BATCH_SIZE) {
      const batch = normalizedRows.slice(offset, offset + OPTION_PERSISTENCE_BATCH_SIZE);
      assertResearchRunActive(params?.researchRunId);
      lease?.assertOwnership();
      const batchInserted = runWithSqliteBusyRetry(
        () => {
          let transactionStarted = false;
          let rowsInserted = 0;
          try {
            db.exec("BEGIN IMMEDIATE");
            transactionStarted = true;
            for (const row of batch) {
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
                row.bidSize,
                row.askSize,
                row.tradeSize,
                row.tradeTimestamp,
                row.impliedVolatility,
                row.delta,
                row.gamma,
                row.theta,
                row.vega,
                row.rho,
                row.snapshotTimestamp,
                row.normalizationPath,
                row.researchRunId,
                row.sourceFeed,
                row.quoteAgeMs,
                row.spreadPercentage,
                row.daysToExpiration
              );
              if (result.changes === 1) rowsInserted += 1;
            }
            db.exec("COMMIT");
            transactionStarted = false;
            return rowsInserted;
          } catch (error) {
            if (transactionStarted) {
              try {
                db.exec("ROLLBACK");
              } catch {
                // Preserve the original batch failure.
              }
            }
            throw error;
          }
        },
        {
          operation: "options_snapshots.persist_batch",
          transaction: "options_snapshot_batch",
          runId: params?.researchRunId || null,
          correlationId: params?.correlationId || null,
          idempotent: true
        }
      );
      inserted += batchInserted;
      lease?.renew();
    }
    return inserted;
  };
  return params?.researchRunId
    ? withHeavyPersistenceLease({
        runId: params.researchRunId,
        correlationId: params.correlationId || null,
        operation: persistSnapshots
      })
    : persistSnapshots();
};

export const ingestOptionSnapshots = async (params?: {
  underlyingSymbols?: string[];
  minDaysToExpiration?: number;
  maxDaysToExpiration?: number;
  minDelta?: number;
  maxDelta?: number;
  researchRunId?: string;
  correlationId?: string;
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
    finishRun(runId, inserted, "completed", undefined, params);
    return { runId, rowsIngested: inserted };
  } catch (error) {
    finishRun(
      runId,
      inserted,
      "failed",
      error instanceof Error ? error.message : "unknown",
      params
    );
    throw error;
  }
};

export const ingestOptionSnapshotsForSymbols = async (
  optionSymbols: string[],
  context?: { researchRunId?: string; correlationId?: string }
) => {
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
    inserted = await insertOptionSnapshotRows(symbols, context);
    finishRun(runId, inserted, "completed", undefined, context);
    return { runId, rowsIngested: inserted };
  } catch (error) {
    finishRun(
      runId,
      inserted,
      "failed",
      error instanceof Error ? error.message : "unknown",
      context
    );
    throw error;
  }
};
