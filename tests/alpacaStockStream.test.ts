import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = "/Users/josephstewart/Documents/Alpaca Trading";

process.env.TRADING_MODE = "paper";
process.env.ALPACA_ENV = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_PAPER_API_KEY = "test-paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "test-paper-secret";
process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
process.env.ALPACA_DATA_BASE_URL = "https://data.alpaca.markets";
process.env.ALPACA_STOCK_STREAM_ENABLED = "false";
process.env.ALPACA_STOCK_STREAM_SYMBOLS = " aapl, MSFT, aapl, , spy ";
process.env.ALPACA_STOCK_STREAM_TRADES = "true";
process.env.ALPACA_STOCK_STREAM_QUOTES = "true";
process.env.ALPACA_STOCK_STREAM_BARS = "true";
process.env.ALPACA_STOCK_STREAM_RECONNECT_MS = "5000";
process.env.ALPACA_STOCK_STREAM_STALE_AFTER_MS = "30000";
process.env.ALPACA_STOCK_STREAM_URL = "wss://stream.data.alpaca.markets/v2/sip";

const [configModule, streamModule] = await Promise.all([
  import("../src/config.js"),
  import("../src/services/alpacaStockStream.js")
]);

const { config } = configModule;
const { AlpacaStockStreamService } = streamModule;

type AlpacaStockStreamConfig = {
  enabled: boolean;
  url: string;
  symbols: string[];
  trades: boolean;
  quotes: boolean;
  bars: boolean;
  reconnectMs: number;
  staleAfterMs: number;
};

type AlpacaStockStreamLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type Listener = (...args: unknown[]) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", 1000, "closed");
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  message(payload: unknown) {
    this.emit("message", typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  error(error: Error) {
    this.emit("error", error);
  }

  closeUnexpectedly() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", 1006, "unexpected");
  }

  private emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) || []) {
      listener(...args);
    }
  }
}

class ManualTimers {
  readonly callbacks: Array<() => void> = [];
  readonly cleared = new Set<ReturnType<typeof setTimeout>>();

  setTimeout = (callback: () => void, _delayMs: number) => {
    const handle = this.callbacks.length + 1 as unknown as ReturnType<typeof setTimeout>;
    this.callbacks.push(callback);
    return handle;
  };

  clearTimeout = (handle: ReturnType<typeof setTimeout>) => {
    this.cleared.add(handle);
  };

  runNext() {
    const callback = this.callbacks.shift();
    assert.ok(callback, "expected a scheduled callback");
    callback();
  }
}

const makeConfig = (overrides: Partial<AlpacaStockStreamConfig> = {}): AlpacaStockStreamConfig => ({
  enabled: true,
  url: "wss://stream.data.alpaca.markets/v2/sip",
  symbols: ["AAPL", "MSFT"],
  trades: true,
  quotes: true,
  bars: true,
  reconnectMs: 5_000,
  staleAfterMs: 30_000,
  ...overrides
});

const makeLogger = () => {
  const entries: string[] = [];
  const logger: AlpacaStockStreamLogger = {
    info: (message) => entries.push(`info:${message}`),
    warn: (message) => entries.push(`warn:${message}`),
    error: (message) => entries.push(`error:${message}`)
  };
  return { entries, logger };
};

const makeFixture = (overrides: Partial<AlpacaStockStreamConfig> = {}) => {
  const sockets: MockWebSocket[] = [];
  const timers = new ManualTimers();
  const logs = makeLogger();
  let now = new Date("2026-07-16T15:00:30.000Z");
  const service = new AlpacaStockStreamService({
    config: makeConfig(overrides),
    credentialsProvider: () => ({ apiKey: "paper-key", secretKey: "paper-secret" }),
    webSocketFactory: (url: string) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    logger: logs.logger,
    now: () => new Date(now),
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout
  });
  return {
    service,
    sockets,
    timers,
    logs,
    setNow: (value: string) => {
      now = new Date(value);
    }
  };
};

const authenticate = (socket: MockWebSocket) => {
  socket.open();
  socket.message({ T: "success", msg: "authenticated" });
};

