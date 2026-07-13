import { getDb } from "../lib/db.js";
import { dedupeSymbols, normalizeSymbol } from "../lib/utils.js";
import type { StockSnapshotRow } from "../types.js";
import { getAlpacaMarketClock } from "./alpacaMarketClockService.js";
import {
  fetchStockSnapshots,
  type FetchedStockSnapshot
} from "./providers/alpaca.js";
import {
  assertLiveTradingDisabled,
  assertReadOnlyAlpacaAccessAllowed
} from "./tradingSafetyService.js";
import {
  getActiveSymbols,
  refreshUniverseAssetMetadata,
  seedInitialUniverse
} from "./universeService.js";
import { normalizeStockSnapshot } from "./stockSnapshotNormalizer.js";

const snapshotColumns = [
  "ingestion_run_id", "symbol", "observed_at", "source_timestamp", "requested_feed",
  "effective_feed", "currency", "latest_trade_price", "latest_trade_size",
  "latest_trade_exchange", "latest_trade_conditions_json", "trade_timestamp",
  "bid_price", "ask_price", "bid_size", "ask_size", "bid_exchange", "ask_exchange",
  "quote_conditions_json", "quote_timestamp", "midpoint", "spread", "spread_pct",
  "minute_timestamp", "minute_open", "minute_high", "minute_low", "minute_close",
  "minute_volume", "minute_trade_count", "minute_vwap", "daily_timestamp", "daily_open",
  "daily_high", "daily_low", "daily_close", "daily_volume", "daily_trade_count",
  "daily_vwap", "previous_daily_timestamp", "previous_daily_open", "previous_daily_high",
  "previous_daily_low", "previous_daily_close", "previous_daily_volume",
  "previous_daily_trade_count", "previous_daily_vwap", "daily_return",
  "gap_from_previous_close", "return_from_open", "distance_from_vwap", "intraday_range",
  "relative_current_day_volume", "freshness_status", "data_quality_status", "source",
  "request_id", "error_summary"
] as const;

const snapshotValues = (row: StockSnapshotRow, ingestionRunId: number | null) => [
  ingestionRunId, row.symbol, row.observedAt, row.sourceTimestamp, row.requestedFeed,
  row.effectiveFeed, row.currency, row.latestTradePrice, row.latestTradeSize,
  row.latestTradeExchange, JSON.stringify(row.latestTradeConditions), row.tradeTimestamp,
  row.bidPrice, row.askPrice, row.bidSize, row.askSize, row.bidExchange, row.askExchange,
  JSON.stringify(row.quoteConditions), row.quoteTimestamp, row.midpoint, row.spread, row.spreadPct,
  row.minuteTimestamp, row.minuteOpen, row.minuteHigh, row.minuteLow, row.minuteClose,
  row.minuteVolume, row.minuteTradeCount, row.minuteVwap, row.dailyTimestamp, row.dailyOpen,
  row.dailyHigh, row.dailyLow, row.dailyClose, row.dailyVolume, row.dailyTradeCount,
  row.dailyVwap, row.previousDailyTimestamp, row.previousDailyOpen, row.previousDailyHigh,
  row.previousDailyLow, row.previousDailyClose, row.previousDailyVolume,
  row.previousDailyTradeCount, row.previousDailyVwap, row.dailyReturn,
  row.gapFromPreviousClose, row.returnFromOpen, row.distanceFromVwap, row.intradayRange,
  row.relativeCurrentDayVolume, row.freshnessStatus, row.dataQualityStatus, row.source,
  row.requestId, row.errorSummary
];

export const persistStockSnapshot = (
  row: StockSnapshotRow,
  ingestionRunId: number | null = null
) => {
  const placeholders = snapshotColumns.map(() => "?").join(", ");
  const result = getDb()
    .prepare(`
      INSERT INTO stock_snapshots(${snapshotColumns.join(", ")})
      VALUES (${placeholders})
      ON CONFLICT(symbol, requested_feed, source_timestamp) DO NOTHING
    `)
    .run(...snapshotValues(row, ingestionRunId));
  return Number(result.changes);
};

