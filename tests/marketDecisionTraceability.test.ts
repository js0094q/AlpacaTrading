import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

const testRoot = mkdtempSync(join(tmpdir(), "alpaca-decision-traceability-test-"));
process.env.RESEARCH_DB_PATH = join(testRoot, "research.db");
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

const [
  libDb,
  identityService,
  candidateRankingService,
  paperTradeService,
  executionLedgerService,
  databaseMaintenanceService
] =
  await Promise.all([
    import("../src/lib/db.js"),
    import("../src/services/marketDecisionIdentityService.js"),
    import("../src/services/candidateRankingService.js"),
    import("../src/services/paperTradeService.js"),
    import("../src/services/paperExecutionLedgerService.js"),
    import("../src/services/databaseMaintenanceService.js")
  ]);

const { closeDbForTests, getDb, runPhase1BMigrations } = libDb;
const { isDecisionId, isPositionLifecycleId } = identityService;
const { persistCandidateDecisions } = candidateRankingService;
const { buildPaperTradePlans } = paperTradeService;
const { insertPaperExecutionLedgerEntry } = executionLedgerService;
const { verifyDatabaseSchema } = databaseMaintenanceService;

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), `
    DELETE FROM paper_position_outcome_revisions;
    DELETE FROM paper_position_outcomes;
    DELETE FROM paper_position_observation_links;
    DELETE FROM paper_position_observations;
    DELETE FROM paper_positions;
    DELETE FROM paper_review_decisions;
    DELETE FROM decision_lifecycle_events;
    DELETE FROM decision_snapshots;
    DELETE FROM paper_execution_ledger;
    DELETE FROM paper_trade_evaluations;
    DELETE FROM paper_trade_plans;
    DELETE FROM paper_trade_candidates;
    DELETE FROM research_runs;
    DELETE FROM target_snapshots;
  `);
};

const insertResearchRun = (id: string) => {
  getDb().prepare(`
    INSERT INTO research_runs(
      id, started_at, completed_at, status, risk_profile, options_enabled,
      universe_size, targets_generated, candidates_selected, config_json
    ) VALUES (?, ?, ?, 'completed', 'moderate', 0, 1, 1, 1, '{}')
  `).run(id, "2026-07-13T15:00:00.000Z", "2026-07-13T15:01:00.000Z");
};

const decisionFixture = (candidateId: string) => ({
  id: candidateId,
  symbol: "AAPL",
  asOf: "2026-07-13T15:00:00.000Z",
  rank: 1,
  direction: "long" as const,
  horizon: "5d" as const,
  riskProfile: "moderate" as const,
  preferredExpression: "shares" as const,
  score: 82,
  confidence: 0.78,
  expectedReturn: 0.04,
  estimatedMaxLoss: 10,
  estimatedMaxProfit: 20,
  rationale: ["Trend confirmed"],
  relevantBacktestRunId: null,
  historicalWinRate: null,
  historicalAvgReturn: null,
  historicalMaxDrawdown: null,
  similarSetupCount: null,
  optionLiquidityScore: null,
  volatilityAdjustedScore: 80,
  signalFreshnessDays: 0,
  recentLearningAdjustment: 0,
  directionalAccuracy: null,
  optionOutperformanceAccuracy: null,
  optionSymbol: null,
  strike: null,
  shortStrike: null,
  decision: "selected" as const,
  decisionReason: "RANKED_SELECTED",
  strategyFamily: "shares",
  signalInputs: { close: 200 },
  dataQualityStatus: "COMPLETE"
});

beforeEach(resetDatabase);

