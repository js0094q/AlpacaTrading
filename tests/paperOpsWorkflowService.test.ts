import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-paper-ops-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.PAPER_REVIEW_SIGNING_KEY = "paper-ops-workflow-test-key";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  runPaperOpsLateDay,
  runPaperOpsMidday,
  runPaperOpsMorning,
  runPaperOpsReview
} from "../src/services/paperOpsWorkflowService.js";
import { verifyPaperReviewArtifact } from "../src/services/paperReviewArtifactService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
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
      sourceCandidateId: "candidate-aapl",
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

const captureSubmitState = async () => ({
  version: "paper-submit-state-v1",
  capturedAt: "2026-07-10T14:00:00.000Z",
  accountIdentityHash: "paper-account-hash",
  accountState: {
    status: "ACTIVE",
    cash: 100_000,
    equity: 100_000,
    buyingPower: 100_000,
    optionsBuyingPower: 100_000,
    optionsApprovalLevel: 3,
    tradingBlocked: false,
    accountBlocked: false
  },
  configuration: {
    environment: "paper",
    tradingMode: "paper",
    liveTradingEnabled: false,
    paperOrderExecutionEnabled: true,
    paperOptionsExecutionEnabled: true,
    maxPositionNotional: 5_000,
    maxTotalPlanNotional: 50_000,
    equityMaxNotionalPerOrder: 5_000,
    equityMaxPortfolioDeployPct: 50,
    equityMaxPositionPct: 10,
    equityMinCashReservePct: 20,
    optionMaxOrderNotional: 2_000,
    optionMaxContracts: 1,
    optionMaxPortfolioRiskPct: 20,
    optionMaxPositionRiskPct: 5,
    quoteMaxAgeSeconds: 600,
    maxPriceDriftPct: 10
  },
  configurationFingerprint: "config-v1",
  positions: [],
  openOrders: [],
  reservations: [],
  marketEvidence: [
    {
      symbol: "AAPL",
      assetClass: "equity",
      referencePrice: 200,
      bid: 199.9,
      ask: 200.1,
      timestamp: "2026-07-10T14:00:00.000Z",
      complete: true
    }
  ],
  payloadIntents: [
    {
      section: "equityBuys",
      payloadIndex: 0,
      assetClass: "equity",
      symbol: "AAPL",
      side: "buy",
      orderType: "market",
      quantity: null,
      notional: 100,
      limitPrice: null,
      estimatedPremium: null,
      positionIntent: null,
      sourceCandidateId: "candidate-aapl",
      sourceReviewId: null,
      clientOrderIdHash: "client-order-hash"
    }
  ],
  structuralPortfolioFingerprint: "portfolio-structure-v1",
  portfolioFingerprint: "portfolio-v1",
  marketEvidenceFingerprint: "market-v1",
  allocationAttestation: {
    mode: "baseline",
    identity: "baseline-v1",
    allocatorControlled: false
  },
  complete: true,
  blockers: [],
  warnings: []
});

beforeEach(() => {
  process.env.AUTOMATED_PAPER_EXECUTION_ENABLED = "false";
  process.env.PAPER_REVIEW_SIGNING_KEY = "paper-ops-workflow-test-key";
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("paper ops workflows", () => {
  test("paper execute confirmation source delegates only to reviewed execution", () => {
    const source = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");

    assert.doesNotMatch(source, /buildPaperExecuteConfirmPaperReport/);
    assert.match(
      source,
      /if \(confirmPaper\)[\s\S]{0,800}buildPaperReviewedPayloadExecutionReport/
    );
  });

  test("review workflow persists separated payload artifact and defaults to review-only", async () => {
    const report = await runPaperOpsReview({ triggerSource: "scheduler" }, {
      buildDryRun: dryRun as any,
      buildPortfolioReview: portfolioReview as any,
      buildHedgeReview: hedgeReview as any,
      captureSubmitState: captureSubmitState as any
    });

    assert.equal(report.status, "success");
    assert.equal(report.reviewOnly, true);
    assert.equal(report.automatedExecutionEnabled, false);
    assert.equal((report.summary.sections as Record<string, number>).equityBuys, 1);
    const evidence = getDb().prepare(`
      SELECT prd.decision_role, ds.decision_status
      FROM paper_review_decisions prd
      JOIN decision_snapshots ds ON ds.decision_id = prd.decision_id
      WHERE prd.artifact_id = ? AND prd.section = 'equityBuys'
    `).get(String(report.summary.artifactId)) as {
      decision_role: string;
      decision_status: string;
    };
    assert.equal(evidence.decision_role, "entry");
    assert.equal(evidence.decision_status, "REVIEWED");
    assert.equal(
      (report.details.artifact as any).artifact.submitState.version,
      "paper-submit-state-v1"
    );
  });

  test("morning workflow evaluates and governs learning before research", async () => {
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
      applyLearningGovernance: () => {
        calls.push("govern");
        return { status: "completed", decisionsWritten: 1 } as any;
      },
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
      },
      captureSubmitState: captureSubmitState as any
    });

    assert.equal(report.workflow, "morning");
    assert.deepEqual(calls, ["learn", "govern", "research", "discover", "review", "hedge"]);
    assert.equal((report.details.learningGovernance as { status: string }).status, "completed");
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

  test("late-day workflow persists a fresh signed forced-exit review artifact", async () => {
    let moment = "";
    const generatedAt = "2026-07-14T19:25:00.000Z";
    const report = await runPaperOpsLateDay({}, {
      buildPortfolioReview: async (input) => {
        moment = input?.moment || "";
        return {
          ...(await portfolioReview("late_day")),
          summary: { eligiblePayloads: 1 },
          recommendations: [{
            recommendation: "SELL_TO_CLOSE_OPTION",
            eligiblePayload: {
              assetClass: "option",
              symbol: "SPY260714P00500000",
              side: "sell",
              type: "limit",
              time_in_force: "day",
              qty: "1",
              limit_price: "1.25",
              position_intent: "sell_to_close",
              client_order_id: "late-day-spy-exit",
              sourceReviewId: "late-day-review"
            }
          }]
        } as any;
      },
      buildHedgeReview: hedgeReview as any,
      buildDryRun: dryRun as any,
      captureSubmitState: captureSubmitState as any,
      now: () => generatedAt
    });

    assert.equal(report.workflow, "late_day");
    assert.equal(moment, "late_day");
    assert.equal(report.details.forcedExitReview, true);
    const artifact = report.details.artifact as any;
    assert.equal(artifact.sourceAction, "paper.ops.late_day");
    assert.equal(artifact.createdAt, generatedAt);
    assert.ok(Date.parse(artifact.expiresAt) > Date.parse(artifact.createdAt));
    assert.equal(
      artifact.artifact.payloadSections.optionSellToCloseExits.length,
      1
    );
    const stored = getDb().prepare(
      "SELECT source_action FROM paper_review_artifacts WHERE id = ?"
    ).get(artifact.id) as { source_action: string };
    assert.equal(stored.source_action, "paper.ops.late_day");
    const verification = verifyPaperReviewArtifact({
      artifact,
      signingKey: "paper-ops-workflow-test-key",
      asOf: "2026-07-14T19:25:01.000Z",
      requireFresh: true
    });
    assert.equal(verification.valid, true);
  });
});