const sentPayloads = (socket: MockWebSocket) => socket.sent.map((payload) => JSON.parse(payload));

const runConfigProbe = (values: Record<string, string>) => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      [
        'import { config } from "./src/config.ts";',
        "console.log(JSON.stringify(config.alpaca.stockStream));"
      ].join("\n")
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ALPACA_STOCK_STREAM_ENABLED: "",
        ALPACA_STOCK_STREAM_SYMBOLS: "",
        ALPACA_STOCK_STREAM_TRADES: "",
        ALPACA_STOCK_STREAM_QUOTES: "",
        ALPACA_STOCK_STREAM_BARS: "",
        ALPACA_STOCK_STREAM_RECONNECT_MS: "",
        ALPACA_STOCK_STREAM_STALE_AFTER_MS: "",
        ALPACA_STOCK_STREAM_URL: "",
        ...values
      },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as AlpacaStockStreamConfig;
};

describe("Alpaca SIP stock stream configuration", () => {
  test("normalizes configured symbols and validates stream settings", () => {
    assert.deepEqual(config.alpaca.stockStream, {
      enabled: false,
      url: "wss://stream.data.alpaca.markets/v2/sip",
      symbols: ["AAPL", "MSFT", "SPY"],
      trades: true,
      quotes: true,
      bars: true,
      reconnectMs: 5_000,
      staleAfterMs: 30_000
    });
  });

  test("defaults to disabled with the seeded active-universe fallback", () => {
    const resolved = runConfigProbe({});
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.url, "wss://stream.data.alpaca.markets/v2/sip");
    assert.equal(resolved.trades, true);
    assert.equal(resolved.quotes, true);
    assert.equal(resolved.bars, true);
    assert.equal(resolved.reconnectMs, 5_000);
    assert.equal(resolved.staleAfterMs, 30_000);
    assert.equal(resolved.symbols.includes("SPY"), true);
    assert.equal(resolved.symbols.includes("*"), false);
  });

  test("preserves explicit URL and setting overrides", () => {
    const resolved = runConfigProbe({
      ALPACA_STOCK_STREAM_ENABLED: "true",
      ALPACA_STOCK_STREAM_SYMBOLS: "aapl, msft, AAPL",
      ALPACA_STOCK_STREAM_TRADES: "false",
      ALPACA_STOCK_STREAM_QUOTES: "true",
      ALPACA_STOCK_STREAM_BARS: "false",
      ALPACA_STOCK_STREAM_RECONNECT_MS: "2500",
      ALPACA_STOCK_STREAM_STALE_AFTER_MS: "45000",
      ALPACA_STOCK_STREAM_URL: "wss://stream.data.alpaca.markets/v2/sip"
    });
    assert.deepEqual(resolved, {
      enabled: true,
      url: "wss://stream.data.alpaca.markets/v2/sip",
      symbols: ["AAPL", "MSFT"],
      trades: false,
      quotes: true,
      bars: false,
      reconnectMs: 2500,
      staleAfterMs: 45000
    });
  });
});