export const getLatestStockObservationFeatures = (
  symbol: string
): Record<string, string | number | null> | null => {
  const row = getDb()
    .prepare(`
      SELECT *
      FROM stock_snapshots
      WHERE symbol = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `)
    .get(normalizeSymbol(symbol)) as Record<string, string | number | null> | undefined;
  if (!row) {
    return null;
  }
  return {
    observatoryObservedAt: row.observed_at,
    observatorySourceTimestamp: row.source_timestamp,
    observatoryRequestedFeed: row.requested_feed,
    observatoryEffectiveFeed: row.effective_feed,
    observatoryCurrency: row.currency,
    observatoryLatestTradePrice: row.latest_trade_price,
    observatoryLatestTradeSize: row.latest_trade_size,
    observatoryLatestTradeExchange: row.latest_trade_exchange,
    observatoryTradeTimestamp: row.trade_timestamp,
    observatoryBidPrice: row.bid_price,
    observatoryAskPrice: row.ask_price,
    observatoryBidSize: row.bid_size,
    observatoryAskSize: row.ask_size,
    observatoryBidExchange: row.bid_exchange,
    observatoryAskExchange: row.ask_exchange,
    observatoryQuoteTimestamp: row.quote_timestamp,
    observatoryMidpoint: row.midpoint,
    observatorySpread: row.spread,
    observatorySpreadPct: row.spread_pct,
    observatoryMinuteTimestamp: row.minute_timestamp,
    observatoryMinuteOpen: row.minute_open,
    observatoryMinuteHigh: row.minute_high,
    observatoryMinuteLow: row.minute_low,
    observatoryMinuteClose: row.minute_close,
    observatoryMinuteVolume: row.minute_volume,
    observatoryMinuteTradeCount: row.minute_trade_count,
    observatoryMinuteVwap: row.minute_vwap,
    observatoryDailyTimestamp: row.daily_timestamp,
    observatoryDailyOpen: row.daily_open,
    observatoryDailyHigh: row.daily_high,
    observatoryDailyLow: row.daily_low,
    observatoryDailyClose: row.daily_close,
    observatoryDailyVolume: row.daily_volume,
    observatoryDailyTradeCount: row.daily_trade_count,
    observatoryDailyVwap: row.daily_vwap,
    observatoryPreviousDailyTimestamp: row.previous_daily_timestamp,
    observatoryPreviousDailyOpen: row.previous_daily_open,
    observatoryPreviousDailyHigh: row.previous_daily_high,
    observatoryPreviousDailyLow: row.previous_daily_low,
    observatoryPreviousDailyClose: row.previous_daily_close,
    observatoryPreviousDailyVolume: row.previous_daily_volume,
    observatoryPreviousDailyTradeCount: row.previous_daily_trade_count,
    observatoryPreviousDailyVwap: row.previous_daily_vwap,
    observatoryDailyReturn: row.daily_return,
    observatoryGapFromPreviousClose: row.gap_from_previous_close,
    observatoryReturnFromOpen: row.return_from_open,
    observatoryDistanceFromVwap: row.distance_from_vwap,
    observatoryIntradayRange: row.intraday_range,
    observatoryRelativeCurrentDayVolume: row.relative_current_day_volume,
    observatoryFreshnessStatus: row.freshness_status,
    observatoryDataQualityStatus: row.data_quality_status,
    observatorySource: row.source,
    observatoryRequestId: row.request_id
  };
};

type ObservationStatus = "completed" | "partial" | "failed" | "skipped_market_closed";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const safeReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown";
  return message.length > 180 ? `${message.slice(0, 180)}...` : message;
};

