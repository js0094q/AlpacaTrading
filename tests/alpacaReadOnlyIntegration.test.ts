import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(mkdtempSync(join(tmpdir(), "alpaca-readonly-test-")), "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
process.env.ALPACA_PAPER_API_KEY = "paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";

const [
  libDb,
  tradingSafetyService,
  alpacaClient,
  alpacaAccountService,
  alpacaAssetService,
  alpacaMarketClockService,
  alpacaOrderReadService,
  alpacaPositionService,
  researchOrchestrator
] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/tradingSafetyService.js"),
  import("../src/services/alpacaClient.js"),
  import("../src/services/alpacaAccountService.js"),
  import("../src/services/alpacaAssetService.js"),
  import("../src/services/alpacaMarketClockService.js"),
  import("../src/services/alpacaOrderReadService.js"),
  import("../src/services/alpacaPositionService.js"),
  import("../src/services/researchOrchestrator.js")
]);

const { closeDbForTests, getDb } = libDb;
const {
  assertLiveTradingDisabled,
  assertNoTradingMutationsAllowed,
  assertReadOnlyAlpacaAccessAllowed,
  getTradingSafetyState
} = tradingSafetyService;
const {
  getAlpacaPaperEndpoint,
  getAlpacaPaperCredentials,
  AlpacaApiError
} = alpacaClient;
const { getAlpacaAccountSnapshot } = alpacaAccountService;
const { getAlpacaAsset, checkAlpacaSymbolTradability } = alpacaAssetService;
const { getAlpacaMarketClock } = alpacaMarketClockService;
const { listAlpacaOpenOrders } = alpacaOrderReadService;
const { listAlpacaPositions } = alpacaPositionService;
const { runResearchDaily } = researchOrchestrator;

