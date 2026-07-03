import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-paper-review-test-")),
  "research.db"
);
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
process.env.ALPACA_PAPER_API_KEY = "paper-key";
process.env.ALPACA_PAPER_SECRET_KEY = "paper-secret";
process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";

import { getDb } from "../src/lib/db.js";
import {
  buildPaperReviewReport,
  formatPaperReviewReportAsTable
} from "../src/services/paperReviewService.js";
import type { PaperPlanReport } from "../src/services/paperPlanService.js";

const resetDatabase = () => {
  const db = getDb();
  db.exec(`
    DELETE FROM paper_trade_candidates;
    DELETE FROM paper_trade_plans;
    DELETE FROM paper_trade_evaluations;
    DELETE FROM market_bars;
    DELETE FROM research_runs;
  `);
};

const makeMockResponse = (payload: unknown, status = 200) =>
  ({
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

const createMockFetcher = ({
  account = { status: "ACTIVE", equity: "1000", cash: "1000", buying_power: "800", accrued_fees: "0", portfolio_value: "1000" },
  positions = [] as Array<{ symbol: string; qty: string }>,
  orders = [] as Array<{ symbol: string; id?: string }>,
  assets = {
    AAPL: { class: "us_equity", status: "active", tradable: true, fractionable: true }
  } as Record<string, { class?: string; status?: string; tradable?: boolean; fractionable?: boolean }>
} = {}) => {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = String(init?.method || "GET").toUpperCase();
    if (method !== "GET") {
      throw new Error(`Unexpected mutation call: ${method} ${input}`);
    }

    if (input.includes("/v2/account")) {
      return makeMockResponse(account);
    }
    if (input.includes("/v2/positions")) {
      return makeMockResponse(positions);
    }
    if (input.includes("/v2/orders?status=open")) {
      return makeMockResponse(orders);
    }
    if (input.includes("/v2/assets/")) {
      const symbol = decodeURIComponent(input.split("/v2/assets/").pop()?.split("?")[0] || "").toUpperCase();
      const asset = assets[symbol];
      if (!asset) {
        return makeMockResponse({}, 404);
      }
      return makeMockResponse({
        symbol,
        class: asset.class || "us_equity",
        status: asset.status || "active",
        tradable: asset.tradable ?? true,
        fractionable: asset.fractionable ?? true
      });
    }

    return makeMockResponse({});
  };
};

const setMockFetch = (fetcher: (input: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = (input, init) => fetcher(String(input), init as RequestInit | undefined);
};

const insertResearchRun = ({
  runId,
  riskProfile = "moderate",
  optionsEnabled = false,
  startedAt,
  completedAt
}: {
  runId: string;
  riskProfile?: "moderate" | "aggressive" | "conservative";
  optionsEnabled?: boolean;
  startedAt?: string;
  completedAt?: string;
}) => {
  getDb().prepare(`
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
  `).run(
    runId,
    startedAt || "2026-01-01T12:00:00.000Z",
    completedAt || startedAt || "2026-01-01T12:00:00.000Z",
    "completed",
    riskProfile,
    optionsEnabled ? 1 : 0,
    5,
    5,
    5,
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
  asOf = "2026-01-01T12:00:00.000Z",
  estimatedMaxLoss = 100,
  estimatedMaxProfit = null,
  riskProfile = "moderate"
}: {
  runId: string;
  symbol: string;
  rank: number;
  direction?: string;
  preferredExpression?: string;
  asOf?: string;
  estimatedMaxLoss?: number | null;
  estimatedMaxProfit?: number | null;
  riskProfile?: "moderate" | "aggressive" | "conservative";
}) => {
  getDb().prepare(`
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
  `).run(
    `cand-${runId}-${rank}`,
    runId,
    symbol,
    asOf,
    rank,
    direction,
    "5d",
    riskProfile,
    preferredExpression,
    1.5,
    0.8,
    0.2,
    estimatedMaxLoss,
    estimatedMaxProfit,
    "[]",
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
    null
  );
};

const insertMarketBar = ({
  symbol,
  close,
  timestamp = "2026-01-01T12:00:00.000Z"
}: {
  symbol: string;
  close: number;
  timestamp?: string;
}) => {
  getDb().prepare(`
    INSERT INTO market_bars(
      symbol,
      timeframe,
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    symbol,
    "1Day",
    timestamp,
    close,
    close,
    close,
    close,
    1000,
    "alpaca"
  );
};

const oldIso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();

const mockPlanReport = (
  values: Partial<PaperPlanReport> = {}
): PaperPlanReport => ({
  paperOnly: true,
  environment: "paper",
  generatedAt: new Date().toISOString(),
  dryRun: true,
  nonMutating: true,
  config: {
    riskProfile: "moderate",
    optionsEnabled: false,
    maxCandidates: 5,
    maxNewPositions: 3,
    maxPositionNotional: 100,
    maxTotalPlanNotional: 300,
    minBuyingPowerReservePct: 20,
    equityNotionalPerOrder: 1000,
    equityMaxNotionalPerOrder: 5000,
    equityMaxPortfolioDeployPct: 50,
    equityMaxPositionPct: 10,
    equityMinCashReservePct: 20
  },
  account: {
    status: "ACTIVE",
    equity: 1000,
    cash: 1000,
    buyingPower: 800,
    reservedBuyingPower: 200,
    deployableBuyingPower: 800
  },
  summary: {
    candidatesEvaluated: 1,
    plannedOrders: 1,
    watched: 0,
    skipped: 0,
    estimatedTotalNotional: 100,
    remainingDeployableBuyingPower: 800
  },
  plan: [
    {
      symbol: "AAPL",
      side: "buy",
      assetClass: "us_equity",
      orderType: "market",
      timeInForce: "day",
      latestRank: 1,
      recommendation: "long",
      estimatedPrice: 100,
      estimatedQty: 1,
      estimatedNotional: 100,
      decision: "planned",
      reasonCodes: ["TRADABLE", "BUYING_POWER_OK", "QTY_ESTIMATED", "WITHIN_POSITION_CAP"],
      explanation: "Planned: TRADABLE"
    }
  ],
  source: {
    snapshotRunId: "run-1",
    recommendationTimestamp: new Date().toISOString(),
    runtimeTimestamp: new Date().toISOString()
  },
  diagnostics: {
    latestSnapshotAvailable: true,
    latestSnapshotRunId: "run-1",
    latestSnapshotTimestamp: new Date().toISOString(),
    filtersMatchedSnapshots: true,
    runtimeCandidatesAvailable: true,
    emptyReason: null
  },
  ...(values as Partial<PaperPlanReport>)
});

const reviewWithPlan = async (
  overrides: Partial<Omit<PaperPlanReport, "dryRun" | "nonMutating">> &
    { dryRun?: boolean; nonMutating?: boolean } = {},
  input: {
    riskProfile?: "moderate" | "aggressive" | "conservative";
    optionsEnabled?: boolean;
    maxPlanAgeMinutes?: number;
    maxBuyingPowerUsePct?: number;
    format?: "table" | "json";
  } = {}
) =>
  buildPaperReviewReport(
    {
      riskProfile: overrides && overrides.config?.riskProfile,
      optionsEnabled: overrides && overrides.config?.optionsEnabled,
      maxPlanAgeMinutes: input.maxPlanAgeMinutes,
      maxBuyingPowerUsePct: input.maxBuyingPowerUsePct
    },
    {
      buildPlan: async () => mockPlanReport(overrides as Partial<PaperPlanReport>)
    }
  );

beforeEach(() => {
  resetDatabase();
  setMockFetch(createMockFetcher());
});

after(() => {
  rmSync(process.env.RESEARCH_DB_PATH!.substring(0, process.env.RESEARCH_DB_PATH!.lastIndexOf("/")), {
    recursive: true,
    force: true
  });
});

describe("paper review service", () => {
  test("returns ready status for safe planned candidates", async () => {
    const report = await reviewWithPlan();
    assert.equal(report.review.status, "ready_for_dry_run_execution");
    assert.equal(report.review.blockers.length, 0);
    assert.equal(report.planSummary.plannedOrders, 1);
  });

  test("returns warning when planned and skipped candidates coexist", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 2,
        plannedOrders: 1,
        watched: 0,
        skipped: 1,
        estimatedTotalNotional: 100,
        remainingDeployableBuyingPower: 800
      },
      plan: [
        {
          symbol: "AAPL",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 1,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: 1,
          estimatedNotional: 100,
          decision: "planned",
          reasonCodes: ["TRADABLE", "BUYING_POWER_OK", "QTY_ESTIMATED", "WITHIN_POSITION_CAP"],
          explanation: "Planned: TRADABLE"
        },
        {
          symbol: "NVDA",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 2,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: null,
          estimatedNotional: null,
          decision: "skip",
          reasonCodes: ["OPEN_ORDER_EXISTS"],
          explanation: "Skipped"
        }
      ]
    });

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.warnings.includes("SKIPPED_CANDIDATES_PRESENT"), true);
  });

  test("blocked when no candidates were evaluated", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 0,
        plannedOrders: 0,
        watched: 0,
        skipped: 0,
        estimatedTotalNotional: 0,
        remainingDeployableBuyingPower: 800
      },
      plan: [],
      source: {
        snapshotRunId: null,
        recommendationTimestamp: null,
        runtimeTimestamp: null
      },
      diagnostics: {
        latestSnapshotAvailable: false,
        latestSnapshotRunId: null,
        latestSnapshotTimestamp: null,
        filtersMatchedSnapshots: false,
        runtimeCandidatesAvailable: false,
        emptyReason: "NO_RESEARCH_SNAPSHOTS"
      }
    });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("NO_RESEARCH_SNAPSHOTS"), true);
    assert.equal(report.diagnostics.emptyReason, "NO_RESEARCH_SNAPSHOTS");
  });

  test("blocked with filter diagnostic when no snapshots match requested filters", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 0,
        plannedOrders: 0,
        watched: 0,
        skipped: 0,
        estimatedTotalNotional: 0,
        remainingDeployableBuyingPower: 800
      },
      plan: [],
      diagnostics: {
        latestSnapshotAvailable: true,
        latestSnapshotRunId: "run-moderate",
        latestSnapshotTimestamp: new Date().toISOString(),
        filtersMatchedSnapshots: false,
        runtimeCandidatesAvailable: false,
        emptyReason: "NO_MATCHING_SNAPSHOTS_FOR_FILTERS"
      }
    });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("NO_MATCHING_SNAPSHOTS_FOR_FILTERS"), true);
  });

  test("blocked with runtime diagnostic when matched snapshot has no candidates", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 0,
        plannedOrders: 0,
        watched: 0,
        skipped: 0,
        estimatedTotalNotional: 0,
        remainingDeployableBuyingPower: 800
      },
      plan: [],
      diagnostics: {
        latestSnapshotAvailable: true,
        latestSnapshotRunId: "run-empty",
        latestSnapshotTimestamp: new Date().toISOString(),
        filtersMatchedSnapshots: true,
        runtimeCandidatesAvailable: false,
        emptyReason: "NO_RUNTIME_CANDIDATES"
      }
    });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("NO_RUNTIME_CANDIDATES"), true);
  });

  test("blocked when no planned orders exist", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 1,
        plannedOrders: 0,
        watched: 0,
        skipped: 1,
        estimatedTotalNotional: 0,
        remainingDeployableBuyingPower: 800
      },
      plan: [
        {
          symbol: "AAPL",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 1,
          recommendation: "long",
          estimatedPrice: null,
          estimatedQty: null,
          estimatedNotional: null,
          decision: "skip",
          reasonCodes: ["OPEN_ORDER_EXISTS"],
          explanation: "Skipped"
        }
      ],
      diagnostics: {
        latestSnapshotAvailable: true,
        latestSnapshotRunId: "run-skipped",
        latestSnapshotTimestamp: new Date().toISOString(),
        filtersMatchedSnapshots: true,
        runtimeCandidatesAvailable: true,
        emptyReason: "ALL_CANDIDATES_SKIPPED"
      }
    });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("NO_PLANNED_ORDERS"), true);
    assert.equal(report.review.blockers.includes("ALL_CANDIDATES_SKIPPED"), true);
  });

  test("blocked for stale plan", async () => {
    const report = await reviewWithPlan({
      generatedAt: oldIso(60)
    }, { maxPlanAgeMinutes: 30 });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("PLAN_STALE"), true);
  });

  test("fresh plan with historical market data source warns without PLAN_STALE", async () => {
    const report = await reviewWithPlan({
      generatedAt: new Date().toISOString(),
      source: {
        snapshotRunId: "run-daily-bars",
        recommendationTimestamp: oldIso(24 * 60),
        runtimeTimestamp: new Date().toISOString()
      }
    }, { maxPlanAgeMinutes: 30 });

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.blockers.includes("PLAN_STALE"), false);
    assert.equal(report.review.warnings.includes("SOURCE_MARKET_DATA_LOOKBACK"), true);
    assert.equal(report.review.warnings.includes("STALE_RECOMMENDATION_SOURCE"), false);
  });

  test("blocked when account is unavailable", async () => {
    const report = await reviewWithPlan({
      account: null as unknown as PaperPlanReport["account"]
    });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("ACCOUNT_UNAVAILABLE"), true);
  });

  test("blocked when buying power is unknown", async () => {
    const report = await reviewWithPlan({
      account: {
        status: "ACTIVE",
        equity: 100,
        cash: 100,
        buyingPower: 100,
        reservedBuyingPower: 200,
        deployableBuyingPower: -1
      }
    });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("BUYING_POWER_UNKNOWN"), true);
  });

  test("blocked when LIVE_TRADING_ENABLED=true", async () => {
    const previous = process.env.LIVE_TRADING_ENABLED;
    try {
      process.env.LIVE_TRADING_ENABLED = "true";
      const report = await reviewWithPlan();
      assert.equal(report.review.status, "blocked");
      assert.equal(report.review.blockers.includes("LIVE_TRADING_ENABLED"), true);
    } finally {
      process.env.LIVE_TRADING_ENABLED = previous;
    }
  });

  test("blocked when ALPACA_ENV is not paper", async () => {
    const previous = process.env.ALPACA_ENV;
    try {
      process.env.ALPACA_ENV = "live";
      const report = await reviewWithPlan();
      assert.equal(report.review.status, "blocked");
      assert.equal(report.review.blockers.includes("NON_PAPER_ENVIRONMENT"), true);
    } finally {
      process.env.ALPACA_ENV = previous;
    }
  });

  test("blocked when aggressive mode requested but flag is not enabled", async () => {
    const previous = process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES;
    try {
      process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "false";
      const report = await buildPaperReviewReport({
        riskProfile: "aggressive"
      }, {
        buildPlan: async () => mockPlanReport({
          config: {
            riskProfile: "aggressive",
            optionsEnabled: false,
            maxCandidates: 5,
            maxNewPositions: 3,
            maxPositionNotional: 100,
            maxTotalPlanNotional: 300,
            minBuyingPowerReservePct: 20,
            equityNotionalPerOrder: 1000,
            equityMaxNotionalPerOrder: 5000,
            equityMaxPortfolioDeployPct: 50,
            equityMaxPositionPct: 10,
            equityMinCashReservePct: 20
          }
        })
      });

      assert.equal(report.review.status, "blocked");
      assert.equal(report.review.blockers.includes("AGGRESSIVE_MODE_NOT_ENABLED"), true);
    } finally {
      process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = previous;
    }
  });

  test("blocked when plan is not dry-run", async () => {
    const report = await reviewWithPlan({ dryRun: false });
    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("PLAN_NOT_DRY_RUN"), true);
  });

  test("blocked when plan is not non-mutating", async () => {
    const report = await reviewWithPlan({ nonMutating: false });
    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("PLAN_NOT_NON_MUTATING"), true);
  });

  test("warning for aggressive mode when enabled", async () => {
    const report = await buildPaperReviewReport({ riskProfile: "aggressive" }, {
      buildPlan: async () => mockPlanReport({
        config: {
          riskProfile: "aggressive",
          optionsEnabled: false,
          maxCandidates: 5,
          maxNewPositions: 3,
          maxPositionNotional: 100,
          maxTotalPlanNotional: 300,
          minBuyingPowerReservePct: 20,
          equityNotionalPerOrder: 1000,
          equityMaxNotionalPerOrder: 5000,
          equityMaxPortfolioDeployPct: 50,
          equityMaxPositionPct: 10,
          equityMinCashReservePct: 20
        }
      })
    });

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.warnings.includes("AGGRESSIVE_MODE_ACTIVE"), true);
  });

  test("warning when options are enabled", async () => {
    const report = await reviewWithPlan({
      config: {
        riskProfile: "moderate",
        optionsEnabled: true,
        maxCandidates: 5,
        maxNewPositions: 3,
        maxPositionNotional: 100,
        maxTotalPlanNotional: 300,
        minBuyingPowerReservePct: 20,
        equityNotionalPerOrder: 1000,
        equityMaxNotionalPerOrder: 5000,
        equityMaxPortfolioDeployPct: 50,
        equityMaxPositionPct: 10,
        equityMinCashReservePct: 20
      }
    });

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.warnings.includes("OPTIONS_ENABLED"), true);
  });

  test("speculative paper option warnings do not block execution readiness", async () => {
    const report = await reviewWithPlan({
      config: {
        riskProfile: "moderate",
        optionsEnabled: true,
        maxCandidates: 5,
        maxNewPositions: 3,
        maxPositionNotional: 1000,
        maxTotalPlanNotional: 5000,
        minBuyingPowerReservePct: 20,
        equityNotionalPerOrder: 1000,
        equityMaxNotionalPerOrder: 5000,
        equityMaxPortfolioDeployPct: 50,
        equityMaxPositionPct: 10,
        equityMinCashReservePct: 20
      },
      plan: [
        {
          symbol: "AAPL260814C00100000",
          side: "buy",
          assetClass: "option",
          orderType: "limit",
          timeInForce: "day",
          underlyingSymbol: "AAPL",
          optionSymbol: "AAPL260814C00100000",
          strategy: "long_call",
          limitPrice: 0.75,
          estimatedPremium: 75,
          maxRisk: 75,
          latestRank: 1,
          recommendation: "long long_call",
          estimatedPrice: 0.75,
          estimatedQty: 1,
          estimatedNotional: 75,
          decision: "planned",
          reasonCodes: [
            "TRADABLE",
            "BUYING_POWER_OK",
            "WITHIN_POSITION_CAP",
            "OPTION_RISK_LIMIT_OK",
            "SPECULATIVE_OPTION_PAPER_WARNING",
            "OPTION_WIDE_SPREAD_WARNING"
          ],
          explanation: "Planned"
        }
      ]
    });

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.blockers.length, 0);
    assert.equal(report.review.warnings.includes("SPECULATIVE_OPTION_PAPER_WARNING"), true);
    assert.equal(report.review.warnings.includes("OPTION_WIDE_SPREAD_WARNING"), true);
    assert.equal(report.executionReadiness?.options.eligible, 1);
  });

  test("warning when watched candidates exist", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 1,
        plannedOrders: 0,
        watched: 1,
        skipped: 0,
        estimatedTotalNotional: 100,
        remainingDeployableBuyingPower: 800
      },
      plan: [
        {
          symbol: "AAPL",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 1,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: 1,
          estimatedNotional: 100,
          decision: "watch",
          reasonCodes: ["PRICE_UNKNOWN"],
          explanation: "Watch"
        }
      ]
    });

    assert.equal(report.review.status, "blocked");
    assert.equal(report.review.blockers.includes("NO_PLANNED_ORDERS"), true);
    assert.equal(report.review.warnings.includes("WATCHED_CANDIDATES_PRESENT"), true);
  });

  test("warning when buying power use is elevated", async () => {
    const report = await reviewWithPlan(
      {
        summary: {
          candidatesEvaluated: 1,
          plannedOrders: 1,
          watched: 0,
          skipped: 0,
          estimatedTotalNotional: 45,
          remainingDeployableBuyingPower: 90
        },
        account: {
          status: "ACTIVE",
          equity: 100,
          cash: 100,
          buyingPower: 100,
          reservedBuyingPower: 10,
          deployableBuyingPower: 90
        }
      },
      { maxBuyingPowerUsePct: 50 }
    );

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.warnings.includes("ELEVATED_BUYING_POWER_USE"), true);
  });

  test("warning when concentration threshold is exceeded", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 2,
        plannedOrders: 2,
        watched: 0,
        skipped: 0,
        estimatedTotalNotional: 200,
        remainingDeployableBuyingPower: 1000
      },
      plan: [
        {
          symbol: "AAPL",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 1,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: 1,
          estimatedNotional: 140,
          decision: "planned",
          reasonCodes: ["TRADABLE", "BUYING_POWER_OK", "QTY_ESTIMATED", "WITHIN_POSITION_CAP"],
          explanation: "Planned"
        },
        {
          symbol: "NVDA",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 2,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: 0.6,
          estimatedNotional: 60,
          decision: "planned",
          reasonCodes: ["TRADABLE", "BUYING_POWER_OK", "QTY_ESTIMATED", "WITHIN_POSITION_CAP"],
          explanation: "Planned"
        }
      ]
    });

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.warnings.includes("CONCENTRATION_WARNING"), true);
  });

  test("warning when duplicate exposure is detected", async () => {
    const report = await reviewWithPlan({
      summary: {
        candidatesEvaluated: 2,
        plannedOrders: 1,
        watched: 0,
        skipped: 1,
        estimatedTotalNotional: 100,
        remainingDeployableBuyingPower: 800
      },
      plan: [
        {
          symbol: "AAPL",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 1,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: 1,
          estimatedNotional: 100,
          decision: "planned",
          reasonCodes: ["TRADABLE", "BUYING_POWER_OK", "QTY_ESTIMATED", "WITHIN_POSITION_CAP"],
          explanation: "Planned"
        },
        {
          symbol: "AAPL",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 2,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: null,
          estimatedNotional: null,
          decision: "skip",
          reasonCodes: ["DUPLICATE_EXPOSURE"],
          explanation: "Duplicate"
        }
      ]
    });

    assert.equal(report.review.status, "warning");
    assert.equal(report.review.warnings.includes("DUPLICATE_EXPOSURE_WARNING"), true);
  });

  test("review output has stable JSON shape", async () => {
    const report = await reviewWithPlan();
    assert.equal(report.paperOnly, true);
    assert.equal(report.reviewOnly, true);
    assert.equal(report.nonMutating, true);
    assert.equal(typeof report.generatedAt, "string");
    assert.equal(report.environment, "paper");
    assert.equal(typeof report.planSummary.estimatedTotalNotional, "number");
    assert.equal(Array.isArray(report.review.blockers), true);
    assert.equal(Array.isArray(report.review.warnings), true);
  });

  test("table output renders without throwing", async () => {
    const report = await reviewWithPlan();
    const output = formatPaperReviewReportAsTable(report);
    assert.equal(typeof output, "string");
    assert.equal(output.includes("Paper Review (non-mutating)"), true);
    assert.equal(output.includes("Review only. No orders were submitted."), true);
  });

  test("reason codes are deterministic and deduplicated", async () => {
    const report = await reviewWithPlan({
      plan: [
        {
          symbol: "AAPL",
          side: "buy",
          assetClass: "us_equity",
          orderType: "market",
          timeInForce: "day",
          latestRank: 1,
          recommendation: "long",
          estimatedPrice: 100,
          estimatedQty: 1,
          estimatedNotional: 100,
          decision: "planned",
          reasonCodes: ["QTY_ESTIMATED", "TRADABLE", "QTY_ESTIMATED", "BUYING_POWER_OK"],
          explanation: "Planned"
        }
      ]
    });

    assert.equal(report.plan[0]?.reasonCodes.includes("QTY_ESTIMATED"), true);
    assert.equal(report.plan[0]?.reasonCodes.includes("TRADABLE"), true);
    assert.equal(report.plan[0]?.reasonCodes.includes("BUYING_POWER_OK"), true);
    assert.equal(report.plan[0]?.reasonCodes.length, 3);
  });

  test("does not call mutation methods in review path", async () => {
    const now = new Date().toISOString();
    insertResearchRun({
      runId: "run-live",
      riskProfile: "moderate",
      optionsEnabled: false,
      startedAt: now,
      completedAt: now
    });
    insertCandidate({ runId: "run-live", symbol: "AAPL", rank: 1, estimatedMaxLoss: 80, asOf: now });
    insertMarketBar({ symbol: "AAPL", close: 100 });

    let nonGetRequested = false;
    const originalFetch = globalThis.fetch;
    setMockFetch(async (input, init) => {
      const method = String(init?.method || "GET").toUpperCase();
      if (method !== "GET") {
        nonGetRequested = true;
      }
      return createMockFetcher()(input, init);
    });

    try {
      const report = await buildPaperReviewReport();
      assert.equal(nonGetRequested, false);
      assert.equal(report.review.status, "ready_for_dry_run_execution");
    } finally {
      globalThis.fetch = originalFetch;
      resetDatabase();
    }
  });
});
