import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as dbModule from "../src/lib/db.js";
import * as analyticsService from "../src/services/paperOutcomeAnalyticsService.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-analytics-test-")),
  "research.db"
);

process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";
process.env.ENABLE_OPTIONS_RESEARCH = "true";

globalThis.fetch = async () =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => "mock-request-id" },
    text: async () => "{}",
    json: async () => ({})
  }) as unknown as Response;

const {
  buildPaperOutcomeAnalytics,
  DEFAULT_ANALYTICS_THRESHOLDS,
  persistRecommendationSnapshots
} = analyticsService;
const { getDb } = dbModule;

const ts = (offset = 0) =>
  new Date(Date.UTC(2026, 0, 1 + offset, 9, 30, 0)).toISOString();

const resetDatabase = () => {
  const db = getDb();
  db.exec(`
    DELETE FROM paper_trade_evaluations;
    DELETE FROM paper_trade_plans;
    DELETE FROM paper_trade_candidates;
    DELETE FROM research_runs;
    DELETE FROM paper_recommendation_snapshots;
    DELETE FROM option_contracts;
    DELETE FROM option_snapshots;
    DELETE FROM universe_symbols;
    DELETE FROM api_request_log;
    DELETE FROM ingestion_runs;
    DELETE FROM market_bars;
    DELETE FROM feature_snapshots;
    DELETE FROM target_snapshots;
    DELETE FROM options_strategy_snapshots;
    DELETE FROM backtest_trades;
    DELETE FROM backtest_options_trades;
    DELETE FROM backtest_runs;
    DELETE FROM learning_runs;
  `);
};

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

type RiskProfile = "aggressive" | "moderate" | "conservative";

interface RunInput {
  id?: string;
  riskProfile?: RiskProfile;
  optionsEnabled?: boolean;
  startedAt?: string;
}

const seedRun = ({
  id,
  riskProfile = "moderate",
  optionsEnabled = false,
  startedAt = ts(0)
}: RunInput = {}) => {
  const runId = id ?? nextId("run");
  getDb()
    .prepare(
      `
      INSERT INTO research_runs(
        id,
        started_at,
        status,
        risk_profile,
        options_enabled,
        universe_size,
        targets_generated,
        candidates_selected,
        error_message,
        config_json
      ) VALUES (?, ?, 'completed', ?, ?, 1, 1, 1, NULL, ?)
      `
    )
    .run(
      runId,
      startedAt,
      riskProfile,
      optionsEnabled ? 1 : 0,
      JSON.stringify({ riskProfile, optionsEnabled, generatedBy: "analytics-test" })
    );
  return runId;
};

interface CandidateInput {
  runId: string;
  symbol: string;
  rank?: number;
  riskProfile?: RiskProfile;
  preferredExpression?: string;
  returnPct?: number;
  outcome?: string;
  asOf?: string;
  evaluatedAt?: string;
  evaluated?: boolean;
}

