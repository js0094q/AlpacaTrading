import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-paper-portfolio-review-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

import type { LeapsExitEvaluation } from "../src/services/leapsExitReviewService.js";
import { withExecutionAuthority } from "./helpers/executionAuthorityRuntime.js";

const [portfolioReview, libDb] = await Promise.all([
  import("../src/services/paperPortfolioReviewService.js"),
  import("../src/lib/db.js")
]);
const { buildPaperPortfolioReviewReport } = portfolioReview;
const { closeDbForTests } = libDb;

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

const account = {
  id: "paper-account-1",
  status: "ACTIVE",
  equity: "100000",
  cash: "50000",
  buyingPower: "50000",
  tradingBlocked: false,
  accountBlocked: false
};

const candidate = {
  id: "candidate-aapl",
  symbol: "AAPL",
  rank: 1,
  confidence: 0.9,
  score: 2,
  risk_profile: "aggressive",
  preferred_expression: "shares",
  research_run_id: "run-1"
};

const scaleInReport = async (input: {
  positions?: Array<Record<string, unknown>>;
  account?: Record<string, unknown>;
  orders?: Array<Record<string, unknown>>;
  reservations?: Array<Record<string, unknown>>;
  ordersUnavailable?: boolean;
  reservationsUnavailable?: boolean;
}) => {
  process.env.PAPER_EQUITY_SCALE_IN_ENABLED = "true";
  return buildPaperPortfolioReviewReport(
    {},
    {
      listPositions: async () => ({
        positions: (input.positions ?? [
          {
            symbol: "AAPL",
            assetClass: "us_equity",
            qty: "2",
            marketValue: "1000",
            currentPrice: "500",
            unrealizedPl: "10",
            unrealizedPlpc: "0.01"
          }
        ]) as any
      }),
      getAccount: async () => ({ ...account, ...input.account }) as any,
      getCandidates: () => [candidate],
      listOpenOrders: async () => {
        if (input.ordersUnavailable) throw new Error("orders unavailable");
        return { orders: input.orders ?? [] };
      },
      listReservations: () => {
        if (input.reservationsUnavailable) throw new Error("reservations unavailable");
        return input.reservations ?? [];
      },
      now: () => "2026-07-07T16:00:00.000Z"
    } as any
  );
};

beforeEach(() => {
  process.env.PAPER_EQUITY_SCALE_IN_ENABLED = "false";
  process.env.PAPER_OPTION_EXIT_REVIEW_ENABLED = "true";
  process.env.PAPER_OPTION_EXIT_STOP_LOSS_PCT = "50";
  process.env.PAPER_OPTION_EXIT_PROFIT_TARGET_PCT = "80";
  delete process.env.PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER;
  delete process.env.PAPER_PLAN_MAX_POSITION_NOTIONAL;
  delete process.env.PAPER_PLAN_MAX_TOTAL_PLAN_NOTIONAL;
  delete process.env.PAPER_EQUITY_MAX_PORTFOLIO_DEPLOY_PCT;
  delete process.env.PAPER_EQUITY_MAX_POSITION_PCT;
  delete process.env.PAPER_EQUITY_MIN_CASH_RESERVE_PCT;
});

