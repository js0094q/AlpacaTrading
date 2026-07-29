import assert from "node:assert/strict";
import test from "node:test";

import {
  attachHistoricalOutcomeEvidence,
  historicalOutcomeEvidenceConfig,
  loadHistoricalOutcomeEvidence,
  selectHistoricalOutcomeEvidence
} from "../src/services/historicalOutcomeEvidenceService.js";

const validRow = (overrides: Record<string, unknown> = {}) => ({
  id: "aggregate-1",
  environment: "paper",
  lane: "equity",
  dimension: "symbol",
  grouping_key: "AAPL",
  date_range_start: "2026-07-01T00:00:00.000Z",
  date_range_end: "2026-07-28T00:00:00.000Z",
  source_truncated: false,
  sample_count: "10",
  filled_count: "8",
  rejected_count: "1",
  canceled_count: "1",
  average_time_to_first_fill_ms: "1500",
  average_slippage_bps: "4.5",
  realized_return_average: "0.03",
  win_rate: "0.6",
  missing_join_count: "1",
  ambiguous_join_count: "0",
  unsupported_metric_count: "4",
  usable_as_evidence: true,
  source_watermark: "2026-07-28T20:00:00.000Z",
  calculated_at: "2026-07-29T11:30:00.000Z",
  schema_version: 1,
  content_hash: "a".repeat(64),
  ...overrides
});

test("configuration is default-off and bounded", () => {
  assert.deepEqual(historicalOutcomeEvidenceConfig({}), {
    enabled: false,
    lookbackDays: 31,
    minimumSample: 5,
    maximumIncompleteJoinRatio: 0.25,
    staleAfterMs: 86_400_000,
    maximumRows: 500,
    schemaVersion: 1
  });
  assert.deepEqual(historicalOutcomeEvidenceConfig({
    OUTCOME_LEARNING_EVIDENCE_ENABLED: "true",
    OUTCOME_LEARNING_LOOKBACK_DAYS: "7",
    OUTCOME_LEARNING_MINIMUM_SAMPLE: "12",
    OUTCOME_LEARNING_MAX_INCOMPLETE_JOIN_RATIO: "0.1",
    OUTCOME_LEARNING_STALE_AFTER_SECONDS: "3600"
  }), {
    enabled: true,
    lookbackDays: 7,
    minimumSample: 12,
    maximumIncompleteJoinRatio: 0.1,
    staleAfterMs: 3_600_000,
    maximumRows: 500,
    schemaVersion: 1
  });
});

test("disabled evidence performs no query and preserves existing proposal inputs", async () => {
  let queries = 0;
  const index = await loadHistoricalOutcomeEvidence({
    query: {
      query: async () => {
        queries += 1;
        return { rows: [validRow()], rowCount: 1 };
      }
    },
    now: new Date("2026-07-29T12:00:00.000Z"),
    environment: "paper",
    config: historicalOutcomeEvidenceConfig({})
  });
  assert.equal(queries, 0);
  assert.equal(index.state, "disabled");

  const original = {
    targetSourceFingerprint: "target-1",
    candidateScore: { total: 82 },
    decisionGates: { outcome: "passed" }
  };
  assert.deepEqual(
    attachHistoricalOutcomeEvidence(original, null),
    original
  );
});

