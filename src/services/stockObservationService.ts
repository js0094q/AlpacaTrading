import { getDb } from "../lib/db.js";
import type { StockSnapshotRow } from "../types.js";

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