describe("Alpaca SIP stock stream service", () => {
  test("disabled configuration creates no connection", async () => {
    const fixture = makeFixture({ enabled: false });
    await fixture.service.start();
    await fixture.service.start();
    assert.equal(fixture.sockets.length, 0);
    assert.equal(fixture.service.getStatus().enabled, false);
  });

  test("authenticates only after open and subscribes only after authentication succeeds", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    assert.equal(fixture.sockets.length, 1);
    assert.equal(fixture.sockets[0]?.url, "wss://stream.data.alpaca.markets/v2/sip");
    assert.deepEqual(sentPayloads(fixture.sockets[0]!), []);

    fixture.sockets[0]!.open();
    assert.deepEqual(sentPayloads(fixture.sockets[0]!), [
      { action: "auth", key: "paper-key", secret: "paper-secret" }
    ]);

    fixture.sockets[0]!.message({ T: "success", msg: "authenticated" });
    assert.deepEqual(sentPayloads(fixture.sockets[0]!), [
      { action: "auth", key: "paper-key", secret: "paper-secret" },
      {
        action: "subscribe",
        trades: ["AAPL", "MSFT"],
        quotes: ["AAPL", "MSFT"],
        bars: ["AAPL", "MSFT"]
      }
    ]);
    assert.equal(fixture.service.getStatus().authenticated, true);
    assert.equal(fixture.service.getStatus().subscribed, true);
  });

  test("builds category arrays according to configuration", async () => {
    const fixture = makeFixture({ quotes: false });
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    assert.deepEqual(sentPayloads(fixture.sockets[0]!)[1], {
      action: "subscribe",
      trades: ["AAPL", "MSFT"],
      quotes: [],
      bars: ["AAPL", "MSFT"]
    });
  });

  test("normalizes trades, quotes, and minute bars into latest state", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);

    fixture.sockets[0]!.message({
      T: "t",
      S: "aapl",
      p: 123.45,
      s: 10,
      x: "D",
      t: "2026-07-16T15:00:00.000Z"
    });
    fixture.sockets[0]!.message({
      T: "q",
      S: "MSFT",
      bp: 500.1,
      bs: 2,
      ap: 500.2,
      as: 3,
      bx: "D",
      ax: "Q",
      t: "2026-07-16T15:00:01.000Z"
    });
    fixture.sockets[0]!.message({
      T: "b",
      S: "spy",
      o: 600,
      h: 601,
      l: 599,
      c: 600.5,
      v: 1000,
      n: 25,
      vw: 600.25,
      t: "2026-07-16T15:00:00.000Z"
    });

    assert.deepEqual(fixture.service.getLatestTrade("aapl"), {
      type: "trade",
      symbol: "AAPL",
      price: 123.45,
      size: 10,
      exchange: "D",
      timestamp: "2026-07-16T15:00:00.000Z",
      receivedAt: "2026-07-16T15:00:30.000Z",
      feed: "sip"
    });
    assert.deepEqual(fixture.service.getLatestQuote("msft"), {
      type: "quote",
      symbol: "MSFT",
      bidPrice: 500.1,
      bidSize: 2,
      askPrice: 500.2,
      askSize: 3,
      bidExchange: "D",
      askExchange: "Q",
      timestamp: "2026-07-16T15:00:01.000Z",
      receivedAt: "2026-07-16T15:00:30.000Z",
      feed: "sip"
    });
    assert.deepEqual(fixture.service.getLatestBar("SPY"), {
      type: "bar",
      symbol: "SPY",
      open: 600,
      high: 601,
      low: 599,
      close: 600.5,
      volume: 1000,
      tradeCount: 25,
      vwap: 600.25,
      timestamp: "2026-07-16T15:00:00.000Z",
      receivedAt: "2026-07-16T15:00:30.000Z",
      feed: "sip"
    });
    assert.equal(fixture.service.getStatus().lastMessageAt, "2026-07-16T15:00:30.000Z");
  });

  test("ignores malformed and unsupported messages safely", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    assert.doesNotThrow(() => {
      fixture.sockets[0]!.message({ T: "success", msg: "connected" });
      fixture.sockets[0]!.message({ T: "unknown", S: "AAPL" });
      fixture.sockets[0]!.message("not-json");
      fixture.sockets[0]!.message({ T: "t", S: "AAPL", p: "bad", s: 1, t: "bad" });
    });
    assert.equal(fixture.service.getLatestTrade("AAPL"), undefined);
  });

  test("detects stale timestamps without changing consumer behavior", () => {
    const fixture = makeFixture();
    assert.equal(fixture.service.isStale("2026-07-16T14:59:59.999Z"), true);
    assert.equal(fixture.service.isStale("2026-07-16T15:00:10.000Z"), false);
    assert.equal(fixture.service.isStale(), true);
    assert.equal(fixture.service.isStale("not-a-timestamp"), true);
  });

  test("reconnects after unexpected close and resubscribes after reauthentication", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    fixture.sockets[0]!.closeUnexpectedly();

    assert.equal(fixture.service.getStatus().connected, false);
    assert.equal(fixture.service.getStatus().reconnectAttempts, 1);
    assert.equal(fixture.timers.callbacks.length, 1);
    assert.equal(fixture.logs.entries.includes("info:Alpaca SIP stream reconnect scheduled"), true);

    fixture.timers.runNext();
    assert.equal(fixture.sockets.length, 2);
    authenticate(fixture.sockets[1]!);
    assert.deepEqual(sentPayloads(fixture.sockets[1]!), [
      { action: "auth", key: "paper-key", secret: "paper-secret" },
      {
        action: "subscribe",
        trades: ["AAPL", "MSFT"],
        quotes: ["AAPL", "MSFT"],
        bars: ["AAPL", "MSFT"]
      }
    ]);
    assert.equal(fixture.service.getStatus().reconnectAttempts, 0);
  });

  test("reconnects after socket error without creating duplicate sockets", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    await fixture.service.start();
    fixture.sockets[0]!.error(new Error("socket failed"));
    assert.equal(fixture.sockets[0]!.closeCalls, 1);
    assert.equal(fixture.sockets.length, 1);
    assert.equal(fixture.timers.callbacks.length, 1);
    fixture.timers.runNext();
    assert.equal(fixture.sockets.length, 2);
  });

  test("does not reconnect after intentional stop", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    await fixture.service.stop();
    assert.equal(fixture.sockets[0]!.closeCalls, 1);
    assert.equal(fixture.timers.callbacks.length, 0);
    fixture.sockets[0]!.closeUnexpectedly();
    assert.equal(fixture.timers.callbacks.length, 0);
    assert.equal(fixture.service.getStatus().connected, false);
  });

  test("updates subscriptions dynamically without reconnecting", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    await fixture.service.setSymbols(["aapl", "SPY", "SPY"]);
    await fixture.service.setSymbols(["SPY"]);

    assert.equal(fixture.sockets.length, 1);
    assert.deepEqual(sentPayloads(fixture.sockets[0]!).slice(2), [
      {
        action: "subscribe",
        trades: ["SPY"],
        quotes: ["SPY"],
        bars: ["SPY"]
      },
      {
        action: "unsubscribe",
        trades: ["MSFT"],
        quotes: ["MSFT"],
        bars: ["MSFT"]
      },
      {
        action: "unsubscribe",
        trades: ["AAPL"],
        quotes: ["AAPL"],
        bars: ["AAPL"]
      }
    ]);
    assert.deepEqual(fixture.service.getStatus().symbols, ["SPY"]);
  });

  test("reports sanitized status and health", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    fixture.sockets[0]!.message({
      T: "t",
      S: "AAPL",
      p: 1,
      s: 1,
      t: "2026-07-16T15:00:29.000Z"
    });
    const status = fixture.service.getStatus();
    assert.deepEqual(status, {
      enabled: true,
      connected: true,
      authenticated: true,
      subscribed: true,
      feed: "sip",
      symbols: ["AAPL", "MSFT"],
      connectedAt: "2026-07-16T15:00:30.000Z",
      lastMessageAt: "2026-07-16T15:00:30.000Z",
      reconnectAttempts: 0
    });
    const health = fixture.service.getHealth({ marketActive: true });
    assert.equal(health.healthy, true);
    assert.equal(health.degraded, false);
    assert.equal(health.symbolCount, 2);
    assert.equal(JSON.stringify(status).includes("paper-secret"), false);
  });

  test("does not emit credentials or raw auth payloads in operational logs", async () => {
    const fixture = makeFixture();
    await fixture.service.start();
    authenticate(fixture.sockets[0]!);
    fixture.sockets[0]!.closeUnexpectedly();
    const logs = fixture.logs.entries.join("\n");
    assert.equal(logs.includes("paper-key"), false);
    assert.equal(logs.includes("paper-secret"), false);
    assert.equal(logs.includes('"action":"auth"'), false);
    assert.equal(logs.includes("Alpaca SIP stream connecting"), true);
    assert.equal(logs.includes("Alpaca SIP stream authenticated"), true);
    assert.equal(logs.includes("Alpaca SIP stream subscribed to 2 symbols"), true);
    assert.equal(logs.includes("Alpaca SIP stream disconnected"), true);
  });
});
