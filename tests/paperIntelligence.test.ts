import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-paper-intel-test-")),
  "research.db"
);
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
process.env.ALPACA_PAPER_API_KEY = "paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  buildPaperRecommendationTrends,
  queryPaperRecommendationTrends
} from "../src/services/paperTrendsService.js";
import {
  buildPaperRuntimeReport,
  type PaperRuntimeReport
} from "../src/services/paperRuntimeService.js";
import { buildPaperIntelligenceReport } from "../src/services/paperIntelService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_recommendation_snapshots;
    DELETE FROM paper_trade_candidates;
    DELETE FROM research_runs;
  `);
};
const setMockFetch = (fetcher: (input: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = async (input, init) =>
    fetcher(String(input), init as RequestInit | undefined);
};

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

const insertSnapshot = ({
  runId,
  createdAt,
  symbol,
  rank,
  source = "paper:analytics",
  riskProfile = "moderate",
  optionsEnabled = true
}: {
  runId: string;
  createdAt: string;
  symbol?: string;
  rank: number;
  source?: string;
  riskProfile?: string;
  optionsEnabled?: boolean;
}) => {
  getDb()
    .prepare(
      `
      INSERT INTO paper_recommendation_snapshots(
        snapshot_run_id,
        created_at,
        source,
        group_by,
        group_key,
        filters_json,
        candidate_count,
        evaluated_count,
        unevaluated_count,
        win_rate,
        avg_return_pct,
        median_return_pct,
        best_return_pct,
        worst_return_pct,
        avg_rank,
        recommendation_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      runId,
      createdAt,
      source,
      "symbol",
      symbol || "UNKNOWN",
      JSON.stringify({ groupBy: "symbol" }),
      10,
      8,
      2,
      0.6,
      1.2,
      1.1,
      2.0,
      0.3,
      rank,
      "KEEP_MONITORING"
    );

  getDb().prepare(
    `
    INSERT INTO paper_recommendation_snapshots(
      snapshot_run_id,
      created_at,
      source,
      group_by,
      group_key,
      filters_json,
      candidate_count,
      evaluated_count,
      unevaluated_count,
      win_rate,
      avg_return_pct,
      median_return_pct,
      best_return_pct,
      worst_return_pct,
      avg_rank,
      recommendation_flag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    runId,
    createdAt,
    source,
    "riskProfile",
    riskProfile,
    JSON.stringify({ groupBy: "riskProfile" }),
    10,
    8,
    2,
    0.6,
    1.2,
    1.1,
    2.0,
    0.3,
    rank,
    "KEEP_MONITORING"
  );

  getDb().prepare(
    `
    INSERT INTO paper_recommendation_snapshots(
      snapshot_run_id,
      created_at,
      source,
      group_by,
      group_key,
      filters_json,
      candidate_count,
      evaluated_count,
      unevaluated_count,
      win_rate,
      avg_return_pct,
      median_return_pct,
      best_return_pct,
      worst_return_pct,
      avg_rank,
      recommendation_flag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    runId,
    createdAt,
    source,
    "optionsEnabled",
    optionsEnabled ? "options-aware" : "equity-only",
    JSON.stringify({ groupBy: "optionsEnabled" }),
    10,
    8,
    2,
    0.6,
    1.2,
    1.1,
    2.0,
    0.3,
    rank,
    "KEEP_MONITORING"
  );
};

