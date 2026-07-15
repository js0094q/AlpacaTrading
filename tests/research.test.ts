import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(mkdtempSync(join(tmpdir(), "alpaca-research-test-")), "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
process.env.ENABLE_OPTIONS_RESEARCH = "true";
process.env.ALPACA_REQUEST_TIMEOUT_MS = "5";
process.env.ALPACA_MAX_RETRIES = "0";

globalThis.fetch = async () =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => "mock-request-id" },
    text: async () => "{}",
    json: async () => ({})
  } as unknown as Response);

const [
  libDb,
  universeService,
  featureService,
  optionService,
  strategySelector,
  backtestService,
  targetService,
  researchOrchestrator,
  candidateRankingService,
  paperTradeService,
  providerAlpaca,
  appConfig
] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/universeService.js"),
  import("../src/services/featureService.js"),
  import("../src/services/optionsService.js"),
  import("../src/services/strategySelector.js"),
  import("../src/services/backtestService.js"),
  import("../src/services/targetService.js"),
  import("../src/services/researchOrchestrator.js"),
  import("../src/services/candidateRankingService.js"),
  import("../src/services/paperTradeService.js"),
  import("../src/services/providers/alpaca.js"),
  import("../src/config.js")
]);

const { closeDbForTests, getDb } = libDb;
const { seedInitialUniverse, addTicker, getAllUniverse } = universeService;
const { buildFeatures } = featureService;
const { ingestOptionContracts, ingestOptionSnapshots, toContractRow } = optionService;
const { selectExpression } = strategySelector;
const { runBacktest } = backtestService;
const { generateTargets } = targetService;
const { runResearchDaily } = researchOrchestrator;
const { rankResearchCandidates } = candidateRankingService;
const { buildPaperTradePlans, evaluatePaperTrades, buildResearchReport } = paperTradeService;
const { fetchAllBars } = providerAlpaca;
const { config: runtimeConfig } = appConfig;

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

const makeMockResponse = (payload: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "mock-request-id" },
    text: async () => JSON.stringify(payload),
    json: async () => payload
  }) as unknown as Response;

const buildBarsPayload = (symbols: string[]) => {
  const barsBySymbol: Record<string, Array<{
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }>> = {};
  for (const symbol of symbols) {
    const direction = symbol === "QQQ" ? -1 : 1;
    const base = symbol === "QQQ" ? 180 : 100;
    const step = direction * 0.6;
    barsBySymbol[symbol] = Array.from({ length: 60 }, (_, index) => {
      const close = base + step * index;
      return {
        t: ts(index + 1),
        o: close - 0.4,
        h: close + 0.6,
        l: close - 0.8,
        c: close,
        v: 1_000 + index * 7
      };
    });
  }
  return { barsBySymbol };
};

const buildOptionsContractsPayload = (symbols: string[]) => ({
  option_contracts: symbols.flatMap((symbol) => [
    {
      symbol: `${symbol}_C_MID`,
      underlying_symbol: symbol,
      type: "call",
      expiration_date: "2026-12-31",
      strike_price: 100,
      multiplier: 100,
      tradable: true
    },
    {
      symbol: `${symbol}_P_MID`,
      underlying_symbol: symbol,
      type: "put",
      expiration_date: "2026-12-31",
      strike_price: 100,
      multiplier: 100,
      tradable: true
    }
  ])
});

const buildOptionSnapshotsPayload = (symbols: string[]) => ({
  snapshots: Object.fromEntries(
    symbols.map((symbol) => {
      const isCall = symbol.endsWith("_C_MID");
      return [
        symbol,
        {
          symbol,
          underlying_symbol: symbol.replace(/_[CP]_MID$/, ""),
          Greeks: {
            delta: isCall ? 0.62 : -0.62,
            gamma: isCall ? 0.08 : 0.07,
            theta: -0.03,
            vega: 0.16,
            rho: isCall ? 0.02 : -0.02
          },
          latest_quote: {
            t: ts(1),
            bp: 0.92,
            ap: 1.0
          },
          latest_trade: {
            t: ts(1),
            p: 0.95
          },
          implied_volatility: 0.35,
          volume: 20_000,
          open_interest: 50_000
        }
      ];
    })
  )
});

const setMockFetchForSuccess = (
  includeOptions = false,
  barsBySymbol: Record<string, Array<{
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }>> | null = null,
  nextPageToken?: string | null
) => {
  globalThis.fetch = async (input: string | Request | URL) => {
    const target = String(input);
    if (target.includes("/v2/stocks/bars")) {
      const endpoint = new URL(target);
      const symbols = (endpoint.searchParams.get("symbols") || "")
        .split(",")
        .filter(Boolean)
        .map((value) => value.toUpperCase());
      const payload = barsBySymbol ?? buildBarsPayload(symbols).barsBySymbol;
      const response: Record<string, unknown> = {
        bars: payload
      };
      if (nextPageToken !== undefined) {
        response.next_page_token = nextPageToken;
      }
      return makeMockResponse({
        ...response
      });
    }

    if (includeOptions && target.includes("/v2/options/contracts")) {
      const endpoint = new URL(target);
      const symbols = (endpoint.searchParams.get("underlying_symbols") || "")
        .split(",")
        .filter(Boolean)
        .map((value) => value.toUpperCase());
      return makeMockResponse(buildOptionsContractsPayload(symbols));
    }

    if (includeOptions && target.includes("/v1beta1/options/snapshots")) {
      const endpoint = new URL(target);
      const symbols = (endpoint.searchParams.get("symbols") || "")
        .split(",")
        .filter(Boolean);
      return makeMockResponse(buildOptionSnapshotsPayload(symbols));
    }

    if (includeOptions && target.includes("/v1beta1/options/quotes/latest")) {
      const endpoint = new URL(target);
      const symbols = (endpoint.searchParams.get("symbols") || "")
        .split(",")
        .filter(Boolean);
      return makeMockResponse({
        quotes: Object.fromEntries(
          symbols.map((symbol) => [
            symbol,
            {
              t: new Date().toISOString(),
              bp: 0.92,
              ap: 1.0
            }
          ])
        )
      });
    }

    return makeMockResponse({});
  };
};

