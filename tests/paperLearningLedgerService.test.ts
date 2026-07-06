import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-paper-learning-test-")),
  "research.db"
);
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  buildPromotionReadinessAnalytics,
  evaluatePaperLearningRecords,
  insertPaperLearningRecord,
  paperLearningSummary
} from "../src/services/paperLearningLedgerService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_learning_records;
    DELETE FROM option_snapshots;
    DELETE FROM option_contracts;
  `);
};

const insertOptionSnapshot = ({
  optionSymbol,
  midpoint = 1,
  timestamp = "2026-01-01T20:00:00.000Z"
}: {
  optionSymbol: string;
  midpoint?: number;
  timestamp?: string;
}) => {
  getDb().prepare(`
    INSERT INTO option_snapshots(
      option_symbol,
      underlying_symbol,
      timestamp,
      bid,
      ask,
      midpoint,
      last,
      quote_status,
      executable,
      executable_price,
      executable_price_source,
      rejection_reason,
      quote_timestamp,
      volume,
      open_interest,
      implied_volatility,
      delta,
      gamma,
      theta,
      vega,
      rho,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    optionSymbol,
    "SPY",
    timestamp,
    midpoint - 0.05,
    midpoint + 0.05,
    midpoint,
    midpoint,
    "valid",
    1,
    midpoint,
    "midpoint",
    null,
    timestamp,
    100,
    100,
    0.3,
    0.5,
    null,
    null,
    null,
    null,
    "alpaca"
  );
};

const insertSubmittedLearningRecord = (input: {
  id: string;
  optionSymbol: string;
  strategyFamily?: "zero_dte_spy" | "leaps";
  createdAt?: string;
  paperEntry?: number;
  liveLikeEntry?: number;
}) => insertPaperLearningRecord({
  id: input.id,
  createdAt: input.createdAt ?? "2026-01-01T15:00:00.000Z",
  strategyFamily: input.strategyFamily ?? "zero_dte_spy",
  symbol: input.strategyFamily === "leaps" ? "AAPL" : "SPY",
  underlyingSymbol: input.strategyFamily === "leaps" ? "AAPL" : "SPY",
  optionSymbol: input.optionSymbol,
  decision: "submitted",
  hypothesis: "test hypothesis",
  signalInputs: { rank: 1, direction: "long" },
  optionMetadata: {
    expirationDate: input.strategyFamily === "leaps" ? "2027-01-15" : "2026-01-01"
  },
  quoteSnapshot: {
    bid: 0.7,
    ask: 0.8,
    midpoint: 0.75,
    spreadPct: 13.33,
    quoteAgeSeconds: 10
  },
  paperFillModel: {
    submittedLimitPrice: input.paperEntry ?? 0.75,
    assumedFillPrice: input.paperEntry ?? 0.75,
    source: "midpoint"
  },
  liveLikeFillModel: {
    assumedEntryPrice: input.liveLikeEntry ?? 0.8,
    method: "ask",
    slippageBps: 666.67,
    spreadPenaltyPct: 13.33
  },
  riskModel: {
    maxPremium: 500,
    contracts: 1,
    notionalPremium: 75,
    maxLoss: 75,
    expectedHoldPeriod: input.strategyFamily === "leaps" ? "long_horizon" : "intraday"
  }
});

beforeEach(() => {
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(process.env.RESEARCH_DB_PATH!.substring(0, process.env.RESEARCH_DB_PATH!.lastIndexOf("/")), {
    recursive: true,
    force: true
  });
});

describe("paper learning ledger service", () => {
  test("evaluates pending 0DTE records when option mark data exists", () => {
    insertSubmittedLearningRecord({ id: "learn-0dte", optionSymbol: "SPY260101C00450000" });
    insertOptionSnapshot({ optionSymbol: "SPY260101C00450000", midpoint: 1.1 });

    const result = evaluatePaperLearningRecords({ asOf: "2026-01-01T21:00:00.000Z" });

    assert.equal(result.evaluated, 1);
    assert.equal(result.stillPending, 0);
    const row = getDb()
      .prepare("SELECT learning_status, outcome_json FROM paper_learning_records WHERE id = ?")
      .get("learn-0dte") as { learning_status: string; outcome_json: string };
    assert.equal(row.learning_status, "evaluated");
    const outcome = JSON.parse(row.outcome_json) as { pnlPaper: number; pnlLiveLike: number };
    assert.equal(outcome.pnlPaper, 35);
    assert.equal(outcome.pnlLiveLike, 30);
  });

  test("leaves records pending with a clear reason when mark data is missing", () => {
    insertSubmittedLearningRecord({ id: "learn-missing", optionSymbol: "SPY260101P00450000" });

    const result = evaluatePaperLearningRecords({ asOf: "2026-01-01T21:00:00.000Z" });

    assert.equal(result.evaluated, 0);
    assert.equal(result.stillPending, 1);
    assert.equal(result.pendingReasons[0]?.reason, "MISSING_MARK_DATA");
    const summary = paperLearningSummary();
    assert.equal(summary.pending, 1);
    assert.equal(summary.evaluated, 0);
  });

  test("promotion readiness blocks insufficient evidence and weak live-like profit factor", () => {
    insertSubmittedLearningRecord({
      id: "learn-weak",
      optionSymbol: "SPY260101C00450000",
      paperEntry: 1,
      liveLikeEntry: 1.2
    });
    getDb()
      .prepare(
        `
        UPDATE paper_learning_records
        SET learning_status = 'evaluated',
          outcome_json = ?,
          promotion_block_reason = 'ANALYTICS_GATE_NOT_REVIEWED'
        WHERE id = ?
        `
      )
      .run(JSON.stringify({
        entryPrice: 1,
        liveLikeEntryPrice: 1.2,
        currentOrExitPrice: 1.05,
        pnlPaper: 5,
        pnlLiveLike: -15
      }), "learn-weak");

    const readiness = buildPromotionReadinessAnalytics().find(
      (entry) => entry.strategyFamily === "zero_dte_spy"
    );

    assert.equal(readiness?.eligibleForLiveReview, false);
    assert.equal(readiness?.blockReasons.includes("INSUFFICIENT_TRADE_COUNT"), true);
    assert.equal(readiness?.blockReasons.includes("INSUFFICIENT_OBSERVED_TRADING_DAYS"), true);
    assert.equal(readiness?.blockReasons.includes("WEAK_LIVE_LIKE_PROFIT_FACTOR"), true);
  });
});
