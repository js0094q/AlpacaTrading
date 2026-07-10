import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-paper-ops-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  runPaperOpsLateDay,
  runPaperOpsMidday,
  runPaperOpsMorning,
  runPaperOpsReview
} from "../src/services/paperOpsWorkflowService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_review_artifacts;
    DELETE FROM paper_operation_log;
  `);
};

const dryRun = async () => ({
  status: "ready",
  warnings: [],
  blockers: [],
  summary: { wouldSubmitCount: 1 },
  wouldSubmit: [
    {
      assetClass: "equity",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      time_in_force: "day",
      notional: "100.00",
      client_order_id: "paper-equity-aapl",
      dedupeKey: "paper:equity:AAPL"
    }
  ]
});

const portfolioReview = async (moment = "manual") => ({
  warnings: [],
  blockers: [],
  summary: { eligiblePayloads: 0 },
  recommendations: [],
  moment
});

const hedgeReview = async () => ({
  paperOnly: true,
  environment: "paper",
  generatedAt: "2026-07-10T14:00:00.000Z",
  status: "monitoring",
  recommendation: { recommendationId: "hedge-scheduler-test" },
  risk: {},
  regime: {},
  score: {},
  warnings: ["HEDGE_MONITORING"],
  blockers: []
});

beforeEach(() => {
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "false";
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("paper ops workflows", () => {
  test("review workflow persists separated payload artifact and defaults to review-only", async () => {
    const report = await runPaperOpsReview({ triggerSource: "scheduler" }, {
      buildDryRun: dryRun as any,
      buildPortfolioReview: portfolioReview as any,
      buildHedgeReview: hedgeReview as any
    });

    assert.equal(report.status, "success");
    assert.equal(report.reviewOnly, true);
    assert.equal(report.automatedExecutionEnabled, false);
    assert.equal((report.summary.sections as Record<string, number>).equityBuys, 1);
  });

  test("morning workflow runs research, learn, discover, and review", async () => {
    const calls: string[] = [];
    const report = await runPaperOpsMorning({}, {
      runResearch: async () => {
        calls.push("research");
        return { status: "completed", warnings: [] } as any;
      },
      evaluateLearning: () => {
        calls.push("learn");
        return { evaluated: 1, stillPending: 0, pendingReasons: [] } as any;
      },
      learningSummary: () => ({ pending: 0, evaluated: 1, promoted: 0, rejected: 0 }),
      promotionReadiness: () => [],
      buildOptionsDiscovery: async () => {
        calls.push("discover");
        return { warnings: [], blockers: [], status: "success" } as any;
      },
      buildDryRun: dryRun as any,
      buildPortfolioReview: async () => {
        calls.push("review");
        return portfolioReview("morning") as any;
      },
      buildHedgeReview: async () => {
        calls.push("hedge");
        return hedgeReview() as any;
      }
    });

    assert.equal(report.workflow, "morning");
    assert.deepEqual(calls, ["research", "learn", "discover", "review", "hedge"]);
  });

  test("midday workflow runs portfolio and exit review", async () => {
    let moment = "";
    let hedgeCalls = 0;
    const report = await runPaperOpsMidday({}, {
      buildPortfolioReview: async (input) => {
        moment = input?.moment || "";
        return portfolioReview("midday") as any;
      },
      buildHedgeReview: async () => {
        hedgeCalls += 1;
        return hedgeReview() as any;
      }
    });

    assert.equal(report.workflow, "midday");
    assert.equal(moment, "midday");
    assert.equal(hedgeCalls, 1);
    assert.equal((report.details.hedgeReview as any).status, "monitoring");
    assert.equal("executeHedge" in report.details, false);
  });

  test("late-day workflow runs forced 0DTE review path", async () => {
    let moment = "";
    const report = await runPaperOpsLateDay({}, {
      buildPortfolioReview: async (input) => {
        moment = input?.moment || "";
        return portfolioReview("late_day") as any;
      },
      buildHedgeReview: hedgeReview as any
    });

    assert.equal(report.workflow, "late_day");
    assert.equal(moment, "late_day");
    assert.equal(report.details.forcedExitReview, true);
  });
});