const createObservationRun = (symbols: string[], startedAt: string) => {
  const result = getDb()
    .prepare(`
      INSERT INTO ingestion_runs(
        run_type,
        status,
        symbols,
        started_at,
        requested_symbols,
        successful_symbols,
        failed_symbols,
        rows_ingested
      ) VALUES ('stock_snapshots', 'running', ?, ?, ?, 0, 0, 0)
    `)
    .run(symbols.join(","), startedAt, symbols.length);
  return Number(result.lastInsertRowid);
};

const updateObservationRunSymbols = (runId: number, symbols: string[]) => {
  getDb()
    .prepare(`
      UPDATE ingestion_runs
      SET symbols = ?, requested_symbols = ?
      WHERE id = ?
    `)
    .run(symbols.join(","), symbols.length, runId);
};

const finishObservationRun = (input: {
  runId: number;
  status: ObservationStatus;
  completedAt: string;
  successfulSymbols: number;
  failedSymbols: number;
  rowsWritten: number;
  errors: Array<{ symbol: string; reason: string }>;
  assetFailures?: Array<{ symbol: string; reason: string }>;
}) => {
  const errorSummary = input.errors.length || input.assetFailures?.length
    ? JSON.stringify({
        symbolErrors: input.errors,
        assetValidationErrors: input.assetFailures ?? []
      })
    : null;
  getDb()
    .prepare(`
      UPDATE ingestion_runs
      SET
        status = ?,
        completed_at = ?,
        successful_symbols = ?,
        failed_symbols = ?,
        rows_ingested = ?,
        error_summary = ?
      WHERE id = ?
    `)
    .run(
      input.status,
      input.completedAt,
      input.successfulSymbols,
      input.failedSymbols,
      input.rowsWritten,
      errorSummary,
      input.runId
    );
};

export interface StockObservationResult {
  runId: number;
  status: ObservationStatus;
  requestedSymbols: number;
  successfulSymbols: number;
  failedSymbols: number;
  rowsWritten: number;
  requestedFeed: string;
  effectiveFeeds: string[];
  errors: Array<{ symbol: string; reason: string }>;
  assetValidation: Awaited<ReturnType<typeof refreshUniverseAssetMetadata>> | null;
  nonMutating: true;
  paperOnly: true;
}