const setMockFetchForFailure = () => {
  globalThis.fetch = async () =>
    makeMockResponse({ message: "mocked provider failure" }, 500);
};

const ts = (offset = 0) =>
  new Date(Date.UTC(2026, 0, 1 + offset, 9, 30, 0)).toISOString();

const insertBar = (symbol: string, timestamp: string, open: number, close: number) => {
  getDb()
    .prepare(
      `
      INSERT INTO market_bars(symbol, timeframe, timestamp, open, high, low, close, volume, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'alpaca')
      `
    )
    .run(
      symbol,
      "1Day",
      timestamp,
      open,
      close + 1,
      close - 1,
      close,
      Math.round((open + close) / 2)
    );
};

const insertFeature = (symbol: string, timestamp: string, features: Record<string, unknown>) => {
  getDb()
    .prepare("INSERT INTO feature_snapshots(symbol, timestamp, features) VALUES (?, ?, ?)")
    .run(symbol, timestamp, JSON.stringify(features));
};

const readCount = (sql: string) =>
  Number((getDb().prepare(sql).get() as { count: number }).count);

beforeEach(() => {
  resetDatabase();
  globalThis.fetch = async () => makeMockResponse({});
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(dirname(path), { recursive: true, force: true });
});

describe("Universe management", () => {
  test("seeded universe is normalized and de-duplicated", async () => {
    await seedInitialUniverse();
    const initial = getAllUniverse();
    assert.ok(initial.length >= 31);
    const duplicate = await addTicker("spy");
    const afterAdd = getAllUniverse();
    assert.equal(afterAdd.length, initial.length);
    assert.equal(duplicate?.symbol, "SPY");
  });
});

describe("Market bar persistence", () => {
  test("honors zero Alpaca retry override", () => {
    assert.equal(runtimeConfig.alpaca.maxRetries, 0);
  });

  test("configures a bounded SQLite busy timeout below control-route deadlines", () => {
    const row = getDb().prepare("PRAGMA busy_timeout").get() as Record<string, number>;
    assert.equal(Object.values(row)[0], 5_000);
  });

  test("stores bars without duplicate rows", () => {
    const statement = getDb().prepare(
      `
      INSERT INTO market_bars(
        symbol, timeframe, timestamp, open, high, low, close, volume, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'alpaca')
      ON CONFLICT(symbol, timeframe, timestamp) DO NOTHING
      `
    );
    const date = ts(0);
    statement.run("SPY", "1Day", date, 100, 101, 99, 100, 10_000);
    statement.run("SPY", "1Day", date, 100, 101, 99, 100, 10_000);
    assert.equal(
      readCount(`SELECT COUNT(*) AS count FROM market_bars WHERE symbol = 'SPY' AND timestamp = '${date}'`),
      1
    );
  });

  test("times out stalled Alpaca market data requests", async () => {
    globalThis.fetch = async (_input: string | Request | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });

    await assert.rejects(
      () => fetchAllBars({ symbols: ["SPY"], timeframe: "1Day" }),
      /Alpaca request timed out after 5ms/
    );
  });
});

describe("Feature generation", () => {
  test("calculates deterministic equity features from bars", async () => {
    await insertBar("SPY", ts(0), 100, 100);
    await insertBar("SPY", ts(1), 102, 102);
    await insertBar("SPY", ts(2), 104, 104);
    await insertBar("SPY", ts(3), 106, 106);
    await insertBar("SPY", ts(4), 108, 108);

    const result = await buildFeatures({ symbols: ["SPY"], timeframe: "1Day", start: ts(0), end: ts(4) });
    assert.equal(result.featuresStored, 5);
    const row = getDb()
      .prepare("SELECT features FROM feature_snapshots WHERE symbol = 'SPY' ORDER BY timestamp DESC LIMIT 1")
      .get() as { features: string };
    const features = JSON.parse(row.features) as Record<string, unknown>;
    assert.equal(features.close, 108);
    assert.equal(features.dailyReturn, 2);
    assert.equal(features.trend, "neutral");
    assert.equal(features.optionSuitability, "insufficient_data");
  });

  test("normalizes option contract payloads", () => {
    const row = toContractRow({
      symbol: "SPY240315C00220000",
      underlying_symbol: "spy",
      type: "call",
      expiration_date: "2024-03-15",
      strike_price: 220,
      multiplier: 100,
      tradable: true
    });
    assert.equal(row.underlyingSymbol, "SPY");
    assert.equal(row.optionSymbol, "SPY240315C00220000");
    assert.equal(row.tradable, 1);
  });

  test("ingests option quotes from Alpaca latest options quote endpoint", async () => {
    const optionSymbol = "SPY260814C00100000";
    const calls: string[] = [];
    globalThis.fetch = async (input: string | Request | URL) => {
      const target = String(input);
      calls.push(target);
      if (target.includes("/v2/options/contracts")) {
        return makeMockResponse({
          option_contracts: [{
            symbol: optionSymbol,
            underlying_symbol: "SPY",
            type: "call",
            expiration_date: "2026-08-14",
            strike_price: 100,
            multiplier: 100,
            tradable: true
          }]
        });
      }
      if (target.includes("/v1beta1/options/snapshots")) {
        return makeMockResponse({
          snapshots: {
            [optionSymbol]: {
              symbol: optionSymbol,
              underlying_symbol: "SPY",
              Greeks: { delta: 0.5 },
              latest_trade: { t: new Date().toISOString(), p: 1.21 },
              implied_volatility: 0.31,
              volume: 100,
              open_interest: 200
            }
          }
        });
      }
      if (target.includes("/v1beta1/options/quotes/latest")) {
        return makeMockResponse({
          quotes: {
            [optionSymbol]: {
              t: new Date().toISOString(),
              bp: 1.2,
              ap: 1.4
            }
          }
        });
      }
      return makeMockResponse({});
    };

    await ingestOptionContracts({ underlyingSymbols: ["SPY"] });
    await ingestOptionSnapshots({ underlyingSymbols: ["SPY"] });

    const row = getDb()
      .prepare(`
        SELECT bid, ask, midpoint, last, quote_status, executable, executable_price, executable_price_source, rejection_reason
        FROM option_snapshots
        WHERE option_symbol = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `)
      .get(optionSymbol) as {
        bid: number | null;
        ask: number | null;
        midpoint: number | null;
        last: number | null;
        quote_status: string;
        executable: number;
        executable_price: number | null;
        executable_price_source: string | null;
        rejection_reason: string | null;
      };

    assert.equal(calls.some((target) => target.includes("/v1beta1/options/quotes/latest")), true);
    assert.equal(row.bid, 1.2);
    assert.equal(row.ask, 1.4);
    assert.equal(row.midpoint, 1.3);
    assert.equal(row.last, 1.21);
    assert.equal(row.quote_status, "valid");
    assert.equal(row.executable, 1);
    assert.equal(row.executable_price, 1.3);
    assert.equal(row.executable_price_source, "midpoint");
    assert.equal(row.rejection_reason, null);
  });

  test("applies delta filters to current Alpaca camelCase option snapshots", async () => {
    const optionSymbol = "SPY270115C00805000";
    globalThis.fetch = async (input: string | Request | URL) => {
      const target = String(input);
      if (target.includes("/v2/options/contracts")) {
        return makeMockResponse({
          option_contracts: [{
            symbol: optionSymbol,
            underlying_symbol: "SPY",
            type: "call",
            expiration_date: "2027-01-15",
            strike_price: 805,
            multiplier: 100,
            tradable: true
          }]
        });
      }
      if (target.includes("/v1beta1/options/snapshots")) {
        return makeMockResponse({
          snapshots: {
            [optionSymbol]: {
              symbol: optionSymbol,
              underlying_symbol: "SPY",
              greeks: { delta: 0.5 },
              latestQuote: { t: new Date().toISOString(), bp: 16.4, ap: 16.52 },
              impliedVolatility: 0.1379
            }
          }
        });
      }
      if (target.includes("/v1beta1/options/quotes/latest")) {
        return makeMockResponse({
          quotes: {
            [optionSymbol]: { t: new Date().toISOString(), bp: 16.4, ap: 16.52 }
          }
        });
      }
      return makeMockResponse({});
    };

    await ingestOptionContracts({ underlyingSymbols: ["SPY"] });
    const result = await ingestOptionSnapshots({
      underlyingSymbols: ["SPY"],
      minDelta: 0.4,
      maxDelta: 0.6
    });
    const row = getDb()
      .prepare("SELECT delta FROM option_snapshots WHERE option_symbol = ?")
      .get(optionSymbol) as { delta: number } | undefined;

    assert.equal(result.rowsIngested, 1);
    assert.equal(row?.delta, 0.5);
  });
});