const seedCandidateWithOptionalEvaluation = ({
  runId,
  symbol,
  rank = 1,
  riskProfile = "moderate",
  preferredExpression = "shares",
  returnPct,
  outcome = "winner",
  asOf = ts(0),
  evaluatedAt = ts(1),
  evaluated = true
}: CandidateInput) => {
  const candidateId = nextId("candidate");
  const planId = nextId("plan");
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
        rationale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      candidateId,
      runId,
      symbol,
      asOf,
      rank,
      "long",
      "1d",
      riskProfile,
      preferredExpression,
      80,
      0.75,
      JSON.stringify(["analytics test"])
    );

  getDb()
    .prepare(
      `
      INSERT INTO paper_trade_plans(
        id,
        research_run_id,
        candidate_id,
        symbol,
        created_at,
        status,
        direction,
        expression,
        entry_reference,
        stop_loss,
        take_profit,
        expiration_date,
        option_symbol,
        strike,
        short_strike,
        estimated_entry_cost,
        estimated_max_loss,
        estimated_max_profit,
        thesis,
        invalidation,
        learning_objective
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      planId,
      runId,
      candidateId,
      symbol,
      evaluatedAt,
      "planned",
      "long",
      preferredExpression,
      100,
      95,
      110,
      null,
      null,
      null,
      null,
      1000,
      100,
      200,
      "test thesis",
      "test invalidation",
      "test learning objective"
    );

  if (evaluated) {
    getDb()
      .prepare(
        `
        INSERT INTO paper_trade_evaluations(
          id,
          research_run_id,
          candidate_id,
          plan_id,
          horizon,
          evaluated_at,
          mark_price,
          estimated_exit_value,
          unrealized_pnl,
          realized_pnl,
          return_pct,
          outcome,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        nextId("eval"),
        runId,
        candidateId,
        planId,
        "1d",
        evaluatedAt,
        100,
        100,
        returnPct ?? 0,
        returnPct ?? 0,
        returnPct ?? null,
        outcome,
        JSON.stringify(["evaluation generated"])
      );
  }

  return { candidateId, planId };
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

