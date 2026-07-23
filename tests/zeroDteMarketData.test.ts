import assert from "node:assert/strict";
import { test } from "node:test";

import { loadZeroDteConfig } from "../src/services/zeroDte/zeroDteConfigService.js";
import {
  collectZeroDteMarketContexts,
  createAlpacaZeroDteMarketDataProvider,
  normalizeZeroDteContract,
  type ZeroDteMarketDataProvider
} from "../src/services/zeroDte/zeroDteMarketDataService.js";

const sessionNow = "2026-07-13T14:00:00.000Z";

const bars = [
  {
    timestamp: "2026-07-13T13:59:00.000Z",
    open: 599.5,
    high: 600.5,
    low: 599.25,
    close: 600,
    volume: 10_000
  }
];

const config = loadZeroDteConfig({
  ZERO_DTE_UNDERLYINGS: "SPY",
  ZERO_DTE_MAX_STRIKES_EACH_SIDE: "3",
  ZERO_DTE_MIN_OPTION_VOLUME: "100",
  ZERO_DTE_MIN_OPEN_INTEREST: "250",
  ZERO_DTE_MAX_SPREAD_PCT: "15",
  ZERO_DTE_MIN_PREMIUM: "0.10",
  ZERO_DTE_MAX_PREMIUM: "5"
});

const makeProvider = (input: {
  isOpen?: boolean;
  contracts?: Array<Record<string, unknown>>;
  snapshots?: Record<string, Record<string, unknown>>;
  calls?: string[];
  underlyingTimestamp?: string | null;
  barRequestIds?: string[];
  contractRequestId?: string;
} = {}): ZeroDteMarketDataProvider => {
  const calls = input.calls ?? [];
  return {
    async getClock() {
      calls.push("clock");
      return {
        timestamp: sessionNow,
        isOpen: input.isOpen ?? true,
        nextClose: "2026-07-13T20:00:00.000Z",
        requestId: "clock-request-1"
      };
    },
    async getStockSnapshot(symbols) {
      calls.push(`stock:${symbols.join(",")}`);
      return {
        SPY: {
          symbol: "SPY",
          latestTrade: {
            price: 600,
            timestamp: input.underlyingTimestamp === undefined
              ? "2026-07-13T13:59:58.000Z"
              : input.underlyingTimestamp
          },
          requestId: "stock-request-1"
        }
      };
    },
    async getBars(symbol, timeframe, start, end) {
      calls.push(`bars:${symbol}:${timeframe}:${start}:${end}`);
      return { bars, requestIds: input.barRequestIds ?? [] };
    },
    async listContracts(request) {
      calls.push(`contracts:${request.underlying}:${request.expirationDate}:${request.limit}`);
      return (input.contracts ?? []).map((contract) => ({
        ...contract,
        ...(input.contractRequestId ? { requestId: input.contractRequestId } : {})
      })) as never;
    },
    async getOptionSnapshots(symbols) {
      calls.push(`options:${symbols.join(",")}`);
      return (input.snapshots ?? {}) as never;
    }
  };
};

test("refuses a closed session before requesting market data", async () => {
  const calls: string[] = [];
  const contexts = await collectZeroDteMarketContexts({
    now: sessionNow,
    config,
    provider: makeProvider({ isOpen: false, calls })
  });

  assert.deepEqual(contexts, []);
  assert.deepEqual(calls, ["clock"]);
});

