import {
  getLatestStockSnapshots,
  type AlpacaBatchedSnapshotResponse,
  type AlpacaStockSnapshotRaw
} from "./alpacaClient.js";
import {
  alpacaStockStream,
  type AlpacaStockStreamStatus,
  type StockQuoteEvent,
  type StockTradeEvent
} from "./alpacaStockStream.js";

export type StockMarketDataSource = "alpaca_sip_stream" | "alpaca_sip_rest";

export interface LatestStockQuoteRead {
  symbol: string;
  bidPrice: number | null;
  bidSize: number | null;
  askPrice: number | null;
  askSize: number | null;
  bidExchange?: string;
  askExchange?: string;
  timestamp: string | null;
  receivedAt: string;
  feed: "sip";
  source: StockMarketDataSource;
  sourceTimestamp: string | null;
}

export interface LatestStockTradeRead {
  symbol: string;
  price: number | null;
  size: number | null;
  exchange?: string;
  timestamp: string | null;
  receivedAt: string;
  feed: "sip";
  source: StockMarketDataSource;
  sourceTimestamp: string | null;
}

export interface LatestStockPriceRead {
  symbol: string;
  price: number | null;
  timestamp: string | null;
  receivedAt: string;
  feed: "sip";
  source: StockMarketDataSource;
  sourceTimestamp: string | null;
}

export interface StockPriceBatchResponse {
  data: Record<string, LatestStockPriceRead>;
  requestIds: string[];
}

export interface StockStreamReader {
  getStatus(): AlpacaStockStreamStatus;
  getLatestTrade(symbol: string): StockTradeEvent | undefined;
  getLatestQuote(symbol: string): StockQuoteEvent | undefined;
  isStale(timestamp?: string): boolean;
}

export interface StockMarketDataAccessorDeps {
  stream?: StockStreamReader;
  getLatestStockSnapshots?: (
    symbols: string[]
  ) => Promise<AlpacaBatchedSnapshotResponse<AlpacaStockSnapshotRaw>>;
  now?: () => string;
  debug?: (message: string) => void;
}

interface StreamContext {
  stream: StockStreamReader;
  status: AlpacaStockStreamStatus;
}

const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();

const normalizeSymbols = (symbols: string[]): string[] =>
  Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const streamReadyFor = (
  context: StreamContext,
  symbol: string,
  debug?: (message: string) => void
): boolean => {
  const { status } = context;
  if (!status.enabled) {
    debug?.(`SIP stream fallback for ${symbol}: disabled`);
    return false;
  }
  if (!status.connected) {
    debug?.(`SIP stream fallback for ${symbol}: disconnected`);
    return false;
  }
  if (!status.authenticated) {
    debug?.(`SIP stream fallback for ${symbol}: unauthenticated`);
    return false;
  }
  if (!status.subscribed) {
    debug?.(`SIP stream fallback for ${symbol}: unsubscribed`);
    return false;
  }
  if (status.feed !== "sip") {
    debug?.(`SIP stream fallback for ${symbol}: non-SIP feed`);
    return false;
  }
  if (!status.symbols.map(normalizeSymbol).includes(symbol)) {
    debug?.(`SIP stream fallback for ${symbol}: symbol not subscribed`);
    return false;
  }
  return true;
};

const getStreamContext = (
  deps: StockMarketDataAccessorDeps,
  debug?: (message: string) => void
): StreamContext | undefined => {
  const stream = deps.stream ?? alpacaStockStream;
  try {
    return { stream, status: stream.getStatus() };
  } catch {
    debug?.("SIP stream fallback: status lookup failed");
    return undefined;
  }
};

