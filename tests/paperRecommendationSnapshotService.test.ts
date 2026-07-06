import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSqliteTestDb } from "./helpers/sqliteTestDb.js";

process.env.RESEARCH_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "alpaca-snapshots-test-")),
  "research.db"
);
process.env.TRADING_MODE = "paper";
process.env.ALPACA_LIVE_TRADE = "false";
process.env.LIVE_TRADING_ENABLED = "false";
process.env.ALPACA_ENV = "paper";
process.env.ENABLE_AGGRESSIVE_PAPER_STRATEGIES = "true";

import { closeDbForTests, getDb } from "../src/lib/db.js";
import {
  listPaperRecommendationSnapshots,
  formatPaperRecommendationSnapshotsAsTable
} from "../src/services/paperRecommendationSnapshotService.js";
import { getTradingSafetyState } from "../src/services/tradingSafetyService.js";

const resetDatabase = () => {
  resetSqliteTestDb(getDb(), "DELETE FROM paper_recommendation_snapshots;");
};

beforeEach(() => {
  resetDatabase();
});

after(() => {
  const path = process.env.RESEARCH_DB_PATH!;
  closeDbForTests();
  rmSync(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
});

interface SeedInput {
  runId: string;
  source?: string;
  groupBy?: string;
  groupKey: string;
  createdAt: string;
  candidateCount?: number;
  evaluatedCount?: number;
  unevaluatedCount?: number;
  winRate?: number;
  avgReturnPct?: number;
  medianReturnPct?: number;
  bestReturnPct?: number;
  worstReturnPct?: number;
  avgRank?: number;
  recommendationFlag?: string;
}

const insertSnapshot = ({
  runId,
  source = "paper:analytics",
  groupBy = "symbol",
  groupKey,
  createdAt,
  candidateCount = 10,
  evaluatedCount = 8,
  unevaluatedCount = 2,
  winRate = 0.66,
  avgReturnPct = 1.5,
  medianReturnPct = 1.0,
  bestReturnPct = 2.0,
  worstReturnPct = 0.2,
  avgRank = 4,
  recommendationFlag = "KEEP_MONITORING"
}: SeedInput) => {
  getDb()
    .prepare(
      `
      INSERT INTO paper_recommendation_snapshots(
        snapshot_run_id,
        created_at,
        source,
        group_by,
        group_key,
        filters_json,
        candidate_count,
        evaluated_count,
        unevaluated_count,
        win_rate,
        avg_return_pct,
        median_return_pct,
        best_return_pct,
        worst_return_pct,
        avg_rank,
        recommendation_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      runId,
      createdAt,
      source,
      groupBy,
      groupKey,
      JSON.stringify({ groupBy }),
      candidateCount,
      evaluatedCount,
      unevaluatedCount,
      winRate,
      avgReturnPct,
      medianReturnPct,
      bestReturnPct,
      worstReturnPct,
      avgRank,
      recommendationFlag
    );
};

describe("paper recommendation snapshots service", () => {
  test("returns most recent snapshots by default", () => {
    insertSnapshot({
      runId: "run-old",
      groupKey: "AAPL",
      createdAt: "2026-01-01T12:00:00.000Z"
    });
    insertSnapshot({
      runId: "run-mid",
      groupKey: "MSFT",
      createdAt: "2026-01-02T12:00:00.000Z"
    });
    insertSnapshot({
      runId: "run-new",
      groupKey: "TSLA",
      createdAt: "2026-01-03T12:00:00.000Z"
    });

    const rows = listPaperRecommendationSnapshots({ limit: 2 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].snapshotRunId, "run-new");
    assert.equal(rows[1].snapshotRunId, "run-mid");
    assert.equal(rows[0].snapshotSource, "paper:analytics");
    assert.equal(rows[1].snapshotSource, "paper:analytics");
  });

  test("filters by symbol", () => {
    insertSnapshot({
      runId: "run-aapl",
      groupKey: "AAPL",
      createdAt: "2026-01-01T12:00:00.000Z"
    });
    insertSnapshot({
      runId: "run-msft",
      groupKey: "MSFT",
      groupBy: "symbol",
      createdAt: "2026-01-02T12:00:00.000Z"
    });

    const rows = listPaperRecommendationSnapshots({ symbol: "AAPL" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].symbol, "AAPL");
    assert.equal(rows[0].snapshotRunId, "run-aapl");
  });

  test("filters by run ID", () => {
    insertSnapshot({
      runId: "run-filter",
      groupKey: "AAPL",
      createdAt: "2026-01-01T12:00:00.000Z"
    });
    insertSnapshot({
      runId: "run-other",
      groupKey: "AAPL",
      createdAt: "2026-01-02T12:00:00.000Z"
    });

    const rows = listPaperRecommendationSnapshots({ runId: "run-filter" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].snapshotRunId, "run-filter");
  });

  test("filters by date range", () => {
    insertSnapshot({
      runId: "run-day1",
      groupKey: "AAPL",
      createdAt: "2026-01-01T09:00:00.000Z"
    });
    insertSnapshot({
      runId: "run-day2",
      groupKey: "AAPL",
      createdAt: "2026-01-02T09:00:00.000Z"
    });
    insertSnapshot({
      runId: "run-day3",
      groupKey: "AAPL",
      createdAt: "2026-01-03T09:00:00.000Z"
    });

    const rows = listPaperRecommendationSnapshots({
      from: "2026-01-02",
      to: "2026-01-02"
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].snapshotRunId, "run-day2");
  });

  test("produces stable JSON payload shape for snapshot history", () => {
    insertSnapshot({
      runId: "run-json",
      groupKey: "AAPL",
      createdAt: "2026-01-01T09:00:00.000Z",
      avgRank: 2
    });

    const rows = listPaperRecommendationSnapshots({ runId: "run-json", symbol: "AAPL" });
    const payload = {
      paperOnly: true,
      environment: getTradingSafetyState().alpacaEnv,
      snapshots: rows
    };

    const parsed = JSON.parse(JSON.stringify(payload));
    assert.equal(parsed.paperOnly, true);
    assert.equal(parsed.environment, "paper");
    assert.equal(Array.isArray(parsed.snapshots), true);
    assert.equal(parsed.snapshots[0].snapshotId > 0, true);
    assert.equal(parsed.snapshots[0].snapshotSource, "paper:analytics");
    assert.equal(parsed.snapshots[0].candidateMetadata.recommendationFlag, "KEEP_MONITORING");
  });

  test("returns table output and empty-state behavior", () => {
    assert.equal(listPaperRecommendationSnapshots().length, 0);
    const output = formatPaperRecommendationSnapshotsAsTable(listPaperRecommendationSnapshots());
    assert.equal(output, "No persisted recommendation snapshots found.");
  });
});
