import WebSocket from "ws";
import { seedUniverse } from "../config/universe.seed.js";
import { getAlpacaPaperCredentials } from "./alpacaClient.js";

export interface AlpacaStockStreamConfig {
  enabled: boolean;
  url: string;
  symbols: string[];
  trades: boolean;
  quotes: boolean;
  bars: boolean;
  reconnectMs: number;
  reconnectMaxMs: number;
  staleAfterMs: number;
}

export type AlpacaStockFeed =
  | "sip"
  | "iex"
  | "delayed_sip"
  | "boats"
  | "overnight"
  | "otc"
  | "test"
  | "unknown";

export interface StockTradeEvent {
  type: "trade";
  symbol: string;
  price: number;
  size: number;
  exchange?: string;
  timestamp: string;
  receivedAt: string;
  feed: AlpacaStockFeed;
  provider: "alpaca";
  environment: "paper";
  providerTimestamp: string;
  receiptTimestamp: string;
}

export interface StockQuoteEvent {
  type: "quote";
  symbol: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  bidExchange?: string;
  askExchange?: string;
  timestamp: string;
  receivedAt: string;
  feed: AlpacaStockFeed;
  provider: "alpaca";
  environment: "paper";
  providerTimestamp: string;
  receiptTimestamp: string;
}

export interface StockBarEvent {
  type: "bar";
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount?: number;
  vwap?: number;
  timestamp: string;
  receivedAt: string;
  feed: AlpacaStockFeed;
  provider: "alpaca";
  environment: "paper";
  providerTimestamp: string;
  receiptTimestamp: string;
}

export interface AlpacaStockStreamStatus {
  enabled: boolean;
  connected: boolean;
  authenticated: boolean;
  subscribed: boolean;
  provider: "alpaca";
  feed: AlpacaStockFeed;
  environment: "paper";
  symbols: string[];
  connectedAt?: string;
  lastMessageAt?: string;
  reconnectAttempts: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  lastReconnectDelayMs?: number;
  nextReconnectAt?: string;
  lastError?: string;
}

export interface AlpacaStockStreamHealth extends AlpacaStockStreamStatus {
  symbolCount: number;
  healthy: boolean;
  degraded: boolean;
}

export interface AlpacaStockStreamLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AlpacaStockWebSocket {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): this;
  send(payload: string): void;
  close(): void;
}

export interface AlpacaStockStreamCredentials {
  apiKey: string;
  secretKey: string;
}

export interface AlpacaStockStreamOptions {
  config?: AlpacaStockStreamConfig;
  credentialsProvider?: () => AlpacaStockStreamCredentials;
  webSocketFactory?: (url: string) => AlpacaStockWebSocket;
  logger?: AlpacaStockStreamLogger;
  now?: () => Date;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  onEvent?: (event: StockTradeEvent | StockQuoteEvent | StockBarEvent) => void | Promise<void>;
}

type StreamMessage = Record<string, unknown>;
export type AlpacaStockStreamEvent = StockTradeEvent | StockQuoteEvent | StockBarEvent;
export type AlpacaStockStreamSubscriber = (
  event: AlpacaStockStreamEvent
) => void | Promise<void>;

const OPEN_STATE = 1;

const boolean = (value: string | undefined, fallback = false) =>
  value === undefined || value.trim() === "" ? fallback : value === "true" || value === "1";
const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const defaultStreamConfig = (): AlpacaStockStreamConfig => ({
  enabled: boolean(process.env.ALPACA_STOCK_STREAM_ENABLED),
  url: process.env.ALPACA_STOCK_STREAM_URL?.trim() || "wss://stream.data.alpaca.markets/v2/sip",
  symbols: normalizeStockSymbols(
    (process.env.ALPACA_STOCK_STREAM_SYMBOLS?.trim() || seedUniverse.join(",")).split(",")
  ),
  trades: boolean(process.env.ALPACA_STOCK_STREAM_TRADES, true),
  quotes: boolean(process.env.ALPACA_STOCK_STREAM_QUOTES, true),
  bars: boolean(process.env.ALPACA_STOCK_STREAM_BARS, true),
  reconnectMs: integer(process.env.ALPACA_STOCK_STREAM_RECONNECT_MS, 5_000),
  reconnectMaxMs: Math.max(
    integer(process.env.ALPACA_STOCK_STREAM_RECONNECT_MS, 5_000),
    integer(process.env.ALPACA_STOCK_STREAM_RECONNECT_MAX_MS, 60_000)
  ),
  staleAfterMs: Math.max(1, integer(process.env.ALPACA_STOCK_STREAM_STALE_AFTER_MS, 30_000))
});

