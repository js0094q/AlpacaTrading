import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const dbDir = mkdtempSync(join(tmpdir(), "alpaca-learning-governance-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import { insertPaperLearningRecord } from "../src/services/paperLearningLedgerService.js";
import {
  applyPaperLearningGovernance,
  getCurrentPaperLearningGovernance
} from "../src/services/learningGovernanceService.js";
import { rankResearchCandidates } from "../src/services/candidateRankingService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_learning_governance_decisions;
    DELETE FROM paper_learning_governance_runs;
    DELETE FROM paper_learning_records;
    DELETE FROM learning_runs;
    DELETE FROM backtest_options_trades;
    DELETE FROM backtest_trades;
    DELETE FROM backtest_runs;
    DELETE FROM options_strategy_snapshots;
    DELETE FROM feature_snapshots;
  `);
};

const insertEvaluatedRecord = (input: {
  id: string;
  symbol: string;
  createdAt: string;
  pnlLiveLike: number;
}) => {
  insertPaperLearningRecord({
    id: input.id,
    createdAt: input.createdAt,
    strategyFamily: "standard_option",
    symbol: input.symbol,
    underlyingSymbol: input.symbol,
    optionSymbol: `${input.symbol}-${input.id}`,
    decision: "submitted",
    hypothesis: "bounded governance evidence",
    signalInputs: { rank: 1 },
    optionMetadata: { expirationDate: "2027-01-15" },
    quoteSnapshot: {
      bid: 0.7,
      ask: 0.8,
      midpoint: 0.75,
      spreadPct: 13.33,
      quoteAgeSeconds: 10
    },
    paperFillModel: {
      submittedLimitPrice: 0.75,
      assumedFillPrice: 0.75,
      source: "midpoint"
    },
    liveLikeFillModel: {
      assumedEntryPrice: 0.8,
      method: "ask",
      slippageBps: 666.67,
      spreadPenaltyPct: 13.33
    },
    riskModel: {
      maxPremium: 500,
      contracts: 1,
      notionalPremium: 75,
      maxLoss: 75,
      expectedHoldPeriod: "swing"
    }
  });
  getDb().prepare(`
    UPDATE paper_learning_records
    SET learning_status = 'evaluated', outcome_json = ?
    WHERE id = ?
  `).run(JSON.stringify({
    pnlPaper: input.pnlLiveLike,
    pnlLiveLike: input.pnlLiveLike
  }), input.id);
};

const seedEvaluatedRecords = (symbol: string, pnlLiveLike: number) => {
  for (let index = 0; index < 50; index += 1) {
    insertEvaluatedRecord({
      id: `${symbol.toLowerCase()}-${index}`,
      symbol,
      createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      pnlLiveLike
    });
  }
};

const target = (symbol: string) => ({
  symbol,
  asOf: "2026-03-01T15:00:00.000Z",
  direction: "long",
  horizon: "1d",
  entryReference: 100,
  upsideTarget: 110,
  downsideRisk: 95,
  stopLoss: 95,
  takeProfit: 110,
  confidence: 0.7,
  expectedReturn: 0.1,
  volatilityAdjustedScore: 1,
  riskProfile: "aggressive",
  preferredExpression: "long_call",
  rationale: []
});

beforeEach(() => {
  resetDatabase();
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("paper learning governance service", () => {
  test("persists priority decisions that raise the research rank for positive live-like evidence", () => {
    seedEvaluatedRecords("AAPL", 10);

    const result = applyPaperLearningGovernance({
      now: () => new Date("2026-03-01T16:00:00.000Z"),
      getGitSha: () => "test-sha"
    });

    assert.equal(result.status, "completed");
    assert.equal(result.nonBrokerMutating, true);
    assert.equal(result.decisionsWritten, 5);
    const decisions = getCurrentPaperLearningGovernance();
    assert.equal(
      decisions.find(
        (decision) => decision.scopeType === "strategy_family" && decision.scopeKey === "standard_option"
      )?.state,
      "prioritized"
    );
    assert.equal(
      decisions.find((decision) => decision.scopeType === "symbol" && decision.scopeKey === "AAPL")?.state,
      "prioritized"
    );

    const ranked = rankResearchCandidates({
      researchRunId: "research-governance-priority",
      riskProfile: "aggressive",
      optionsEnabled: true,
      targets: [target("AAPL"), target("MSFT")] as any,
      maxCandidates: 2,
      maxPerSymbol: 1,
      maxPerDirection: 2,
      maxPerExpression: 2
    });
    assert.equal(ranked.candidates[0]?.symbol, "AAPL");
    assert.equal(
      ranked.candidates[0]?.rationale.some((line) => line.includes("Learning governance prioritized")),
      true
    );
  });

  test("suspends a negatively evidenced symbol from future research candidates", () => {
    seedEvaluatedRecords("AAPL", -10);
    applyPaperLearningGovernance({
      now: () => new Date("2026-03-01T16:00:00.000Z"),
      getGitSha: () => "test-sha"
    });

    const ranked = rankResearchCandidates({
      researchRunId: "research-governance-suspension",
      riskProfile: "aggressive",
      optionsEnabled: true,
      targets: [target("AAPL")] as any,
      maxCandidates: 1,
      maxPerSymbol: 1,
      maxPerDirection: 1,
      maxPerExpression: 1
    });

    assert.equal(ranked.candidates.length, 0);
    assert.equal(ranked.decisions[0]?.decisionReason, "LEARNING_GOVERNANCE_SUSPENDED");
    assert.equal(ranked.warnings.includes("All ranked candidates were suspended by bounded learning governance."), true);
  });
});