const isFreshTrade = (
  event: StockTradeEvent | undefined,
  symbol: string,
  context: StreamContext,
  debug?: (message: string) => void
): event is StockTradeEvent => {
  if (!event) {
    debug?.(`SIP stream fallback for ${symbol}: trade unavailable`);
    return false;
  }
  if (
    event.type !== "trade" ||
    normalizeSymbol(event.symbol) !== symbol ||
    event.feed !== "sip" ||
    !Number.isFinite(event.price) ||
    event.price <= 0 ||
    !Number.isFinite(event.size) ||
    event.size < 0 ||
    !validTimestamp(event.timestamp)
  ) {
    debug?.(`SIP stream fallback for ${symbol}: malformed trade`);
    return false;
  }
  try {
    if (context.stream.isStale(event.timestamp)) {
      debug?.(`SIP stream fallback for ${symbol}: stale trade`);
      return false;
    }
  } catch {
    debug?.(`SIP stream fallback for ${symbol}: trade freshness lookup failed`);
    return false;
  }
  return true;
};

const isFreshQuote = (
  event: StockQuoteEvent | undefined,
  symbol: string,
  context: StreamContext,
  debug?: (message: string) => void
): event is StockQuoteEvent => {
  if (!event) {
    debug?.(`SIP stream fallback for ${symbol}: quote unavailable`);
    return false;
  }
  if (
    event.type !== "quote" ||
    normalizeSymbol(event.symbol) !== symbol ||
    event.feed !== "sip" ||
    !Number.isFinite(event.bidPrice) ||
    event.bidPrice < 0 ||
    !Number.isFinite(event.bidSize) ||
    event.bidSize < 0 ||
    !Number.isFinite(event.askPrice) ||
    event.askPrice < 0 ||
    !Number.isFinite(event.askSize) ||
    event.askSize < 0 ||
    event.askPrice < event.bidPrice ||
    !validTimestamp(event.timestamp)
  ) {
    debug?.(`SIP stream fallback for ${symbol}: malformed quote`);
    return false;
  }
  try {
    if (context.stream.isStale(event.timestamp)) {
      debug?.(`SIP stream fallback for ${symbol}: stale quote`);
      return false;
    }
  } catch {
    debug?.(`SIP stream fallback for ${symbol}: quote freshness lookup failed`);
    return false;
  }
  return true;
};

const findSnapshot = (
  data: Record<string, AlpacaStockSnapshotRaw>,
  symbol: string
): AlpacaStockSnapshotRaw | undefined => {
  const direct = data[symbol];
  if (direct) {
    return direct;
  }
  const entry = Object.entries(data).find(([key]) => normalizeSymbol(key) === symbol);
  return entry?.[1];
};

const receivedAt = (deps: StockMarketDataAccessorDeps): string =>
  deps.now?.() ?? new Date().toISOString();

const mapStreamQuote = (event: StockQuoteEvent): LatestStockQuoteRead => ({
  symbol: normalizeSymbol(event.symbol),
  bidPrice: event.bidPrice,
  bidSize: event.bidSize,
  askPrice: event.askPrice,
  askSize: event.askSize,
  ...(event.bidExchange ? { bidExchange: event.bidExchange } : {}),
  ...(event.askExchange ? { askExchange: event.askExchange } : {}),
  timestamp: event.timestamp,
  receivedAt: event.receivedAt,
  feed: "sip",
  source: "alpaca_sip_stream",
  sourceTimestamp: event.timestamp
});

const mapStreamTrade = (event: StockTradeEvent): LatestStockTradeRead => ({
  symbol: normalizeSymbol(event.symbol),
  price: event.price,
  size: event.size,
  ...(event.exchange ? { exchange: event.exchange } : {}),
  timestamp: event.timestamp,
  receivedAt: event.receivedAt,
  feed: "sip",
  source: "alpaca_sip_stream",
  sourceTimestamp: event.timestamp
});

