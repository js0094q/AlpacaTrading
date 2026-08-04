import assert from "node:assert/strict";
import test from "node:test";

import {
  refreshPostgresSelectedCandidateEvidence
} from "../src/services/postgresSelectedEvidenceRefreshService.js";

const fence = {
  jobName: "option-discovery",
  workstream: "paper:options:discover",
  ownerId: "worker-1",
  runId: "run-1",
  fencingToken: "11"
};

test("refreshes only selected option underlyings with the configured quote-age limit before review", async () => {
  const statements: string[] = [];
  const refreshInputs: Array<Record<string, unknown>> = [];
  const result = await refreshPostgresSelectedCandidateEvidence({
    query: {
      query: async (sql: string) => {
        statements.push(sql);
        return {
          rows: [
            { symbol: "SPY", option_symbol: "SPY260804C00769000" },
            { symbol: "AMZN", option_symbol: "AMZN280121C00300000" },
            { symbol: "SPY", option_symbol: "SPY271217C01090000" }
          ],
          rowCount: 3
        };
      }
    },
    fence,
    now: new Date("2026-08-04T17:20:00.000Z"),
    clock: () => new Date("2026-08-04T17:20:01.000Z"),
    maxCandidates: 25,
    maxQuoteAgeMs: 900_000,
    dependencies: {
      refreshMarketData: async (input) => {
        refreshInputs.push(input as unknown as Record<string, unknown>);
        return {
          bars: [],
          stockSnapshots: [],
          optionContracts: [],
          optionSnapshots: [
            {
              optionSymbol: "SPY260804C00769000",
              quoteTimestamp: "2026-08-04T17:20:00.000Z",
              bid: 2.49,
              ask: 2.51,
              requestedFeed: "opra",
              effectiveFeed: "opra",
              freshnessStatus: "fresh"
            },
            {
              optionSymbol: "AMZN280121C00300000",
              quoteTimestamp: "2026-08-04T17:20:00.000Z",
              bid: 49.5,
              ask: 50,
              requestedFeed: "opra",
              effectiveFeed: "opra",
              freshnessStatus: "fresh"
            },
            {
              optionSymbol: "SPY271217C01090000",
              quoteTimestamp: "2026-08-04T17:20:00.000Z",
              bid: 10,
              ask: 10.1,
              requestedFeed: "opra",
              effectiveFeed: "opra",
              freshnessStatus: "fresh"
            }
          ] as never,
          summary: {
            symbolCount: 2,
            barCount: 0,
            stockSnapshotCount: 2,
            optionContractCount: 3,
            optionSnapshotCount: 3,
            optionChainPageCount: 2,
            optionContractsByUnderlying: { AMZN: 1, SPY: 2 },
            optionSnapshotsByUnderlying: { AMZN: 1, SPY: 2 },
            freshOptionSnapshotsByUnderlying: { AMZN: 1, SPY: 2 },
            optionEvidenceByUnderlying: {},
            optionDataStatus: "current" as const,
            optionDataRejectionReasons: []
          }
        };
      }
    }
  });

  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /latest_research/);
  assert.match(statements[0]!, /candidate\.decision = 'selected'/);
  assert.deepEqual(refreshInputs[0]?.symbols, ["AMZN", "SPY"]);
  assert.deepEqual(refreshInputs[0]?.requiredOptionUnderlyings, ["AMZN", "SPY"]);
  assert.deepEqual(refreshInputs[0]?.selectedOptionSymbols, [
    "SPY260804C00769000",
    "AMZN280121C00300000",
    "SPY271217C01090000"
  ]);
  assert.equal(refreshInputs[0]?.optionsEnabled, true);
  assert.equal(refreshInputs[0]?.maxOptionSnapshotAgeSeconds, 900);
  assert.equal(refreshInputs[0]?.start, "2025-08-04T17:20:00.000Z");
  assert.equal(refreshInputs[0]?.end, "2026-08-04T17:20:00.000Z");
  assert.deepEqual(result, {
    status: "completed",
    selectedOptionCount: 3,
    freshSelectedOptionCount: 3,
    staleSelectedOptionSymbols: [],
    underlyingCount: 2,
    underlyings: ["AMZN", "SPY"],
    optionDataStatus: "current",
    optionDataRejectionReasons: [],
    brokerMutationPerformed: false
  });
});

