import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-universe-lifecycle-test-")),
  "research.db"
);
process.env.ALPACA_ENV = "paper";
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";

const [libDb, universeService, lifecycleService] = await Promise.all([
  import("../src/lib/db.js"),
  import("../src/services/universeService.js"),
  import("../src/services/universeLifecycleService.js")
]);

const { closeDbForTests, getDb } = libDb;
const {
  getActiveSymbols,
  getObservableSymbols,
  getUniverseSymbol,
  refreshUniverseAssetMetadata
} = universeService;
const { runAutonomousUniverseLifecycle } = lifecycleService;

const nowIso = "2026-07-14T20:30:00.000Z";
const now = () => new Date(nowIso);

const basePolicy = {
  configVersion: "test-v1",
  discoveryScanLimit: 5,
  discoveryMaxNewSymbols: 2,
  assessmentMaxSymbols: 80,
  historicalRefreshMaxSymbols: 0,
  approvedExchanges: ["NASDAQ", "NYSE"],
  minimumPrice: 5,
  minimumDailyDollarVolume: 1_000,
  maximumSpreadPct: 1,
  minimumHistoryBars: 2,
  minimumGoodObservations: 1,
  maximumObservationAgeHours: 36,
  requiredResearchSelections: 1,
  requireOptions: false,
  maximumDataFailures: 3,
  maximumExecutionFailures: 3,
  maximumUnderperformingOutcomes: 3,
  suspensionRetirementDays: 30
};

const asset = (symbol: string) => ({
  id: "asset-" + symbol,
  class: "us_equity",
  exchange: "NASDAQ",
  symbol,
  status: "active",
  tradable: true,
  marginable: true,
  shortable: true,
  fractionable: true,
  attributes: ["has_options"]
});

const runLifecycle = async (
  assets: Array<ReturnType<typeof asset>>,
  policy: Partial<typeof basePolicy> = {}
) =>
  runAutonomousUniverseLifecycle({
    listAssets: async () => assets,
    ingestBars: async () => ({ runId: 1, rowsIngested: 0 }),
    now,
    getGitSha: () => "test-git-sha",
    policy: { ...basePolicy, ...policy }
  });

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), [
    "DELETE FROM universe_lifecycle_events;",
    "DELETE FROM universe_lifecycle_runs;",
    "DELETE FROM paper_position_outcome_revisions;",
    "DELETE FROM paper_position_outcomes;",
    "DELETE FROM paper_position_observation_links;",
    "DELETE FROM paper_position_observations;",
    "DELETE FROM paper_positions;",
    "DELETE FROM paper_execution_ledger;",
    "DELETE FROM paper_learning_records;",
    "DELETE FROM paper_trade_evaluations;",
    "DELETE FROM paper_trade_plans;",
    "DELETE FROM paper_trade_candidates;",
    "DELETE FROM research_runs;",
    "DELETE FROM market_bars;",
    "DELETE FROM stock_snapshots;",
    "DELETE FROM ingestion_runs;",
    "DELETE FROM universe_symbols;"
  ].join("\n"));
};

const insertUniverse = (symbol: string, state: string, enteredAt = nowIso) => {
  getDb().prepare(
    "INSERT INTO universe_symbols(" +
      "symbol, asset_class, enabled, source, tradable, asset_status, exchange, " +
      "options_enabled, created_at, updated_at, lifecycle_state, " +
      "lifecycle_reason_code, lifecycle_entered_at, lifecycle_updated_at, " +
      "lifecycle_config_version" +
    ") VALUES (?, 'stock', ?, 'test', 1, 'active', 'NASDAQ', 1, ?, ?, ?, " +
      "'TEST_SEED', ?, ?, 'test-v1')"
  ).run(
    symbol,
    ["research_eligible", "paper_eligible", "paper_active"].includes(state) ? 1 : 0,
    nowIso,
    nowIso,
    state,
    enteredAt,
    enteredAt
  );
};