const defaultLogger: AlpacaStockStreamLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message)
};

export const normalizeStockSymbols = (symbols: string[]): string[] =>
  Array.from(
    new Set(
      symbols
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean)
    )
  );

const supportedFeeds = new Set<AlpacaStockFeed>([
  "sip",
  "iex",
  "delayed_sip",
  "boats",
  "overnight",
  "otc",
  "test"
]);

export const stockFeedFromStreamUrl = (url: string): AlpacaStockFeed => {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1)?.toLowerCase();
    return segment && supportedFeeds.has(segment as AlpacaStockFeed)
      ? segment as AlpacaStockFeed
      : "unknown";
  } catch {
    return "unknown";
  }
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const toTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return value;
};

const toSymbol = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const symbol = value.trim().toUpperCase();
  return symbol || undefined;
};

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const rawMessageToText = (raw: unknown): string => {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return typeof raw === "object" && raw !== null ? JSON.stringify(raw) : "";
};

export class AlpacaStockStreamService {
  private readonly streamConfig: AlpacaStockStreamConfig;
  private readonly credentialsProvider: () => AlpacaStockStreamCredentials;
  private readonly webSocketFactory: (url: string) => AlpacaStockWebSocket;
  private readonly logger: AlpacaStockStreamLogger;
  private readonly now: () => Date;
  private readonly setTimeoutFn: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly eventSubscribers = new Set<AlpacaStockStreamSubscriber>();
  private readonly feed: AlpacaStockFeed;

  private symbols: string[];
  private socket: AlpacaStockWebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private intentionalStop = false;
  private connected = false;
  private authenticated = false;
  private subscribed = false;
  private connectedAt: string | undefined;
  private lastMessageAt: string | undefined;
  private lastError: string | undefined;
  private reconnectAttempts = 0;
  private lastReconnectDelayMs: number | undefined;
  private nextReconnectAt: string | undefined;
  private readonly latestTrades = new Map<string, StockTradeEvent>();
  private readonly latestQuotes = new Map<string, StockQuoteEvent>();
  private readonly latestBars = new Map<string, StockBarEvent>();

  constructor(options: AlpacaStockStreamOptions = {}) {
    this.streamConfig = options.config ?? defaultStreamConfig();
    this.feed = stockFeedFromStreamUrl(this.streamConfig.url);
    this.symbols = normalizeStockSymbols(this.streamConfig.symbols);
    this.credentialsProvider =
      options.credentialsProvider ?? (() => {
        const credentials = getAlpacaPaperCredentials();
        return { apiKey: credentials.apiKey, secretKey: credentials.secretKey };
      });
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as AlpacaStockWebSocket);
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    if (options.onEvent) {
      this.eventSubscribers.add(options.onEvent);
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.intentionalStop = false;

    if (!this.streamConfig.enabled) {
      this.running = false;
      return;
    }

    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.intentionalStop = true;

    if (this.reconnectTimer !== undefined) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    this.authenticated = false;
    this.subscribed = false;
    this.connectedAt = undefined;
    this.nextReconnectAt = undefined;

    if (socket && socket.readyState !== 3) {
      try {
        socket.close();
      } catch {
        // The stream is already stopping; no reconnect is scheduled.
      }
    }
  }

