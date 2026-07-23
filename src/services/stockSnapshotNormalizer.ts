import { normalizeSymbol } from "../lib/utils.js";
import type {
  StockSnapshotDataQualityStatus,
  StockSnapshotFreshnessStatus,
  StockSnapshotRow
} from "../types.js";

export interface StockSnapshotRaw {
  [key: string]: unknown;
  latestTrade?: unknown;
  latest_trade?: unknown;
  latestQuote?: unknown;
  latest_quote?: unknown;
  minuteBar?: unknown;
  minute_bar?: unknown;
  dailyBar?: unknown;
  daily_bar?: unknown;
  prevDailyBar?: unknown;
  previousDailyBar?: unknown;
  previous_daily_bar?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

const finiteNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
};

const textValue = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
};

const stringArray = (...values: unknown[]): string[] => {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
};

const timestampValue = (...values: unknown[]): string | null => {
  const value = textValue(...values);
  return value && Number.isFinite(new Date(value).getTime()) ? value : null;
};

const ratioChange = (value: number | null, basis: number | null) =>
  value !== null && basis !== null && basis !== 0 ? value / basis - 1 : null;

const sourceFreshness = (input: {
  sourceTimestamp: string | null;
  now: Date;
  maxAgeSeconds: number;
}): StockSnapshotFreshnessStatus => {
  if (!input.sourceTimestamp) {
    return "UNKNOWN";
  }
  const sourceMs = new Date(input.sourceTimestamp).getTime();
  const nowMs = input.now.getTime();
  if (!Number.isFinite(sourceMs) || !Number.isFinite(nowMs) || sourceMs > nowMs + 60_000) {
    return "UNKNOWN";
  }
  return nowMs - sourceMs <= input.maxAgeSeconds * 1000 ? "FRESH" : "STALE";
};

const dataQuality = (input: {
  error: string | null;
  quoteTimestamp: string | null;
  tradeTimestamp: string | null;
  minuteTimestamp: string | null;
  dailyTimestamp: string | null;
  previousDailyTimestamp: string | null;
}): StockSnapshotDataQualityStatus => {
  if (input.error) {
    return "SOURCE_ERROR";
  }
  if (!input.quoteTimestamp) {
    return "MISSING_QUOTE";
  }
  if (!input.tradeTimestamp) {
    return "MISSING_TRADE";
  }
  if (!input.minuteTimestamp) {
    return "MISSING_MINUTE_BAR";
  }
  if (!input.dailyTimestamp || !input.previousDailyTimestamp) {
    return "PARTIAL";
  }
  return "COMPLETE";
};