describe("Strategy selector", () => {
  test("chooses options structure only for aggressive high-conviction signals", () => {
    const result = selectExpression({
      symbol: "SPY",
      asOf: ts(0),
      direction: "long",
      confidence: 0.85,
      expectedReturn: 0.02,
      atr: 4,
      trend: "bullish",
      iv: 0.32,
      liquidityScore: 0.8,
      spreadPct: 0.02,
      hasOptionsData: true
    });

    assert.equal(result.preferredExpression, "call_spread");
    assert.equal(result.optionsCandidate?.type, "call");
  });

  test("returns no expression when directional confidence is too weak", () => {
    const result = selectExpression({
      symbol: "SPY",
      asOf: ts(0),
      direction: "neutral",
      confidence: 0.2,
      expectedReturn: 0.01,
      atr: 4,
      trend: "neutral",
      iv: 0.2,
      liquidityScore: 0.1,
      spreadPct: 0.2,
      hasOptionsData: false
    });
    assert.equal(result.preferredExpression, "none");
  });
});

describe("Backtest", () => {
  test("generates share trades with deterministic accounting", async () => {
    await insertBar("SPY", ts(0), 100, 100);
    await insertBar("SPY", ts(1), 102, 102);
    await insertBar("SPY", ts(2), 104, 104);
    await insertBar("SPY", ts(3), 106, 106);
    insertFeature("SPY", ts(0), {
      close: 100,
      trend: "bullish",
      atr14: 2,
      rsi14: 65,
      ema9: 97,
      ema21: 95,
      macdHistogram: 0.4,
      relativeVolume: 1.1,
      optionsNearestExpiration: null
    });
    insertFeature("SPY", ts(1), {
      close: 102,
      trend: "bullish",
      atr14: 2,
      rsi14: 65,
      ema9: 97,
      ema21: 95,
      macdHistogram: 0.4,
      relativeVolume: 1.1,
      optionsNearestExpiration: null
    });
    insertFeature("SPY", ts(2), {
      close: 104,
      trend: "bullish",
      atr14: 2,
      rsi14: 65,
      ema9: 97,
      ema21: 95,
      macdHistogram: 0.4,
      relativeVolume: 1.1,
      optionsNearestExpiration: null
    });
    insertFeature("SPY", ts(3), {
      close: 106,
      trend: "bullish",
      atr14: 2,
      rsi14: 65,
      ema9: 97,
      ema21: 95,
      macdHistogram: 0.4,
      relativeVolume: 1.1,
      optionsNearestExpiration: null
    });

    const result = await runBacktest({
      startDate: ts(0),
      endDate: ts(3),
      holdingPeriod: 2,
      initialCapital: 100_000,
      positionSize: 0.2,
      maxNotionalPerTrade: 10_000,
      optionsEnabled: false,
      longEnabled: true,
      shortEnabled: false
    });

    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].exitReason, "time_exit");
    assert.equal(result.trades[0].side, "long");
    assert.equal(result.metrics.trades, 1);
    assert.ok(Number.isFinite(result.metrics.totalReturn));
  });

  test("supports option-like trade simulation in research mode", async () => {
    await insertBar("SPY", ts(0), 100, 100);
    await insertBar("SPY", ts(1), 110, 110);
    await insertBar("SPY", ts(2), 112, 112);
    insertFeature("SPY", ts(0), {
      close: 100,
      trend: "bullish",
      atr14: 3,
      rsi14: 65,
      ema9: 97,
      ema21: 95,
      macdHistogram: 0.4,
      relativeVolume: 1.1,
      optionsNearestExpiration: "2026-12-31"
    });
    insertFeature("SPY", ts(1), {
      close: 110,
      trend: "bullish",
      atr14: 3,
      rsi14: 65,
      ema9: 97,
      ema21: 95,
      macdHistogram: 0.4,
      relativeVolume: 1.1,
      optionsNearestExpiration: "2026-12-31"
    });
    insertFeature("SPY", ts(2), {
      close: 112,
      trend: "bullish",
      atr14: 3,
      rsi14: 65,
      ema9: 97,
      ema21: 95,
      macdHistogram: 0.4,
      relativeVolume: 1.1,
      optionsNearestExpiration: "2026-12-31"
    });

    getDb()
      .prepare(
        `
        INSERT INTO option_contracts(
          underlying_symbol, option_symbol, type, expiration_date, strike, multiplier, tradable, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'alpaca')
        `
      )
      .run("SPY", "SPY_C_ATM", "call", "2026-12-31", 100, 100, 1);

    const result = await runBacktest({
      startDate: ts(0),
      endDate: ts(2),
      holdingPeriod: 5,
      initialCapital: 100_000,
      positionSize: 0.2,
      maxNotionalPerTrade: 10_000,
      optionsEnabled: true,
      aggressiveMode: true,
      longEnabled: true,
      shortEnabled: false
    });

    assert.equal(result.optionTrades.length, 1);
    assert.equal(result.optionTrades[0].underlyingSymbol, "SPY");
    assert.equal(result.optionTrades[0].strategy, "long_call");
    assert.ok(["time_exit", "take_profit"].includes(result.optionTrades[0].exitReason));
  });
});

