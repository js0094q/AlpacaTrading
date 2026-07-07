import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

import { buildPaperPortfolioReviewReport } from "../src/services/paperPortfolioReviewService.js";

const account = {
  status: "ACTIVE",
  equity: "100000",
  cash: "50000",
  buyingPower: "50000"
};

beforeEach(() => {
  process.env.PAPER_EQUITY_SCALE_IN_ENABLED = "false";
  process.env.PAPER_OPTION_EXIT_REVIEW_ENABLED = "true";
  process.env.PAPER_OPTION_EXIT_STOP_LOSS_PCT = "50";
  process.env.PAPER_OPTION_EXIT_PROFIT_TARGET_PCT = "80";
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
          symbol: "AAPL",
          rank: 1,
          confidence: 0.9,
          score: 2,
          risk_profile: "aggressive",
          preferred_expression: "shares",
          research_run_id: "run-1"
        }
      ],
      now: () => "2026-07-07T16:00:00.000Z"
    };

    const disabled = await buildPaperPortfolioReviewReport({}, baseInput);
    assert.equal(disabled.recommendations[0]?.recommendation, "HOLD_EQUITY");
    assert.equal(disabled.recommendations[0]?.skippedReason, "SCALE_IN_DISABLED");

    process.env.PAPER_EQUITY_SCALE_IN_ENABLED = "true";
    const enabled = await buildPaperPortfolioReviewReport({}, baseInput);
    assert.equal(enabled.recommendations[0]?.recommendation, "ADD_TO_EQUITY");
    assert.equal(enabled.recommendations[0]?.eligiblePayload?.orderAction, "BUY");
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
});