const mapRestQuote = (
  symbol: string,
  snapshot: AlpacaStockSnapshotRaw,
  receivedAtValue: string
): LatestStockQuoteRead => {
  const timestamp = validTimestamp(snapshot.latestQuote?.t) ? snapshot.latestQuote.t : null;
  return {
    symbol,
    bidPrice: finiteNumber(snapshot.latestQuote?.bp),
    bidSize: null,
    askPrice: finiteNumber(snapshot.latestQuote?.ap),
    askSize: null,
    timestamp,
    receivedAt: receivedAtValue,
    feed: "sip",
    source: "alpaca_sip_rest",
    sourceTimestamp: timestamp
  };
};

const mapRestTrade = (
  symbol: string,
  snapshot: AlpacaStockSnapshotRaw,
  receivedAtValue: string
): LatestStockTradeRead => {
  const timestamp = validTimestamp(snapshot.latestTrade?.t) ? snapshot.latestTrade.t : null;
  return {
    symbol,
    price: finiteNumber(snapshot.latestTrade?.p),
    size: null,
    timestamp,
    receivedAt: receivedAtValue,
    feed: "sip",
    source: "alpaca_sip_rest",
    sourceTimestamp: timestamp
  };
};

const snapshotPrice = (
  snapshot: AlpacaStockSnapshotRaw
): { price: number | null; timestamp: string | null } => {
  const trade = finiteNumber(snapshot.latestTrade?.p);
  const tradeTimestamp = validTimestamp(snapshot.latestTrade?.t) ? snapshot.latestTrade.t : null;
  if (trade !== null && trade > 0) {
    return { price: trade, timestamp: tradeTimestamp };
  }

  const bid = finiteNumber(snapshot.latestQuote?.bp);
  const ask = finiteNumber(snapshot.latestQuote?.ap);
  const quoteTimestamp = validTimestamp(snapshot.latestQuote?.t) ? snapshot.latestQuote.t : null;
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) {
    return { price: Number(((bid + ask) / 2).toFixed(4)), timestamp: quoteTimestamp };
  }

  for (const value of [snapshot.minuteBar?.c, snapshot.dailyBar?.c, snapshot.prevDailyBar?.c]) {
    const barPrice = finiteNumber(value);
    if (barPrice !== null) {
      return { price: barPrice, timestamp: null };
    }
  }
  return { price: null, timestamp: null };
};

const mapRestPrice = (
  symbol: string,
  snapshot: AlpacaStockSnapshotRaw,
  receivedAtValue: string
): LatestStockPriceRead => {
  const current = snapshotPrice(snapshot);
  return {
    symbol,
    price: current.price,
    timestamp: current.timestamp,
    receivedAt: receivedAtValue,
    feed: "sip",
    source: "alpaca_sip_rest",
    sourceTimestamp: current.timestamp
  };
};

const getRestSnapshots = async (
  symbols: string[],
  deps: StockMarketDataAccessorDeps
): Promise<AlpacaBatchedSnapshotResponse<AlpacaStockSnapshotRaw>> =>
  (deps.getLatestStockSnapshots ?? getLatestStockSnapshots)(symbols);

const readFreshTrade = (
  symbol: string,
  context: StreamContext | undefined,
  debug?: (message: string) => void
): StockTradeEvent | undefined => {
  if (!context) {
    return undefined;
  }
  try {
    if (!streamReadyFor(context, symbol, debug)) {
      return undefined;
    }
  } catch {
    debug?.(`SIP stream fallback for ${symbol}: readiness lookup failed`);
    return undefined;
  }
  try {
    const event = context.stream.getLatestTrade(symbol);
    return isFreshTrade(event, symbol, context, debug) ? event : undefined;
  } catch {
    debug?.(`SIP stream fallback for ${symbol}: trade lookup failed`);
    return undefined;
  }
};