test("loads at most one bounded aggregate page and selects matching read-only evidence", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const config = historicalOutcomeEvidenceConfig({
    OUTCOME_LEARNING_EVIDENCE_ENABLED: "true"
  });
  const index = await loadHistoricalOutcomeEvidence({
    query: {
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        return {
          rows: [
            validRow(),
            validRow({
              id: "aggregate-lane",
              dimension: "lane",
              grouping_key: "equity"
            }),
            validRow({
              id: "aggregate-live",
              environment: "live"
            })
          ],
          rowCount: 3
        };
      }
    },
    now: new Date("2026-07-29T12:00:00.000Z"),
    environment: "paper",
    config
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /usable_as_evidence/);
  assert.match(calls[0]!.sql, /NOT source_truncated/);
  assert.match(calls[0]!.sql, /LIMIT \$7/);
  assert.equal(calls[0]!.values[6], 500);

  const evidence = selectHistoricalOutcomeEvidence(index, {
    environment: "paper",
    lane: "equity",
    symbol: "AAPL",
    underlyingSymbol: "AAPL",
    now: new Date("2026-07-29T12:00:00.000Z")
  });
  assert.deepEqual(evidence, {
    state: "available",
    reasonCode: "HISTORICAL_OUTCOME_EVIDENCE_AVAILABLE",
    aggregateId: "aggregate-1",
    environment: "paper",
    lane: "equity",
    dimension: "symbol",
    groupingKey: "AAPL",
    dateRangeStart: "2026-07-01T00:00:00.000Z",
    dateRangeEnd: "2026-07-28T00:00:00.000Z",
    sampleCount: 10,
    filledCount: 8,
    rejectedCount: 1,
    canceledCount: 1,
    averageTimeToFirstFillMs: 1500,
    averageSlippageBps: 4.5,
    realizedReturnAverage: 0.03,
    winRate: 0.6,
    missingJoinCount: 1,
    ambiguousJoinCount: 0,
    unsupportedMetricCount: 4,
    sourceWatermark: "2026-07-28T20:00:00.000Z",
    calculatedAt: "2026-07-29T11:30:00.000Z",
    schemaVersion: 1,
    contentHash: "a".repeat(64)
  });

  const attached = attachHistoricalOutcomeEvidence({
    candidateScore: { total: 82 },
    decisionGates: { outcome: "passed", reasons: ["RANKED_SELECTED"] }
  }, evidence);
  assert.deepEqual(attached.candidateScore, { total: 82 });
  assert.deepEqual(attached.decisionGates, {
    outcome: "passed",
    reasons: ["RANKED_SELECTED"]
  });
  assert.deepEqual(attached.historicalOutcomeEvidence, evidence);
});

test("insufficient, stale, truncated, mismatched, or incompatible aggregates are unavailable", async () => {
  const config = historicalOutcomeEvidenceConfig({
    OUTCOME_LEARNING_EVIDENCE_ENABLED: "true"
  });
  for (const [label, row] of [
    ["insufficient", validRow({ sample_count: "4" })],
    ["stale", validRow({ calculated_at: "2026-07-27T00:00:00.000Z" })],
    ["truncated", validRow({ source_truncated: true })],
    ["environment", validRow({ environment: "live" })],
    ["lane", validRow({ lane: "options_0dte" })],
    ["schema", validRow({ schema_version: 2 })],
    ["missing filled count", validRow({ filled_count: null })],
    [
      "missing unsupported count",
      validRow({ unsupported_metric_count: null })
    ],
    [
      "invalid source watermark",
      validRow({ source_watermark: "not-a-timestamp" })
    ],
    [
      "incomplete",
      validRow({ missing_join_count: "3", ambiguous_join_count: "0" })
    ]
  ] as const) {
    const index = await loadHistoricalOutcomeEvidence({
      query: {
        query: async () => ({ rows: [row], rowCount: 1 })
      },
      now: new Date("2026-07-29T12:00:00.000Z"),
      environment: "paper",
      config
    });
    assert.equal(selectHistoricalOutcomeEvidence(index, {
      environment: "paper",
      lane: "equity",
      symbol: "AAPL",
      underlyingSymbol: "AAPL",
      now: new Date("2026-07-29T12:00:00.000Z")
    }), null, label);
  }
});

test("aggregate query failure is local and does not become a global gate", async () => {
  const index = await loadHistoricalOutcomeEvidence({
    query: {
      query: async () => {
        throw new Error("database unavailable");
      }
    },
    now: new Date("2026-07-29T12:00:00.000Z"),
    environment: "paper",
    config: historicalOutcomeEvidenceConfig({
      OUTCOME_LEARNING_EVIDENCE_ENABLED: "true"
    })
  });
  assert.deepEqual(index, {
    state: "unavailable",
    reasonCode: "HISTORICAL_OUTCOME_QUERY_UNAVAILABLE",
    rows: [],
    config: historicalOutcomeEvidenceConfig({
      OUTCOME_LEARNING_EVIDENCE_ENABLED: "true"
    })
  });
  assert.equal(selectHistoricalOutcomeEvidence(index, {
    environment: "paper",
    lane: "equity",
    symbol: "AAPL",
    underlyingSymbol: "AAPL",
    now: new Date("2026-07-29T12:00:00.000Z")
  }), null);
});