  async setSymbols(symbols: string[]): Promise<void> {
    const nextSymbols = normalizeStockSymbols(symbols);
    const previousSymbols = new Set(this.symbols);
    const nextSymbolSet = new Set(nextSymbols);
    const added = nextSymbols.filter((symbol) => !previousSymbols.has(symbol));
    const removed = this.symbols.filter((symbol) => !nextSymbolSet.has(symbol));
    this.symbols = nextSymbols;

    if (this.socket && this.authenticated) {
      if (added.length > 0) {
        this.sendSubscription("subscribe", added);
      }
      if (removed.length > 0) {
        this.sendSubscription("unsubscribe", removed);
      }
    }
  }

  subscribe(subscriber: AlpacaStockStreamSubscriber): () => void {
    this.eventSubscribers.add(subscriber);
    return () => {
      this.eventSubscribers.delete(subscriber);
    };
  }

  getLatestTrade(symbol: string): StockTradeEvent | undefined {
    return this.latestTrades.get(this.normalizeLookupSymbol(symbol));
  }

  getLatestQuote(symbol: string): StockQuoteEvent | undefined {
    return this.latestQuotes.get(this.normalizeLookupSymbol(symbol));
  }

  getLatestBar(symbol: string): StockBarEvent | undefined {
    return this.latestBars.get(this.normalizeLookupSymbol(symbol));
  }

  getStatus(): AlpacaStockStreamStatus {
    const status: AlpacaStockStreamStatus = {
      enabled: this.streamConfig.enabled,
      connected: this.connected,
      authenticated: this.authenticated,
      subscribed: this.subscribed,
      provider: "alpaca",
      feed: this.feed,
      environment: "paper",
      symbols: [...this.symbols],
      reconnectAttempts: this.reconnectAttempts,
      reconnectBaseMs: this.streamConfig.reconnectMs,
      reconnectMaxMs: this.streamConfig.reconnectMaxMs
    };
    if (this.connectedAt) {
      status.connectedAt = this.connectedAt;
    }
    if (this.lastMessageAt) {
      status.lastMessageAt = this.lastMessageAt;
    }
    if (this.lastError) {
      status.lastError = this.lastError;
    }
    if (this.lastReconnectDelayMs !== undefined) {
      status.lastReconnectDelayMs = this.lastReconnectDelayMs;
    }
    if (this.nextReconnectAt) {
      status.nextReconnectAt = this.nextReconnectAt;
    }
    return status;
  }

  isStale(timestamp?: string): boolean {
    if (!timestamp) {
      return true;
    }
    const parsedAt = Date.parse(timestamp);
    if (!Number.isFinite(parsedAt)) {
      return true;
    }
    return this.now().getTime() - parsedAt > this.streamConfig.staleAfterMs;
  }

  getHealth(options: { marketActive?: boolean } = {}): AlpacaStockStreamHealth {
    const status = this.getStatus();
    let degraded = false;
    if (status.enabled) {
      degraded = !status.connected || !status.authenticated || !status.subscribed;
      if (options.marketActive && (!status.lastMessageAt || this.isStale(status.lastMessageAt))) {
        degraded = true;
      }
    }
    return {
      ...status,
      symbolCount: status.symbols.length,
      healthy: !degraded,
      degraded
    };
  }