export const runStockObservation = async (input: {
  symbols?: string[];
  feed?: string;
  currency?: string;
  getClock?: typeof getAlpacaMarketClock;
  getSnapshots?: typeof fetchStockSnapshots;
  refreshAssets?: typeof refreshUniverseAssetMetadata;
  persistSnapshot?: typeof persistStockSnapshot;
  now?: () => Date;
} = {}): Promise<StockObservationResult> => {
  await seedInitialUniverse();
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const initialSymbols = dedupeSymbols(input.symbols?.length ? input.symbols : getActiveSymbols());
  const runId = createObservationRun(initialSymbols, startedAt);
  const feed = (input.feed || process.env.MARKET_OBSERVATORY_FEED || "iex").trim().toLowerCase();
  const currency = (input.currency || process.env.MARKET_OBSERVATORY_CURRENCY || "USD").trim().toUpperCase();
  const getClock = input.getClock ?? getAlpacaMarketClock;
  const getSnapshots = input.getSnapshots ?? fetchStockSnapshots;
  const refreshAssets = input.refreshAssets ?? refreshUniverseAssetMetadata;
  const persistSnapshot = input.persistSnapshot ?? persistStockSnapshot;
  let symbols = initialSymbols;
  let assetValidation: Awaited<ReturnType<typeof refreshUniverseAssetMetadata>> | null = null;

  try {
    assertReadOnlyAlpacaAccessAllowed();
    assertLiveTradingDisabled();
    const clock = await getClock();
    if (clock.isOpen !== true) {
      finishObservationRun({
        runId,
        status: "skipped_market_closed",
        completedAt: now().toISOString(),
        successfulSymbols: 0,
        failedSymbols: 0,
        rowsWritten: 0,
        errors: []
      });
      return {
        runId,
        status: "skipped_market_closed",
        requestedSymbols: symbols.length,
        successfulSymbols: 0,
        failedSymbols: 0,
        rowsWritten: 0,
        requestedFeed: feed,
        effectiveFeeds: [],
        errors: [],
        assetValidation,
        nonMutating: true,
        paperOnly: true
      };
    }

    assetValidation = await refreshAssets({
      symbols,
      maxAgeMs: positiveInteger(
        process.env.MARKET_OBSERVATORY_ASSET_REFRESH_HOURS,
        24
      ) * 60 * 60 * 1000
    });
    const active = new Set(getActiveSymbols());
    symbols = symbols.filter((symbol) => active.has(symbol));
    updateObservationRunSymbols(runId, symbols);

    const observedAt = now().toISOString();
    const fetched = await getSnapshots({ symbols, feed, currency });
    const fetchedBySymbol = new Map(fetched.map((row) => [row.symbol, row]));
    const errors: Array<{ symbol: string; reason: string }> = [];
    const effectiveFeeds = new Set<string>();
    let successfulSymbols = 0;
    let failedSymbols = 0;
    let rowsWritten = 0;

    for (const symbol of symbols) {
      const response: FetchedStockSnapshot = fetchedBySymbol.get(symbol) ?? {
        symbol,
        raw: null,
        requestedFeed: feed,
        effectiveFeed: feed,
        currency,
        requestId: null,
        error: "SOURCE_SYMBOL_MISSING"
      };
      effectiveFeeds.add(response.effectiveFeed);
      const row = normalizeStockSnapshot({
        symbol,
        raw: response.raw,
        observedAt,
        requestedFeed: response.requestedFeed,
        effectiveFeed: response.effectiveFeed,
        currency: response.currency,
        requestId: response.requestId,
        error: response.error ?? null,
        now: now(),
        maxAgeSeconds: positiveInteger(
          process.env.MARKET_OBSERVATORY_MAX_AGE_SECONDS,
          1200
        )
      });
      try {
        rowsWritten += persistSnapshot(row, runId);
        if (row.dataQualityStatus === "SOURCE_ERROR") {
          failedSymbols += 1;
          errors.push({ symbol, reason: response.error ?? "SOURCE_ERROR" });
        } else {
          successfulSymbols += 1;
        }
      } catch (error) {
        failedSymbols += 1;
        errors.push({ symbol, reason: `PERSISTENCE_ERROR:${safeReason(error)}` });
      }
    }

    const status: ObservationStatus = failedSymbols === 0
      ? "completed"
      : successfulSymbols > 0
        ? "partial"
        : "failed";
    finishObservationRun({
      runId,
      status,
      completedAt: now().toISOString(),
      successfulSymbols,
      failedSymbols,
      rowsWritten,
      errors,
      assetFailures: assetValidation.failed
    });
    return {
      runId,
      status,
      requestedSymbols: symbols.length,
      successfulSymbols,
      failedSymbols,
      rowsWritten,
      requestedFeed: feed,
      effectiveFeeds: [...effectiveFeeds],
      errors,
      assetValidation,
      nonMutating: true,
      paperOnly: true
    };
  } catch (error) {
    const errors = [{ symbol: "*", reason: safeReason(error) }];
    finishObservationRun({
      runId,
      status: "failed",
      completedAt: now().toISOString(),
      successfulSymbols: 0,
      failedSymbols: symbols.length,
      rowsWritten: 0,
      errors,
      assetFailures: assetValidation?.failed
    });
    return {
      runId,
      status: "failed",
      requestedSymbols: symbols.length,
      successfulSymbols: 0,
      failedSymbols: symbols.length,
      rowsWritten: 0,
      requestedFeed: feed,
      effectiveFeeds: [],
      errors,
      assetValidation,
      nonMutating: true,
      paperOnly: true
    };
  }
};
