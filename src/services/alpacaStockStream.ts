import WebSocket from "ws";
import { config, type AlpacaStockStreamConfig } from "../config.js";
import { getAlpacaPaperCredentials } from "./alpacaClient.js";

export interface StockTradeEvent {
  type: "trade";
  symbol: string;
  price: number;
  size: number;
  exchange?: string;
  timestamp: string;
  receivedAt: string;
  feed: "sip";
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
  feed: "sip";
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
  feed: "sip";
}

export interface AlpacaStockStreamStatus {
  enabled: boolean;
  connected: boolean;
  authenticated: boolean;
  subscribed: boolean;
  feed: "sip";
  symbols: string[];
  connectedAt?: string;
  lastMessageAt?: string;
  reconnectAttempts: number;
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
}

type StreamMessage = Record<string, unknown>;

const OPEN_STATE = 1;

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
  private readonly latestTrades = new Map<string, StockTradeEvent>();
  private readonly latestQuotes = new Map<string, StockQuoteEvent>();
  private readonly latestBars = new Map<string, StockBarEvent>();

  constructor(options: AlpacaStockStreamOptions = {}) {
    this.streamConfig = options.config ?? config.alpaca.stockStream;
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
      feed: "sip",
      symbols: [...this.symbols],
      reconnectAttempts: this.reconnectAttempts
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
      }
      return;
    }

    if (messageType === "q") {
      const event = this.normalizeQuote(message, receivedAt);
      if (event) {
        this.latestQuotes.set(event.symbol, event);
      }
      return;
    }

    if (messageType === "b") {
      const event = this.normalizeBar(message, receivedAt);
      if (event) {
        this.latestBars.set(event.symbol, event);
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
      feed: "sip"
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
      feed: "sip"
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
      feed: "sip"
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
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.streamConfig.reconnectMs);
    this.logger.info("Alpaca SIP stream reconnect scheduled");
  }

  private normalizeLookupSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }
}

export const alpacaStockStream = new AlpacaStockStreamService();