export const normalizeStockSnapshot = (input: {
  symbol: string;
  raw: StockSnapshotRaw | null;
  observedAt: string;
  requestedFeed: string;
  effectiveFeed?: string | null;
  currency?: string | null;
  requestId?: string | null;
  error?: string | null;
  now?: Date;
  maxAgeSeconds?: number;
}): StockSnapshotRow => {
  const raw = input.raw ?? {};
  const trade = asRecord(raw.latestTrade ?? raw.latest_trade);
  const quote = asRecord(raw.latestQuote ?? raw.latest_quote);
  const minute = asRecord(raw.minuteBar ?? raw.minute_bar);
  const daily = asRecord(raw.dailyBar ?? raw.daily_bar);
  const previous = asRecord(
    raw.prevDailyBar ?? raw.previousDailyBar ?? raw.previous_daily_bar
  );

  const tradeTimestamp = timestampValue(trade.t, trade.timestamp);
  const quoteTimestamp = timestampValue(quote.t, quote.timestamp);
  const minuteTimestamp = timestampValue(minute.t, minute.timestamp);
  const dailyTimestamp = timestampValue(daily.t, daily.timestamp);
  const previousDailyTimestamp = timestampValue(previous.t, previous.timestamp);
  const sourceTimestamp = quoteTimestamp ?? tradeTimestamp ?? minuteTimestamp ?? dailyTimestamp ?? previousDailyTimestamp;

  const bidPrice = finiteNumber(quote.bp, quote.bidPrice, quote.bid_price);
  const askPrice = finiteNumber(quote.ap, quote.askPrice, quote.ask_price);
  const midpoint = bidPrice !== null && askPrice !== null ? (bidPrice + askPrice) / 2 : null;
  const spread = bidPrice !== null && askPrice !== null ? askPrice - bidPrice : null;
  const spreadPct = spread !== null && midpoint !== null && midpoint > 0
    ? spread / midpoint * 100
    : null;

  const dailyOpen = finiteNumber(daily.o, daily.open);
  const dailyHigh = finiteNumber(daily.h, daily.high);
  const dailyLow = finiteNumber(daily.l, daily.low);
  const dailyClose = finiteNumber(daily.c, daily.close);
  const dailyVolume = finiteNumber(daily.v, daily.volume);
  const dailyVwap = finiteNumber(daily.vw, daily.vwap);
  const previousDailyClose = finiteNumber(previous.c, previous.close);
  const previousDailyVolume = finiteNumber(previous.v, previous.volume);
  const errorSummary = input.error ?? null;

  return {
    symbol: normalizeSymbol(input.symbol),
    observedAt: input.observedAt,
    sourceTimestamp,
    requestedFeed: input.requestedFeed,
    effectiveFeed: input.effectiveFeed || input.requestedFeed,
    currency: input.currency ?? null,
    latestTradePrice: finiteNumber(trade.p, trade.price),
    latestTradeSize: finiteNumber(trade.s, trade.size),
    latestTradeExchange: textValue(trade.x, trade.exchange),
    latestTradeConditions: stringArray(trade.c, trade.conditions),
    tradeTimestamp,
    bidPrice,
    askPrice,
    bidSize: finiteNumber(quote.bs, quote.bidSize, quote.bid_size),
    askSize: finiteNumber(quote.as, quote.askSize, quote.ask_size),
    bidExchange: textValue(quote.bx, quote.bidExchange, quote.bid_exchange),
    askExchange: textValue(quote.ax, quote.askExchange, quote.ask_exchange),
    quoteConditions: stringArray(quote.c, quote.conditions),
    quoteTimestamp,
    midpoint,
    spread,
    spreadPct,
    minuteTimestamp,
    minuteOpen: finiteNumber(minute.o, minute.open),
    minuteHigh: finiteNumber(minute.h, minute.high),
    minuteLow: finiteNumber(minute.l, minute.low),
    minuteClose: finiteNumber(minute.c, minute.close),
    minuteVolume: finiteNumber(minute.v, minute.volume),
    minuteTradeCount: finiteNumber(minute.n, minute.tradeCount, minute.trade_count),
    minuteVwap: finiteNumber(minute.vw, minute.vwap),
    dailyTimestamp,
    dailyOpen,
    dailyHigh,
    dailyLow,
    dailyClose,
    dailyVolume,
    dailyTradeCount: finiteNumber(daily.n, daily.tradeCount, daily.trade_count),
    dailyVwap,
    previousDailyTimestamp,
    previousDailyOpen: finiteNumber(previous.o, previous.open),
    previousDailyHigh: finiteNumber(previous.h, previous.high),
    previousDailyLow: finiteNumber(previous.l, previous.low),
    previousDailyClose,
    previousDailyVolume,
    previousDailyTradeCount: finiteNumber(previous.n, previous.tradeCount, previous.trade_count),
    previousDailyVwap: finiteNumber(previous.vw, previous.vwap),
    dailyReturn: ratioChange(dailyClose, previousDailyClose),
    gapFromPreviousClose: ratioChange(dailyOpen, previousDailyClose),
    returnFromOpen: ratioChange(dailyClose, dailyOpen),
    distanceFromVwap: ratioChange(dailyClose, dailyVwap),
    intradayRange: dailyHigh !== null && dailyLow !== null ? dailyHigh - dailyLow : null,
    relativeCurrentDayVolume: dailyVolume !== null && previousDailyVolume !== null && previousDailyVolume !== 0
      ? dailyVolume / previousDailyVolume
      : null,
    freshnessStatus: sourceFreshness({
      sourceTimestamp,
      now: input.now ?? new Date(input.observedAt),
      maxAgeSeconds: input.maxAgeSeconds ?? 1200
    }),
    dataQualityStatus: dataQuality({
      error: errorSummary,
      quoteTimestamp,
      tradeTimestamp,
      minuteTimestamp,
      dailyTimestamp,
      previousDailyTimestamp
    }),
    source: "alpaca",
    requestId: input.requestId ?? null,
    errorSummary
  };
};
