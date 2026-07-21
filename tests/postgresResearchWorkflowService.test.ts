import assert from "node:assert/strict";
import test from "node:test";

import { runPostgresResearchWorkflow } from "../src/services/postgresResearchWorkflowService.js";

const fence = {
  jobName: "research",
  workstream: "research",
  ownerId: "worker",
  runId: "lease-run",
  fencingToken: "12"
};

const bar = {
  symbol: "SPY", timeframe: "1Day", observedAt: "2026-07-20T20:00:00.000Z",
  open: 550, high: 556, low: 549, close: 555, volume: 1_000_000,
  source: "alpaca", requestId: "bars-request"
};

const target = {
  symbol: "SPY", asOf: bar.observedAt, direction: "long" as const, horizon: "1d",
  entryReference: 555, upsideTarget: 570, downsideRisk: 547.5, stopLoss: 547.5,
  takeProfit: 570, confidence: 0.9, expectedReturn: 1.5,
  volatilityAdjustedScore: 1.2, riskProfile: "aggressive",
  preferredExpression: "shares", rationale: ["Observed bullish trend"],
  sourceFingerprint: "target-fingerprint", optionsStrategy: null
};

test("research persists current PostgreSQL evidence and selected candidates before completing", async () => {
  const sql: string[] = [];
  let candidateValues: readonly unknown[] = [];
  const result = await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("INSERT INTO candidates")) candidateValues = values ?? [];
        return { rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [], rowCount: 1 };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: false,
    maxCandidates: 10,
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [{
          id: "stock-1", symbol: "SPY", observedAt: "2026-07-20T22:00:00.000Z",
          sourceTimestamp: "2026-07-20T20:00:00.000Z", requestedFeed: "sip",
          effectiveFeed: "sip", source: "alpaca", requestId: "stock-request",
          evidence: { symbol: "SPY", marketReferencePrice: 555 }
        }],
        optionContracts: [], optionSnapshots: [], summary: { symbolCount: 1 }
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [{
          symbol: "SPY", observedAt: bar.observedAt,
          features: { close: 555, trend: "bullish", marketEvidenceTimestamp: bar.observedAt },
          sourceFingerprint: "feature-fingerprint"
        }],
        targets: [{ ...target, optionsStrategy: { decisionInputs: {
          currentTradablePrice: 555, intradayReturn: 0.01,
          stockEvidenceFreshnessStatus: "FRESH", marketSessionEligible: true
        } } }]
      }),
      symbols: ["SPY"]
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.candidatesSelected, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO research_evidence")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO candidates")), true);
  assert.equal(sql.some((statement) => /id, decision_id, research_run_id/.test(statement)), true);
  assert.equal(sql.some((statement) => /SET status = 'completed'/.test(statement)), true);
  assert.deepEqual(JSON.parse(String(candidateValues[22])), {
    targetSourceFingerprint: "target-fingerprint", marketEvidenceTimestamp: bar.observedAt,
    entryReference: 555, stopLoss: 547.5, takeProfit: 570,
    marketDecisionInputs: {
      currentTradablePrice: 555, intradayReturn: 0.01,
      stockEvidenceFreshnessStatus: "FRESH", marketSessionEligible: true,
      option: null
    }
  });
});

test("research fails closed and records failure when current market evidence is unavailable", async () => {
  const sql: string[] = [];
  await assert.rejects(
    runPostgresResearchWorkflow({
      query: {
        query: async (statement: string) => {
          sql.push(statement);
          return { rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [], rowCount: 1 };
        }
      },
      fence,
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      dependencies: {
        refreshMarketData: async () => { throw new Error("POSTGRES_MARKET_BARS_STALE:SPY"); },
        buildFeaturesAndTargets: async () => { throw new Error("must not build features"); },
        symbols: ["SPY"]
      }
    }),
    /POSTGRES_MARKET_BARS_STALE:SPY/
  );
  assert.equal(sql.some((statement) => /SET status = 'failed'/.test(statement)), true);
  assert.equal(sql.some((statement) => /SET status = 'completed'/.test(statement)), false);
});

test("research never converts a shares expression into an option candidate", async () => {
  let candidateValues: readonly unknown[] = [];
  const sharesWithOptionEvidence = {
    ...target,
    optionsStrategy: {
      alternatives: ["long_call"],
      rationale: [],
      optionsCandidate: {
        optionSymbol: "SPY260720C00555000", type: "call", expirationDate: "2026-07-20",
        strike: 555, estimatedEntryPrice: 2, liquidityScore: 0.9
      }
    }
  };
  const result = await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("INSERT INTO candidates")) candidateValues = values ?? [];
        return { rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [], rowCount: 1 };
      }
    },
    fence, riskProfile: "aggressive", optionsEnabled: true, maxCandidates: 10,
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar], stockSnapshots: [], optionContracts: [], optionSnapshots: [], summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({ features: [], targets: [sharesWithOptionEvidence] }),
      symbols: ["SPY"]
    }
  });
  assert.equal(result.candidatesSelected, 1);
  assert.equal(candidateValues[4], null);
  assert.equal(candidateValues[5], "equity");
  assert.equal(candidateValues[12], "equity");
});

test("research assigns zero_dte_spy only to a matching SPY same-day option expression", async () => {
  let candidateValues: readonly unknown[] = [];
  const zeroDteTarget = {
    ...target,
    preferredExpression: "long_call" as const,
    optionsStrategy: {
      alternatives: ["shares"], rationale: [],
      optionsCandidate: {
        optionSymbol: "SPY260720C00555000", type: "call", expirationDate: "2026-07-20",
        strike: 555, estimatedEntryPrice: 2, liquidityScore: 0.9
      }
    }
  };
  await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("INSERT INTO candidates")) candidateValues = values ?? [];
        return { rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [], rowCount: 1 };
      }
    },
    fence, riskProfile: "aggressive", optionsEnabled: true, maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar], stockSnapshots: [], optionContracts: [], optionSnapshots: [], summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({ features: [], targets: [zeroDteTarget] }),
      symbols: ["SPY"]
    }
  });
  assert.equal(candidateValues[4], "SPY260720C00555000");
  assert.equal(candidateValues[5], "option");
  assert.equal(candidateValues[12], "zero_dte_spy");
});