  private connect(): void {
    if (!this.running || !this.streamConfig.enabled || this.socket) {
      return;
    }

    let credentials: AlpacaStockStreamCredentials;
    try {
      credentials = this.credentialsProvider();
    } catch {
      this.lastError = "credential_configuration_unavailable";
      this.scheduleReconnect();
      return;
    }

    this.logger.info("Alpaca SIP stream connecting");

    let socket: AlpacaStockWebSocket;
    try {
      socket = this.webSocketFactory(this.streamConfig.url);
    } catch {
      this.lastError = "connection_failed";
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket || !this.running || this.intentionalStop) {
        return;
      }
      this.connected = true;
      this.authenticated = false;
      this.subscribed = false;
      this.connectedAt = this.now().toISOString();
      this.nextReconnectAt = undefined;
      this.lastError = undefined;
      this.send({ action: "auth", key: credentials.apiKey, secret: credentials.secretKey });
    });
    socket.on("message", (raw) => this.handleRawMessage(socket, raw));
    socket.on("error", () => this.handleSocketError(socket));
    socket.on("close", () => this.handleSocketClose(socket));
  }

  private handleRawMessage(socket: AlpacaStockWebSocket, raw: unknown): void {
    if (this.socket !== socket) {
      return;
    }

    const text = rawMessageToText(raw);
    if (!text) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        continue;
      }
      this.handleMessage(socket, message as StreamMessage);
    }
  }

  private handleMessage(socket: AlpacaStockWebSocket, message: StreamMessage): void {
    if (this.socket !== socket) {
      return;
    }

    const receivedAt = this.now().toISOString();
    this.lastMessageAt = receivedAt;
    const messageType = typeof message.T === "string" ? message.T : "";

    if (messageType === "success" && message.msg === "authenticated") {
      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.lastReconnectDelayMs = undefined;
      this.nextReconnectAt = undefined;
      this.lastError = undefined;
      this.logger.info("Alpaca SIP stream authenticated");
      this.subscribed = this.sendSubscription("subscribe", this.symbols);
      if (this.subscribed) {
        this.logger.info(`Alpaca SIP stream subscribed to ${this.symbols.length} symbols`);
      }
      return;
    }

    if (messageType === "subscription") {
      this.subscribed = true;
      return;
    }

    if (messageType === "error") {
      this.lastError = "alpaca_stream_error";
      return;
    }

    if (messageType === "t") {
      const event = this.normalizeTrade(message, receivedAt);
      if (event) {
        this.latestTrades.set(event.symbol, event);
        this.persistEvent(event);
      }
      return;
    }

    if (messageType === "q") {
      const event = this.normalizeQuote(message, receivedAt);
      if (event) {
        this.latestQuotes.set(event.symbol, event);
        this.persistEvent(event);
      }
      return;
    }

    if (messageType === "b") {
      const event = this.normalizeBar(message, receivedAt);
      if (event) {
        this.latestBars.set(event.symbol, event);
        this.persistEvent(event);
      }
    }
  }

  private normalizeTrade(message: StreamMessage, receivedAt: string): StockTradeEvent | undefined {
    const symbol = toSymbol(message.S);
    const price = toFiniteNumber(message.p);
    const size = toFiniteNumber(message.s);
    const timestamp = toTimestamp(message.t);
    if (!symbol || price === undefined || size === undefined || !timestamp) {
      return undefined;
    }
    return {
      type: "trade",
      symbol,
      price,
      size,
      ...(toOptionalString(message.x) ? { exchange: toOptionalString(message.x) } : {}),
      timestamp,
      receivedAt,
      feed: this.feed,
      provider: "alpaca",
      environment: "paper",
      providerTimestamp: timestamp,
      receiptTimestamp: receivedAt
    };
  }

  private normalizeQuote(message: StreamMessage, receivedAt: string): StockQuoteEvent | undefined {
    const symbol = toSymbol(message.S);
    const bidPrice = toFiniteNumber(message.bp);
    const bidSize = toFiniteNumber(message.bs);
    const askPrice = toFiniteNumber(message.ap);
    const askSize = toFiniteNumber(message.as);
    const timestamp = toTimestamp(message.t);
    if (
      !symbol ||
      bidPrice === undefined ||
      bidSize === undefined ||
      askPrice === undefined ||
      askSize === undefined ||
      !timestamp
    ) {
      return undefined;
    }
    return {
      type: "quote",
      symbol,
      bidPrice,
      bidSize,
      askPrice,
      askSize,
      ...(toOptionalString(message.bx) ? { bidExchange: toOptionalString(message.bx) } : {}),
      ...(toOptionalString(message.ax) ? { askExchange: toOptionalString(message.ax) } : {}),
      timestamp,
      receivedAt,
      feed: this.feed,
      provider: "alpaca",
      environment: "paper",
      providerTimestamp: timestamp,
      receiptTimestamp: receivedAt
    };
  }

  private normalizeBar(message: StreamMessage, receivedAt: string): StockBarEvent | undefined {
    const symbol = toSymbol(message.S);
    const open = toFiniteNumber(message.o);
    const high = toFiniteNumber(message.h);
    const low = toFiniteNumber(message.l);
    const close = toFiniteNumber(message.c);
    const volume = toFiniteNumber(message.v);
    const timestamp = toTimestamp(message.t);
    if (
      !symbol ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined ||
      volume === undefined ||
      !timestamp
    ) {
      return undefined;
    }
    const tradeCount = toFiniteNumber(message.n);
    const vwap = toFiniteNumber(message.vw);
    return {
      type: "bar",
      symbol,
      open,
      high,
      low,
      close,
      volume,
      ...(tradeCount !== undefined ? { tradeCount } : {}),
      ...(vwap !== undefined ? { vwap } : {}),
      timestamp,
      receivedAt,
      feed: this.feed,
      provider: "alpaca",
      environment: "paper",
      providerTimestamp: timestamp,
      receiptTimestamp: receivedAt
    };
  }

  private sendSubscription(action: "subscribe" | "unsubscribe", symbols: string[]): boolean {
    const symbolList = normalizeStockSymbols(symbols);
    return this.send({
      action,
      trades: this.streamConfig.trades ? symbolList : [],
      quotes: this.streamConfig.quotes ? symbolList : [],
      bars: this.streamConfig.bars ? symbolList : []
    });
  }

  private send(payload: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== OPEN_STATE) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      this.lastError = "send_failed";
      return false;
    }
  }

  private handleSocketError(socket: AlpacaStockWebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.lastError = "socket_error";
    try {
      socket.close();
    } catch {
      // The close handler below still owns state cleanup when close itself fails.
    }
    this.handleSocketClose(socket);
  }

  private handleSocketClose(socket: AlpacaStockWebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.connected = false;
    this.authenticated = false;
    this.subscribed = false;
    this.connectedAt = undefined;
    this.logger.info("Alpaca SIP stream disconnected");
    if (this.running && !this.intentionalStop) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.intentionalStop || this.reconnectTimer !== undefined) {
      return;
    }
    this.reconnectAttempts += 1;
    const exponent = Math.min(this.reconnectAttempts - 1, 30);
    const delayMs = Math.min(
      this.streamConfig.reconnectMaxMs,
      this.streamConfig.reconnectMs * 2 ** exponent
    );
    this.lastReconnectDelayMs = delayMs;
    this.nextReconnectAt = new Date(this.now().getTime() + delayMs).toISOString();
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.logger.info("Alpaca SIP stream reconnect scheduled");
  }

  private normalizeLookupSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }

  private persistEvent(event: AlpacaStockStreamEvent): void {
    for (const subscriber of this.eventSubscribers) {
      Promise.resolve().then(() => subscriber(event)).catch(() => {
        this.lastError = "stream_consumer_failed";
        this.logger.warn("Alpaca stock stream consumer failed");
      });
    }
  }
}

const sharedStockStreams = new Map<string, AlpacaStockStreamService>();

const sharedStreamKey = (config: AlpacaStockStreamConfig) => {
  try {
    const url = new URL(config.url);
    url.hash = "";
    return url.toString();
  } catch {
    return config.url.trim();
  }
};

export const getSharedAlpacaStockStream = (
  options: AlpacaStockStreamOptions = {}
): AlpacaStockStreamService => {
  const config = options.config ?? defaultStreamConfig();
  const key = sharedStreamKey(config);
  const existing = sharedStockStreams.get(key);
  if (existing) {
    if (options.onEvent) {
      existing.subscribe(options.onEvent);
    }
    void existing.setSymbols(normalizeStockSymbols([
      ...existing.getStatus().symbols,
      ...config.symbols
    ]));
    return existing;
  }
  const created = new AlpacaStockStreamService({ ...options, config });
  sharedStockStreams.set(key, created);
  return created;
};

export const alpacaStockStream = getSharedAlpacaStockStream();
