import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-market-observatory-test-")),
  "research.db"
);
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_MAX_RETRIES = "1";

const [
  libDb,
  universeService,
  stockSnapshotNormalizer,
  stockObservationService,
  alpacaProvider,
  featureService,
  candidateRankingService,
  paperTradeService,
  learningService
] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/universeService.js"),
  import("../src/services/stockSnapshotNormalizer.js"),
  import("../src/services/stockObservationService.js"),
  import("../src/services/providers/alpaca.js"),
  import("../src/services/featureService.js"),
  import("../src/services/candidateRankingService.js"),
  import("../src/services/paperTradeService.js"),
  import("../src/services/learningService.js")
]);

const { closeDbForTests, getDb } = libDb;
const {
  getAllUniverse,
  getUniverseSymbol,
  refreshUniverseAssetMetadata,
  seedInitialUniverse
} = universeService;
const { normalizeStockSnapshot } = stockSnapshotNormalizer;
const { persistStockSnapshot, runStockObservation } = stockObservationService;
const { fetchStockSnapshots } = alpacaProvider;
const { buildFeatures } = featureService;
const { persistCandidateDecisions, rankResearchCandidates } = candidateRankingService;
const { buildPaperTradePlans } = paperTradeService;
const { runLearning } = learningService;

const originalSymbols = [
  "SPY", "NEE", "POOL", "NFG", "CVS", "SOFI", "XLE", "XLK", "QQQ", "IWM",
  "TSLA", "HNRG", "HRB", "NSP", "SCHD", "TWO", "VWO", "VUG", "RSP", "VTI",
  "IVV", "VOO", "IJR", "XLF", "TQQQ", "VTV", "VO", "VB", "VXF", "VBR",
  "COP", "VEA"
];

