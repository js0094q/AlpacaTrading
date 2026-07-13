import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";
import type { PositionLifecycleId } from "../src/types.js";

const testRoot = mkdtempSync(join(tmpdir(), "alpaca-decision-evidence-test-"));
process.env.RESEARCH_DB_PATH = join(testRoot, "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.GIT_SHA = "9384392-test-sha";

const [libDb, candidateRankingService, evidenceService] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/candidateRankingService.js"),
  import("../src/services/marketDecisionEvidenceService.js")
]);

const { closeDbForTests, getDb } = libDb;
const { persistCandidateDecisions } = candidateRankingService;
const {
  appendDecisionLifecycleEvent,
  hashAllowlistedConfig,
  linkPaperReviewDecision,
  persistDecisionSnapshot
} = evidenceService;

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
    DELETE FROM paper_trade_evaluations;
    DELETE FROM paper_trade_plans;
    DELETE FROM paper_trade_candidates;
    DELETE FROM paper_review_artifacts;
    DELETE FROM research_runs;
  `);
};

const insertResearchRun = (id: string) => {
  getDb().prepare(`
    INSERT INTO research_runs(
      id, started_at, completed_at, status, risk_profile, options_enabled,
      universe_size, targets_generated, candidates_selected, config_json
    ) VALUES (?, ?, ?, 'completed', 'moderate', 0, 4, 4, 1, ?)
  `).run(
    id,
    "2026-07-13T15:00:00.000Z",
    "2026-07-13T15:01:00.000Z",
    JSON.stringify({
      riskProfile: "moderate",
      optionsEnabled: false,
      maxCandidates: 1,
      maxPerSymbol: 1,
      maxPerDirection: 1,
      maxPerExpression: 1,
      barLookbackDays: 120,
      secretKey: "must-not-affect-hash"
    })
  );
};

const decisionFixture = (
  id: string,
  decision: "selected" | "rejected" | "skipped" | "blocked",
  decisionReason: string,
  score = 80
) => ({
  id,
  symbol: id.endsWith("2") ? "MSFT" : "AAPL",
  asOf: "2026-07-13T15:00:00.000Z",
  rank: 1,
  direction: "long" as const,
  horizon: "5d" as const,
  riskProfile: "moderate" as const,
  preferredExpression: "shares" as const,
  score,
  confidence: 0.75,
  expectedReturn: 0.04,
  estimatedMaxLoss: 10,
  estimatedMaxProfit: 20,
  rationale: ["Observed trend evidence"],
  relevantBacktestRunId: null,
  historicalWinRate: null,
  historicalAvgReturn: null,
  historicalMaxDrawdown: null,
  similarSetupCount: null,
  optionLiquidityScore: null,
  volatilityAdjustedScore: 78,
  signalFreshnessDays: 0,
  recentLearningAdjustment: 0,
  directionalAccuracy: null,
  optionOutperformanceAccuracy: null,
  optionSymbol: null,
  strike: null,
  shortStrike: null,
  decision,
  decisionReason,
  strategyFamily: "shares",
  signalInputs: {
    observatorySourceTimestamp: "2026-07-13T14:59:58.000Z",
    observatoryRequestId: "market-request-1",
    observatoryEffectiveFeed: "iex",
    close: 200
  },
  dataQualityStatus: "COMPLETE"
});

beforeEach(resetDatabase);

after(() => {
  closeDbForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("immutable decision evidence", () => {
  test("canonical configuration hashes include only allowlisted paths", () => {
    const first = hashAllowlistedConfig(
      {
        strategy: { threshold: 0.7, maxCandidates: 2 },
        apiKey: "secret-one"
      },
      ["strategy.threshold", "strategy.maxCandidates"]
    );
    const reordered = hashAllowlistedConfig(
      {
        apiKey: "secret-two",
        strategy: { maxCandidates: 2, threshold: 0.7 }
      },
      ["strategy.maxCandidates", "strategy.threshold"]
    );
    const changedAllowedValue = hashAllowlistedConfig(
      {
        strategy: { threshold: 0.8, maxCandidates: 2 },
        apiKey: "secret-two"
      },
      ["strategy.threshold", "strategy.maxCandidates"]
    );

    assert.equal(first, reordered);
    assert.notEqual(first, changedAllowedValue);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  test("candidate persistence writes one immutable snapshot and initial event", () => {
    insertResearchRun("run-evidence");
    persistCandidateDecisions({
      researchRunId: "run-evidence",
      decisions: [decisionFixture("candidate-evidence", "selected", "RANKED_SELECTED")]
    });

    const original = getDb().prepare(`
      SELECT * FROM decision_snapshots WHERE candidate_id = 'candidate-evidence'
    `).get() as Record<string, unknown>;
    const candidate = getDb().prepare(`
      SELECT decision_id FROM paper_trade_candidates WHERE id = 'candidate-evidence'
    `).get() as { decision_id: string };

    assert.equal(original.decision_id, candidate.decision_id);
    assert.equal(original.decision_role, "entry");
    assert.equal(original.decision_status, "SELECTED");
    assert.equal(original.git_sha, "9384392-test-sha");
    assert.equal(original.environment, "paper");
    assert.equal(original.feed, "iex");
    assert.equal(original.market_data_request_id, "market-request-1");
    assert.deepEqual(JSON.parse(String(original.reason_codes_json)), ["RANKED_SELECTED"]);
    assert.match(String(original.strategy_config_hash), /^[0-9a-f]{64}$/);
    assert.match(String(original.risk_config_hash), /^[0-9a-f]{64}$/);

    persistCandidateDecisions({
      researchRunId: "run-evidence",
      decisions: [
        {
          ...decisionFixture("candidate-evidence", "selected", "CHANGED_LATER", 5),
          rationale: ["Later mutable value"]
        }
      ]
    });

    const retained = getDb().prepare(`
      SELECT score, reason_codes_json, rationale
      FROM decision_snapshots
      WHERE candidate_id = 'candidate-evidence'
    `).get() as { score: number; reason_codes_json: string; rationale: string };
    assert.equal(retained.score, 80);
    assert.deepEqual(JSON.parse(retained.reason_codes_json), ["RANKED_SELECTED"]);
    assert.equal(retained.rationale, JSON.stringify(["Observed trend evidence"]));

    const counts = getDb().prepare(`
      SELECT
        (SELECT COUNT(*) FROM decision_snapshots WHERE candidate_id = 'candidate-evidence') AS snapshots,
        (SELECT COUNT(*) FROM decision_lifecycle_events WHERE decision_id = ?) AS events
    `).get(candidate.decision_id) as { snapshots: number; events: number };
    assert.equal(counts.snapshots, 1);
    assert.equal(counts.events, 1);
  });

  test("selected rejected skipped and blocked decisions retain typed states and reasons", () => {
    insertResearchRun("run-states");
    persistCandidateDecisions({
      researchRunId: "run-states",
      decisions: [
        decisionFixture("candidate-state-1", "selected", "RANKED_SELECTED"),
        decisionFixture("candidate-state-2", "rejected", "DATA_INCOMPLETE"),
        decisionFixture("candidate-state-3", "skipped", "RANK_BELOW_CUTOFF"),
        decisionFixture("candidate-state-4", "blocked", "ASSET_NOT_TRADABLE")
      ]
    });

    const rows = getDb().prepare(`
      SELECT candidate_id, decision_role, decision_status, reason_codes_json
      FROM decision_snapshots
      ORDER BY candidate_id
    `).all() as Array<{
      candidate_id: string;
      decision_role: string;
      decision_status: string;
      reason_codes_json: string;
    }>;
    assert.deepEqual(
      rows.map((row) => [
        row.candidate_id,
        row.decision_role,
        row.decision_status,
        JSON.parse(row.reason_codes_json)[0]
      ]),
      [
        ["candidate-state-1", "entry", "SELECTED", "RANKED_SELECTED"],
        ["candidate-state-2", "non_executable", "REJECTED", "DATA_INCOMPLETE"],
        ["candidate-state-3", "non_executable", "SKIPPED", "RANK_BELOW_CUTOFF"],
        ["candidate-state-4", "non_executable", "BLOCKED", "ASSET_NOT_TRADABLE"]
      ]
    );
  });

  test("lifecycle events and exit decisions are append-only and origin-idempotent", () => {
    const entry = persistDecisionSnapshot({
      originType: "candidate",
      originId: "candidate-direct",
      decisionRole: "entry",
      decisionStatus: "SELECTED",
      createdAt: "2026-07-13T15:00:00.000Z",
      reasonCodes: ["RANKED_SELECTED"],
      dataQualityStatus: "COMPLETE",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });
    const exit = persistDecisionSnapshot({
      originType: "paper_review_artifact",
      originId: "artifact-exit-1:optionSellToCloseExits:0",
      decisionRole: "exit",
      decisionStatus: "REVIEWED",
      positionLifecycleId:
        "b33a22de-1f20-4d15-b451-c084ba8e62b1" as PositionLifecycleId,
      createdAt: "2026-07-13T16:00:00.000Z",
      reasonCodes: ["TAKE_PROFIT"],
      dataQualityStatus: "COMPLETE",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });
    const exitRetry = persistDecisionSnapshot({
      originType: "paper_review_artifact",
      originId: "artifact-exit-1:optionSellToCloseExits:0",
      decisionRole: "exit",
      decisionStatus: "BLOCKED",
      createdAt: "2026-07-13T16:05:00.000Z",
      reasonCodes: ["CHANGED_LATER"],
      dataQualityStatus: "PARTIAL",
      sourceTimestamps: {},
      environment: "paper",
      configAllowlistVersion: "phase1b-v1"
    });

    assert.notEqual(entry.decisionId, exit.decisionId);
    assert.equal(exitRetry.decisionId, exit.decisionId);
    assert.equal(exitRetry.decisionStatus, "REVIEWED");

    const firstEvent = appendDecisionLifecycleEvent({
      decisionId: entry.decisionId,
      status: "REVIEWED",
      reasonCodes: [],
      occurredAt: "2026-07-13T15:10:00.000Z",
      sourceType: "paper_review_artifact",
      sourceId: "artifact-entry-1",
      evidence: { artifactId: "artifact-entry-1" }
    });
    const retryEvent = appendDecisionLifecycleEvent({
      decisionId: entry.decisionId,
      status: "REVIEWED",
      reasonCodes: ["CHANGED_LATER"],
      occurredAt: "2026-07-13T15:11:00.000Z",
      sourceType: "paper_review_artifact",
      sourceId: "artifact-entry-1",
      evidence: { artifactId: "artifact-entry-1", changed: true }
    });
    assert.equal(retryEvent.eventId, firstEvent.eventId);

    getDb().prepare(`
      INSERT INTO paper_review_artifacts(
        id, created_at, expires_at, source_action, status,
        payload_signature, payload_count, artifact_json
      ) VALUES ('artifact-exit-1', ?, ?, 'paper:exit:review', 'ready', 'sig', 1, '{}')
    `).run("2026-07-13T16:00:00.000Z", "2026-07-13T16:30:00.000Z");
    linkPaperReviewDecision({
      artifactId: "artifact-exit-1",
      section: "optionSellToCloseExits",
      payloadIndex: 0,
      decisionId: exit.decisionId,
      decisionRole: "exit"
    });
    const link = getDb().prepare(`
      SELECT decision_id, decision_role
      FROM paper_review_decisions
      WHERE artifact_id = 'artifact-exit-1'
    `).get() as { decision_id: string; decision_role: string };
    assert.equal(link.decision_id, exit.decisionId);
    assert.equal(link.decision_role, "exit");
  });
});