const makeMockResponse = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name: string) => {
      if (name.toLowerCase() === "x-request-id") {
        return "mock-request-id";
      }
      if (name.toLowerCase() === "content-type") {
        return "application/json";
      }
      return null;
    }
  },
  text: async () => JSON.stringify(payload),
  json: async () => payload
}) as unknown as Response;

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_trade_evaluations;
    DELETE FROM paper_trade_plans;
    DELETE FROM paper_trade_candidates;
    DELETE FROM research_runs;
    DELETE FROM backtest_options_trades;
    DELETE FROM backtest_trades;
    DELETE FROM backtest_runs;
    DELETE FROM learning_runs;
    DELETE FROM target_snapshots;
    DELETE FROM options_strategy_snapshots;
    DELETE FROM feature_snapshots;
    DELETE FROM option_snapshots;
    DELETE FROM option_contracts;
    DELETE FROM market_bars;
    DELETE FROM api_request_log;
    DELETE FROM ingestion_runs;
    DELETE FROM universe_symbols;
  `);
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

const setMockFetch = (fetcher: (input: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = async (input, init) =>
    fetcher(String(input), init as RequestInit | undefined);
};

describe("Trading safety read-only guardrails", () => {
  test("default trading safety state is paper-only", () => {
    const state = getTradingSafetyState();
    assert.equal(state.alpacaEnv, "paper");
    assert.equal(state.liveTradingEnabled, false);
    assert.equal(state.paperOnly, true);
    assert.equal(state.mutationAllowed, false);
    assert.equal(state.liveMutationAllowed, false);
  });

  test("read-only alpaca access and live trading flags pass by default", () => {
    assert.doesNotThrow(() => assertReadOnlyAlpacaAccessAllowed());
    assert.doesNotThrow(() => assertLiveTradingDisabled());
  });

  test("mutation guards throw by default", () => {
    assert.throws(() => assertNoTradingMutationsAllowed(), /disabled/i);
    process.env.LIVE_TRADING_ENABLED = "true";
    assert.throws(() => assertLiveTradingDisabled(), /Live trading is disabled/i);
    process.env.LIVE_TRADING_ENABLED = "false";
  });

  test("mutation and secrets are not in guardrail errors", () => {
    assert.throws(() => assertNoTradingMutationsAllowed(), /disabled/i);
  });
});


describe("alpaca client behavior", () => {
  beforeEach(() => {
    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
  });

  test("GET requests include required Alpaca headers", async () => {
    let captured: RequestInit | undefined;
    setMockFetch(async (input, init) => {
      captured = init || {};
      if (input.includes("/v2/account")) {
        return makeMockResponse({ status: "ok" });
      }
      return makeMockResponse({});
    });

    await getAlpacaPaperEndpoint<{ status: string }>("/v2/account");

    const headers = new Headers(captured?.headers);
    assert.equal(headers.get("APCA-API-KEY-ID"), "paper-key");
    assert.equal(headers.get("APCA-API-SECRET-KEY"), "paper-secret");
    assert.equal(captured?.method, "GET");
  });

  test("captures x-request-id from response", async () => {
    setMockFetch(async (input) => {
      if (input.includes("/v2/clock")) {
        return makeMockResponse({ timestamp: "2026-07-01T12:00:00Z", is_open: true }, 200);
      }
      return makeMockResponse({});
    });

    const result = await getAlpacaPaperEndpoint<{ is_open: boolean }>('/v2/clock');
    assert.equal(result.requestId, "mock-request-id");
    assert.equal(result.status, 200);
  });

  test("non-2xx responses throw AlpacaApiError", async () => {
    setMockFetch(async () => makeMockResponse({ message: "bad request" }, 400));
    await assert.rejects(
      () => getAlpacaPaperEndpoint<{ message: string }>("/v2/account"),
      (error) => error instanceof AlpacaApiError && error.status === 400
    );
  });

  test("missing paper credentials fail clearly", async () => {
    process.env.ALPACA_PAPER_API_KEY = "";
    process.env.ALPACA_PAPER_SECRET_KEY = "";
    await assert.rejects(
      async () => {
        const credentials = getAlpacaPaperCredentials();
        assert.equal(credentials.apiKey, "");
      },
      /Missing Alpaca paper credentials/i
    );
    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
  });

  test("error output does not include secret", async () => {
    process.env.ALPACA_PAPER_SECRET_KEY = "super-secret";
    setMockFetch(async () => makeMockResponse({ message: "oops" }, 503));
    let error: unknown;
    try {
      await getAlpacaPaperEndpoint<{ status: string }>("/v2/account");
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    const text = error.message;
    assert.equal(text.includes("super-secret"), false);
  });

  test("alpaca symbol tradability check surfaces missing credentials", async () => {
    process.env.ALPACA_PAPER_API_KEY = "";
    process.env.ALPACA_PAPER_SECRET_KEY = "";

    await assert.rejects(
      () => checkAlpacaSymbolTradability("AAPL"),
      /Missing Alpaca paper credentials/i
    );

    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
  });
});


describe("alpaca read-only services", () => {
  beforeEach(() => {
    setMockFetch(async (input) => {
      if (input.includes("/v2/account")) {
        return makeMockResponse({
          id: "acct-1",
          status: "ACTIVE",
          currency: "USD",
          cash: "1000",
          portfolio_value: "5000",
          equity: "5000",
          last_equity: "5000",
          buying_power: "4000",
          regt_buying_power: "2000",
          daytrading_buying_power: "1000",
          non_marginable_buying_power: "3000",
          pattern_day_trader: false,
          daytrade_count: 0,
          trading_blocked: false,
          transfers_blocked: false,
          account_blocked: false,
          created_at: "2026-01-01T00:00:00Z"
        });
      }
      if (input.includes("/v2/positions")) {
        return makeMockResponse([
          {
            symbol: "AAPL",
            asset_id: "a",
            qty: "1",
            market_value: "200.00",
            cost_basis: "195.00",
            unrealized_pl: "5.00",
            unrealized_plpc: "0.0256",
            current_price: "200",
            side: "long"
          }
        ]);
      }
      if (input.includes("/v2/orders?status=open")) {
        return makeMockResponse([
          {
            id: "order-1",
            symbol: "AAPL",
            side: "buy",
            type: "market",
            status: "accepted",
            submitted_at: "2026-01-01T09:30:00Z",
            qty: "1"
          }
        ]);
      }
      if (input.includes("/v2/clock")) {
        return makeMockResponse({
          timestamp: "2026-07-01T12:00:00Z",
          is_open: false,
          next_open: "2026-07-02T09:30:00Z",
          next_close: "2026-07-02T16:00:00Z"
        });
      }
      if (input.includes("/v2/assets/AAPL")) {
        return makeMockResponse({
          id: "a1",
          class: "us_equity",
          exchange: "NASDAQ",
          symbol: "AAPL",
          name: "Apple Inc.",
          status: "active",
          tradable: true,
          marginable: true,
          shortable: true,
          easy_to_borrow: true,
          fractionable: true
        });
      }
      if (input.includes("/v2/stocks/bars")) {
        const parsed = new URL(input);
        const symbols = (parsed.searchParams.get("symbols") || "").split(",").filter(Boolean);
        const payloadBars: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> = {};
        symbols.forEach((symbol, index) => {
          payloadBars[symbol] = [{
            t: new Date(Date.UTC(2026, 6, index + 1, 9, 30, 0)).toISOString(),
            o: 100,
            h: 102,
            l: 99,
            c: 101,
            v: 1000
          }];
        });
        return makeMockResponse({ bars: payloadBars });
      }
      return makeMockResponse({});
    });
  });

  test("maps account payload into camelCase fields", async () => {
    const snapshot = await getAlpacaAccountSnapshot();
    assert.equal(snapshot.currency, "USD");
    assert.equal(snapshot.lastEquity, "5000");
    assert.equal(snapshot.daytradingBuyingPower, "1000");
  });

  test("maps positions payload", async () => {
    const snapshot = await listAlpacaPositions();
    assert.equal(snapshot.positions.length, 1);
    assert.equal(snapshot.positions[0]?.unrealizedPl, "5.00");
    assert.equal(snapshot.requestId, "mock-request-id");
  });

  test("maps open-order payload", async () => {
    const snapshot = await listAlpacaOpenOrders();
    assert.equal(snapshot.orders.length, 1);
    assert.equal(snapshot.orders[0]?.symbol, "AAPL");
  });

  test("maps clock payload", async () => {
    const clock = await getAlpacaMarketClock();
    assert.equal(clock.isOpen, false);
    assert.equal(clock.nextOpen, "2026-07-02T09:30:00Z");
  });

  test("tradability checks map symbols to reason codes", async () => {
    setMockFetch(async (input) => {
      if (input.includes("/v2/assets/XYZ")) {
        return makeMockResponse({}, 404);
      }
      if (input.includes("/v2/assets/INACTIVE")) {
        return makeMockResponse({ symbol: "INACTIVE", status: "inactive", tradable: true });
      }
      if (input.includes("/v2/assets/NOTRADE")) {
        return makeMockResponse({ symbol: "NOTRADE", status: "active", tradable: false });
      }
      return makeMockResponse({
        symbol: "AAPL",
        status: "active",
        tradable: true
      });
    });

    const normal = await checkAlpacaSymbolTradability("AAPL");
    assert.equal(normal.tradable, true);

    const missing = await checkAlpacaSymbolTradability("XYZ");
    assert.equal(missing.tradable, false);
    assert.equal(missing.reason, "asset_not_found");

    const inactive = await checkAlpacaSymbolTradability("INACTIVE");
    assert.equal(inactive.tradable, false);
    assert.equal(inactive.reason, "inactive");

    const untradeable = await checkAlpacaSymbolTradability("NOTRADE");
    assert.equal(untradeable.tradable, false);
    assert.equal(untradeable.reason, "not_tradable");
  });

  test("getAlpacaAsset maps response fields", async () => {
    const asset = await getAlpacaAsset("AAPL");
    assert.equal(asset.symbol, "AAPL");
    assert.equal(asset.easyToBorrow, true);
  });
});


describe("research daily asset filtering", () => {
  test("runs without Alpaca filter when disabled", async () => {
    setMockFetch(async (input) => {
      if (input.includes("/v2/stocks/bars")) {
        const parsed = new URL(input);
        const symbols = (parsed.searchParams.get("symbols") || "").split(",").filter(Boolean);
        const payload: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> = {};
        for (const symbol of symbols) {
          payload[symbol] = [
            { t: new Date(Date.UTC(2026, 0, 1, 9, 30, 0)).toISOString(), o: 100, h: 100, l: 99, c: 101, v: 1000 }
          ];
        }
        return makeMockResponse({ bars: payload });
      }
      if (input.includes("/v2/features")) {
        return makeMockResponse({});
      }
      return makeMockResponse({});
    });

    const result = await runResearchDaily({
      riskProfile: "moderate",
      optionsEnabled: false,
      maxCandidates: 2,
      useAlpacaAssets: false
    });

    assert.equal(result.status, "completed");
    assert.equal(result.optionsEnabled, false);
    assert.equal(result.alpacaAssetFilter, undefined);
  });

  test("filters by Alpaca tradability and preserves exclusion reasons", async () => {
    let assetCallCount = 0;
    setMockFetch(async (input) => {
      if (input.includes("/v2/stocks/bars")) {
        const parsed = new URL(input);
        const symbols = (parsed.searchParams.get("symbols") || "").split(",").filter(Boolean);
        const payload: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> = {};
        for (const symbol of symbols) {
          payload[symbol] = [
            { t: new Date(Date.UTC(2026, 0, 1, 9, 30, 0)).toISOString(), o: 100, h: 100, l: 99, c: 101, v: 1000 }
          ];
        }
        return makeMockResponse({ bars: payload });
      }
      if (input.includes("/v2/assets/")) {
        assetCallCount += 1;
        const symbol = input.split("/").pop() || "";
        if (assetCallCount === 1) {
          return makeMockResponse({}, 404);
        }
        if (symbol === "INACTIVE") {
          return makeMockResponse({ symbol: "INACTIVE", status: "inactive", tradable: true });
        }
        return makeMockResponse({ symbol, status: "active", tradable: true });
      }
      return makeMockResponse({});
    });

    const result = await runResearchDaily({
      riskProfile: "moderate",
      optionsEnabled: false,
      maxCandidates: 2,
      useAlpacaAssets: true
    });

    assert.equal(result.status, "completed");
    assert.ok(result.alpacaAssetFilter);
    assert.ok(result.alpacaAssetFilter!.checked >= 1);
    assert.ok(result.alpacaAssetFilter!.excluded.length >= 1);
    assert.equal(result.alpacaAssetFilter!.excluded.some((entry) => entry.reason === "asset_not_found" || entry.reason === "inactive"), true);
  });

  test("fails early when Alpaca credentials are missing", async () => {
    process.env.ALPACA_PAPER_API_KEY = "";
    process.env.ALPACA_PAPER_SECRET_KEY = "";

    await assert.rejects(
      () =>
        runResearchDaily({
          riskProfile: "moderate",
          useAlpacaAssets: true
        }),
      /Missing Alpaca paper credentials/i
    );

    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
  });

  test("alpaca clients do not issue non-GET methods", async () => {
    const methods = new Set<string>();
    setMockFetch(async (input, init) => {
      methods.add(String(init?.method || "GET").toUpperCase());
      if (input.includes("/v2/stocks/bars")) {
        const parsed = new URL(input);
        const symbols = (parsed.searchParams.get("symbols") || "").split(",").filter(Boolean);
        const payload: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>> = {};
        for (const symbol of symbols) {
          payload[symbol] = [
            { t: new Date(Date.UTC(2026, 0, 1, 9, 30, 0)).toISOString(), o: 100, h: 100, l: 99, c: 101, v: 1000 }
          ];
        }
        return makeMockResponse({ bars: payload });
      }
      if (input.includes("/v2/account")) {
        return makeMockResponse({ status: "ACTIVE" });
      }
      if (input.includes("/v2/assets")) {
        return makeMockResponse({ symbol: "AAPL", status: "active", tradable: true });
      }
      if (input.includes("/v2/clock")) {
        return makeMockResponse({ timestamp: "2026-07-01T12:00:00Z", is_open: false, next_open: "", next_close: "" });
      }
      return makeMockResponse({});
    });

    await getAlpacaPaperEndpoint("/v2/account");
    await getAlpacaMarketClock();
    await runResearchDaily({ riskProfile: "moderate", optionsEnabled: false, useAlpacaAssets: true, maxCandidates: 1 });
    for (const method of methods) {
      assert.equal(method, "GET");
    }
  });
});