const insertResearchRun = ({
  runId,
  riskProfile = "moderate",
  optionsEnabled = false
}: {
  runId: string;
  riskProfile: string;
  optionsEnabled: boolean;
}) => {
  getDb()
    .prepare(
      `
      INSERT INTO research_runs(
        id,
        started_at,
        completed_at,
        status,
        risk_profile,
        options_enabled,
        universe_size,
        targets_generated,
        candidates_selected,
        error_message,
        config_json,
        summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      runId,
      new Date().toISOString(),
      new Date().toISOString(),
      "completed",
      riskProfile,
      optionsEnabled ? 1 : 0,
      1,
      1,
      2,
      null,
      JSON.stringify({ riskProfile, optionsEnabled }),
      null
    );
};

const insertCandidate = ({
  runId,
  symbol,
  rank,
  direction = "long",
  preferredExpression = "shares",
  estimatedMaxLoss,
  estimatedMaxProfit = null,
  riskProfile = "moderate"
}: {
  runId: string;
  symbol: string;
  rank: number;
  direction?: string;
  preferredExpression?: string;
  estimatedMaxLoss: number | null;
  estimatedMaxProfit?: number | null;
  riskProfile?: string;
}) => {
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
        rationale,
        relevant_backtest_run_id,
        historical_win_rate,
        historical_avg_return,
        historical_max_drawdown,
        similar_setup_count,
        option_liquidity_score,
        volatility_score,
        signal_freshness_days,
        recent_learning_adjustment,
        directional_accuracy,
        option_outperformance_accuracy,
        option_symbol,
        strike,
        short_strike
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      `${runId}-${symbol}-${rank}`,
      runId,
      symbol,
      new Date().toISOString(),
      rank,
      direction,
      "1d",
      riskProfile,
      preferredExpression,
      10,
      0.75,
      0.5,
      estimatedMaxLoss,
      estimatedMaxProfit,
      JSON.stringify(["stable trend"]),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

describe("paper recommendation trends", () => {
  test("aggregates latest trend states with optional filters", () => {
    insertSnapshot({
      runId: "run-1",
      symbol: "AAPL",
      createdAt: "2026-01-01T12:00:00.000Z",
      rank: 7,
      riskProfile: "moderate",
      optionsEnabled: true
    });
    insertSnapshot({
      runId: "run-2",
      symbol: "AAPL",
      createdAt: "2026-01-02T12:00:00.000Z",
      rank: 4,
      riskProfile: "moderate",
      optionsEnabled: true
    });
    insertSnapshot({
      runId: "run-3",
      symbol: "AAPL",
      createdAt: "2026-01-03T12:00:00.000Z",
      rank: 2,
      riskProfile: "moderate",
      optionsEnabled: true
    });
    insertSnapshot({
      runId: "run-4",
      symbol: "NVDA",
      createdAt: "2026-01-04T12:00:00.000Z",
      rank: 1,
      riskProfile: "aggressive",
      optionsEnabled: true
    });

    const result = buildPaperRecommendationTrends({
      riskProfile: "moderate",
      optionsEnabled: true,
      limit: 20
    });

    assert.equal(result.trends.length, 1);
    assert.equal(result.trends[0]!.symbol, "AAPL");
    assert.equal(result.trends[0]?.trend, "new");
    assert.equal(result.trends[0]?.appearances, 3);
    assert.equal(result.trends[0]?.riskProfiles.includes("moderate"), true);
    assert.equal(result.trends[0]?.optionsEnabledModes.includes(true), true);
  });

  test("supports symbol, date range, and risk/options filters", () => {
    insertSnapshot({
      runId: "run-1",
      symbol: "TSLA",
      createdAt: "2026-01-01T12:00:00.000Z",
      rank: 5,
      riskProfile: "aggressive",
      optionsEnabled: false
    });
    insertSnapshot({
      runId: "run-2",
      symbol: "TSLA",
      createdAt: "2026-01-02T12:00:00.000Z",
      rank: 6,
      riskProfile: "aggressive",
      optionsEnabled: false
    });
    insertSnapshot({
      runId: "run-3",
      symbol: "TSLA",
      createdAt: "2026-01-03T12:00:00.000Z",
      rank: 2,
      riskProfile: "conservative",
      optionsEnabled: false
    });

    const filteredByRisk = buildPaperRecommendationTrends({
      symbol: "TSLA",
      riskProfile: "aggressive",
      optionsEnabled: false,
      from: "2026-01-01",
      to: "2026-01-02"
    });

    assert.equal(filteredByRisk.trends.length, 1);
    assert.equal(filteredByRisk.trends[0]!.symbol, "TSLA");
    assert.equal(filteredByRisk.trends[0]!.trend, "new");

    const report = buildPaperRecommendationTrends({
      symbol: "TSLA",
      riskProfile: "aggressive",
      optionsEnabled: false,
      from: "2026-02-01",
      to: "2026-02-28",
      limit: 20
    });
    assert.equal(report.trends.length, 1);
    assert.equal(report.trends[0]!.trend, "inactive");
  });

  test("returns empty trend list when symbol exists only in unrelated filters", () => {
    insertSnapshot({
      runId: "run-empty",
      symbol: "MSFT",
      createdAt: "2026-01-01T12:00:00.000Z",
      rank: 4,
      riskProfile: "moderate",
      optionsEnabled: true
    });

    const report = buildPaperRecommendationTrends({
      symbol: "MSFT",
      riskProfile: "aggressive",
      optionsEnabled: true,
      limit: 20
    });

    assert.equal(report.trends.length, 0);
  });

  test("returns stable trend report shape", () => {
    insertSnapshot({
      runId: "run-json",
      symbol: "AAPL",
      createdAt: "2026-01-01T12:00:00.000Z",
      rank: 3,
      riskProfile: "moderate",
      optionsEnabled: true
    });

    const report = buildPaperRecommendationTrends({
      symbol: "AAPL",
      limit: 7
    });
    const parsed = JSON.parse(JSON.stringify(report));

    assert.equal(parsed.paperOnly, true);
    assert.equal(parsed.environment, "paper");
    assert.equal(Array.isArray(parsed.trends), true);
    assert.equal(parsed.trends[0].symbol, "AAPL");
    assert.equal(parsed.trends[0].trend, "new");
    assert.equal(parsed.filters.limit, 7);
  });

  test("supports trend query helper with symbol filter", () => {
    insertSnapshot({
      runId: "run-empty",
      symbol: "AAPL",
      createdAt: "2026-01-01T12:00:00.000Z",
      rank: 3,
      riskProfile: "moderate",
      optionsEnabled: true
    });
    const rows = queryPaperRecommendationTrends({
      symbol: "AAPL",
      riskProfile: "moderate",
      optionsEnabled: true,
      limit: 5
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.symbol, "AAPL");
  });
});

describe("paper runtime decision logic", () => {
  test("marks watch and candidate decisions from live account and market state", async () => {
    insertResearchRun({ runId: "run-runtime", riskProfile: "moderate", optionsEnabled: false });
    insertCandidate({
      runId: "run-runtime",
      symbol: "MSFT",
      rank: 1,
      direction: "long",
      estimatedMaxLoss: 300,
      riskProfile: "moderate"
    });
    insertCandidate({
      runId: "run-runtime",
      symbol: "AAPL",
      rank: 2,
      direction: "long",
      estimatedMaxLoss: null,
      riskProfile: "moderate"
    });

    setMockFetch(async (input, init) => {
      if (init?.method !== "GET") {
        return makeMockResponse({ status: "unexpected" }, 500);
      }
      if (input.includes("/v2/account")) {
        return makeMockResponse({
          id: "acct-1",
          status: "ACTIVE",
          equity: "1000",
          buying_power: "250",
          cash: "1000",
          daytrade_count: 0
        });
      }
      if (input.includes("/v2/positions")) {
        return makeMockResponse([]);
      }
      if (input.includes("/v2/orders?status=open")) {
        return makeMockResponse([]);
      }
      if (input.includes("/v2/assets/MSFT")) {
        return makeMockResponse({
          symbol: "MSFT",
          status: "active",
          tradable: true
        });
      }
      if (input.includes("/v2/assets/AAPL")) {
        return makeMockResponse({
          symbol: "AAPL",
          status: "active",
          tradable: true
        });
      }
      return makeMockResponse({});
    });

    const report: PaperRuntimeReport = await buildPaperRuntimeReport();

    assert.equal(report.account.buyingPower, 250);
    assert.equal(report.candidates.length, 2);
    assert.equal(report.candidates[0]?.symbol, "MSFT");
    assert.equal(report.candidates[0]?.runtimeDecision, "watch");
    assert.equal(report.candidates[0]?.skipReason, "insufficient buying power");
    assert.equal(report.candidates[1]?.runtimeDecision, "watch");
    assert.equal(report.candidates[1]?.skipReason, "estimated notional unavailable");
  });

  test("does not use mutation methods when checking runtime decisions", async () => {
    const methods = new Set<string>();
    insertResearchRun({ runId: "run-runtime-safe", riskProfile: "aggressive", optionsEnabled: true });
    insertCandidate({
      runId: "run-runtime-safe",
      symbol: "NVDA",
      rank: 1,
      direction: "long",
      estimatedMaxLoss: 50,
      riskProfile: "aggressive"
    });

    setMockFetch(async (input, init) => {
      methods.add(String(init?.method || "GET").toUpperCase());
      if (input.includes("/v2/account")) {
        return makeMockResponse({
          status: "ACTIVE",
          equity: "500",
          buying_power: "100",
          cash: "500",
          daytrade_count: 0
        });
      }
      if (input.includes("/v2/positions")) {
        return makeMockResponse([]);
      }
      if (input.includes("/v2/orders?status=open")) {
        return makeMockResponse([]);
      }
      if (input.includes("/v2/assets/NVDA")) {
        return makeMockResponse({ symbol: "NVDA", status: "active", tradable: true });
      }
      return makeMockResponse({});
    });

    await buildPaperRuntimeReport({
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 1
    });

    for (const method of methods) {
      assert.equal(method, "GET");
    }
  });
});

describe("paper intelligence report", () => {
  test("combines snapshots, trends, and runtime sections", async () => {
    insertSnapshot({
      runId: "run-snapshot",
      symbol: "GOOGL",
      createdAt: "2026-01-01T12:00:00.000Z",
      rank: 1,
      riskProfile: "aggressive",
      optionsEnabled: true
    });

    insertResearchRun({ runId: "run-intel", riskProfile: "aggressive", optionsEnabled: true });
    insertCandidate({
      runId: "run-intel",
      symbol: "GOOGL",
      rank: 1,
      direction: "long",
      estimatedMaxLoss: 75,
      riskProfile: "aggressive"
    });

    setMockFetch(async (input) => {
      if (input.includes("/v2/account")) {
        return makeMockResponse({
          status: "ACTIVE",
          equity: "1000",
          buying_power: "500",
          cash: "1000",
          daytrade_count: 0
        });
      }
      if (input.includes("/v2/positions")) {
        return makeMockResponse([]);
      }
      if (input.includes("/v2/orders?status=open")) {
        return makeMockResponse([]);
      }
      if (input.includes("/v2/assets/GOOGL")) {
        return makeMockResponse({ symbol: "GOOGL", status: "active", tradable: true });
      }
      return makeMockResponse({});
    });

    const report = await buildPaperIntelligenceReport({
      riskProfile: "aggressive",
      optionsEnabled: true
    });

    assert.equal(report.paperOnly, true);
    assert.equal(report.environment, "paper");
    assert.equal(report.snapshots.length >= 1, true);
    assert.equal(
      report.snapshots.some((snapshot) => snapshot.symbol === "GOOGL"),
      true
    );
    assert.equal(report.trends.length, 1);
    assert.equal(report.runtime.candidates.length, 1);
    assert.equal(report.runtime.candidates[0]?.symbol, "GOOGL");
  });
});