const requestedSymbols = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX",
  "JPM", "GS", "XOM", "LLY", "UNH", "COST", "WMT", "CAT", "PLTR", "SMCI"
];

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_trade_evaluations;
    DELETE FROM paper_trade_plans;
    DELETE FROM paper_trade_candidates;
    DELETE FROM research_runs;
    DELETE FROM learning_runs;
    DELETE FROM target_snapshots;
    DELETE FROM feature_snapshots;
    DELETE FROM market_bars;
    DELETE FROM stock_snapshots;
    DELETE FROM ingestion_runs;
    DELETE FROM universe_symbols;
  `);
};

const insertResearchRun = (id: string) => {
  getDb().prepare(`
    INSERT INTO research_runs(
      id, started_at, completed_at, status, risk_profile, options_enabled,
      universe_size, targets_generated, candidates_selected, config_json
    ) VALUES (?, ?, ?, 'completed', 'moderate', 0, 51, 4, 1, '{}')
  `).run(id, "2026-07-13T16:45:00.000Z", "2026-07-13T16:46:00.000Z");
};

const completeSnapshot = {
  latestTrade: {
    t: "2026-07-13T16:44:48.000Z",
    p: 100.1,
    s: 10,
    x: "V",
    c: ["@"]
  },
  latestQuote: {
    t: "2026-07-13T16:44:50.000Z",
    bp: 100,
    ap: 100.2,
    bs: 5,
    as: 7,
    bx: "V",
    ax: "V",
    c: ["R"]
  },
  minuteBar: {
    t: "2026-07-13T16:44:00.000Z",
    o: 99.9,
    h: 100.3,
    l: 99.8,
    c: 100.1,
    v: 1000,
    n: 40,
    vw: 100.05
  },
  dailyBar: {
    t: "2026-07-13T04:00:00.000Z",
    o: 98,
    h: 101,
    l: 97.5,
    c: 100,
    v: 100_000,
    n: 4000,
    vw: 99.5
  },
  prevDailyBar: {
    t: "2026-07-10T04:00:00.000Z",
    o: 96,
    h: 99,
    l: 95,
    c: 97,
    v: 200_000,
    n: 8000,
    vw: 97.25
  }
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

describe("market observatory universe", () => {
  test("canonical universe retains existing symbols and includes the requested set once", async () => {
    const first = await seedInitialUniverse();
    const second = await seedInitialUniverse();

    assert.equal(first.symbols.length, 51);
    assert.deepEqual(second.symbols, first.symbols);
    assert.equal(new Set(second.symbols).size, 51);
    requestedSymbols.forEach((symbol) => assert.equal(second.symbols.includes(symbol), true));
    originalSymbols.forEach((symbol) => assert.equal(second.symbols.includes(symbol), true));
    assert.equal(getAllUniverse().length, 51);
  });

  test("Alpaca asset validation persists traceable metadata", async () => {
    await seedInitialUniverse();
    const result = await refreshUniverseAssetMetadata({
      symbols: ["AAPL"],
      getAsset: async () => ({
        id: "asset-aapl",
        class: "us_equity",
        exchange: "NASDAQ",
        symbol: "AAPL",
        status: "active",
        tradable: true,
        marginable: true,
        shortable: true,
        fractionable: true,
        attributes: ["has_options", "overnight_tradable"],
        requestId: "asset-request"
      })
    });

    const row = getUniverseSymbol("AAPL");
    assert.deepEqual(result, { checked: 1, active: 1, disabled: 0, failed: [] });
    assert.equal(row?.assetId, "asset-aapl");
    assert.equal(row?.assetStatus, "active");
    assert.equal(row?.exchange, "NASDAQ");
    assert.equal(row?.fractionable, 1);
    assert.equal(row?.shortable, 1);
    assert.equal(row?.marginable, 1);
    assert.equal(row?.optionsEnabled, 1);
    assert.deepEqual(row?.assetAttributes, ["has_options", "overnight_tradable"]);
    assert.equal(row?.assetRequestId, "asset-request");
    assert.ok(row?.assetValidatedAt);
  });

  test("inactive or non-tradable Alpaca assets are retained but disabled", async () => {
    await seedInitialUniverse();
    const result = await refreshUniverseAssetMetadata({
      symbols: ["AAPL", "MSFT"],
      getAsset: async (symbol: string) => ({
        symbol,
        status: symbol === "AAPL" ? "inactive" : "active",
        tradable: false
      })
    });

    assert.equal(result.disabled, 2);
    assert.equal(getUniverseSymbol("AAPL")?.enabled, 0);
    assert.equal(getUniverseSymbol("AAPL")?.tradable, 0);
    assert.equal(getUniverseSymbol("AAPL")?.assetStatus, "inactive");
    assert.equal(getUniverseSymbol("MSFT")?.enabled, 0);
    assert.equal(getUniverseSymbol("MSFT")?.tradable, 0);
  });
});

describe("market observatory stock snapshots", () => {
  test("uses Alpaca multi-symbol snapshots and represents a partial response", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return {
        ok: true,
        status: 200,
        headers: { get: () => "snapshot-request" },
        text: async () => JSON.stringify({ AAPL: completeSnapshot })
      } as unknown as Response;
    };

    const rows = await fetchStockSnapshots({
      symbols: ["AAPL", "MSFT"],
      feed: "iex",
      currency: "USD"
    });

    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? "", /\/v2\/stocks\/snapshots\?/);
    assert.match(urls[0] ?? "", /symbols=AAPL%2CMSFT/);
    assert.match(urls[0] ?? "", /feed=iex/);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.symbol, "AAPL");
    assert.equal(rows[0]?.requestId, "snapshot-request");
    assert.equal(rows[0]?.requestedFeed, "iex");
    assert.equal(rows[0]?.effectiveFeed, "iex");
    assert.equal(rows[1]?.symbol, "MSFT");
    assert.equal(rows[1]?.raw, null);
    assert.equal(rows[1]?.error, "SOURCE_SYMBOL_MISSING");
  });

  test("bounds provider retries and returns explicit source errors", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      throw new Error("temporary network failure");
    };

    const rows = await fetchStockSnapshots({ symbols: ["AAPL"], feed: "iex" });

    assert.equal(attempts, 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.error, "STOCK_SNAPSHOT_REQUEST_FAILED");
  });

  test("normalizes complete evidence while preserving source and ingestion timestamps", () => {
    const row = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: completeSnapshot,
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      currency: "USD",
      requestId: "snapshot-request",
      now: new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(row.observedAt, "2026-07-13T16:45:00.000Z");
    assert.equal(row.sourceTimestamp, "2026-07-13T16:44:50.000Z");
    assert.equal(row.tradeTimestamp, "2026-07-13T16:44:48.000Z");
    assert.equal(row.quoteTimestamp, "2026-07-13T16:44:50.000Z");
    assert.equal(row.minuteTimestamp, "2026-07-13T16:44:00.000Z");
    assert.equal(row.latestTradePrice, 100.1);
    assert.equal(row.midpoint, 100.1);
    assert.ok(Math.abs((row.spread ?? 0) - 0.2) < 1e-10);
    assert.ok(Math.abs((row.spreadPct ?? 0) - 0.1998001998) < 1e-8);
    assert.equal(row.dailyReturn, 100 / 97 - 1);
    assert.equal(row.gapFromPreviousClose, 98 / 97 - 1);
    assert.equal(row.returnFromOpen, 100 / 98 - 1);
    assert.equal(row.distanceFromVwap, 100 / 99.5 - 1);
    assert.equal(row.intradayRange, 3.5);
    assert.equal(row.relativeCurrentDayVolume, 0.5);
    assert.equal(row.freshnessStatus, "FRESH");
    assert.equal(row.dataQualityStatus, "COMPLETE");
    assert.equal(row.requestedFeed, "iex");
    assert.equal(row.effectiveFeed, "iex");
    assert.equal(row.requestId, "snapshot-request");
  });

  test("represents missing and stale evidence explicitly", () => {
    const missingQuote = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: { ...completeSnapshot, latestQuote: undefined },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });
    const missingTrade = normalizeStockSnapshot({
      symbol: "MSFT",
      raw: { ...completeSnapshot, latestTrade: undefined },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });
    const missingMinute = normalizeStockSnapshot({
      symbol: "NVDA",
      raw: { ...completeSnapshot, minuteBar: undefined },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });
    const stale = normalizeStockSnapshot({
      symbol: "AMZN",
      raw: completeSnapshot,
      observedAt: "2026-07-13T17:30:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T17:30:00.000Z")
    });

    assert.equal(missingQuote.dataQualityStatus, "MISSING_QUOTE");
    assert.equal(missingQuote.bidPrice, null);
    assert.equal(missingQuote.spread, null);
    assert.equal(missingTrade.dataQualityStatus, "MISSING_TRADE");
    assert.equal(missingTrade.latestTradePrice, null);
    assert.equal(missingMinute.dataQualityStatus, "MISSING_MINUTE_BAR");
    assert.equal(missingMinute.minuteTimestamp, null);
    assert.equal(stale.freshnessStatus, "STALE");
  });

  test("marks incomplete daily context partial and preserves observed zeroes", () => {
    const row = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: {
        ...completeSnapshot,
        latestQuote: { ...completeSnapshot.latestQuote, bp: 0, ap: 0 },
        prevDailyBar: undefined
      },
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(row.bidPrice, 0);
    assert.equal(row.askPrice, 0);
    assert.equal(row.midpoint, 0);
    assert.equal(row.spread, 0);
    assert.equal(row.spreadPct, null);
    assert.equal(row.previousDailyClose, null);
    assert.equal(row.dailyReturn, null);
    assert.equal(row.dataQualityStatus, "PARTIAL");
  });

  test("persists append-only evidence and deduplicates repeated source timestamps", () => {
    const row = normalizeStockSnapshot({
      symbol: "AAPL",
      raw: completeSnapshot,
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      now: new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(persistStockSnapshot(row, 1), 1);
    assert.equal(persistStockSnapshot(row, 2), 0);
    const stored = getDb()
      .prepare("SELECT * FROM stock_snapshots WHERE symbol = ?")
      .all("AAPL") as Array<Record<string, unknown>>;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.source_timestamp, "2026-07-13T16:44:50.000Z");
    assert.equal(stored[0]?.observed_at, "2026-07-13T16:45:00.000Z");
  });
});

describe("market observatory research traceability", () => {
  test("enriches only the latest feature row with the latest raw observation", async () => {
    const insertBar = getDb().prepare(`
      INSERT INTO market_bars(symbol, timeframe, timestamp, open, high, low, close, volume, source)
      VALUES (?, '1Day', ?, ?, ?, ?, ?, ?, 'test')
    `);
    insertBar.run("AAPL", "2026-07-10T04:00:00.000Z", 96, 99, 95, 97, 200_000);
    insertBar.run("AAPL", "2026-07-13T04:00:00.000Z", 98, 101, 97.5, 100, 100_000);
    persistStockSnapshot(normalizeStockSnapshot({
      symbol: "AAPL",
      raw: completeSnapshot,
      observedAt: "2026-07-13T16:45:00.000Z",
      requestedFeed: "iex",
      effectiveFeed: "iex",
      currency: "USD",
      now: new Date("2026-07-13T16:45:00.000Z")
    }));

    await buildFeatures({ symbols: ["AAPL"], timeframe: "1Day" });

    const rows = getDb()
      .prepare("SELECT timestamp, features FROM feature_snapshots WHERE symbol = ? ORDER BY timestamp")
      .all("AAPL") as Array<{ timestamp: string; features: string }>;
    const earlier = JSON.parse(rows[0]?.features ?? "{}") as Record<string, unknown>;
    const latest = JSON.parse(rows[1]?.features ?? "{}") as Record<string, unknown>;
    assert.equal(rows.length, 2);
    assert.equal(earlier.observatoryObservedAt, undefined);
    assert.equal(latest.observatoryObservedAt, "2026-07-13T16:45:00.000Z");
    assert.equal(latest.observatoryEffectiveFeed, "iex");
    assert.ok(Math.abs(Number(latest.observatorySpread) - 0.2) < 1e-10);
    assert.equal(latest.observatoryDataQualityStatus, "COMPLETE");
    assert.equal(latest.observatoryFreshnessStatus, "FRESH");
    assert.equal(latest.observatoryDailyReturn, 100 / 97 - 1);
  });

  test("persists selected, rejected, skipped, and blocked scored decisions without planning non-selected rows", () => {
    const researchRunId = "market-observatory-decisions";
    insertResearchRun(researchRunId);
    const asOf = "2026-07-13T16:45:00.000Z";
    const targets = ["AAPL", "MSFT", "PLTR", "SMCI"].map((symbol, index) => ({
      symbol,
      asOf,
      direction: "long" as const,
      horizon: "1d" as const,
      entryReference: 100 + index,
      upsideTarget: 110 + index,
      downsideRisk: 95 + index,
      stopLoss: 95 + index,
      takeProfit: 110 + index,
      confidence: 0.8 - index * 0.05,
      expectedReturn: 0.05 - index * 0.005,
      volatilityAdjustedScore: 1 - index * 0.1,
      riskProfile: "moderate" as const,
      preferredExpression: "shares" as const,
      rationale: [`traceable ${symbol}`]
    }));
    const ranked = rankResearchCandidates({
      researchRunId,
      riskProfile: "moderate",
      optionsEnabled: false,
      targets,
      maxCandidates: 1,
      maxPerSymbol: 1,
      maxPerDirection: 4,
      maxPerExpression: 4
    });
    const decisions = ranked.decisions.map((entry, index) => {
      if (index === 1) {
        return { ...entry, decision: "rejected" as const, decisionReason: "TEST_REJECTED" };
      }
      if (index === 3) {
        return { ...entry, decision: "blocked" as const, decisionReason: "TEST_BLOCKED" };
      }
      return entry;
    });

    const persisted = persistCandidateDecisions({ researchRunId, decisions });
    const selectedTarget = targets.find((target) => target.symbol === ranked.candidates[0]?.symbol);
    assert.ok(selectedTarget);
    getDb().prepare(`
      INSERT INTO target_snapshots(
        symbol, as_of, direction, horizon, entry_reference, upside_target,
        downside_risk, stop_loss, take_profit, confidence, expected_return,
        volatility_adjusted_score, risk_profile, preferred_expression, rationale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      selectedTarget.symbol,
      selectedTarget.asOf,
      selectedTarget.direction,
      selectedTarget.horizon,
      selectedTarget.entryReference,
      selectedTarget.upsideTarget,
      selectedTarget.downsideRisk,
      selectedTarget.stopLoss,
      selectedTarget.takeProfit,
      selectedTarget.confidence,
      selectedTarget.expectedReturn,
      selectedTarget.volatilityAdjustedScore,
      selectedTarget.riskProfile,
      selectedTarget.preferredExpression,
      JSON.stringify(selectedTarget.rationale)
    );
    buildPaperTradePlans({
      researchRunId,
      candidates: ranked.candidates,
      riskProfile: "moderate"
    });

    assert.equal(ranked.candidates.length, 1);
    assert.equal(ranked.decisions.length, 4);
    assert.equal(persisted.length, 4);
    const stored = getDb()
      .prepare(`
        SELECT decision, decision_reason, strategy_family, signal_inputs_json,
               data_quality_status
        FROM paper_trade_candidates
        WHERE research_run_id = ?
        ORDER BY rank, symbol
      `)
      .all(researchRunId) as Array<Record<string, unknown>>;
    assert.deepEqual(new Set(stored.map((row) => row.decision)), new Set([
      "selected", "rejected", "skipped", "blocked"
    ]));
    assert.equal(stored.every((row) => typeof row.decision_reason === "string"), true);
    assert.equal(stored.every((row) => typeof row.strategy_family === "string"), true);
    assert.equal(stored.every((row) => typeof row.signal_inputs_json === "string"), true);
    assert.equal(stored.every((row) => typeof row.data_quality_status === "string"), true);
    const plans = getDb()
      .prepare("SELECT COUNT(*) AS count FROM paper_trade_plans WHERE research_run_id = ?")
      .get(researchRunId) as { count: number };
    assert.equal(plans.count, 1);
  });

  test("new canonical symbols remain available to learning", async () => {
    getDb().prepare(`
      INSERT INTO feature_snapshots(symbol, timestamp, features)
      VALUES ('PLTR', '2026-07-13T16:45:00.000Z', ?)
    `).run(JSON.stringify({ close: 140, observatoryDataQualityStatus: "COMPLETE" }));

    const model = await runLearning();

    assert.equal(model.universe.includes("PLTR"), true);
  });
});