describe("Target generation and learning influence", () => {
  test("creates long/short/neutral targets", async () => {
    insertFeature("SPY", ts(0), {
      close: 120,
      trend: "bullish",
      atr14: 2,
      rsi14: 72,
      ema9: 118,
      ema21: 114,
      macdHistogram: 0.45,
      relativeVolume: 1.2,
      callLiquidityAvailable: 3,
      putLiquidityAvailable: 2,
      optionsNearestExpiration: "2026-12-31",
      ivPercentile: 0.8,
      atmImpliedVol: 0.32,
      preferredContractLiquidityScore: 0.75
    });
    insertFeature("QQQ", ts(0), {
      close: 300,
      trend: "bearish",
      atr14: 3,
      rsi14: 30,
      ema9: 305,
      ema21: 310,
      macdHistogram: -0.45,
      relativeVolume: 0.9,
      callLiquidityAvailable: 0,
      putLiquidityAvailable: 0,
      optionsNearestExpiration: null
    });
    insertFeature("IWM", ts(0), {
      close: 190,
      trend: "neutral",
      atr14: 4,
      rsi14: 50,
      ema9: 190,
      ema21: 190,
      macdHistogram: 0,
      relativeVolume: 1.0,
      optionsNearestExpiration: null
    });

    const output = await generateTargets({
      riskProfile: "aggressive"
    });
    const rows = getDb()
      .prepare("SELECT symbol, direction, risk_profile, preferred_expression FROM target_snapshots")
      .all() as Array<{ symbol: string; direction: string; risk_profile: string; preferred_expression: string }>;
    const rowBySymbol = new Map(rows.map((row) => [row.symbol, row]));
    assert.equal(output.generated, 3);
    assert.equal(rowBySymbol.get("SPY")?.direction, "long");
    assert.equal(rowBySymbol.get("QQQ")?.direction, "short");
    assert.equal(rowBySymbol.get("IWM")?.direction, "neutral");
  });

  test("uses latest learning accuracy to raise target confidence", async () => {
    insertFeature("SPY", ts(0), {
      close: 120,
      trend: "bullish",
      atr14: 2,
      rsi14: 72,
      ema9: 118,
      ema21: 114,
      macdHistogram: 0.45,
      relativeVolume: 1.2,
      callLiquidityAvailable: 3,
      putLiquidityAvailable: 2,
      optionsNearestExpiration: "2026-12-31",
      ivPercentile: 0.8,
      atmImpliedVol: 0.32,
      preferredContractLiquidityScore: 0.75
    });

    const firstRun = await generateTargets();
    const firstConfidence = Number(
      (getDb().prepare("SELECT confidence FROM target_snapshots ORDER BY rowid DESC LIMIT 1").get() as { confidence: number })
        .confidence
    );
    assert.equal(firstRun.generated, 1);
    assert.equal(firstConfidence, firstRun.rows[0].confidence);

    getDb()
      .prepare(
        `
        INSERT INTO learning_runs(
          id, model_name, trained_at, horizon, universe_json, metrics_json, feature_importance_json, strategy_performance_json, notes_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "learn-test-1",
        "baseline_logistic_1d",
        ts(0),
        "1d",
        JSON.stringify(["SPY"]),
        JSON.stringify({ accuracy: 0.95 }),
        JSON.stringify({ close: 1 }),
        JSON.stringify({ close: 1 }),
        JSON.stringify({ notes: "test learning run" })
      );

    const secondRun = await generateTargets();
    const secondConfidence = Number(
      (getDb().prepare("SELECT confidence FROM target_snapshots ORDER BY rowid DESC LIMIT 1").get() as { confidence: number })
        .confidence
    );
    assert.equal(secondRun.generated, 1);
    assert.ok(secondConfidence > firstConfidence);
  });
});

describe("Alpaca provider pagination", () => {
  test("stops pagination when next_page_token is omitted", async () => {
    let pageCalls = 0;
    globalThis.fetch = async (input: string | Request | URL) => {
      const target = String(input);
      if (target.includes("/v2/stocks/bars")) {
        pageCalls += 1;
        const endpoint = new URL(target);
        const symbols = (endpoint.searchParams.get("symbols") || "")
          .split(",")
          .filter(Boolean)
          .map((value) => value.toUpperCase());
        return makeMockResponse({
          bars: buildBarsPayload(symbols).barsBySymbol
        });
      }
      return makeMockResponse({});
    };

    const rows = await fetchAllBars({
      symbols: ["SPY"],
      timeframe: "1Day",
      start: ts(0)
    });

    assert.equal(pageCalls, 1);
    assert.equal(rows.length, 60);
  });

  test("throws when bars pagination repeats the same next page token", async () => {
    let pageCalls = 0;
    const repeatedRows = buildBarsPayload(["SPY"]).barsBySymbol;
    globalThis.fetch = async (input: string | Request | URL) => {
      const target = String(input);
      if (target.includes("/v2/stocks/bars")) {
        pageCalls += 1;
        return makeMockResponse({
          bars: repeatedRows,
          next_page_token: pageCalls === 1 ? "same-token" : "same-token"
        });
      }
      return makeMockResponse({});
    };

    await assert.rejects(
      () => fetchAllBars({ symbols: ["SPY"], timeframe: "1Day", start: ts(0) }),
      /Alpaca bars pagination repeated token/i
    );
  });
});

describe("Research orchestration", () => {
  test("returns already_running without network work when a fresh research lease exists", async () => {
    const startedAt = new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO research_runs(
          id, started_at, heartbeat_at, status, risk_profile, options_enabled,
          universe_size, targets_generated, candidates_selected, config_json
        ) VALUES ('active-research', ?, ?, 'running', 'moderate', 0, 0, 0, 0, '{}')
      `)
      .run(startedAt, startedAt);
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return makeMockResponse({});
    };

    const result = await runResearchDaily({
      riskProfile: "moderate",
      optionsEnabled: false,
      maxCandidates: 4
    });

    assert.deepEqual(result, {
      status: "already_running",
      runId: "active-research",
      activeRunId: "active-research",
      startedAt,
      heartbeatAt: startedAt,
      riskProfile: "moderate",
      optionsEnabled: false,
      universeSize: 0,
      targetsGenerated: 0,
      candidatesSelected: 0,
      barLookbackDays: 365,
      barLookbackStart: result.barLookbackStart,
      warnings: ["RESEARCH_ALREADY_RUNNING"]
    });
    assert.equal(fetchCalls, 0);
    assert.equal(
      readCount("SELECT COUNT(*) AS count FROM research_runs WHERE status = 'running'"),
      1
    );
  });

  test("stops before candidate writes when the research lease is lost", async () => {
    let leaseRevoked = false;
    globalThis.fetch = async (input: string | Request | URL) => {
      const target = String(input);
      if (target.includes("/v2/stocks/bars")) {
        const activeRun = getDb()
          .prepare("SELECT id, status FROM research_runs ORDER BY started_at DESC LIMIT 1")
          .get() as { id: string; status: string };
        if (!leaseRevoked) {
          assert.equal(activeRun.status, "running");
          getDb()
            .prepare(`
              UPDATE research_runs
              SET status = 'failed', completed_at = ?, recovery_reason = 'TEST_LEASE_RECOVERY'
              WHERE id = ? AND status = 'running'
            `)
            .run(new Date().toISOString(), activeRun.id);
          leaseRevoked = true;
        }

        const endpoint = new URL(target);
        const symbols = (endpoint.searchParams.get("symbols") || "")
          .split(",")
          .filter(Boolean)
          .map((value) => value.toUpperCase());
        return makeMockResponse({
          bars: buildBarsPayload(symbols).barsBySymbol
        });
      }
      return makeMockResponse({});
    };

    await assert.rejects(
      () => runResearchDaily({ riskProfile: "moderate", optionsEnabled: false, maxCandidates: 4 }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "RESEARCH_RUN_LEASE_LOST"
    );

    const recovered = getDb()
      .prepare("SELECT id, status, recovery_reason FROM research_runs ORDER BY started_at DESC LIMIT 1")
      .get() as { id: string; status: string; recovery_reason: string };
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.recovery_reason, "TEST_LEASE_RECOVERY");
    assert.equal(
      readCount(
        `SELECT COUNT(*) AS count FROM paper_trade_candidates WHERE research_run_id = '${recovered.id}'`
      ),
      0
    );
    assert.equal(
      readCount(
        `SELECT COUNT(*) AS count FROM paper_trade_plans WHERE research_run_id = '${recovered.id}'`
      ),
      0
    );
  });

  test("completes when bars response includes next_page_token null", async () => {
    setMockFetchForSuccess(false, null, null);
    const result = await runResearchDaily({ riskProfile: "moderate", optionsEnabled: false, maxCandidates: 4 });

    const run = getDb()
      .prepare("SELECT status, targets_generated, candidates_selected FROM research_runs WHERE id = ?")
      .get(result.runId) as {
      status: string;
      targets_generated: number;
      candidates_selected: number;
    };

    assert.equal(run.status, "completed");
    assert.equal(run.targets_generated, result.targetsGenerated);
    assert.equal(run.candidates_selected, result.candidatesSelected);
  });

  test("completes when bars response is an empty object and next_page_token is null", async () => {
    setMockFetchForSuccess(false, {}, null);
    const result = await runResearchDaily({ riskProfile: "moderate", optionsEnabled: false, maxCandidates: 4 });

    const run = getDb()
      .prepare("SELECT status FROM research_runs WHERE id = ?")
      .get(result.runId) as { status: string };
    assert.equal(run.status, "completed");
    assert.equal(typeof result.runId, "string");
    assert.equal(result.universeSize >= 1, true);
    assert.equal(result.candidatesSelected >= 0, true);
  });

  test("creates research run records and paper plans on success", async () => {
    setMockFetchForSuccess(false);
    const result = await runResearchDaily({
      riskProfile: "aggressive",
      optionsEnabled: false,
      maxCandidates: 5,
      maxPerSymbol: 2,
      maxPerDirection: 3,
      maxPerExpression: 4
    });

    const run = getDb()
      .prepare("SELECT * FROM research_runs WHERE id = ?")
      .get(result.runId) as {
      id: string;
      status: string;
      targets_generated: number;
      candidates_selected: number;
      universe_size: number;
    };

    assert.equal(run.status, "completed");
    assert.equal(run.targets_generated, result.targetsGenerated);
    assert.equal(run.candidates_selected, result.candidatesSelected);
    assert.equal(run.universe_size >= 1, true);

    const candidateCount = readCount(
      `SELECT COUNT(*) AS count FROM paper_trade_candidates WHERE research_run_id = '${result.runId}'`
    );
    const selectedCandidateCount = readCount(
      `SELECT COUNT(*) AS count FROM paper_trade_candidates WHERE research_run_id = '${result.runId}' AND decision = 'selected'`
    );
    const planCount = readCount(
      `SELECT COUNT(*) AS count FROM paper_trade_plans WHERE research_run_id = '${result.runId}'`
    );
    assert.equal(selectedCandidateCount, result.candidatesSelected);
    assert.equal(planCount, selectedCandidateCount);
    assert.equal(candidateCount >= selectedCandidateCount, true);
    assert.ok(planCount > 0);
  });

  test("uses a historical daily-bar lookback for candidate generation", async () => {
    const starts: string[] = [];
    globalThis.fetch = async (input: string | Request | URL) => {
      const target = String(input);
      if (target.includes("/v2/stocks/bars")) {
        const endpoint = new URL(target);
        starts.push(endpoint.searchParams.get("start") || "");
        const symbols = (endpoint.searchParams.get("symbols") || "")
          .split(",")
          .filter(Boolean)
          .map((value) => value.toUpperCase());
        return makeMockResponse({
          bars: buildBarsPayload(symbols).barsBySymbol
        });
      }
      return makeMockResponse({});
    };

    const result = await runResearchDaily({
      riskProfile: "moderate",
      optionsEnabled: false,
      maxCandidates: 2,
      barLookbackDays: 90
    });
    const run = getDb()
      .prepare("SELECT config_json FROM research_runs WHERE id = ?")
      .get(result.runId) as { config_json: string };
    const configJson = JSON.parse(run.config_json) as {
      barLookbackDays: number;
      barLookbackStart: string;
    };

    assert.equal(result.barLookbackDays, 90);
    assert.equal(configJson.barLookbackDays, 90);
    assert.equal(starts.length > 0, true);
    assert.equal(starts.every(Boolean), true);
    assert.equal(starts.every((value) => value === result.barLookbackStart), true);
  });

  test("builds a JSON paper report from a completed research run", async () => {
    setMockFetchForSuccess(false);
    const result = await runResearchDaily({ riskProfile: "moderate", optionsEnabled: false, maxCandidates: 4 });
    const report = buildResearchReport({ runId: result.runId });

    assert.equal(report.run.id, result.runId);
    assert.equal(report.run.status, "completed");
    assert.equal(report.topCandidates.length, result.candidatesSelected);
    assert.equal(report.paperTradePlans.length, result.candidatesSelected);
    assert.ok(typeof report.topCandidates[0]?.rank === "number");
    assert.ok(Array.isArray(report.bestLearningSignals));
  });

  test("marks research run as failed when the daily pipeline errors", async () => {
    setMockFetchForFailure();
    await assert.rejects(
      () => runResearchDaily({ riskProfile: "moderate", optionsEnabled: false }),
      /mocked provider failure|Alpaca request failed/i
    );
    const run = getDb()
      .prepare("SELECT status, error_message FROM research_runs ORDER BY started_at DESC LIMIT 1")
      .get() as { status: string; error_message: string };
    assert.equal(run.status, "failed");
    assert.equal(typeof run.error_message, "string");
  });

  test("uses options-first candidate ranking in aggressive mode", async () => {
    setMockFetchForSuccess(true);
    const asOf = ts(59);
    await seedInitialUniverse();
    insertFeature("SPY", asOf, {
      close: 100,
      trend: "bullish",
      atr14: 2,
      rsi14: 65,
      ema9: 105,
      ema21: 103,
      macdHistogram: 0.5,
      relativeVolume: 1.4,
      callLiquidityAvailable: 2,
      putLiquidityAvailable: 0,
      optionsNearestExpiration: "2026-12-31",
      preferredContractLiquidityScore: 0.9
    });
    insertFeature("QQQ", asOf, {
      close: 200,
      trend: "bearish",
      atr14: 2,
      rsi14: 35,
      ema9: 195,
      ema21: 198,
      macdHistogram: -0.5,
      relativeVolume: 1.4,
      callLiquidityAvailable: 0,
      putLiquidityAvailable: 2,
      optionsNearestExpiration: "2026-12-31",
      preferredContractLiquidityScore: 0.9
    });
    getDb()
      .prepare(
        `
        INSERT INTO options_strategy_snapshots(
          symbol,
          as_of,
          direction,
          preferred_expression,
          alternatives,
          rationale,
          options_candidate
        ) VALUES
        (?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "SPY",
        asOf,
        "long",
        "long_call",
        JSON.stringify(["shares"]),
        JSON.stringify(["existing option opportunity"]),
        JSON.stringify({
          optionSymbol: "SPY_C_MID",
          strike: 100,
          shortStrike: null
        }),
        "QQQ",
        asOf,
        "short",
        "long_put",
        JSON.stringify(["shares"]),
        JSON.stringify(["existing option opportunity"]),
        JSON.stringify({
          optionSymbol: "QQQ_P_MID",
          strike: 200,
          shortStrike: null
        })
      );

    const ranked = rankResearchCandidates({
      researchRunId: "manual-agg-opt",
      riskProfile: "aggressive",
      optionsEnabled: true,
      targets: [
        {
          symbol: "SPY",
          asOf,
          direction: "long",
          horizon: "1d",
          entryReference: 100,
          upsideTarget: 110,
          downsideRisk: 95,
          stopLoss: 95,
          takeProfit: 110,
          confidence: 0.78,
          expectedReturn: 0.04,
          volatilityAdjustedScore: 1.1,
          riskProfile: "aggressive",
          preferredExpression: "shares",
          rationale: ["target baseline"]
        },
        {
          symbol: "SPY",
          asOf,
          direction: "long",
          horizon: "1d",
          entryReference: 100,
          upsideTarget: 112,
          downsideRisk: 94,
          stopLoss: 94,
          takeProfit: 112,
          confidence: 0.8,
          expectedReturn: 0.05,
          volatilityAdjustedScore: 1.2,
          riskProfile: "aggressive",
          preferredExpression: "long_call",
          rationale: ["target options first"]
        }
      ],
      maxCandidates: 2,
      maxPerSymbol: 4,
      maxPerDirection: 4,
      maxPerExpression: 4
    });

    assert.equal(ranked.candidates.length, 2);
    assert.equal(ranked.candidates[0].preferredExpression, "long_call");
  });
});

describe("Candidate ranking", () => {
  test("applies learning influence and emits asymmetric rationale", async () => {
    getDb()
      .prepare(
        `
        INSERT INTO learning_runs(
          id,
          model_name,
          trained_at,
          horizon,
          universe_json,
          metrics_json,
          feature_importance_json,
          strategy_performance_json,
          notes_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "learn-test-high",
        "unit-test",
        ts(0),
        "1d",
        JSON.stringify(["SPY", "QQQ"]),
        JSON.stringify({ directionalAccuracy: 0.84, optionOutperformanceAccuracy: 0.77 }),
        "{}",
        "{}",
        "{}"
      );

    getDb()
      .prepare(
        `
        INSERT INTO options_strategy_snapshots(
          symbol,
          as_of,
          direction,
          preferred_expression,
          alternatives,
          rationale,
          options_candidate
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "SPY",
        ts(0),
        "long",
        "long_call",
        JSON.stringify(["shares"]),
        JSON.stringify(["candidate"]),
        JSON.stringify({ optionSymbol: "SPY_C_MID", strike: 100 })
      );

    const ranked = rankResearchCandidates({
      researchRunId: "learning-rank-test",
      riskProfile: "moderate",
      optionsEnabled: true,
      targets: [
        {
          symbol: "SPY",
          asOf: ts(0),
          direction: "long",
          horizon: "1d",
          entryReference: 100,
          upsideTarget: 104,
          downsideRisk: 97,
          stopLoss: 97,
          takeProfit: 104,
          confidence: 0.71,
          expectedReturn: 0.04,
          volatilityAdjustedScore: 1.1,
          riskProfile: "moderate",
          preferredExpression: "long_call",
          rationale: ["learning-aware candidate"]
        }
      ],
      maxCandidates: 1,
      maxPerSymbol: 1,
      maxPerDirection: 1,
      maxPerExpression: 1
    });

    assert.equal(ranked.candidates.length, 1);
    assert.equal(ranked.candidates[0].recentLearningAdjustment, 5);
    assert.ok(
      ranked.candidates[0].rationale.some((entry) =>
        entry.includes("Recent directional learning accuracy")
      )
    );
  });

  test("considers backtest performance in candidate annotations", async () => {
    const runId = "bt-run-1";
    getDb()
      .prepare(
        `
        INSERT INTO backtest_runs(
          id,
          started_at,
          completed_at,
          status,
          config_json,
          metrics_json,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        runId,
        ts(0),
        ts(1),
        "completed",
        JSON.stringify({ mode: "unit" }),
        JSON.stringify({ maxDrawdown: -0.08 }),
        "unit test"
      );
    getDb()
      .prepare(
        `
        INSERT INTO backtest_options_trades(
          run_id,
          underlying_symbol,
          option_symbol,
          strategy,
          entry_date,
          exit_date,
          expiration_date,
          strike,
          short_strike,
          entry_premium,
          exit_premium,
          contracts,
          estimated_max_loss,
          estimated_max_profit,
          pnl,
          return_pct,
          exit_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        runId,
        "SPY",
        "SPY_C_MID",
        "long_call",
        ts(0),
        ts(5),
        "2026-12-31",
        100,
        null,
        1.2,
        1.9,
        1,
        100,
        400,
        75,
        0.75,
        "take_profit"
      );

    getDb()
      .prepare(
        `
        INSERT INTO options_strategy_snapshots(
          symbol,
          as_of,
          direction,
          preferred_expression,
          alternatives,
          rationale,
          options_candidate
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "SPY",
        ts(5),
        "long",
        "long_call",
        JSON.stringify(["shares"]),
        JSON.stringify(["candidate"]),
        JSON.stringify({ optionSymbol: "SPY_C_MID", strike: 100 })
      );

    const ranked = rankResearchCandidates({
      researchRunId: "backtest-rank-test",
      riskProfile: "moderate",
      optionsEnabled: true,
      targets: [
        {
          symbol: "SPY",
          asOf: ts(5),
          direction: "long",
          horizon: "1d",
          entryReference: 100,
          upsideTarget: 106,
          downsideRisk: 95,
          stopLoss: 95,
          takeProfit: 106,
          confidence: 0.77,
          expectedReturn: 0.05,
          volatilityAdjustedScore: 1.2,
          riskProfile: "moderate",
          preferredExpression: "long_call",
          rationale: ["linked to backtest"]
        }
      ],
      maxCandidates: 1,
      maxPerSymbol: 1,
      maxPerDirection: 1,
      maxPerExpression: 1
    });

    assert.equal(ranked.candidates.length, 1);
    assert.equal(ranked.candidates[0].relevantBacktestRunId, runId);
    assert.ok(ranked.candidates[0].historicalWinRate !== null);
    assert.equal(ranked.candidates[0].similarSetupCount, 1);
    assert.equal(ranked.candidates[0].historicalMaxDrawdown, -0.08);
  });

  test("enforces diversity caps and reports concentration", () => {
    const asOf = ts(20);
    const ranked = rankResearchCandidates({
      researchRunId: "diversity-test",
      riskProfile: "moderate",
      optionsEnabled: true,
      targets: Array.from({ length: 6 }, (_, index) => ({
        symbol: "SPY",
        asOf,
        direction: "long",
        horizon: "1d",
        entryReference: 100 + index,
        upsideTarget: 106,
        downsideRisk: 95,
        stopLoss: 95,
        takeProfit: 106,
        confidence: 0.51 + index * 0.01,
        expectedReturn: 0.02,
        volatilityAdjustedScore: 1.1,
        riskProfile: "moderate",
        preferredExpression: "shares",
        rationale: ["concentrated signal"]
      })),
      maxCandidates: 4,
      maxPerSymbol: 20,
      maxPerDirection: 20,
      maxPerExpression: 20
    });

    assert.equal(ranked.candidates.length, 4);
    assert.ok(
      ranked.warnings.some((warning) => warning.includes("Candidate list is concentrated"))
    );
  });
});

describe("Paper plan and evaluation", () => {
  test("creates paper plans with thesis, invalidation, and learning objective", () => {
    getDb()
      .prepare(
        `
        INSERT INTO research_runs(
          id,
          started_at,
          status,
          risk_profile,
          options_enabled,
          universe_size,
          targets_generated,
          candidates_selected,
          error_message,
          config_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "run-plans-1",
        ts(0),
        "completed",
        "moderate",
        0,
        1,
        1,
        1,
        null,
        JSON.stringify({ riskProfile: "moderate" })
      );
    getDb()
      .prepare(
        `
        INSERT INTO paper_trade_candidates(
          id,
          research_run_id,
          symbol,
          as_of,
          rank,
          direction,
          horizon,
          risk_profile,
          preferred_expression,
          score,
          confidence,
          expected_return,
          estimated_max_loss,
          estimated_max_profit,
          rationale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "candidate-1",
        "run-plans-1",
        "SPY",
        ts(10),
        1,
        "long",
        "1d",
        "moderate",
        "long_call",
        80,
        0.78,
        0.04,
        300,
        900,
        JSON.stringify(["option flow supportive"])
      );
    getDb()
      .prepare(
        `
        INSERT INTO target_snapshots(
          symbol,
          as_of,
          direction,
          horizon,
          entry_reference,
          upside_target,
          downside_risk,
          stop_loss,
          take_profit,
          confidence,
          expected_return,
          volatility_adjusted_score,
          risk_profile,
          preferred_expression,
          rationale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "SPY",
        ts(10),
        "long",
        "1d",
        110,
        114,
        108,
        107,
        114,
        0.78,
        0.04,
        1.1,
        "moderate",
        "long_call",
        JSON.stringify(["manual candidate"])
      );

    const [plan] = buildPaperTradePlans({
      researchRunId: "run-plans-1",
      riskProfile: "moderate",
      candidates: [
        {
          id: "candidate-1",
          symbol: "SPY",
          asOf: ts(10),
          rank: 1,
          direction: "long",
          horizon: "1d",
          riskProfile: "moderate",
          preferredExpression: "long_call",
          score: 80,
          confidence: 0.78,
          expectedReturn: 0.04,
          estimatedMaxLoss: 300,
          estimatedMaxProfit: 900,
          rationale: ["option flow supportive"],
          optionSymbol: "SPY_C_MID",
          strike: 100,
          shortStrike: null,
          relevantBacktestRunId: null,
          historicalWinRate: null,
          historicalAvgReturn: null,
          historicalMaxDrawdown: null,
          similarSetupCount: null,
          optionLiquidityScore: 0.9,
          volatilityAdjustedScore: 1.1,
          signalFreshnessDays: 0,
          recentLearningAdjustment: 0,
          directionalAccuracy: null,
          optionOutperformanceAccuracy: null
        }
      ]
    });

    assert.equal(plan.status, "planned");
    assert.equal(plan.thesis.length > 0, true);
    assert.equal(plan.invalidation.length > 0, true);
    assert.equal(plan.learningObjective.length > 0, true);
    assert.equal(plan.optionSymbol, "SPY_C_MID");
    assert.equal(plan.estimatedEntryCost, 3000);
  });

  test("evaluates paper plans into outcomes and updates status", () => {
    const runId = "run-eval-1";
    const candidateId = "candidate-eval-1";
    const planId = "plan-eval-1";
    const createdAt = ts(40);
    const dueAt = new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1_000).toISOString();

    getDb()
      .prepare(
        `
        INSERT INTO research_runs(
          id,
          started_at,
          status,
          risk_profile,
          options_enabled,
          universe_size,
          targets_generated,
          candidates_selected,
          error_message,
          config_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(runId, createdAt, "completed", "moderate", 0, 1, 1, 1, null, JSON.stringify({ riskProfile: "moderate" }));

    getDb()
      .prepare(
        `
        INSERT INTO paper_trade_candidates(
          id,
          research_run_id,
          symbol,
          as_of,
          rank,
          direction,
          horizon,
          risk_profile,
          preferred_expression,
          score,
          confidence,
          expected_return,
          estimated_max_loss,
          estimated_max_profit,
          rationale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        candidateId,
        runId,
        "SPY",
        ts(40),
        1,
        "long",
        "1d",
        "moderate",
        "shares",
        76,
        0.68,
        0.03,
        150,
        300,
        JSON.stringify(["evaluate test"])
      );

    getDb()
      .prepare(
        `
        INSERT INTO paper_trade_plans(
          id,
          research_run_id,
          candidate_id,
          symbol,
          created_at,
          status,
          direction,
          expression,
          entry_reference,
          stop_loss,
          take_profit,
          expiration_date,
          option_symbol,
          strike,
          short_strike,
          estimated_entry_cost,
          estimated_max_loss,
          estimated_max_profit,
          thesis,
          invalidation,
          learning_objective
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        planId,
        runId,
        candidateId,
        "SPY",
        createdAt,
        "planned",
        "long",
        "shares",
        100,
        95,
        112,
        null,
        null,
        null,
        null,
        500,
        150,
        300,
        "Long SPY on bullish setup.",
        "Price falls below stop-loss or invalidates setup.",
        "Test whether long SPY shares improve score over baseline."
      );

    insertBar("SPY", dueAt, 101, 116);
    const result = evaluatePaperTrades({ asOf: dueAt, horizon: "1d" });

    assert.equal(result.evaluated, 1);
    assert.equal(result.evaluations[0].outcome, "hit_take_profit");
    const planRow = getDb()
      .prepare("SELECT status FROM paper_trade_plans WHERE id = ?")
      .get(planId) as { status: string };
    assert.equal(planRow.status, "closed");
    assert.equal(result.evaluations[0].returnPct, 3.2);
  });
});
