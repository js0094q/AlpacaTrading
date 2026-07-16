import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type {
  AlpacaBatchedSnapshotResponse,
  AlpacaStockSnapshotRaw
} from "../src/services/alpacaClient.js";
import type {
  AlpacaStockStreamStatus,
  StockBarEvent,
  StockQuoteEvent,
  StockTradeEvent
} from "../src/services/alpacaStockStream.js";
import {
  getLatestStockPrices,
  getLatestStockQuote,
  getLatestStockTrade,
  type StockMarketDataAccessorDeps
} from "../src/services/stockMarketDataAccessor.js";

const now = "2026-07-16T15:00:30.000Z";
const eventTimestamp = "2026-07-16T15:00:29.000Z";

const streamStatus = (overrides: Partial<AlpacaStockStreamStatus> = {}): AlpacaStockStreamStatus => ({
  enabled: true,
  connected: true,
  authenticated: true,
  subscribed: true,
  feed: "sip",
  symbols: ["AAPL", "MSFT", "SPY"],
  reconnectAttempts: 0,
  ...overrides
});

const quoteEvent = (overrides: Partial<StockQuoteEvent> = {}): StockQuoteEvent => ({
  type: "quote",
  symbol: "AAPL",
  bidPrice: 199.9,
  bidSize: 10,
  askPrice: 200.1,
  askSize: 12,
  bidExchange: "D",
  askExchange: "Q",
  timestamp: eventTimestamp,
  receivedAt: now,
  feed: "sip",
  ...overrides
});

const tradeEvent = (overrides: Partial<StockTradeEvent> = {}): StockTradeEvent => ({
  type: "trade",
  symbol: "AAPL",
  price: 200,
  size: 5,
  exchange: "D",
  timestamp: eventTimestamp,
  receivedAt: now,
  feed: "sip",
  ...overrides
});

const barEvent = (overrides: Partial<StockBarEvent> = {}): StockBarEvent => ({
  type: "bar",
  symbol: "AAPL",
  open: 198,
  high: 201,
  low: 197,
  close: 200,
  volume: 10_000,
  timestamp: eventTimestamp,
  receivedAt: now,
  feed: "sip",
  ...overrides
});

const restSnapshot = (overrides: Partial<AlpacaStockSnapshotRaw> = {}): AlpacaStockSnapshotRaw => ({
  latestTrade: { p: 190, t: "2026-07-16T15:00:20.000Z" },
  latestQuote: { bp: 189.9, ap: 190.1, t: "2026-07-16T15:00:21.000Z" },
  minuteBar: { c: 189 },
  dailyBar: { c: 188 },
  prevDailyBar: { c: 187 },
  ...overrides
});

const makeRest = (snapshot: AlpacaStockSnapshotRaw = restSnapshot()) => {
  const calls: string[][] = [];
  const getLatestStockSnapshots = async (
    symbols: string[]
  ): Promise<AlpacaBatchedSnapshotResponse<AlpacaStockSnapshotRaw>> => {
    calls.push([...symbols]);
    return {
      data: Object.fromEntries(symbols.map((symbol) => [symbol, snapshot])),
      requestIds: ["rest-request-id"],
      status: 200,
      urls: ["https://data.alpaca.markets/v2/stocks/snapshots?feed=sip"]
    };
  };
  return { calls, getLatestStockSnapshots };
};

const makeStream = (overrides: Partial<{
  status: AlpacaStockStreamStatus;
  quote: StockQuoteEvent | undefined;
  trade: StockTradeEvent | undefined;
  bar: StockBarEvent | undefined;
  getStatus: () => AlpacaStockStreamStatus;
  getLatestQuote: (symbol: string) => StockQuoteEvent | undefined;
  getLatestTrade: (symbol: string) => StockTradeEvent | undefined;
  isStale: (timestamp?: string) => boolean;
}> = {}) => ({
  getStatus: overrides.getStatus ?? (() => overrides.status ?? streamStatus()),
    getLatestQuote:
      overrides.getLatestQuote ??
      (() => ("quote" in overrides ? overrides.quote : quoteEvent())),
    getLatestTrade:
      overrides.getLatestTrade ??
      (() => ("trade" in overrides ? overrides.trade : tradeEvent())),
  getLatestBar: () => overrides.bar ?? barEvent(),
  isStale: overrides.isStale ?? (() => false)
});

const deps = (overrides: Partial<StockMarketDataAccessorDeps> = {}) => ({
  now: () => now,
  ...overrides
});