describe("paper portfolio review", () => {
  test("recommends add-to-equity only when scale-in rules allow", async () => {
    const baseInput = {
      listPositions: async () => ({
        positions: [
          {
            symbol: "AAPL",
            assetClass: "us_equity",
            qty: "2",
            marketValue: "1000",
            unrealizedPl: "10",
            unrealizedPlpc: "0.01"
          }
        ]
      }),
      getAccount: async () => account,
      getCandidates: () => [
        {
          id: "candidate-aapl",
          symbol: "AAPL",
          rank: 1,
          confidence: 0.9,
          score: 2,
          risk_profile: "aggressive",
          preferred_expression: "shares",
          research_run_id: "run-1"
        }
      ],
      listOpenOrders: async () => ({ orders: [] }),
      listReservations: () => [],
      now: () => "2026-07-07T16:00:00.000Z"
    };

    const disabled = await buildPaperPortfolioReviewReport({}, baseInput);
    assert.equal(disabled.recommendations[0]?.recommendation, "HOLD_EQUITY");
    assert.equal(disabled.recommendations[0]?.skippedReason, "SCALE_IN_DISABLED");

    process.env.PAPER_EQUITY_SCALE_IN_ENABLED = "true";
    const enabled = await buildPaperPortfolioReviewReport({}, baseInput);
    assert.equal(enabled.recommendations[0]?.recommendation, "ADD_TO_EQUITY");
    assert.equal(enabled.recommendations[0]?.eligiblePayload?.orderAction, "BUY");
    assert.equal(enabled.recommendations[0]?.eligiblePayload?.notional, "250.00");
    assert.equal(
      enabled.recommendations[0]?.eligiblePayload?.sourceCandidateId,
      "candidate-aapl"
    );
  });

  test("fails closed when scale-in position quantity or market value is missing", async () => {
    const missingQuantity = await scaleInReport({
      positions: [
        {
          symbol: "AAPL",
          assetClass: "us_equity",
          marketValue: "1000",
          currentPrice: "500"
        }
      ]
    });
    const missingValue = await scaleInReport({
      positions: [
        {
          symbol: "AAPL",
          assetClass: "us_equity",
          qty: "2",
          currentPrice: "500"
        }
      ]
    });

    for (const report of [missingQuantity, missingValue]) {
      assert.equal(report.recommendations[0]?.recommendation, "HOLD_EQUITY");
      assert.equal(
        report.recommendations[0]?.skippedReason,
        "SCALE_IN_POSITION_EVIDENCE_INCOMPLETE"
      );
      assert.equal(report.recommendations[0]?.eligiblePayload, null);
    }
  });

  test("fails closed when scale-in account capital evidence is incomplete", async () => {
    for (const field of ["id", "status", "equity", "cash", "buyingPower"] as const) {
      const report = await scaleInReport({ account: { [field]: undefined } });
      assert.equal(report.recommendations[0]?.recommendation, "HOLD_EQUITY");
      assert.equal(
        report.recommendations[0]?.skippedReason,
        "SCALE_IN_CAPITAL_EVIDENCE_INCOMPLETE"
      );
    }
    for (const unavailable of [
      { ordersUnavailable: true },
      { reservationsUnavailable: true }
    ]) {
      const report = await scaleInReport(unavailable);
      assert.equal(
        report.recommendations[0]?.skippedReason,
        "SCALE_IN_CAPITAL_EVIDENCE_INCOMPLETE"
      );
    }
  });

  test("blocks a scale-in for a same-symbol open buy or active reservation", async () => {
    const openOrder = await scaleInReport({
      orders: [
        {
          id: "open-aapl",
          symbol: "AAPL",
          assetClass: "us_equity",
          side: "buy",
          status: "accepted",
          notional: "250"
        }
      ]
    });
    const reservation = await scaleInReport({
      reservations: [
        {
          assetClass: "equity",
          symbol: "AAPL",
          side: "buy",
          status: "reserved",
          notional: "250"
        }
      ]
    });

    for (const report of [openOrder, reservation]) {
      assert.equal(report.recommendations[0]?.recommendation, "HOLD_EQUITY");
      assert.equal(
        report.recommendations[0]?.skippedReason,
        "SCALE_IN_DUPLICATE_ORDER_OR_RESERVATION"
      );
    }
  });

  test("uses PostgreSQL reservations and skips SQLite position observations under authority", async () => {
    process.env.PAPER_EQUITY_SCALE_IN_ENABLED = "true";
    const before = libDb.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM paper_position_observations"
    )?.count ?? 0;

    const report = await withExecutionAuthority(() =>
      buildPaperPortfolioReviewReport(
        {},
        {
          listPositions: async () => ({
            positions: [{
              symbol: "AAPL",
              assetClass: "us_equity",
              qty: "2",
              marketValue: "1000",
              currentPrice: "500",
              unrealizedPl: "10",
              unrealizedPlpc: "0.01"
            }]
          }),
          getAccount: async () => account,
          getCandidates: () => [candidate],
          listOpenOrders: async () => ({ orders: [] }),
          listReservations: () => {
            throw new Error("SQLite reservations must not be read under PostgreSQL authority");
          },
          resolveReservations: async () => [],
          now: () => "2026-07-07T16:00:00.000Z"
        } as any
      )
    );

    const after = libDb.queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM paper_position_observations"
    )?.count ?? 0;
    assert.equal(report.recommendations[0]?.recommendation, "ADD_TO_EQUITY");
    assert.equal(after, before);
  });

  test("enforces cash reserve and portfolio deployment caps for scale-ins", async () => {
    const cashReserve = await scaleInReport({
      account: { cash: "20000", buyingPower: "50000" }
    });
    const deployment = await scaleInReport({
      positions: [
        {
          symbol: "AAPL",
          assetClass: "us_equity",
          qty: "2",
          marketValue: "1000",
          currentPrice: "500"
        },
        {
          symbol: "MSFT",
          assetClass: "us_equity",
          qty: "10",
          marketValue: "48900",
          currentPrice: "4890"
        }
      ]
    });

    assert.equal(
      cashReserve.recommendations.find((row) => row.symbol === "AAPL")?.skippedReason,
      "SCALE_IN_CASH_RESERVE_EXCEEDED"
    );
    assert.equal(
      deployment.recommendations.find((row) => row.symbol === "AAPL")?.skippedReason,
      "SCALE_IN_PORTFOLIO_DEPLOYMENT_CAP_EXCEEDED"
    );
  });

  test("enforces ordinary per-position and per-order caps without resizing the $250 scale-in", async () => {
    const positionCap = await scaleInReport({
      positions: [
        {
          symbol: "AAPL",
          assetClass: "us_equity",
          qty: "20",
          marketValue: "9900",
          currentPrice: "495"
        }
      ]
    });
    process.env.PAPER_EQUITY_MAX_NOTIONAL_PER_ORDER = "200";
    const orderCap = await scaleInReport({});

    assert.equal(
      positionCap.recommendations[0]?.skippedReason,
      "SCALE_IN_POSITION_CAP_EXCEEDED"
    );
    assert.equal(
      orderCap.recommendations[0]?.skippedReason,
      "SCALE_IN_ORDER_CAP_EXCEEDED"
    );
    assert.equal(orderCap.recommendations[0]?.eligiblePayload, null);
  });

  test("recommends sell equity when max-loss rule triggers", async () => {
    const report = await buildPaperPortfolioReviewReport({}, {
      listPositions: async () => ({
        positions: [
          {
            symbol: "MSFT",
            assetClass: "us_equity",
            qty: "3",
            marketValue: "900",
            unrealizedPl: "-120",
            unrealizedPlpc: "-0.12"
          }
        ]
      }),
      getAccount: async () => account,
      getCandidates: () => [],
      now: () => "2026-07-07T16:00:00.000Z"
    });

    assert.equal(report.recommendations[0]?.recommendation, "SELL_EQUITY");
    assert.equal(report.recommendations[0]?.eligiblePayload?.side, "sell");
  });

  test("recommends hold when no equity exit condition triggers", async () => {
    const report = await buildPaperPortfolioReviewReport({}, {
      listPositions: async () => ({
        positions: [
          {
            symbol: "VTI",
            assetClass: "us_equity",
            qty: "4",
            marketValue: "1000",
            unrealizedPl: "15",
            unrealizedPlpc: "0.015"
          }
        ]
      }),
      getAccount: async () => account,
      getCandidates: () => [],
      now: () => "2026-07-07T16:00:00.000Z"
    });

    assert.equal(report.recommendations[0]?.recommendation, "HOLD_EQUITY");
    assert.equal(report.recommendations[0]?.eligiblePayload, null);
  });

  test("detects open option position and creates sell-to-close payload on 0DTE stop loss", async () => {
    const report = await buildPaperPortfolioReviewReport({}, {
      listPositions: async () => ({
        positions: [
          {
            symbol: "SPY260707C00450000",
            assetClass: "us_option",
            qty: "1",
            marketValue: "60",
            unrealizedPl: "-70",
            unrealizedPlpc: "-0.55",
            currentPrice: "0.6"
          }
        ]
      }),
      getAccount: async () => account,
      getCandidates: () => [],
      now: () => "2026-07-07T16:00:00.000Z"
    });

    assert.equal(report.summary.optionPositions, 1);
    assert.equal(report.recommendations[0]?.recommendation, "SELL_TO_CLOSE_OPTION");
    assert.equal(report.recommendations[0]?.eligiblePayload?.position_intent, "sell_to_close");
  });

  test("creates sell-to-close payload for late-day 0DTE forced exit", async () => {
    const report = await buildPaperPortfolioReviewReport({ moment: "late_day" }, {
      listPositions: async () => ({
        positions: [
          {
            symbol: "SPY260707P00450000",
            assetClass: "us_option",
            qty: "1",
            marketValue: "100",
            unrealizedPl: "5",
            unrealizedPlpc: "0.05",
            currentPrice: "1"
          }
        ]
      }),
      getAccount: async () => account,
      getCandidates: () => [],
      now: () => "2026-07-07T19:15:00.000Z"
    });

    assert.equal(report.recommendations[0]?.recommendation, "SELL_TO_CLOSE_OPTION");
    assert.equal(report.recommendations[0]?.reason, "OPTION_0DTE_LATE_DAY_FORCED_EXIT_REVIEW");
  });

  test("creates reviewed option sell-to-close payload for executable LEAPS hard exit", async () => {
    const leapsEvaluation: LeapsExitEvaluation = {
      symbol: "SPY",
      contractSymbol: "SPY270115C00600000",
      classification: "LEAPS",
      classificationInferred: false,
      entryDte: 540,
      currentDte: 175,
      unrealizedPlPct: 82.4,
      delta: 0.61,
      bidAskSpreadPct: 8.7,
      hardExit: true,
      reviewOnly: false,
      executable: true,
      section: "optionSellToCloseExits",
      reasons: ["LEAPS_DTE_EXIT_WINDOW"],
      underlyingClose: 500,
      trendReviewSma: 490,
      severeTrendExitSma: 480,
      limitPrice: 8.4,
      exitQuantity: 1,
      partialExitCandidate: null,
      lastReviewAt: "2026-07-01T14:00:00.000Z"
    };
    const report = await buildPaperPortfolioReviewReport({}, {
      listPositions: async () => ({
        positions: [
          {
            symbol: "SPY270115C00600000",
            assetClass: "us_option",
            qty: "1",
            marketValue: "840",
            unrealizedPl: "400",
            unrealizedPlpc: "0.82",
            currentPrice: "8.4"
          }
        ]
      }),
      getAccount: async () => account,
      getCandidates: () => [],
      evaluateLeapsExit: () => leapsEvaluation,
      now: () => "2026-07-08T14:00:00.000Z"
    });

    assert.equal(report.leapsExitEvaluations.length, 1);
    assert.equal(report.recommendations[0]?.recommendation, "SELL_TO_CLOSE_OPTION");
    assert.equal(report.recommendations[0]?.eligiblePayload?.position_intent, "sell_to_close");
    assert.equal(report.recommendations[0]?.eligiblePayload?.limit_price, "8.40");
    assert.deepEqual(report.recommendations[0]?.eligiblePayload?.reasonCodes, ["LEAPS_DTE_EXIT_WINDOW"]);
  });

  test("keeps liquidity-blocked LEAPS hard exit non-executable", async () => {
    const leapsEvaluation: LeapsExitEvaluation = {
      symbol: "SPY",
      contractSymbol: "SPY270115C00600000",
      classification: "LEAPS",
      classificationInferred: false,
      entryDte: 540,
      currentDte: 190,
      unrealizedPlPct: 130,
      delta: 0.61,
      bidAskSpreadPct: 33.3,
      hardExit: true,
      reviewOnly: false,
      executable: false,
      reasons: ["LEAPS_FULL_PROFIT_TAKE", "LIMIT_EXIT_REQUIRED"],
      underlyingClose: 500,
      trendReviewSma: 490,
      severeTrendExitSma: 480,
      limitPrice: null,
      exitQuantity: null,
      partialExitCandidate: null,
      lastReviewAt: "2026-07-01T14:00:00.000Z"
    };
    const report = await buildPaperPortfolioReviewReport({}, {
      listPositions: async () => ({
        positions: [
          {
            symbol: "SPY270115C00600000",
            assetClass: "us_option",
            qty: "1",
            marketValue: "1300",
            unrealizedPl: "500",
            unrealizedPlpc: "1.3",
            currentPrice: "13"
          }
        ]
      }),
      getAccount: async () => account,
      getCandidates: () => [],
      evaluateLeapsExit: () => leapsEvaluation,
      now: () => "2026-07-08T14:00:00.000Z"
    });

    assert.equal(report.recommendations[0]?.recommendation, "SELL_TO_CLOSE_OPTION");
    assert.equal(report.recommendations[0]?.eligiblePayload, null);
    assert.equal(report.recommendations[0]?.skippedReason, "LIMIT_EXIT_REQUIRED");
    assert.equal(report.warnings.includes("LIMIT_EXIT_REQUIRED"), true);
  });
});