test("defers when an exact selected contract has aged beyond the quote limit by command completion", async () => {
  const result = await refreshPostgresSelectedCandidateEvidence({
    query: {
      query: async () => ({
        rows: [{ symbol: "AMZN", option_symbol: "AMZN280121C00300000" }],
        rowCount: 1
      })
    },
    fence,
    now: new Date("2026-08-04T17:20:00.000Z"),
    clock: () => new Date("2026-08-04T17:35:00.001Z"),
    maxQuoteAgeMs: 900_000,
    dependencies: {
      refreshMarketData: async () => ({
        bars: [],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [{
          optionSymbol: "AMZN280121C00300000",
          quoteTimestamp: "2026-08-04T17:20:00.000Z",
          bid: 49.5,
          ask: 50,
          requestedFeed: "opra",
          effectiveFeed: "opra",
          freshnessStatus: "fresh"
        }],
        summary: {
          symbolCount: 1,
          barCount: 0,
          stockSnapshotCount: 1,
          optionContractCount: 1,
          optionSnapshotCount: 1,
          optionChainPageCount: 1,
          optionContractsByUnderlying: { AMZN: 1 },
          optionSnapshotsByUnderlying: { AMZN: 1 },
          freshOptionSnapshotsByUnderlying: { AMZN: 1 },
          optionEvidenceByUnderlying: {},
          optionDataStatus: "current" as const,
          optionDataRejectionReasons: []
        }
      } as never)
    }
  });

  assert.deepEqual(result, {
    status: "deferred",
    code: "POSTGRES_SELECTED_OPTION_EVIDENCE_REFRESH_INCOMPLETE",
    selectedOptionCount: 1,
    freshSelectedOptionCount: 0,
    staleSelectedOptionSymbols: ["AMZN280121C00300000"],
    underlyingCount: 1,
    underlyings: ["AMZN"],
    optionDataStatus: "degraded",
    optionDataRejectionReasons: [
      "POSTGRES_SELECTED_OPTION_EVIDENCE_STALE:AMZN280121C00300000"
    ],
    brokerMutationPerformed: false
  });
});

test("defers when a selected contract reports a non-OPRA response feed despite an OPRA request", async () => {
  const result = await refreshPostgresSelectedCandidateEvidence({
    query: {
      query: async () => ({
        rows: [{ symbol: "AMZN", option_symbol: "AMZN280121C00300000" }],
        rowCount: 1
      })
    },
    fence,
    now: new Date("2026-08-04T17:20:00.000Z"),
    clock: () => new Date("2026-08-04T17:20:01.000Z"),
    maxQuoteAgeMs: 900_000,
    dependencies: {
      refreshMarketData: async () => ({
        optionSnapshots: [{
          optionSymbol: "AMZN280121C00300000",
          quoteTimestamp: "2026-08-04T17:20:00.000Z",
          bid: 49.5,
          ask: 50,
          requestedFeed: "opra",
          effectiveFeed: "indicative",
          validationBasis: "request_feed_opra",
          freshnessStatus: "fresh"
        }],
        summary: {
          optionDataStatus: "current" as const,
          optionDataRejectionReasons: []
        }
      } as never)
    }
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.code, "POSTGRES_SELECTED_OPTION_EVIDENCE_REFRESH_INCOMPLETE");
  assert.deepEqual(result.staleSelectedOptionSymbols, ["AMZN280121C00300000"]);
  assert.equal(result.brokerMutationPerformed, false);
});

test("does not call Alpaca when the latest completed research has no selected option candidate", async () => {
  let refreshCalled = false;
  const result = await refreshPostgresSelectedCandidateEvidence({
    query: {
      query: async () => ({ rows: [], rowCount: 0 })
    },
    fence,
    now: new Date("2026-08-04T17:20:00.000Z"),
    dependencies: {
      refreshMarketData: async () => {
        refreshCalled = true;
        throw new Error("unexpected refresh");
      }
    }
  });

  assert.equal(refreshCalled, false);
  assert.deepEqual(result, {
    status: "no_op",
    code: "NO_SELECTED_OPTION_EVIDENCE_TO_REFRESH",
    selectedOptionCount: 0,
    freshSelectedOptionCount: 0,
    staleSelectedOptionSymbols: [],
    underlyingCount: 0,
    underlyings: [],
    optionDataStatus: "not_applicable",
    optionDataRejectionReasons: [],
    brokerMutationPerformed: false
  });
});