describe("fresh SIP stock stream selection", () => {
  test("prefers a fresh stream quote over REST", async () => {
    const rest = makeRest();
    const result = await getLatestStockQuote("aapl", deps({
      stream: makeStream({ quote: quoteEvent({ bidPrice: 201, askPrice: 202 }) }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result?.source, "alpaca_sip_stream");
    assert.equal(result?.feed, "sip");
    assert.equal(result?.bidPrice, 201);
    assert.equal(result?.sourceTimestamp, eventTimestamp);
    assert.equal(result?.receivedAt, now);
    assert.deepEqual(rest.calls, []);
  });

  test("prefers a fresh stream trade over REST", async () => {
    const rest = makeRest();
    const result = await getLatestStockTrade("AAPL", deps({
      stream: makeStream({ trade: tradeEvent({ price: 202.5 }) }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result?.source, "alpaca_sip_stream");
    assert.equal(result?.price, 202.5);
    assert.equal(result?.sourceTimestamp, eventTimestamp);
    assert.deepEqual(rest.calls, []);
  });

  test("uses SIP REST when streaming is disabled", async () => {
    const rest = makeRest();
    const result = await getLatestStockQuote("AAPL", deps({
      stream: makeStream({ status: streamStatus({ enabled: false }) }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result?.source, "alpaca_sip_rest");
    assert.equal(result?.bidPrice, 189.9);
    assert.deepEqual(rest.calls, [["AAPL"]]);
    assert.equal(new URL("https://data.alpaca.markets/v2/stocks/snapshots?feed=sip").searchParams.get("feed"), "sip");
  });

  test("uses SIP REST when the socket is disconnected", async () => {
    const rest = makeRest();
    const result = await getLatestStockTrade("AAPL", deps({
      stream: makeStream({ status: streamStatus({ connected: false }) }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result?.source, "alpaca_sip_rest");
    assert.equal(result?.price, 190);
    assert.deepEqual(rest.calls, [["AAPL"]]);
  });

  test("uses SIP REST when authentication or subscription is incomplete", async () => {
    for (const status of [
      streamStatus({ authenticated: false }),
      streamStatus({ subscribed: false })
    ]) {
      const rest = makeRest();
      const result = await getLatestStockQuote("AAPL", deps({
        stream: makeStream({ status }),
        getLatestStockSnapshots: rest.getLatestStockSnapshots
      }));

      assert.equal(result?.source, "alpaca_sip_rest");
      assert.deepEqual(rest.calls, [["AAPL"]]);
    }
  });

  test("uses SIP REST when the requested symbol is missing from stream coverage", async () => {
    const rest = makeRest();
    const result = await getLatestStockTrade("TSLA", deps({
      stream: makeStream({
        status: streamStatus({ symbols: ["AAPL"] }),
        trade: tradeEvent({ symbol: "TSLA" })
      }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result?.source, "alpaca_sip_rest");
    assert.deepEqual(rest.calls, [["TSLA"]]);
  });

  test("uses SIP REST when stream state is stale or its timestamp is malformed", async () => {
    for (const stream of [
      makeStream({ isStale: () => true }),
      makeStream({ quote: quoteEvent({ timestamp: "not-a-timestamp" }) })
    ]) {
      const rest = makeRest();
      const result = await getLatestStockQuote("AAPL", deps({
        stream,
        getLatestStockSnapshots: rest.getLatestStockSnapshots
      }));

      assert.equal(result?.source, "alpaca_sip_rest");
      assert.deepEqual(rest.calls, [["AAPL"]]);
    }
  });

  test("uses SIP REST when a stream lookup throws", async () => {
    const rest = makeRest();
    const result = await getLatestStockQuote("AAPL", deps({
      stream: makeStream({
        getLatestQuote: () => {
          throw new Error("stream lookup failed");
        }
      }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result?.source, "alpaca_sip_rest");
    assert.deepEqual(rest.calls, [["AAPL"]]);
  });

  test("selects fresh stream prices and REST prices only for uncovered symbols", async () => {
    const rest = makeRest();
    const result = await getLatestStockPrices(["AAPL", "MSFT"], deps({
      stream: makeStream({
        quote: quoteEvent({ symbol: "AAPL", bidPrice: 210, askPrice: 212 }),
        trade: tradeEvent({ symbol: "AAPL", price: 211 })
      }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result.data.AAPL?.source, "alpaca_sip_stream");
    assert.equal(result.data.AAPL?.price, 211);
    assert.equal(result.data.MSFT?.source, "alpaca_sip_rest");
    assert.equal(result.data.MSFT?.price, 190);
    assert.deepEqual(rest.calls, [["MSFT"]]);
    assert.deepEqual(result.requestIds, ["rest-request-id"]);
  });

  test("does not use stream bars to fabricate a current quote or trade", async () => {
    const rest = makeRest();
    const result = await getLatestStockQuote("AAPL", deps({
      stream: makeStream({ quote: undefined, trade: undefined, bar: barEvent() }),
      getLatestStockSnapshots: rest.getLatestStockSnapshots
    }));

    assert.equal(result?.source, "alpaca_sip_rest");
    assert.deepEqual(rest.calls, [["AAPL"]]);
  });
});
