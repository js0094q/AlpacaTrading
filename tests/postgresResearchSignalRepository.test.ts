import assert from "node:assert/strict";
import test from "node:test";

import {
  importResearchSignals,
  loadResearchSignalsForSymbols
} from "../src/repositories/postgres/postgresResearchSignalRepository.js";

const fence = {
  jobName: "research",
  workstream: "research",
  ownerId: "worker",
  runId: "lease-run",
  fencingToken: "41"
};

const payload = {
  schema_version: 1,
  signals: [{
    provider: "public-equity-export",
    provider_signal_id: "spy-2026-07-28",
    symbol: "SPY",
    as_of: "2026-07-28T12:00:00.000Z",
    horizon: "long_term",
    thesis_direction: "bullish",
    confidence: 0.7,
    catalysts: ["Investor day"],
    catalyst_dates: ["2026-07-28T15:00:00.000Z"],
    risks: ["Margin compression"],
    source_references: ["research://public-equity-export/spy-2026-07-28"],
    expires_or_review_at: "2026-08-15T12:00:00.000Z"
  }]
};

test("persists one normalized signal and treats exact reimport as idempotent", async () => {
  const stored = new Map<string, { id: string; content_hash: string }>();
  const inserts: Array<readonly unknown[]> = [];
  const query = {
    query: async (statement: string, values?: readonly unknown[]) => {
      if (statement.includes("FROM universe_symbols")) {
        return { rows: [{ symbol: "SPY" }], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO research_signals")) {
        inserts.push(values ?? []);
        const id = String(values?.[0]);
        const contentHash = String(values?.[18]);
        if (stored.has(id)) return { rows: [], rowCount: 0 };
        stored.set(id, { id, content_hash: contentHash });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (statement.includes("FROM research_signals") && statement.includes("WHERE id = $1")) {
        const row = stored.get(String(values?.[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [{ held: true }], rowCount: 1 };
    }
  };

  const first = await importResearchSignals({
    query,
    fence,
    payload,
    now: new Date("2026-07-28T14:00:00.000Z")
  });
  const replay = await importResearchSignals({
    query,
    fence,
    payload,
    now: new Date("2026-07-29T14:00:00.000Z")
  });

  assert.equal(first.status, "completed");
  assert.equal(first.imported, 1);
  assert.equal(first.existing, 0);
  assert.equal(replay.status, "completed");
  assert.equal(replay.imported, 0);
  assert.equal(replay.existing, 1);
  assert.equal(stored.size, 1);
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0]?.[1], "public-equity-export");
  assert.equal(inserts[0]?.[3], "SPY");
  assert.equal(inserts[0]?.[4], "2026-07-28T12:00:00.000Z");
  assert.equal(inserts[0]?.[17], "2026-07-28T14:00:00.000Z");
  assert.notEqual(inserts[0]?.[4], inserts[0]?.[17]);
  assert.notEqual(inserts[0]?.[16], inserts[0]?.[17]);
  assert.equal(String(inserts[0]?.[13]).includes("research://public-equity-export"), true);
});

test("rejects unsupported symbols and continues importing valid siblings", async () => {
  let insertCount = 0;
  const result = await importResearchSignals({
    query: {
      query: async (statement: string) => {
        if (statement.includes("FROM universe_symbols")) {
          return { rows: [{ symbol: "SPY" }], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO research_signals")) {
          insertCount += 1;
          return { rows: [{ id: "stored" }], rowCount: 1 };
        }
        return { rows: [{ held: true }], rowCount: 1 };
      }
    },
    fence,
    payload: {
      schema_version: 1,
      signals: [
        payload.signals[0],
        { ...payload.signals[0], provider_signal_id: "qqq", symbol: "QQQ" },
        { ...payload.signals[0], provider_signal_id: "broker", quantity: 2 }
      ]
    },
    now: new Date("2026-07-28T14:00:00.000Z")
  });

  assert.equal(insertCount, 1);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.rejections.map(({ reasonCode }) => reasonCode), [
    "RESEARCH_EXECUTION_FIELD_FORBIDDEN",
    "RESEARCH_SYMBOL_UNSUPPORTED"
  ]);
  assert.equal(result.status, "completed_with_rejections");
});

test("loads bounded stored research for requested symbols without provider calls", async () => {
  const statements: string[] = [];
  const signals = await loadResearchSignalsForSymbols({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        statements.push(statement);
        assert.deepEqual(values, [["SPY", "QQQ"]]);
        return {
          rows: [{
            id: "research_signal_1",
            provider: "public-equity-export",
            provider_signal_id: null,
            symbol: "SPY",
            as_of: "2026-07-28T12:00:00.000Z",
            horizon: "long_term",
            thesis_summary: null,
            thesis_direction: "bullish",
            confidence: "0.7",
            catalysts: ["Investor day"],
            catalyst_dates: ["2026-07-28T15:00:00.000Z"],
            risks: [],
            invalidation_conditions: [],
            contradiction_status: null,
            contradiction_reason: null,
            valuation_summary: null,
            source_references: ["research://public-equity-export/spy"],
            expires_or_review_at: "2026-08-15T12:00:00.000Z",
            ingestion_timestamp: "2026-07-28T14:00:00.000Z",
            content_hash: "a".repeat(64),
            schema_version: 1
          }],
          rowCount: 1
        };
      }
    },
    symbols: ["spy", "QQQ", "SPY"]
  });

  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /row_number\(\) OVER \(PARTITION BY symbol/);
  assert.deepEqual(signals.map(({ symbol }) => symbol), ["SPY"]);
  assert.equal(signals[0]?.confidence, 0.7);
  assert.deepEqual(signals[0]?.sourceReferences, ["research://public-equity-export/spy"]);
});

test("requires the active scheduler fence before a research-signal write", async () => {
  await assert.rejects(
    importResearchSignals({
      query: {
        query: async (statement: string) => {
          if (statement.includes("FROM universe_symbols")) {
            return { rows: [{ symbol: "SPY" }], rowCount: 1 };
          }
          if (statement.includes("INSERT INTO research_signals")) {
            return { rows: [], rowCount: 0 };
          }
          if (statement.includes("FROM research_signals")) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        }
      },
      fence,
      payload,
      now: new Date("2026-07-28T14:00:00.000Z")
    }),
    /POSTGRES_RESEARCH_SIGNAL_FENCE_REJECTED/
  );
});