test("direct Alpaca bars and contract routes fail closed outside paper-only mode", async () => {
  const previous = {
    alpacaEnv: process.env.ALPACA_ENV,
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED,
    liveTrade: process.env.ALPACA_LIVE_TRADE
  };
  process.env.ALPACA_ENV = "live";
  process.env.LIVE_TRADING_ENABLED = "false";
  process.env.ALPACA_LIVE_TRADE = "false";
  try {
    const provider = createAlpacaZeroDteMarketDataProvider();
    await assert.rejects(
      provider.getBars("SPY", "1Min", "2026-07-13T13:30:00.000Z", sessionNow),
      /Alpaca read-only access is disabled/
    );
    await assert.rejects(
      provider.listContracts({
        underlying: "SPY",
        expirationDate: "2026-07-13",
        limit: 20
      }),
      /Alpaca read-only access is disabled/
    );
  } finally {
    if (previous.alpacaEnv === undefined) delete process.env.ALPACA_ENV;
    else process.env.ALPACA_ENV = previous.alpacaEnv;
    if (previous.liveTradingEnabled === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = previous.liveTradingEnabled;
    if (previous.liveTrade === undefined) delete process.env.ALPACA_LIVE_TRADE;
    else process.env.ALPACA_LIVE_TRADE = previous.liveTrade;
  }
});

test("blocks missing or stale underlying prices before bars or contracts are requested", async () => {
  for (const underlyingTimestamp of [null, "2026-07-13T13:58:59.000Z"]) {
    const calls: string[] = [];
    const contexts = await collectZeroDteMarketContexts({
      now: sessionNow,
      config,
      provider: makeProvider({ calls, underlyingTimestamp })
    });

    assert.deepEqual(contexts, []);
    assert.deepEqual(calls, ["clock", "stock:SPY"]);
  }
});

test("normalizes contracts from canonical OCC identity and rejects conflicting metadata", () => {
  const normalized = normalizeZeroDteContract({
    symbol: "SPY260713C00600000",
    underlying_symbol: "SPY",
    root_symbol: "SPY",
    expiration_date: "2026-07-13",
    type: "call",
    strike_price: "600",
    open_interest: "1000",
    tradable: true,
    requestId: "contract-request-1"
  });

  assert.deepEqual(normalized, {
    symbol: "SPY260713C00600000",
    underlying: "SPY",
    expirationDate: "2026-07-13",
    type: "call",
    strike: 600,
    tradable: true,
    openInterest: 1_000,
    requestId: "contract-request-1"
  });
  assert.equal(
    normalizeZeroDteContract({
      symbol: "SPY260713C00600000",
      underlying_symbol: "QQQ",
      expiration_date: "2026-07-13",
      type: "call",
      strike_price: 600
    }),
    null
  );
  assert.equal(
    normalizeZeroDteContract({
      symbol: "SPY260713C00600000",
      underlying_symbol: "SPY",
      expiration_date: "2026-07-13",
      type: "put",
      strike_price: 600
    }),
    null
  );
});

test("uses the explicit ET session date, stages underlying calls, and filters a narrow liquid strike band", async () => {
  const calls: string[] = [];
  const contracts = [
    { symbol: "SPY260713C00599000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 599, tradable: true },
    { symbol: "SPY260713C00600000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 600, tradable: true },
    { symbol: "SPY260713C00601000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 601, tradable: true },
    { symbol: "SPY260713C00620000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 620, tradable: true },
    { symbol: "SPY260713P00599000", underlying: "SPY", expirationDate: "2026-07-13", type: "put", strike: 599, tradable: true },
    { symbol: "SPY260713P00600000", underlying: "SPY", expirationDate: "2026-07-13", type: "put", strike: 600, tradable: true },
    { symbol: "SPY260713P00601000", underlying: "SPY", expirationDate: "2026-07-13", type: "put", strike: 601, tradable: true },
    { symbol: "SPY260713P00602000", underlying: "SPY", expirationDate: "2026-07-13", type: "put", strike: 602, tradable: true }
  ];
  const snapshots = {
    SPY260713C00599000: {
      latestQuote: { bidPrice: 1, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    },
    SPY260713C00600000: {
      latestQuote: { bidPrice: 1, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 50,
      openInterest: 1_000
    },
    SPY260713C00601000: {
      latestQuote: { bidPrice: 1, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    },
    SPY260713P00599000: {
      latestQuote: { bidPrice: 1, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    },
    SPY260713P00600000: {
      latestQuote: { bidPrice: 1, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 100
    },
    SPY260713P00601000: {
      latestQuote: { bidPrice: 1, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    }
  };

  const contexts = await collectZeroDteMarketContexts({
    now: sessionNow,
    config,
    provider: makeProvider({
      calls,
      contracts,
      snapshots,
      barRequestIds: ["bar-request-1"],
      contractRequestId: "contract-request-1"
    })
  });

  assert.equal(calls[0], "clock");
  assert.equal(calls[1], "stock:SPY");
  assert.ok(calls.slice(2, 5).every((call) => call.startsWith("bars:SPY:")));
  assert.equal(calls[5], "contracts:SPY:2026-07-13:1000");
  assert.ok(calls[6]?.startsWith("options:"));
  assert.ok(!calls[6]?.includes("SPY260713C00620000"));
  assert.equal(contexts.length, 4);
  assert.deepEqual(
    contexts.map((context) => context.option.symbol),
    ["SPY260713C00599000", "SPY260713C00601000", "SPY260713P00599000", "SPY260713P00601000"]
  );
  assert.deepEqual(
    contexts.map((context) => context.direction),
    ["bullish", "bullish", "bearish", "bearish"]
  );
  assert.ok(contexts.every((context) => context.tradingDate === "2026-07-13"));
  assert.ok(contexts.every((context) => context.option.midpoint !== null));
  assert.ok(contexts.every((context) => context.option.spreadPct !== null));
  assert.deepEqual(contexts[0]?.requestIds.bars, ["bar-request-1"]);
  assert.deepEqual(contexts[0]?.requestIds.contracts, ["contract-request-1"]);
});

test("uses contract open interest when the option snapshot omits it", async () => {
  const contexts = await collectZeroDteMarketContexts({
    now: sessionNow,
    config,
    provider: makeProvider({
      contracts: [{
        symbol: "SPY260713C00600000",
        underlying: "SPY",
        expirationDate: "2026-07-13",
        type: "call",
        strike: 600,
        tradable: true,
        openInterest: 1_000
      }],
      snapshots: {
        SPY260713C00600000: {
          latestQuote: {
            bidPrice: 1,
            askPrice: 1.1,
            timestamp: "2026-07-13T13:59:56.000Z"
          },
          volume: 500
        }
      }
    })
  });

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.option.openInterest, 1_000);
});

test("filters otherwise liquid valid quotes outside the configured spread and premium caps", async () => {
  const contracts = [
    { symbol: "SPY260713C00599000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 599, tradable: true },
    { symbol: "SPY260713C00600000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 600, tradable: true },
    { symbol: "SPY260713C00601000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 601, tradable: true }
  ];
  const snapshots = {
    SPY260713C00599000: {
      latestQuote: { bidPrice: 1, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    },
    SPY260713C00600000: {
      latestQuote: { bidPrice: 1, askPrice: 1.5, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    },
    SPY260713C00601000: {
      latestQuote: { bidPrice: 6, askPrice: 6.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    }
  };

  const contexts = await collectZeroDteMarketContexts({
    now: sessionNow,
    config,
    provider: makeProvider({ contracts, snapshots })
  });

  assert.deepEqual(contexts.map((context) => context.option.symbol), ["SPY260713C00599000"]);
});

test("preserves source and ingestion timestamps while blocking missing, crossed, and stale quotes", async () => {
  const contracts = [
    { symbol: "SPY260713C00600000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 600, tradable: true },
    { symbol: "SPY260713C00601000", underlying: "SPY", expirationDate: "2026-07-13", type: "call", strike: 601, tradable: true },
    { symbol: "SPY260713P00600000", underlying: "SPY", expirationDate: "2026-07-13", type: "put", strike: 600, tradable: true }
  ];
  const snapshots = {
    SPY260713C00600000: {
      latestQuote: { bidPrice: null, askPrice: null, timestamp: null },
      volume: 500,
      openInterest: 1_000
    },
    SPY260713C00601000: {
      latestQuote: { bidPrice: 1.2, askPrice: 1.1, timestamp: "2026-07-13T13:59:56.000Z" },
      volume: 500,
      openInterest: 1_000
    },
    SPY260713P00600000: {
      latestQuote: { bidPrice: 1, askPrice: 1.2, timestamp: "2026-07-13T13:00:00.000Z" },
      volume: 500,
      openInterest: 1_000
    }
  };

  const contexts = await collectZeroDteMarketContexts({
    now: sessionNow,
    config,
    provider: makeProvider({ contracts, snapshots })
  });
  const bySymbol = new Map(contexts.map((context) => [context.option.symbol, context]));
  const missing = bySymbol.get("SPY260713C00600000");
  const crossed = bySymbol.get("SPY260713C00601000");
  const stale = bySymbol.get("SPY260713P00600000");

  assert.ok(missing && crossed && stale);
  assert.equal(missing.option.bid, null);
  assert.equal(missing.option.ask, null);
  assert.equal(missing.option.midpoint, null);
  assert.equal(missing.option.quoteStatus, "missing");
  assert.ok(missing.blockers.includes("QUOTE_MISSING"));
  assert.equal(crossed.option.midpoint, null);
  assert.equal(crossed.option.quoteStatus, "invalid");
  assert.ok(crossed.blockers.includes("QUOTE_CROSSED"));
  assert.equal(stale.option.quoteStatus, "stale");
  assert.ok(stale.blockers.includes("QUOTE_STALE"));
  assert.equal(stale.sourceTimestamps.optionQuote, "2026-07-13T13:00:00.000Z");
  assert.equal(stale.sourceTimestamps.underlying, "2026-07-13T13:59:58.000Z");
  assert.equal(stale.ingestedAt, sessionNow);
  assert.equal(stale.requestIds.clock, "clock-request-1");
});