after(() => {
  closeDbForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("Phase 1B decision identity migration", () => {
  test("migrates legacy linkage exactly and remains idempotent", () => {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(`
      CREATE TABLE paper_trade_candidates(id TEXT PRIMARY KEY);
      CREATE TABLE paper_trade_plans(id TEXT PRIMARY KEY, candidate_id TEXT);
      CREATE TABLE paper_trade_evaluations(id TEXT PRIMARY KEY, candidate_id TEXT);
      CREATE TABLE paper_execution_ledger(id INTEGER PRIMARY KEY, source_candidate_id TEXT);
      CREATE TABLE paper_learning_records(id TEXT PRIMARY KEY, source_candidate_id TEXT);
      CREATE TABLE paper_review_artifacts(id TEXT PRIMARY KEY);
      CREATE TABLE hedge_execution_reviews(review_id TEXT PRIMARY KEY);
      CREATE TABLE hedge_learning_events(event_id TEXT PRIMARY KEY);

      INSERT INTO paper_trade_candidates(id) VALUES ('candidate-exact');
      INSERT INTO paper_trade_plans(id, candidate_id) VALUES ('plan-exact', 'candidate-exact');
      INSERT INTO paper_trade_evaluations(id, candidate_id) VALUES ('eval-exact', 'candidate-exact');
      INSERT INTO paper_execution_ledger(id, source_candidate_id) VALUES (1, 'candidate-exact');
      INSERT INTO paper_execution_ledger(id, source_candidate_id) VALUES (2, 'synthetic:unknown');
      INSERT INTO paper_learning_records(id, source_candidate_id) VALUES ('learn-exact', 'candidate-exact');
      INSERT INTO paper_learning_records(id, source_candidate_id) VALUES ('learn-unknown', 'synthetic:unknown');
    `);

    runPhase1BMigrations(legacy);
    runPhase1BMigrations(legacy);

    const migration = legacy.prepare(`
      SELECT COUNT(*) AS count
      FROM schema_migrations
      WHERE version = '2026-07-13-market-observatory-phase-1b'
    `).get() as { count: number };
    assert.equal(migration.count, 1);

    const candidate = legacy.prepare(
      "SELECT decision_id, decision_linkage_status FROM paper_trade_candidates WHERE id = 'candidate-exact'"
    ).get() as { decision_id: string | null; decision_linkage_status: string };
    assert.equal(candidate.decision_id, "candidate-exact");
    assert.equal(candidate.decision_linkage_status, "EXACT_LEGACY_REUSE");

    for (const table of ["paper_trade_plans", "paper_trade_evaluations"]) {
      const row = legacy.prepare(
        `SELECT decision_id, decision_linkage_status FROM ${table} LIMIT 1`
      ).get() as { decision_id: string | null; decision_linkage_status: string };
      assert.equal(row.decision_id, "candidate-exact");
      assert.equal(row.decision_linkage_status, "EXACT_LEGACY_REUSE");
    }

    const exactLedger = legacy.prepare(
      "SELECT decision_id, decision_linkage_status FROM paper_execution_ledger WHERE id = 1"
    ).get() as { decision_id: string | null; decision_linkage_status: string };
    const unknownLedger = legacy.prepare(
      "SELECT decision_id, decision_linkage_status FROM paper_execution_ledger WHERE id = 2"
    ).get() as { decision_id: string | null; decision_linkage_status: string };
    assert.equal(exactLedger.decision_id, "candidate-exact");
    assert.equal(exactLedger.decision_linkage_status, "EXACT_LEGACY_REUSE");
    assert.equal(unknownLedger.decision_id, null);
    assert.equal(unknownLedger.decision_linkage_status, "LEGACY_UNLINKED");

    const integrity = legacy.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    assert.equal(integrity.integrity_check, "ok");
    legacy.close();
  });

  test("new candidates receive a distinct stable decision ID that plans preserve", () => {
    insertResearchRun("run-distinct-id");
    getDb().prepare(`
      INSERT INTO target_snapshots(
        symbol, as_of, direction, horizon, entry_reference, upside_target,
        downside_risk, confidence, risk_profile, preferred_expression, rationale
      ) VALUES ('AAPL', ?, 'long', '5d', 200, 220, 190, 0.78, 'moderate', 'shares', '[]')
    `).run("2026-07-13T15:00:00.000Z");

    const candidateId = "candidate-new";
    persistCandidateDecisions({
      researchRunId: "run-distinct-id",
      decisions: [decisionFixture(candidateId)]
    });
    const first = getDb().prepare(
      "SELECT decision_id FROM paper_trade_candidates WHERE id = ?"
    ).get(candidateId) as { decision_id: string };

    persistCandidateDecisions({
      researchRunId: "run-distinct-id",
      decisions: [decisionFixture(candidateId)]
    });
    const second = getDb().prepare(
      "SELECT decision_id FROM paper_trade_candidates WHERE id = ?"
    ).get(candidateId) as { decision_id: string };

    assert.notEqual(first.decision_id, candidateId);
    assert.equal(second.decision_id, first.decision_id);
    assert.equal(isDecisionId(first.decision_id), true);

    const plans = buildPaperTradePlans({
      researchRunId: "run-distinct-id",
      candidates: [decisionFixture(candidateId)],
      riskProfile: "moderate"
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.decisionId, first.decision_id);

    const storedPlan = getDb().prepare(
      "SELECT decision_id, decision_linkage_status FROM paper_trade_plans WHERE id = ?"
    ).get(plans[0]?.id) as {
      decision_id: string;
      decision_linkage_status: string;
    };
    assert.equal(storedPlan.decision_id, first.decision_id);
    assert.equal(storedPlan.decision_linkage_status, "EXACT");
  });

  test("decision and position lifecycle validators accept only UUID identities", () => {
    assert.equal(isDecisionId("ee31f098-5241-4d05-9443-1959fc57857b"), true);
    assert.equal(isDecisionId("candidate-new"), false);
    assert.equal(isPositionLifecycleId("b33a22de-1f20-4d15-b451-c084ba8e62b1"), true);
    assert.equal(isPositionLifecycleId("position:legacy"), false);
  });

  test("execution ledger resolves exact candidate lineage without symbol inference", () => {
    insertResearchRun("run-ledger-link");
    persistCandidateDecisions({
      researchRunId: "run-ledger-link",
      decisions: [decisionFixture("candidate-ledger-link")]
    });
    const candidate = getDb().prepare(
      "SELECT decision_id FROM paper_trade_candidates WHERE id = 'candidate-ledger-link'"
    ).get() as { decision_id: string };

    const linked = insertPaperExecutionLedgerEntry({
      mode: "test",
      assetClass: "equity",
      symbol: "AAPL",
      dedupeKey: "decision-link-exact",
      clientOrderId: "decision-link-exact",
      status: "built",
      sourceCandidateId: "candidate-ledger-link",
      payload: { symbol: "AAPL" }
    });
    const unlinked = insertPaperExecutionLedgerEntry({
      mode: "test",
      assetClass: "equity",
      symbol: "AAPL",
      dedupeKey: "decision-link-unknown",
      clientOrderId: "decision-link-unknown",
      status: "built",
      sourceCandidateId: "synthetic:unknown",
      payload: { symbol: "AAPL" }
    });

    assert.equal(linked.decisionId, candidate.decision_id);
    assert.equal(linked.decisionLinkageStatus, "EXACT");
    assert.equal(unlinked.decisionId, null);
    assert.equal(unlinked.decisionLinkageStatus, "LEGACY_UNLINKED");
  });

  test("database verification reports migration, schema, indexes, and integrity", () => {
    const report = verifyDatabaseSchema({ db: getDb(), databasePath: "test.db" });
    assert.equal(report.ok, true);
    assert.equal(report.integrity, "ok");
    assert.equal(report.migrationApplied, true);
    assert.deepEqual(report.missingTables, []);
    assert.deepEqual(report.missingColumns, []);
    assert.deepEqual(report.missingIndexes, []);
  });

  test("SQLite schema verification remains test-only and has no runtime command", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    assert.equal(packageJson.scripts["db:migrate"], undefined);
    assert.equal(packageJson.scripts["db:verify"], undefined);
    assert.match(
      packageJson.scripts.pretest,
      /tests\/marketDecisionTraceability\.test\.ts/
    );
  });
});
