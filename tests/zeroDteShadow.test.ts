import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createZeroDteShadowTrade,
  markZeroDteShadowTrades,
  readZeroDteShadowTrades,
  type ZeroDteShadowTrade
} from "../src/services/zeroDte/zeroDteShadowService.js";
import type { ZeroDteQueueCandidate } from "../src/services/zeroDte/zeroDtePersistenceService.js";

const dbDir = mkdtempSync(join(tmpdir(), "zero-dte-level-2-shadow-"));
process.env.RESEARCH_DB_PATH = join(dbDir, "research.db");

const { closeDbForTests, getDb } = await import("../src/lib/db.js");

const timestamp = "2026-07-13T14:30:00.000Z";
const optionSymbol = "SPY260713C00500000";
const candidateId = "shadow-candidate-1";

const seedFixtures = () => {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_configuration_versions
      (configuration_version_id, strategy_version, configuration_hash,
       configuration_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("shadow-config-1", "zero-dte-level-2-v1", "shadow-config-hash", "{}", timestamp);
  db.prepare(
    `INSERT OR IGNORE INTO zero_dte_engine_runs
      (run_id, trading_date, mode, account_mode, status, strategy_version,
       configuration_version_id, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "shadow-run-1",
    "2026-07-13",
    "test",
    "paper",
    "running",
    "zero-dte-level-2-v1",
    "shadow-config-1",
    timestamp,
    timestamp
  );
  db.prepare(
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
    "trend_continuation",
    "bullish",
    "2026-07-13",
    500,
    "skipped",
    timestamp,
    timestamp,
    timestamp,
    timestamp,
    timestamp
  );
};

const candidate = (): ZeroDteQueueCandidate => ({
  candidateId,
  tradingDate: "2026-07-13",
  underlyingSymbol: "SPY",
  optionSymbol,
  playbook: "trend_continuation",
  direction: "bullish",
  expirationDate: "2026-07-13",
  strike: 500,
  state: "skipped",
  eligible: true,
  executable: false,
  rank: 2,
  totalScore: 78,
  score: 78,
  playbookScore: 76,
  signalStrengthAdjustment: 2,
  liquidityAdjustment: 1,
  regimeAdjustment: 0,
  executionQualityAdjustment: 1,
  riskPenalty: 0,
  staleDataPenalty: 0,
  confidence: 80,
  signalSlope: 3,
  shortWindowSlope: 3,
  mediumWindowSlope: 2,
  liquidityScore: 85,
  freshnessScore: 95,
  setupAgeSeconds: 60,
  quote: {
    bid: 1.2,
    ask: 1.4,
    midpoint: 1.3,
    premium: 1.3,
    spreadPct: 15.38,
    volume: 500,
    openInterest: 900,
    impliedVolatility: 0.3,
    delta: 0.5,
    gamma: 0.08,
    theta: -0.2,
    vega: 0.1,
    marketTimestamp: timestamp
  },
  componentScores: {
    playbook: 76,
    signalStrength: 2,
    liquidity: 1,
    regime: 0,
    executionQuality: 1,
    riskPenalty: 0,
    staleDataPenalty: 0
  },
  blockers: ["HIGHER_RANKED_CANDIDATE"],
  reappearanceCount: 0,
  firstSeenAt: timestamp,
  lastSeenAt: timestamp
});

after(() => {
  closeDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
});

test("shadow trades use conservative fills, remain idempotent, and never submit orders", () => {
  seedFixtures();
  const created = createZeroDteShadowTrade({
    candidate: candidate(),
    decisionGroupId: "shadow-group-1",
    reasonCode: "HIGHER_RANKED_CANDIDATE",
    asOf: timestamp
  });

  assert.ok(created);
  assert.equal(created?.alternativeType, "simulated_runner_up");
  assert.equal(created?.entryPremium, 1.45);
  assert.equal(created?.fees, 0.65);
  assert.equal(created?.status, "open");
  assert.equal(created?.fillAssumptions.simulated, true);
  assert.equal(
    createZeroDteShadowTrade({
      candidate: candidate(),
      decisionGroupId: "shadow-group-1",
      reasonCode: "HIGHER_RANKED_CANDIDATE",
      asOf: timestamp
    })?.shadowTradeId,
    created?.shadowTradeId
  );
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_shadow_trades").get() as { count: number }).count,
    1
  );
});

test("shadow marks use bid minus slippage, track MFE/MAE, and block invalid quotes", () => {
  const created = readZeroDteShadowTrades({ tradingDate: "2026-07-13" })[0] as ZeroDteShadowTrade;
  const marked = markZeroDteShadowTrades({
    asOf: "2026-07-13T14:31:00.000Z",
    quotes: { [optionSymbol]: { bid: 1.1, ask: 1.2, midpoint: 1.15 } }
  });
  assert.equal(marked.marked.length, 1);
  assert.equal(marked.marked[0]?.markPrice, 1.05);
  assert.equal(marked.marked[0]?.unrealizedPnl, -40.65);
  assert.equal(marked.marked[0]?.mae, -40.65);
  assert.equal(marked.marked[0]?.mfe, 0);

  const blocked = markZeroDteShadowTrades({
    asOf: "2026-07-13T14:32:00.000Z",
    quotes: { [optionSymbol]: { bid: 1.3, ask: 1.2, midpoint: 1.25 } }
  });
  assert.equal(blocked.marked.length, 0);
  assert.deepEqual(blocked.blocked, [{
    shadowTradeId: created.shadowTradeId,
    candidateId,
    reasonCode: "CROSSED_QUOTE"
  }]);
});

test("session-end shadow marking closes the simulated trade without a broker call", () => {
  const result = markZeroDteShadowTrades({
    asOf: "2026-07-13T20:00:00.000Z",
    quotes: { [optionSymbol]: { bid: 1, ask: 1.1, midpoint: 1.05 } }
  });
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0]?.status, "closed");
  assert.equal(result.closed[0]?.exitPremium, 0.95);
  assert.equal(result.closed[0]?.fees, 1.3);
  assert.equal(result.closed[0]?.realizedPnl, -51.3);
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) AS count FROM zero_dte_lifecycle_events WHERE event_type = 'shadow_closed'").get() as { count: number }).count,
    1
  );
});

test("low-quality and neutral candidates are not shadowed", () => {
  const lowQuality = candidate();
  lowQuality.blockers = ["WIDE_SPREAD"];
  assert.equal(
    createZeroDteShadowTrade({
      candidate: lowQuality,
      decisionGroupId: "shadow-group-low-quality",
      reasonCode: "WIDE_SPREAD",
      asOf: timestamp
    }),
    null
  );
  const neutral = candidate();
  neutral.direction = "neutral";
  assert.equal(
    createZeroDteShadowTrade({
      candidate: neutral,
      decisionGroupId: "shadow-group-neutral",
      reasonCode: "NEUTRAL_DIRECTION",
      asOf: timestamp
    }),
    null
  );
});