const insertDailyBars = (symbol: string) => {
  const insert = getDb().prepare(
    "INSERT INTO market_bars(symbol, timeframe, timestamp, open, high, low, close, volume, source) " +
      "VALUES (?, '1Day', ?, 99, 101, 98, 100, 1000, 'alpaca')"
  );
  insert.run(symbol, "2026-07-11T04:00:00.000Z");
  insert.run(symbol, "2026-07-14T04:00:00.000Z");
};

const insertSnapshot = (symbol: string, status = "COMPLETE") => {
  getDb().prepare(
    "INSERT INTO stock_snapshots(" +
      "symbol, observed_at, source_timestamp, requested_feed, effective_feed, " +
      "latest_trade_conditions_json, quote_conditions_json, latest_trade_price, " +
      "daily_close, daily_volume, spread_pct, freshness_status, " +
      "data_quality_status, source, error_summary" +
    ") VALUES (?, ?, ?, 'iex', 'iex', '[]', '[]', 100, 100, 1000, 0.1, " +
      "'FRESH', ?, 'alpaca', ?)"
  ).run(
    symbol,
    nowIso,
    nowIso + "-" + status + "-" + crypto.randomUUID(),
    status,
    status === "SOURCE_ERROR" ? "SOURCE_ERROR" : null
  );
};

const insertSelectedCandidate = (symbol: string) => {
  getDb().prepare(
    "INSERT INTO research_runs(" +
      "id, started_at, completed_at, status, risk_profile, options_enabled, " +
      "universe_size, targets_generated, candidates_selected, config_json" +
    ") VALUES ('run-1', ?, ?, 'completed', 'moderate', 0, 1, 1, 1, '{}')"
  ).run(nowIso, nowIso);
  getDb().prepare(
    "INSERT INTO paper_trade_candidates(" +
      "id, research_run_id, symbol, as_of, rank, direction, horizon, risk_profile, " +
      "preferred_expression, score, confidence, rationale, decision, data_quality_status" +
    ") VALUES ('candidate-1', 'run-1', ?, ?, 1, 'long', '1d', 'moderate', " +
      "'shares', 10, 0.8, '[]', 'selected', 'COMPLETE')"
  ).run(symbol, nowIso);
};

