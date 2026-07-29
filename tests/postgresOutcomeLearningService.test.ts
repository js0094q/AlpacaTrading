import assert from "node:assert/strict";
import test from "node:test";

import type { SchedulerFence } from "../src/repositories/contracts/common.js";
import {
  OUTCOME_CANDIDATE_SOURCE_SQL,
  OUTCOME_EXCURSION_LOOKUP_SQL,
  OUTCOME_REFERENCE_LOOKUP_SQL,
  parseOutcomeLearningWindow,
  readBoundedHistoricalOutcomeAggregates,
  readBoundedOutcomeLearningRecords,
  runPostgresOutcomeLearningRefresh,
  type OutcomeLearningQueryExecutor
} from "../src/services/postgresOutcomeLearningService.js";

const fence: SchedulerFence = {
  jobName: "learning",
  workstream: "learning",
  ownerId: "worker-1",
  runId: "scheduler-run-1",
  fencingToken: "9"
};

const candidate = (id: string, symbol = "AAPL") => ({
  id,
  research_run_id: "research-1",
  symbol,
  underlying_symbol: symbol,
  option_symbol: null,
  asset_class: "equity",
  as_of: "2026-07-28T14:00:00.000Z",
  strategy_family: "equity",
  score: "80",
  confidence: "0.75",
  decision: "selected",
  lifecycle_status: "reviewed",
  decision_reason: "MOMENTUM_CONFIRMED",
  rationale: ["bounded fixture"],
  signal_inputs: {},
  option_liquidity_score: null,
  option_contract_id: null,
  contract_multiplier: null,
  updated_at: "2026-07-28T14:00:01.000Z"
});