const readFreshQuote = (
  symbol: string,
  context: StreamContext | undefined,
  debug?: (message: string) => void
): StockQuoteEvent | undefined => {
  if (!context) {
    return undefined;
  }
  try {
    if (!streamReadyFor(context, symbol, debug)) {
      return undefined;
    }
  } catch {
    debug?.(`SIP stream fallback for ${symbol}: readiness lookup failed`);
    return undefined;
  }
  try {
    const event = context.stream.getLatestQuote(symbol);
    return isFreshQuote(event, symbol, context, debug) ? event : undefined;
  } catch {
    debug?.(`SIP stream fallback for ${symbol}: quote lookup failed`);
    return undefined;
  }
};

const getStreamPrice = (
  symbol: string,
  context: StreamContext | undefined,
  debug?: (message: string) => void
): LatestStockPriceRead | undefined => {
  const trade = readFreshTrade(symbol, context, debug);
  if (trade) {
    return {
      symbol,
      price: trade.price,
      timestamp: trade.timestamp,
      receivedAt: trade.receivedAt,
      feed: "sip",
      source: "alpaca_sip_stream",
      sourceTimestamp: trade.timestamp
    };
  }

  const quote = readFreshQuote(symbol, context, debug);
  if (!quote || quote.bidPrice <= 0 || quote.askPrice <= 0 || quote.askPrice < quote.bidPrice) {
    return undefined;
  }
  return {
    symbol,
    price: Number(((quote.bidPrice + quote.askPrice) / 2).toFixed(4)),
    timestamp: quote.timestamp,
    receivedAt: quote.receivedAt,
    feed: "sip",
    source: "alpaca_sip_stream",
    sourceTimestamp: quote.timestamp
  };
};

export const getLatestStockQuote = async (
  symbol: string,
  deps: StockMarketDataAccessorDeps = {}
): Promise<LatestStockQuoteRead | undefined> => {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) {
    return undefined;
  }

  const context = getStreamContext(deps, deps.debug);
  const streamQuote = readFreshQuote(normalizedSymbol, context, deps.debug);
  if (streamQuote) {
    return mapStreamQuote(streamQuote);
  }

  const response = await getRestSnapshots([normalizedSymbol], deps);
  const snapshot = findSnapshot(response.data, normalizedSymbol);
  return snapshot ? mapRestQuote(normalizedSymbol, snapshot, receivedAt(deps)) : undefined;
};

export const getLatestStockTrade = async (
  symbol: string,
  deps: StockMarketDataAccessorDeps = {}
): Promise<LatestStockTradeRead | undefined> => {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) {
    return undefined;
  }

  const context = getStreamContext(deps, deps.debug);
  const streamTrade = readFreshTrade(normalizedSymbol, context, deps.debug);
  if (streamTrade) {
    return mapStreamTrade(streamTrade);
  }

  const response = await getRestSnapshots([normalizedSymbol], deps);
  const snapshot = findSnapshot(response.data, normalizedSymbol);
  return snapshot ? mapRestTrade(normalizedSymbol, snapshot, receivedAt(deps)) : undefined;
};

export const getLatestStockPrices = async (
  symbols: string[],
  deps: StockMarketDataAccessorDeps = {}
): Promise<StockPriceBatchResponse> => {
  const normalizedSymbols = normalizeSymbols(symbols);
  const data: Record<string, LatestStockPriceRead> = {};
  const restSymbols: string[] = [];
  const context = getStreamContext(deps, deps.debug);

  for (const symbol of normalizedSymbols) {
    const streamPrice = getStreamPrice(symbol, context, deps.debug);
    if (streamPrice) {
      data[symbol] = streamPrice;
    } else {
      restSymbols.push(symbol);
    }
  }

  if (restSymbols.length === 0) {
    return { data, requestIds: [] };
  }

  const response = await getRestSnapshots(restSymbols, deps);
  const receivedAtValue = receivedAt(deps);
  for (const symbol of restSymbols) {
    const snapshot = findSnapshot(response.data, symbol);
    if (snapshot) {
      data[symbol] = mapRestPrice(symbol, snapshot, receivedAtValue);
    }
  }
  return { data, requestIds: response.requestIds };
};