const insertOpenPosition = (symbol: string) => {
  getDb().exec("PRAGMA foreign_keys = OFF;");
  try {
    getDb().prepare(
      "INSERT INTO paper_positions(" +
        "position_lifecycle_id, entry_decision_id, symbol, asset_class, side, " +
        "entry_client_order_id, status, opened_at, linkage_status, created_at, updated_at" +
      ") VALUES ('position-1', 'decision-1', ?, 'equity', 'long', 'client-1', " +
        "'OPEN', ?, 'EXACT', ?, ?)"
    ).run(symbol, nowIso, nowIso, nowIso);
  } finally {
    getDb().exec("PRAGMA foreign_keys = ON;");
  }
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

describe("autonomous universe lifecycle", () => {
  test("discovers a bounded asset, records provenance, and admits it only to observation", async () => {
    const result = await runLifecycle([
      asset("LIFE"),
      asset("NEXT"),
      asset("THIRD")
    ], {
      discoveryScanLimit: 2,
      discoveryMaxNewSymbols: 1
    });

    const row = getUniverseSymbol("LIFE");
    const events = getDb().prepare(
      "SELECT to_state, reason_code, git_sha, config_version, config_hash " +
        "FROM universe_lifecycle_events WHERE symbol = ? ORDER BY occurred_at, id"
    ).all("LIFE") as Array<Record<string, string>>;

    assert.equal(result.discovery.scanned, 2);
    assert.equal(result.discovery.discovered, 1);
    assert.equal(row?.lifecycleState, "observe_only");
    assert.equal(row?.enabled, 0);
    assert.equal(getObservableSymbols().includes("LIFE"), true);
    assert.equal(getActiveSymbols().includes("LIFE"), false);
    assert.deepEqual(events.map((event) => event.to_state), ["discovered", "observe_only"]);
    assert.equal(events[0]?.reason_code, "DISCOVERED_FROM_ALPACA");
    assert.equal(events[0]?.git_sha, "test-git-sha");
    assert.equal(events[0]?.config_version, "test-v1");
    assert.equal(typeof events[0]?.config_hash, "string");

    await refreshUniverseAssetMetadata({
      symbols: ["LIFE"],
      maxAgeMs: 0,
      getAsset: async () => asset("LIFE")
    });
    assert.equal(getUniverseSymbol("LIFE")?.lifecycleState, "observe_only");
    assert.equal(getUniverseSymbol("LIFE")?.enabled, 0);
  });

  test("promotes qualified research evidence to paper eligibility and tracks reconciled activity", async () => {
    await runLifecycle([asset("QUAL")]);
    insertDailyBars("QUAL");
    insertSnapshot("QUAL");
    insertSelectedCandidate("QUAL");

    await runLifecycle([asset("QUAL")]);
    assert.equal(getUniverseSymbol("QUAL")?.lifecycleState, "paper_eligible");
    assert.equal(getActiveSymbols().includes("QUAL"), true);

    insertOpenPosition("QUAL");
    await runLifecycle([asset("QUAL")]);
    assert.equal(getUniverseSymbol("QUAL")?.lifecycleState, "paper_active");

    getDb().prepare(
      "UPDATE paper_positions SET status = 'CLOSED', closed_at = ? WHERE position_lifecycle_id = 'position-1'"
    ).run(nowIso);
    await runLifecycle([asset("QUAL")]);
    assert.equal(getUniverseSymbol("QUAL")?.lifecycleState, "paper_eligible");
  });

  test("suspends repeated data failures and recovers through observation after valid evidence returns", async () => {
    insertUniverse("RECOVER", "research_eligible");
    insertSnapshot("RECOVER", "SOURCE_ERROR");
    insertSnapshot("RECOVER", "SOURCE_ERROR");
    insertSnapshot("RECOVER", "SOURCE_ERROR");

    await runLifecycle([asset("RECOVER")]);
    assert.equal(getUniverseSymbol("RECOVER")?.lifecycleState, "suspended");
    assert.equal(getActiveSymbols().includes("RECOVER"), false);

    getDb().prepare("DELETE FROM stock_snapshots WHERE symbol = 'RECOVER'").run();
    insertDailyBars("RECOVER");
    insertSnapshot("RECOVER");
    await runLifecycle([asset("RECOVER")]);

    assert.equal(getUniverseSymbol("RECOVER")?.lifecycleState, "observe_only");
    assert.equal(getObservableSymbols().includes("RECOVER"), true);
  });

  test("recovers an interrupted lifecycle run before continuing", async () => {
    getDb().prepare(
      "INSERT INTO universe_lifecycle_runs(" +
        "id, started_at, status, git_sha, config_version, config_hash" +
      ") VALUES ('interrupted-run', ?, 'running', 'prior-git', 'prior-v1', 'prior-hash')"
    ).run(nowIso);

    await runLifecycle([]);

    const recovered = getDb().prepare(
      "SELECT status, error_summary FROM universe_lifecycle_runs WHERE id = 'interrupted-run'"
    ).get() as { status: string; error_summary: string | null };
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error_summary, "RECOVERED_INCOMPLETE_RUN");
  });

  test("retires a persistent suspended symbol that remains outside the active Alpaca inventory", async () => {
    insertUniverse("RETIRED", "suspended", "2026-06-01T20:30:00.000Z");

    await runLifecycle([]);

    const row = getUniverseSymbol("RETIRED");
    const event = getDb().prepare(
      "SELECT reason_code FROM universe_lifecycle_events WHERE symbol = ? ORDER BY occurred_at DESC, id DESC LIMIT 1"
    ).get("RETIRED") as { reason_code: string };

    assert.equal(row?.lifecycleState, "retired");
    assert.equal(row?.enabled, 0);
    assert.equal(event.reason_code, "SUSPENSION_RETIREMENT_THRESHOLD");
  });
});