const mockQuery = (options: {
  existingRefresh?: boolean;
  fenceHeld?: boolean;
  candidates?: Record<string, unknown>[];
} = {}) => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const writtenOutcomes: Record<string, unknown>[] = [];
  const writtenAggregates: Record<string, unknown>[] = [];
  const query: OutcomeLearningQueryExecutor = {
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.includes("FROM candidates candidate")) {
        return {
          rows: options.candidates ?? [candidate("candidate-1"), candidate("candidate-2", "MSFT")],
          rowCount: options.candidates?.length ?? 2
        };
      }
      if (sql.includes("FROM portfolio_arbitration_decisions ")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM execution_reviews ")) {
        return {
          rows: [{
            id: "review-1",
            candidate_id: "candidate-1",
            review_type: "entry",
            environment: "paper",
            status: "valid",
            market_evidence: [],
            warnings: [],
            blockers: [],
            created_at: "2026-07-28T14:00:10.000Z",
            updated_at: "2026-07-28T14:00:10.000Z"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM order_intents ")) {
        return {
          rows: [{
            id: "intent-1",
            candidate_id: "candidate-1",
            review_id: "review-1",
            client_order_id: "client-1",
            status: "submitted",
            quantity: "1",
            parent_position_id: null,
            created_at: "2026-07-28T14:00:20.000Z",
            submitted_at: "2026-07-28T14:00:30.000Z",
            updated_at: "2026-07-28T14:00:30.000Z"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM orders ")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM broker_events ")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM positions ")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM research_signals ")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH reference_events AS")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH outcome_windows AS")) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("FROM outcome_learning_refresh_runs") &&
        sql.includes("source_fingerprint")
      ) {
        return options.existingRefresh
          ? {
              rows: [{
                id: "existing-refresh",
                status: "completed",
                source_record_count: "2",
                outcome_record_count: "2",
                aggregate_record_count: "10",
                source_truncated: false
              }],
              rowCount: 1
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO outcome_learning_refresh_runs")) {
        return {
          rows: [{ fence_held: options.fenceHeld !== false, affected_count: options.fenceHeld === false ? 0 : 1 }],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO outcome_learning_records")) {
        writtenOutcomes.push(...JSON.parse(String(values[0])));
        return {
          rows: [{
            fence_held: options.fenceHeld !== false,
            affected_count: options.fenceHeld === false ? 0 : writtenOutcomes.length
          }],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO historical_outcome_aggregates")) {
        const rows = JSON.parse(String(values[0])) as Record<string, unknown>[];
        writtenAggregates.push(...rows);
        return {
          rows: [{
            fence_held: options.fenceHeld !== false,
            affected_count: options.fenceHeld === false ? 0 : rows.length
          }],
          rowCount: 1
        };
      }
      if (sql.includes("UPDATE outcome_learning_refresh_runs")) {
        return {
          rows: [{ fence_held: options.fenceHeld !== false, affected_count: options.fenceHeld === false ? 0 : 1 }],
          rowCount: 1
        };
      }
      throw new Error(`UNEXPECTED_SQL:${sql.slice(0, 100)}`);
    }
  };
  return { query, calls, writtenOutcomes, writtenAggregates };
};

test("manual backfill bounds are explicit, finite, ordered, and capped", () => {
  assert.deepEqual(
    parseOutcomeLearningWindow({
      mode: "backfill",
      start: "2026-07-28T00:00:00Z",
      end: "2026-07-29T00:00:00Z",
      maxRecords: "250",
      now: new Date("2026-07-29T12:00:00Z")
    }),
    {
      start: "2026-07-28T00:00:00.000Z",
      end: "2026-07-29T00:00:00.000Z",
      maxRecords: 250
    }
  );
  for (const invalid of [
    { mode: "backfill" as const },
    {
      mode: "backfill" as const,
      start: "2026-07-28T00:00:00Z"
    },
    {
      mode: "backfill" as const,
      start: "invalid",
      end: "2026-07-29T00:00:00Z"
    },
    {
      mode: "backfill" as const,
      start: "2026-07-29T00:00:00Z",
      end: "2026-07-28T00:00:00Z"
    },
    {
      mode: "backfill" as const,
      start: "2026-01-01T00:00:00Z",
      end: "2026-07-29T00:00:00Z"
    },
    {
      mode: "backfill" as const,
      start: "2026-07-28T00:00:00Z",
      end: "2026-07-29T00:00:00Z",
      maxRecords: "501"
    },
    {
      mode: "backfill" as const,
      start: "2026-07-28T00:00:00Z",
      end: "2026-07-29T00:00:00Z",
      maxRecords: "NaN"
    }
  ]) {
    assert.throws(() => parseOutcomeLearningWindow({
      ...invalid,
      now: new Date("2026-07-29T12:00:00Z")
    }), /OUTCOME_LEARNING_/);
  }

  assert.deepEqual(parseOutcomeLearningWindow({
    mode: "scheduled",
    now: new Date("2026-07-29T12:34:56Z")
  }), {
    start: "2026-07-28T00:00:00.000Z",
    end: "2026-07-29T00:00:00.000Z",
    maxRecords: 250
  });
});

test("refresh loads bounded source batches once, reports broken lineage, and writes derived tables only", async () => {
  const mock = mockQuery();
  const result = await runPostgresOutcomeLearningRefresh({
    query: mock.query,
    fence,
    environment: "paper",
    start: "2026-07-28T00:00:00.000Z",
    end: "2026-07-29T00:00:00.000Z",
    maxRecords: 250,
    now: new Date("2026-07-29T12:00:00.000Z")
  });

  assert.equal(result.status, "completed");
  assert.equal(result.sourceRecordCount, 2);
  assert.equal(result.outcomeRecordCount, 2);
  assert.equal(result.sourceTruncated, false);
  assert.equal(mock.writtenOutcomes.length, 2);
  assert.ok(mock.writtenAggregates.length > 0);
  assert.deepEqual(
    mock.writtenOutcomes.map((row) => row.join_status),
    ["missing", "missing"]
  );
  assert.ok(
    (mock.writtenOutcomes[0]!.missing_join_reasons as string[]).includes(
      "ORDER_MISSING"
    )
  );
  assert.equal(mock.writtenOutcomes[0]!.average_fill_price, null);
  assert.equal(mock.writtenOutcomes[0]!.realized_return, null);

  const candidateQueries = mock.calls.filter(
    (call) => call.sql.includes("FROM candidates candidate")
  );
  assert.equal(candidateQueries.length, 1);
  assert.deepEqual(candidateQueries[0]!.values, [
    "2026-07-28T00:00:00.000Z",
    "2026-07-29T00:00:00.000Z",
    251
  ]);
  for (const sourceTable of [
    "portfolio_arbitration_decisions",
    "execution_reviews",
    "order_intents",
    "orders",
    "broker_events",
    "positions",
    "research_signals"
  ]) {
    assert.equal(
      mock.calls.filter(
        (call) =>
          call.sql.includes(`FROM ${sourceTable} `) &&
          call.sql.includes("JOIN LATERAL") &&
          call.sql.includes("unnest($1::text[])")
      ).length,
      1,
      sourceTable
    );
  }
  for (const call of mock.calls) {
    if (!/\b(INSERT|UPDATE|DELETE)\b/i.test(call.sql)) continue;
    assert.doesNotMatch(
      call.sql,
      /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:candidates|portfolio_arbitration_decisions|execution_reviews|order_intents|orders|broker_events|positions|research_signals|stock_snapshots|option_snapshots|market_bars)\b/i
    );
  }
});

test("exact source replay is idempotent and performs no derived rewrite", async () => {
  const mock = mockQuery({ existingRefresh: true });
  const result = await runPostgresOutcomeLearningRefresh({
    query: mock.query,
    fence,
    environment: "paper",
    start: "2026-07-28T00:00:00.000Z",
    end: "2026-07-29T00:00:00.000Z",
    maxRecords: 250,
    now: new Date("2026-07-29T12:00:00.000Z")
  });

  assert.equal(result.status, "no_op");
  assert.equal(result.code, "OUTCOME_LEARNING_REPLAY_UNCHANGED");
  assert.equal(result.refreshRunId, "existing-refresh");
  assert.equal(mock.writtenOutcomes.length, 0);
  assert.equal(mock.writtenAggregates.length, 0);
  assert.equal(
    mock.calls.some((call) => call.sql.includes("INSERT INTO outcome_learning_refresh_runs")),
    false
  );
});

test("an empty bounded range records a fenced successful no-action refresh", async () => {
  const mock = mockQuery({ candidates: [] });
  const result = await runPostgresOutcomeLearningRefresh({
    query: mock.query,
    fence,
    environment: "paper",
    start: "2026-07-28T00:00:00.000Z",
    end: "2026-07-29T00:00:00.000Z",
    maxRecords: 250,
    now: new Date("2026-07-29T12:00:00.000Z")
  });

  assert.equal(result.status, "no_op");
  assert.equal(result.code, "NO_BOUNDED_OUTCOME_SOURCES");
  assert.equal(result.sourceRecordCount, 0);
  assert.equal(result.outcomeRecordCount, 0);
  assert.equal(result.aggregateRecordCount, 0);
  assert.equal(mock.writtenOutcomes.length, 0);
  assert.equal(mock.writtenAggregates.length, 0);
  assert.equal(
    mock.calls.filter((call) =>
      call.sql.includes("INSERT INTO outcome_learning_refresh_runs")
    ).length,
    1
  );
  assert.equal(
    mock.calls.filter((call) =>
      call.sql.includes("UPDATE outcome_learning_refresh_runs")
    ).length,
    1
  );
});

test("source selection stops at the hard record cap and makes aggregates unusable", async () => {
  const candidates = Array.from({ length: 4 }, (_, index) =>
    candidate(`candidate-${index + 1}`)
  );
  const mock = mockQuery({ candidates });
  const result = await runPostgresOutcomeLearningRefresh({
    query: mock.query,
    fence,
    environment: "paper",
    start: "2026-07-28T00:00:00.000Z",
    end: "2026-07-29T00:00:00.000Z",
    maxRecords: 3,
    now: new Date("2026-07-29T12:00:00.000Z")
  });

  assert.equal(result.sourceTruncated, true);
  assert.equal(result.sourceRecordCount, 3);
  assert.equal(result.outcomeRecordCount, 3);
  assert.deepEqual(result.limitations, ["SOURCE_RECORD_LIMIT_REACHED"]);
  assert.equal(mock.writtenOutcomes.length, 3);
  assert.ok(mock.writtenAggregates.length > 0);
  assert.ok(
    mock.writtenAggregates.every((row) =>
      row.source_truncated === true && row.usable_as_evidence === false
    )
  );
  const candidateQuery = mock.calls.find((call) =>
    call.sql.includes("FROM candidates candidate")
  )!;
  assert.equal(candidateQuery.values[2], 4);
});

test("every derived write is fenced and a lost fence fails closed", async () => {
  const mock = mockQuery({ fenceHeld: false });
  await assert.rejects(
    runPostgresOutcomeLearningRefresh({
      query: mock.query,
      fence,
      environment: "paper",
      start: "2026-07-28T00:00:00.000Z",
      end: "2026-07-29T00:00:00.000Z",
      maxRecords: 250,
      now: new Date("2026-07-29T12:00:00.000Z")
    }),
    /SCHEDULER_FENCE_LOST/
  );
  const modifyingCalls = mock.calls.filter((call) =>
    /\b(?:INSERT INTO|UPDATE)\s+(?:outcome_learning|historical_outcome)/i.test(call.sql)
  );
  assert.ok(modifyingCalls.length > 0);
  assert.ok(modifyingCalls.every((call) => call.sql.includes("scheduler_leases")));
});

test("bounded outcome query accepts no arbitrary SQL fragments or unbounded range", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query: OutcomeLearningQueryExecutor = {
    query: async (sql, values = []) => {
      calls.push({ sql, values });
      return { rows: [{ outcome_id: "outcome-1" }], rowCount: 1 };
    }
  };
  const rows = await readBoundedOutcomeLearningRecords({
    query,
    start: "2026-07-28T00:00:00Z",
    end: "2026-07-29T00:00:00Z",
    environment: "paper",
    lane: "equity",
    candidateId: "candidate-1'; DROP TABLE orders; --",
    limit: 20
  });
  assert.equal(rows.length, 1);
  assert.doesNotMatch(calls[0]!.sql, /DROP TABLE/);
  assert.ok(calls[0]!.sql.includes("$5::text"));
  assert.equal(calls[0]!.values[4], "candidate-1'; DROP TABLE orders; --");
  await assert.rejects(
    readBoundedOutcomeLearningRecords({
      query,
      start: "2026-01-01T00:00:00Z",
      end: "2026-07-29T00:00:00Z",
      limit: 20
    }),
    /OUTCOME_LEARNING_RANGE_TOO_WIDE/
  );
  await assert.rejects(
    readBoundedHistoricalOutcomeAggregates({
      query,
      start: "2026-07-28T00:00:00Z",
      end: "2026-07-29T00:00:00Z",
      environment: "paper",
      lane: "equity'; DROP TABLE orders; --",
      limit: 20
    }),
    /OUTCOME_LEARNING_LANE_INVALID/
  );
});

