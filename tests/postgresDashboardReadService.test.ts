import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  readPostgresWorkerHealth,
  readPostgresZeroDteDashboardSummary,
  type PostgresDashboardQuery
} from "../src/services/postgresDashboardReadService.js";

const queryFor = (rowsFor: (sql: string) => Record<string, unknown>[]) => {
  const query: PostgresDashboardQuery = {
    query: async (sql) => ({ rows: rowsFor(sql), rowCount: 1 })
  };
  return query;
};

describe("PostgreSQL dashboard read services", () => {
  test("reports a recent completed worker cycle as running", async () => {
    const health = await readPostgresWorkerHealth(queryFor((sql) => {
      assert.match(sql, /workstream = 'autonomous_worker'/);
      return [{
        event_type: "cycle_completed",
        entity_id: "cycle-1",
        occurred_at: new Date("2026-07-22T15:00:00.000Z"),
        last_cycle_completed_at: new Date("2026-07-22T15:00:00.000Z")
      }];
    }), new Date("2026-07-22T15:01:00.000Z"));

    assert.deepEqual(health, {
      status: "running",
      active: true,
      lastEventType: "cycle_completed",
      lastEventAt: "2026-07-22T15:00:00.000Z",
      cycleId: "cycle-1",
      lastCycleCompletedAt: "2026-07-22T15:00:00.000Z"
    });
  });

  test("does not turn a stopped or stale persisted worker state into active health", async () => {
    const stopped = await readPostgresWorkerHealth(queryFor(() => [{
      event_type: "worker_stopped",
      entity_id: "cycle-1",
      occurred_at: "2026-07-22T15:00:00.000Z",
      last_cycle_completed_at: "2026-07-22T14:00:00.000Z"
    }]), new Date("2026-07-22T15:01:00.000Z"));
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.active, false);

    const stale = await readPostgresWorkerHealth(queryFor(() => [{
      event_type: "cycle_completed",
      entity_id: "cycle-old",
      occurred_at: "2026-07-22T00:00:00.000Z",
      last_cycle_completed_at: "2026-07-22T00:00:00.000Z"
    }]), new Date("2026-07-22T15:01:00.000Z"));
    assert.equal(stale.status, "stale");
    assert.equal(stale.active, false);
  });

  test("returns a PostgreSQL-backed blocked 0DTE result when no current candidates exist", async () => {
    const summary = await readPostgresZeroDteDashboardSummary({
      query: queryFor(() => []),
      now: new Date("2026-07-22T15:00:00.000Z"),
      limit: 25
    });

    assert.equal(summary.paperOnly, true);
    assert.equal(summary.tradingDate, "2026-07-22");
    assert.equal(summary.engine.status, "blocked");
    assert.deepEqual(summary.queue, []);
    assert.deepEqual(summary.blockers, ["NO_CURRENT_POSTGRES_ZERO_DTE_CANDIDATES"]);
  });

  test("preserves a blocked PostgreSQL strategy decision as domain data", async () => {
    const summary = await readPostgresZeroDteDashboardSummary({
      query: queryFor((sql) => {
        if (sql.includes("FROM candidates candidate")) {
          return [{
            candidate_id: "candidate-1",
            rank: 1,
            option_symbol: "SPY260722C00500000",
            direction: "long",
            decision: "blocked",
            lifecycle_status: "blocked",
            score: "80",
            confidence: "0.8",
            signal_inputs: {},
            rationale: {},
            data_quality_status: "CURRENT_POSTGRES_MARKET_EVIDENCE",
            updated_at: "2026-07-22T14:59:00.000Z",
            expiration_date: "2026-07-22",
            strike: "500",
            bid: "1.1",
            ask: "1.3",
            midpoint: "1.2",
            volume: "100",
            open_interest: "200",
            quote_timestamp: "2026-07-22T14:58:00.000Z",
            observed_at: "2026-07-22T14:58:00.000Z"
          }];
        }
        return [];
      }),
      now: new Date("2026-07-22T15:00:00.000Z"),
      limit: 25
    });

    assert.equal(summary.engine.status, "blocked");
    assert.equal(summary.queue.length, 1);
    assert.deepEqual(summary.queue[0]?.blockers, ["STRATEGY_DECISION_BLOCKED", "CANDIDATE_LIFECYCLE_BLOCKED"]);
  });
});