describe("Paper outcome analytics", () => {
  test("aggregates outcomes by symbol", () => {
    const runId = seedRun({ id: "run-symbols", riskProfile: "moderate", optionsEnabled: false });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      rank: 1,
      returnPct: 1.5,
      outcome: "winner"
    });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      rank: 2,
      evaluated: false
    });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "MSFT",
      rank: 1,
      returnPct: -2,
      outcome: "loser"
    });

    const result = buildPaperOutcomeAnalytics({ groupBy: "symbol" });
    assert.equal(result.supported, true);
    assert.equal(result.groups.length, 2);
    const aapl = result.groups.find((group) => group.key === "AAPL");
    const msft = result.groups.find((group) => group.key === "MSFT");
    assert.equal(aapl?.candidateCount, 2);
    assert.equal(aapl?.evaluatedCount, 1);
    assert.equal(aapl?.unevaluatedCount, 1);
    assert.equal(msft?.candidateCount, 1);
    assert.equal(msft?.evaluatedCount, 1);
    assert.equal(msft?.avgReturnPct, -2);
    assert.equal(msft?.winRate, 0);
  });

  test("aggregates outcomes by risk profile", () => {
    const moderateRun = seedRun({ id: "run-moderate", riskProfile: "moderate" });
    const aggressiveRun = seedRun({ id: "run-aggressive", riskProfile: "aggressive" });

    seedCandidateWithOptionalEvaluation({
      runId: moderateRun,
      symbol: "SPY",
      riskProfile: "moderate",
      returnPct: 1
    });
    seedCandidateWithOptionalEvaluation({
      runId: aggressiveRun,
      symbol: "QQQ",
      riskProfile: "aggressive",
      returnPct: -1
    });

    const result = buildPaperOutcomeAnalytics({ groupBy: "riskProfile" });
    assert.equal(result.supported, true);
    const moderate = result.groups.find((group) => group.key === "moderate");
    const aggressive = result.groups.find((group) => group.key === "aggressive");
    assert.equal(moderate?.evaluatedCount, 1);
    assert.equal(aggressive?.evaluatedCount, 1);
    assert.equal(moderate?.avgReturnPct > aggressive?.avgReturnPct ? true : false, true);
  });

  test("aggregates options-aware outcomes versus equity-only", () => {
    const optionsRun = seedRun({ id: "run-options", riskProfile: "moderate", optionsEnabled: true });
    const equityRun = seedRun({ id: "run-equity", riskProfile: "moderate", optionsEnabled: false });

    seedCandidateWithOptionalEvaluation({
      runId: optionsRun,
      symbol: "AAPL",
      returnPct: 2.5
    });
    seedCandidateWithOptionalEvaluation({
      runId: equityRun,
      symbol: "MSFT",
      returnPct: 0.5
    });

    const result = buildPaperOutcomeAnalytics({ groupBy: "optionsEnabled" });
    assert.equal(result.supported, true);
    const options = result.groups.find((group) => group.key === "options-aware");
    const equity = result.groups.find((group) => group.key === "equity-only");
    assert.equal(options?.evaluatedCount, 1);
    assert.equal(equity?.evaluatedCount, 1);
    assert.equal(options?.avgReturnPct > equity?.avgReturnPct ? true : false, true);
  });

  test("supports json output shape for analytics result", () => {
    const runId = seedRun({ id: "run-json", riskProfile: "moderate" });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      returnPct: 1.8,
      outcome: "winner"
    });

    const result = buildPaperOutcomeAnalytics({ groupBy: "symbol", minEvaluations: 1 });
    const serialized = JSON.parse(JSON.stringify(result));
    assert.equal(serialized.paperOnly, true);
    assert.equal(serialized.groupBy, "symbol");
    assert.equal(Array.isArray(serialized.groups), true);
    assert.equal(serialized.disclaimer.includes("Paper-only research analytics"), true);
  });

  test("applies minimum-evaluation filtering", () => {
    const runId = seedRun({ id: "run-min-filter", riskProfile: "moderate" });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      returnPct: 1.2,
      outcome: "winner"
    });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      evaluated: false
    });

    const result = buildPaperOutcomeAnalytics({ groupBy: "symbol", minEvaluations: 2 });
    assert.equal(result.groups.length, 0);
  });

  test("returns paper-only metadata", () => {
    const runId = seedRun({ id: "run-paper-meta", riskProfile: "moderate" });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "SPY",
      returnPct: 0.8,
      outcome: "winner"
    });

    const result = buildPaperOutcomeAnalytics();
    assert.equal(result.paperOnly, true);
    assert.equal(result.groupBy, "symbol");
    assert.equal(result.disclaimer, "Paper-only research analytics. Not live-trading advice.");
    assert.equal(result.filters.minEvaluations, 1);
  });

  test("supports ranking slices with top/bottom N metrics", () => {
    const runId = seedRun({ id: "run-rank-slices", riskProfile: "moderate" });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      returnPct: 4,
      outcome: "winner"
    });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "MSFT",
      returnPct: 1,
      outcome: "winner"
    });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "TSLA",
      returnPct: -2,
      outcome: "loser"
    });

    const result = buildPaperOutcomeAnalytics({
      groupBy: "symbol",
      topN: 1,
      bottomN: 1,
      includeRankingSlices: true,
      minEvaluations: 1
    });
    assert.equal(result.supported, true);
    assert.equal(result.rankingSlices?.topN, 1);
    const avgReturnSlice = result.rankingSlices?.slices.find((entry) => entry.metric === "avgReturnPct");
    assert.equal(avgReturnSlice?.top[0]?.key, "AAPL");
    assert.equal(avgReturnSlice?.bottom[0]?.key, "TSLA");
  });

  test("applies recommendation flags", () => {
    const promoteRun = seedRun({ id: "run-promote", riskProfile: "moderate" });
    const demoteRun = seedRun({ id: "run-demote", riskProfile: "moderate" });
    const keepRun = seedRun({ id: "run-keep", riskProfile: "moderate" });

    seedCandidateWithOptionalEvaluation({ runId: promoteRun, symbol: "PROMO", rank: 1, returnPct: 1, outcome: "winner", asOf: ts(1), evaluatedAt: ts(1) });
    seedCandidateWithOptionalEvaluation({ runId: promoteRun, symbol: "PROMO", rank: 2, returnPct: 2, outcome: "winner", asOf: ts(1), evaluatedAt: ts(1) });
    seedCandidateWithOptionalEvaluation({ runId: promoteRun, symbol: "PROMO", rank: 3, returnPct: 3, outcome: "winner", asOf: ts(1), evaluatedAt: ts(1) });
    seedCandidateWithOptionalEvaluation({ runId: promoteRun, symbol: "PROMO", rank: 4, returnPct: 4, outcome: "winner", asOf: ts(1), evaluatedAt: ts(1) });
    seedCandidateWithOptionalEvaluation({ runId: promoteRun, symbol: "PROMO", rank: 5, returnPct: 5, outcome: "winner", asOf: ts(1), evaluatedAt: ts(1) });

    seedCandidateWithOptionalEvaluation({ runId: demoteRun, symbol: "DEMOTE", rank: 1, returnPct: -1, outcome: "loser", asOf: ts(2), evaluatedAt: ts(2) });
    seedCandidateWithOptionalEvaluation({ runId: demoteRun, symbol: "DEMOTE", rank: 2, returnPct: -2, outcome: "loser", asOf: ts(2), evaluatedAt: ts(2) });
    seedCandidateWithOptionalEvaluation({ runId: demoteRun, symbol: "DEMOTE", rank: 3, returnPct: -3, outcome: "loser", asOf: ts(2), evaluatedAt: ts(2) });
    seedCandidateWithOptionalEvaluation({ runId: demoteRun, symbol: "DEMOTE", rank: 4, returnPct: -4, outcome: "loser", asOf: ts(2), evaluatedAt: ts(2) });
    seedCandidateWithOptionalEvaluation({ runId: demoteRun, symbol: "DEMOTE", rank: 5, returnPct: -5, outcome: "loser", asOf: ts(2), evaluatedAt: ts(2) });

    seedCandidateWithOptionalEvaluation({ runId: keepRun, symbol: "KEEP", rank: 1, returnPct: 3, outcome: "winner", asOf: ts(3), evaluatedAt: ts(3) });
    seedCandidateWithOptionalEvaluation({ runId: keepRun, symbol: "KEEP", rank: 2, returnPct: 3, outcome: "winner", asOf: ts(3), evaluatedAt: ts(3) });
    seedCandidateWithOptionalEvaluation({ runId: keepRun, symbol: "KEEP", rank: 3, returnPct: 3, outcome: "winner", asOf: ts(3), evaluatedAt: ts(3) });
    seedCandidateWithOptionalEvaluation({ runId: keepRun, symbol: "KEEP", rank: 4, returnPct: -3, outcome: "loser", asOf: ts(3), evaluatedAt: ts(3) });
    seedCandidateWithOptionalEvaluation({ runId: keepRun, symbol: "KEEP", rank: 5, returnPct: -10, outcome: "loser", asOf: ts(3), evaluatedAt: ts(3) });

    const result = buildPaperOutcomeAnalytics({ groupBy: "symbol", minEvaluations: 5 });
    assert.equal(result.supported, true);
    const promote = result.groups.find((group) => group.key === "PROMO");
    const demote = result.groups.find((group) => group.key === "DEMOTE");
    const keep = result.groups.find((group) => group.key === "KEEP");
    assert.equal(promote?.recommendationFlag, "PROMOTE_FOR_MORE_PAPER_TESTING");
    assert.equal(demote?.recommendationFlag, "DEMOTE_OR_EXCLUDE_FROM_NEXT_LOOP");
    assert.equal(keep?.recommendationFlag, "KEEP_MONITORING");
    assert.equal(promote?.evaluatedCount, DEFAULT_ANALYTICS_THRESHOLDS.minEvaluationsForPromotion);
  });

  test("persists recommendation snapshot rows", () => {
    const runId = seedRun({ id: "run-snapshot", riskProfile: "moderate" });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      returnPct: 2,
      outcome: "winner"
    });

    const result = buildPaperOutcomeAnalytics({ groupBy: "symbol", minEvaluations: 1 });
    assert.equal(result.supported, true);
    const persisted = persistRecommendationSnapshots({
      result,
      snapshotRunId: "snapshot-run-1",
      source: "paper:analytics:test"
    });
    assert.equal(persisted.persistedCount, 1);

    const stored = Number(
      (getDb().prepare(
        "SELECT COUNT(*) AS count FROM paper_recommendation_snapshots WHERE snapshot_run_id = ?"
      ).get(persisted.snapshotRunId) as { count: number }).count
    );
    assert.equal(stored, 1);
  });

  test("computes unevaluated backlog aging buckets", () => {
    const runId = seedRun({ id: "run-backlog", riskProfile: "moderate", startedAt: "2026-01-01T00:00:00.000Z" });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "AAPL",
      asOf: "2026-01-01T00:00:00.000Z",
      returnPct: 3,
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      outcome: "winner"
    });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "MSFT",
      asOf: "2026-01-03T00:00:00.000Z",
      evaluated: false
    });
    seedCandidateWithOptionalEvaluation({
      runId,
      symbol: "TSLA",
      asOf: "2026-01-09T00:00:00.000Z",
      evaluated: false
    });

    const result = buildPaperOutcomeAnalytics({
      groupBy: "symbol",
      includeBacklogAging: true,
      until: "2026-01-11T00:00:00.000Z",
      minEvaluations: 1
    });
    assert.equal(result.supported, true);
    assert.equal(result.backlogAging?.totalUnevaluated, 2);
    const olderBucket = result.backlogAging?.buckets.find((entry) => entry.bucket === "2-3 days");
    const midBucket = result.backlogAging?.buckets.find((entry) => entry.bucket === "8-14 days");
    assert.equal(olderBucket?.count, 1);
    assert.equal(midBucket?.count, 1);
  });

  test("does not require live credentials", () => {
    const originalPaperKey = process.env.ALPACA_PAPER_KEY;
    const originalPaperSecret = process.env.ALPACA_PAPER_SECRET;
    const originalLiveKey = process.env.ALPACA_LIVE_KEY;
    const originalLiveSecret = process.env.ALPACA_LIVE_SECRET;

    delete process.env.ALPACA_PAPER_KEY;
    delete process.env.ALPACA_PAPER_SECRET;
    delete process.env.ALPACA_LIVE_KEY;
    delete process.env.ALPACA_LIVE_SECRET;

    const runId = seedRun({ id: "run-no-creds", riskProfile: "moderate" });
    seedCandidateWithOptionalEvaluation({ runId, symbol: "AAPL", returnPct: 0.3 });
    assert.doesNotThrow(() => {
      const result = buildPaperOutcomeAnalytics({ groupBy: "symbol" });
      assert.equal(result.supported, true);
    });

    if (originalPaperKey === undefined) {
      delete process.env.ALPACA_PAPER_KEY;
    } else {
      process.env.ALPACA_PAPER_KEY = originalPaperKey;
    }
    if (originalPaperSecret === undefined) {
      delete process.env.ALPACA_PAPER_SECRET;
    } else {
      process.env.ALPACA_PAPER_SECRET = originalPaperSecret;
    }
    if (originalLiveKey === undefined) {
      delete process.env.ALPACA_LIVE_KEY;
    } else {
      process.env.ALPACA_LIVE_KEY = originalLiveKey;
    }
    if (originalLiveSecret === undefined) {
      delete process.env.ALPACA_LIVE_SECRET;
    } else {
      process.env.ALPACA_LIVE_SECRET = originalLiveSecret;
    }
  });

  test("handles empty database without crashing", () => {
    const result = buildPaperOutcomeAnalytics({ groupBy: "symbol" });
    assert.equal(result.supported, true);
    assert.equal(result.groups.length, 0);
    assert.equal(result.paperOnly, true);
  });

  test("returns unsupported payload for unsupported groupBy", () => {
    const result = buildPaperOutcomeAnalytics({ groupBy: "not-a-group" as never });
    assert.equal(result.supported, false);
    assert.equal(result.paperOnly, true);
    assert.equal(result.reason.includes("Unsupported groupBy"), true);
  });
});