test("source and market lookup SQL use the intended bounded indexes and no future evidence", () => {
  assert.match(OUTCOME_CANDIDATE_SOURCE_SQL, /candidate\.as_of >= \$1/);
  assert.match(OUTCOME_CANDIDATE_SOURCE_SQL, /candidate\.as_of < \$2/);
  assert.match(OUTCOME_CANDIDATE_SOURCE_SQL, /ORDER BY candidate\.as_of, candidate\.id/);
  assert.match(OUTCOME_CANDIDATE_SOURCE_SQL, /LIMIT \$3/);
  assert.match(OUTCOME_REFERENCE_LOOKUP_SQL, /LEFT JOIN LATERAL/);
  assert.match(OUTCOME_REFERENCE_LOOKUP_SQL, /observed_at <= event\.event_at/);
  assert.match(OUTCOME_REFERENCE_LOOKUP_SQL, /observed_at >= event\.event_at -/);
  assert.match(OUTCOME_REFERENCE_LOOKUP_SQL, /ORDER BY .*observed_at DESC/s);
  assert.match(OUTCOME_REFERENCE_LOOKUP_SQL, /LIMIT 1/);
  assert.doesNotMatch(
    OUTCOME_REFERENCE_LOOKUP_SQL,
    /evidence->>[^\n]+::(?:numeric|timestamptz)/
  );
  assert.match(OUTCOME_EXCURSION_LOOKUP_SQL, /LEFT JOIN LATERAL/);
  assert.match(OUTCOME_EXCURSION_LOOKUP_SQL, /timeframe = '1Day'/);
  assert.match(OUTCOME_EXCURSION_LOOKUP_SQL, /LIMIT 500/);
});

test("every dependent lifecycle query applies a hard per-parent row cap", async () => {
  const mock = mockQuery();
  await runPostgresOutcomeLearningRefresh({
    query: mock.query,
    fence,
    environment: "paper",
    start: "2026-07-28T00:00:00.000Z",
    end: "2026-07-29T00:00:00.000Z",
    maxRecords: 250,
    now: new Date("2026-07-29T12:00:00.000Z")
  });

  for (const sourceTable of [
    "portfolio_arbitration_decisions",
    "execution_reviews",
    "order_intents",
    "orders",
    "broker_events",
    "positions",
    "research_signals"
  ]) {
    const call = mock.calls.find((entry) =>
      entry.sql.includes(`FROM ${sourceTable} `) &&
      entry.sql.includes("JOIN LATERAL")
    );
    assert.ok(call, sourceTable);
    assert.match(call.sql, /JOIN LATERAL/, sourceTable);
    assert.match(call.sql, /LIMIT \$\d+/, sourceTable);
    assert.ok(
      call.values.some(
        (value) =>
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value > 0
      ),
      sourceTable
    );
  }
});