describe("market observatory collection", () => {
  test("market-open collection records a completed ingestion run", async () => {
    const result = await runStockObservation({
      getClock: async () => ({ isOpen: true }),
      refreshAssets: async () => ({ checked: 0, active: 0, disabled: 0, failed: [] }),
      getSnapshots: async ({ symbols, feed, currency }: {
        symbols: string[];
        feed: string;
        currency?: string;
      }) => symbols.map((symbol) => ({
        symbol,
        raw: completeSnapshot,
        requestedFeed: feed,
        effectiveFeed: feed,
        currency: currency ?? null,
        requestId: "snapshot-request"
      })),
      now: () => new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(result.status, "completed");
    assert.equal(result.requestedSymbols, 51);
    assert.equal(result.successfulSymbols, 51);
    assert.equal(result.failedSymbols, 0);
    assert.equal(result.rowsWritten, 51);
    const run = getDb()
      .prepare(`
        SELECT run_type, status, requested_symbols, successful_symbols,
               failed_symbols, rows_ingested, error_summary
        FROM ingestion_runs WHERE id = ?
      `)
      .get(result.runId) as Record<string, unknown>;
    assert.equal(run.run_type, "stock_snapshots");
    assert.equal(run.status, "completed");
    assert.equal(run.requested_symbols, 51);
    assert.equal(run.successful_symbols, 51);
    assert.equal(run.failed_symbols, 0);
    assert.equal(run.rows_ingested, 51);
    assert.equal(run.error_summary, null);
  });

  test("market-closed collection records a skip and never requests snapshots", async () => {
    let calls = 0;
    const result = await runStockObservation({
      symbols: ["AAPL", "MSFT"],
      getClock: async () => ({ isOpen: false }),
      refreshAssets: async () => ({ checked: 0, active: 0, disabled: 0, failed: [] }),
      getSnapshots: async () => {
        calls += 1;
        return [];
      },
      now: () => new Date("2026-07-13T12:00:00.000Z")
    });

    assert.equal(result.status, "skipped_market_closed");
    assert.equal(result.requestedSymbols, 2);
    assert.equal(result.rowsWritten, 0);
    assert.equal(calls, 0);
    const run = getDb()
      .prepare("SELECT status, rows_ingested FROM ingestion_runs WHERE id = ?")
      .get(result.runId) as Record<string, unknown>;
    assert.equal(run.status, "skipped_market_closed");
    assert.equal(run.rows_ingested, 0);
  });

  test("partial symbol failure preserves successful rows and run evidence", async () => {
    const result = await runStockObservation({
      symbols: ["AAPL", "MSFT"],
      getClock: async () => ({ isOpen: true }),
      refreshAssets: async () => ({ checked: 0, active: 0, disabled: 0, failed: [] }),
      getSnapshots: async () => [
        {
          symbol: "AAPL",
          raw: completeSnapshot,
          requestedFeed: "iex",
          effectiveFeed: "iex",
          currency: "USD",
          requestId: "snapshot-request"
        },
        {
          symbol: "MSFT",
          raw: null,
          requestedFeed: "iex",
          effectiveFeed: "iex",
          currency: "USD",
          requestId: "snapshot-request",
          error: "SOURCE_SYMBOL_MISSING" as const
        }
      ],
      now: () => new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(result.status, "partial");
    assert.equal(result.successfulSymbols, 1);
    assert.equal(result.failedSymbols, 1);
    assert.equal(result.rowsWritten, 2);
    assert.deepEqual(result.errors, [{ symbol: "MSFT", reason: "SOURCE_SYMBOL_MISSING" }]);
    const rows = getDb()
      .prepare("SELECT symbol, data_quality_status FROM stock_snapshots ORDER BY symbol")
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => ({
      symbol: row.symbol,
      data_quality_status: row.data_quality_status
    })), [
      { symbol: "AAPL", data_quality_status: "COMPLETE" },
      { symbol: "MSFT", data_quality_status: "SOURCE_ERROR" }
    ]);
  });

  test("temporary persistence failure is isolated to one symbol", async () => {
    const result = await runStockObservation({
      symbols: ["AAPL", "MSFT"],
      getClock: async () => ({ isOpen: true }),
      refreshAssets: async () => ({ checked: 0, active: 0, disabled: 0, failed: [] }),
      getSnapshots: async ({ symbols, feed, currency }: {
        symbols: string[];
        feed: string;
        currency?: string;
      }) => symbols.map((symbol) => ({
        symbol,
        raw: completeSnapshot,
        requestedFeed: feed,
        effectiveFeed: feed,
        currency: currency ?? null,
        requestId: "snapshot-request"
      })),
      persistSnapshot: (row, runId) => {
        if (row.symbol === "MSFT") {
          throw new Error("database temporarily busy");
        }
        return persistStockSnapshot(row, runId);
      },
      now: () => new Date("2026-07-13T16:45:00.000Z")
    });

    assert.equal(result.status, "partial");
    assert.equal(result.successfulSymbols, 1);
    assert.equal(result.failedSymbols, 1);
    assert.equal(result.rowsWritten, 1);
    assert.deepEqual(result.errors, [{
      symbol: "MSFT",
      reason: "PERSISTENCE_ERROR:database temporarily busy"
    }]);
    const stored = getDb()
      .prepare("SELECT symbol FROM stock_snapshots ORDER BY symbol")
      .all() as Array<{ symbol: string }>;
    assert.deepEqual(stored.map((row) => row.symbol), ["AAPL"]);
  });

  test("observation service has no order-submission dependency", () => {
    const source = readFileSync(
      join(process.cwd(), "src/services/stockObservationService.ts"),
      "utf8"
    );
    assert.doesNotMatch(source, /submitPaperOrder|paperExecute|confirmPaper|\/v2\/orders/);
  });
});
