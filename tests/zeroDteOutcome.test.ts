import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  captureZeroDteOutcomes,
  readZeroDteDailyOutcomeSummary,
  type ZeroDteMissedCandidate
} from "../src/services/zeroDte/zeroDteOutcomeService.js";
import {
  createZeroDteShadowTrade,
} from "../src/services/zeroDte/zeroDteShadowService.js";
import type { ZeroDteQueueCandidate } from "../src/services/zeroDte/zeroDtePersistenceService.js";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-outcome-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

const { closeDbForTests, getDb } = await import("../src/lib/db.js");

const firstCandidateId = "outcome-candidate-1";
const secondCandidateId = "outcome-candidate-2";
const firstSymbol = "SPY260713C00500000";
const secondSymbol = "SPY260713P00500000";
const runTimestamp = "2026-07-13T14:00:00.000Z";

const seedCandidate = (
  candidateId: string,
  optionSymbol: string,
  direction: "bullish" | "bearish"
) => {
  getDb().prepare(
    `INSERT OR IGNORE INTO zero_dte_candidates
      (candidate_id, trading_date, underlying_symbol, option_symbol, playbook,
       direction, expiration_date, strike, state, first_seen_at, last_seen_at,
       state_changed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    candidateId,
    "2026-07-13",
    "SPY",
    optionSymbol,
    direction === "bullish" ? "trend_continuation" : "reversal",
    direction,
    "2026-07-13",
    500,
    "skipped",
    runTimestamp,
    runTimestamp,
    runTimestamp,
    runTimestamp,
    runTimestamp
  );
};

const seedFixtures = () => {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("outcome-config-1", "zero-dte-level-2-v1", "outcome-config-hash", "{}", runTimestamp);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "outcome-run-1",
    "2026-07-13",
    "test",
    "paper",
    "running",
    "zero-dte-level-2-v1",
    "outcome-config-1",
    runTimestamp,
    runTimestamp
  );
  seedCandidate(firstCandidateId, firstSymbol, "bullish");
  seedCandidate(secondCandidateId, secondSymbol, "bearish");
};

const firstCandidate = (): ZeroDteMissedCandidate => ({
  candidateId: firstCandidateId,
  tradingDate: "2026-07-13",
  optionSymbol: firstSymbol,
  direction: "bullish",
  entryPremium: 1.05,
  observedAt: "2026-07-13T14:30:00.000Z"
});

const shadowCandidate = (): ZeroDteQueueCandidate => ({
  candidateId: secondCandidateId,
  tradingDate: "2026-07-13",
  underlyingSymbol: "SPY",
  optionSymbol: secondSymbol,
  playbook: "reversal",
  direction: "bearish",
  expirationDate: "2026-07-13",
  strike: 500,
  state: "skipped",
  eligible: true,
  executable: false,
  rank: 2,
  totalScore: 72,
  score: 72,
  playbookScore: 70,
  signalStrengthAdjustment: 2,
  liquidityAdjustment: 0,
  regimeAdjustment: 0,
  executionQualityAdjustment: 0,
  riskPenalty: 0,
  staleDataPenalty: 0,
  confidence: 72,
  signalSlope: 2,
  shortWindowSlope: 2,
  mediumWindowSlope: 1,
  liquidityScore: 80,
  freshnessScore: 90,
  setupAgeSeconds: 30,
  quote: {
    bid: 1.1,
    ask: 1.2,
    midpoint: 1.15,
    premium: 1.15,
    spreadPct: 8.7,
    volume: 400,
    openInterest: 800,
    impliedVolatility: 0.3,
    delta: -0.5,
    gamma: 0.08,
    theta: -0.2,
    vega: 0.1,
    marketTimestamp: "2026-07-13T14:30:00.000Z"
  },
  componentScores: {
    playbook: 70,
    signalStrength: 2,
    liquidity: 0,
    regime: 0,
    executionQuality: 0,
    riskPenalty: 0,
    staleDataPenalty: 0
  },
  blockers: ["HIGHER_RANKED_CANDIDATE"],
  reappearanceCount: 0,
  firstSeenAt: runTimestamp,
  lastSeenAt: runTimestamp
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("forward outcomes capture configured horizons, direction, and incomplete data", () => {
  seedFixtures();
  const result = captureZeroDteOutcomes({
    asOf: "2026-07-13T15:10:00.000Z",
    candidates: [firstCandidate()],
    quotes: {
      [`${firstSymbol}:5`]: {
        bid: 1.2,
        ask: 1.3,
        midpoint: 1.25,
        quoteTimestamp: "2026-07-13T14:35:00.000Z"
      },
      [`${firstSymbol}:15`]: {
        bid: 1.3,
        ask: 1.4,
        midpoint: 1.35,
        quoteTimestamp: "2026-07-13T14:45:00.000Z"
      },
      [`${firstSymbol}:30`]: {
        bid: 1.1,
        ask: 1.2,
        midpoint: 1.15,
        quoteTimestamp: "2026-07-13T15:00:00.000Z"
      }
    },
    horizonsMinutes: [60, 5, 15, 30, 15]
  });

  assert.equal(result.outcomes.length, 4);
  assert.equal(result.outcomes.filter((outcome) => outcome.completenessStatus === "complete").length, 3);
  assert.equal(result.incomplete.length, 1);
  assert.equal(result.outcomes[0]?.horizonMinutes, 5);
  assert.equal(result.outcomes[0]?.terminalPrice, 1.15);
  assert.equal(result.outcomes[0]?.realizedPnl, 9.35);
  assert.equal(result.outcomes[0]?.directionalCorrect, true);
  assert.equal(result.outcomes[3]?.horizonMinutes, 60);
  assert.equal(result.outcomes[3]?.evidence.incompleteReasonCode, "HORIZON_NOT_REACHED");
});

test("missing forward quotes are labeled and can be completed later", () => {
  const first = captureZeroDteOutcomes({
    asOf: "2026-07-13T14:40:00.000Z",
    candidates: [{
      ...firstCandidate(),
      candidateId: secondCandidateId,
      optionSymbol: secondSymbol,
      direction: "bearish",
      entryPremium: 1
    }],
    quotes: {},
    horizonsMinutes: [5]
  });
  assert.equal(first.incomplete[0]?.evidence.incompleteReasonCode, "QUOTE_MISSING");

  const completed = captureZeroDteOutcomes({
    asOf: "2026-07-13T14:40:00.000Z",
    candidates: [{
      ...firstCandidate(),
      candidateId: secondCandidateId,
      optionSymbol: secondSymbol,
      direction: "bearish",
      entryPremium: 1
    }],
    quotes: {
      [`${secondSymbol}:5`]: {
        bid: 1.2,
        ask: 1.3,
        midpoint: 1.25,
        quoteTimestamp: "2026-07-13T14:35:00.000Z"
      }
    },
    horizonsMinutes: [5]
  });
  assert.equal(completed.outcomes[0]?.completenessStatus, "complete");
  assert.equal(completed.outcomes[0]?.directionalCorrect, true);
});

test("outcome reconciliation closes open shadow trades at session end", () => {
  const created = createZeroDteShadowTrade({
    candidate: shadowCandidate(),
    decisionGroupId: "outcome-shadow-group",
    reasonCode: "HIGHER_RANKED_CANDIDATE",
    asOf: "2026-07-13T14:30:00.000Z"
  });
  assert.ok(created);
  const result = captureZeroDteOutcomes({
    asOf: "2026-07-13T20:00:00.000Z",
    candidates: [],
    quotes: { [secondSymbol]: { bid: 1.3, ask: 1.4, midpoint: 1.35 } },
    horizonsMinutes: []
  });
  assert.equal(result.closedShadowTrades.length, 1);
  assert.equal(result.closedShadowTrades[0]?.status, "closed");
  const summary = readZeroDteDailyOutcomeSummary("2026-07-13");
  assert.equal(summary.paperOnly, true);
  assert.equal(summary.counts.closedShadowTrades, 1);
});
