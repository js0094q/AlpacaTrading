import assert from "node:assert/strict";
import test from "node:test";

import { paperExplorationThresholds } from "../src/services/paperExplorationConfig.js";
import { runPostgresResearchWorkflow } from "../src/services/postgresResearchWorkflowService.js";

const paperEnv = {
  ALPACA_ENV: "paper",
  TRADING_MODE: "paper",
  ALPACA_LIVE_TRADE: "false",
  LIVE_TRADING_ENABLED: "false"
};

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
  const cancellation = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const result = await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("INSERT INTO candidates")) candidateValues = values ?? [];
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
        return { rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [], rowCount: 1 };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: false,
    maxCandidates: 10,
    now: new Date("2026-07-20T22:00:00.000Z"),
    signal: cancellation.signal,
    dependencies: {
      refreshMarketData: async (input) => {
        observedSignal = input.signal;
        return {
          bars: [bar],
          stockSnapshots: [{
            id: "stock-1", symbol: "SPY", observedAt: "2026-07-20T22:00:00.000Z",
            sourceTimestamp: "2026-07-20T20:00:00.000Z", requestedFeed: "sip",
            effectiveFeed: "sip", source: "alpaca", requestId: "stock-request",
            evidence: { symbol: "SPY", marketReferencePrice: 555 }
          }],
          optionContracts: [], optionSnapshots: [], summary: { symbolCount: 1 }
        } as never;
      },
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
  assert.equal(observedSignal, cancellation.signal);
  assert.equal(result.candidatesSelected, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO research_evidence")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO candidates")), true);
  assert.equal(sql.some((statement) => /id, decision_id, research_run_id/.test(statement)), true);
  assert.equal(sql.some((statement) => /SET status = 'completed'/.test(statement)), true);
  const signalInputs = JSON.parse(String(candidateValues[25]));
  assert.deepEqual({
    ...signalInputs,
    decisionGates: undefined
  }, {
    targetSourceFingerprint: "target-fingerprint", marketEvidenceTimestamp: bar.observedAt,
    entryReference: 555, stopLoss: 547.5, takeProfit: 570,
    marketDecisionInputs: {
      currentTradablePrice: 555, intradayReturn: 0.01,
      stockEvidenceFreshnessStatus: "FRESH", marketSessionEligible: true,
      option: null
    },
    learningAdjustmentStatus: "not_applicable_no_postgres_learning_model",
    learningModelCapability: {
      authority: "postgres",
      relation: "public.learning_runs",
      status: "absent",
      verifiedAt: "2026-07-20T22:00:00.000Z"
    },
    decisionGates: undefined
  });
  assert.equal(signalInputs.decisionGates.outcome, "passed");
  assert.deepEqual(signalInputs.decisionGates.reasons, ["RANKED_SELECTED"]);
  assert.equal(signalInputs.decisionGates.profile.scope, "paper_only");
});

test("paper exploration persists selected and rejected candidate decisions with reversible gates", async () => {
  const candidateRows: Array<readonly unknown[]> = [];
  let researchConfig: Record<string, unknown> = {};
  const result = await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("INSERT INTO research_runs")) {
          researchConfig = JSON.parse(String(values?.[3]));
          return { rows: [{ version: "1" }], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO candidates")) candidateRows.push(values ?? []);
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: false,
    maxCandidates: 25,
    explorationThresholds: paperExplorationThresholds(paperEnv),
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar], stockSnapshots: [], optionContracts: [], optionSnapshots: [],
        summary: { optionDataStatus: "disabled", optionDataRejectionReasons: [] }
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [
          target,
          {
            ...target,
            symbol: "QQQ",
            direction: "neutral",
            confidence: 0.2,
            expectedReturn: 0,
            preferredExpression: "none",
            sourceFingerprint: "rejected-target-fingerprint"
          }
        ]
      }),
      symbols: ["SPY", "QQQ"]
    }
  });

  assert.equal(result.candidatesSelected, 1);
  assert.equal(result.candidatesRejected, 1);
  assert.equal(candidateRows.length, 2);
  assert.equal(candidateRows[0]?.[21], "selected");
  assert.equal(candidateRows[0]?.[23], "RANKED_SELECTED");
  assert.equal(candidateRows[1]?.[21], "rejected");
  assert.equal(candidateRows[1]?.[23], "DIRECTION_THRESHOLD_NOT_MET");
  assert.deepEqual(researchConfig.explorationProfile, {
    scope: "paper_only",
    profile: "exploration_v2",
    thresholds: {
      directionScore: { previous: 0.15, current: 0.05 },
      directionalConfidence: { previous: 0.25, current: 0.1 },
      optionLiquidityScore: { previous: 0.35, current: 0.1 },
      maxOptionSpreadPct: { previous: 0.12, current: 0.15 },
      longOptionConfidence: { previous: 0.4, current: 0.25 },
      aggressiveOptionConfidence: { previous: 0.6, current: 0.4 },
      definedRiskConfidence: { previous: 0.7, current: 0.5 },
      optionExpectedReturnPct: { previous: 0.75, current: 0.25 },
      definedRiskExpectedReturnPct: { previous: 1, current: 0.5 },
      maxCandidates: { previous: 25, current: 25 },
      maxOrderNotional: { previous: 1_000, current: 1_000 }
    }
  });
});

test("research reservation closes an abandoned run owned by an older scheduler fence", async () => {
  const sql: string[] = [];
  let abandonedClosed = false;
  const result = await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.trimStart().startsWith("UPDATE research_runs") &&
            statement.includes("SET status = 'recovered'")) {
          abandonedClosed = true;
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("INSERT INTO research_runs")) {
          if (!abandonedClosed) {
            const conflict = new Error("research_runs_one_active_workstream_idx") as Error & { code: string };
            conflict.code = "23505";
            throw conflict;
          }
          return { rows: [{ version: "1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: false,
    maxCandidates: 0,
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [], stockSnapshots: [], optionContracts: [], optionSnapshots: [], summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({ features: [], targets: [] }),
      symbols: ["SPY"]
    }
  });
  assert.equal(result.status, "completed");
  assert.match(sql[0]!, /SET status = 'recovered'/);
  assert.match(sql[0]!, /scheduler_fencing_token IS DISTINCT FROM/);
  assert.match(sql[1]!, /INSERT INTO research_runs/);
});

test("research fails closed when a PostgreSQL learning model exists without supported wiring", async () => {
  const sql: string[] = [];
  await assert.rejects(runPostgresResearchWorkflow({
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("INSERT INTO research_runs")) {
          return { rows: [{ version: "1" }], rowCount: 1 };
        }
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: "learning_runs" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence, riskProfile: "aggressive", optionsEnabled: false, maxCandidates: 10,
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar], stockSnapshots: [], optionContracts: [], optionSnapshots: [], summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({ features: [], targets: [target] }),
      symbols: ["SPY"]
    }
  }), /POSTGRES_LEARNING_MODEL_PRESENT_UNSUPPORTED/);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO candidates")), false);
  assert.equal(sql.some((statement) => /SET status = 'completed'/.test(statement)), false);
  assert.equal(sql.some((statement) => /SET status = 'failed'/.test(statement)), true);
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

test("research closes its own run when failure terminalization loses the scheduler fence", async () => {
  const failureUpdates: string[] = [];
  await assert.rejects(
    runPostgresResearchWorkflow({
      query: {
        query: async (statement: string) => {
          if (statement.includes("INSERT INTO research_runs")) {
            return { rows: [{ version: "1" }], rowCount: 1 };
          }
          if (/SET status = 'failed'/.test(statement)) {
            failureUpdates.push(statement);
            return { rows: [], rowCount: failureUpdates.length === 1 ? 0 : 1 };
          }
          return { rows: [], rowCount: 1 };
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
  assert.equal(failureUpdates.length, 2);
  assert.match(failureUpdates[0]!, /scheduler_leases/);
  assert.match(failureUpdates[1]!, /worker_identity/);
  assert.doesNotMatch(failureUpdates[1]!, /scheduler_leases/);
});

test("research preserves the workflow error when the first failure update times out", async () => {
  let failureUpdates = 0;
  await assert.rejects(
    runPostgresResearchWorkflow({
      query: {
        query: async (statement: string) => {
          if (statement.includes("INSERT INTO research_runs")) {
            return { rows: [{ version: "1" }], rowCount: 1 };
          }
          if (/SET status = 'failed'/.test(statement)) {
            failureUpdates += 1;
            if (failureUpdates === 1) throw new Error("Query read timeout");
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
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
  assert.equal(failureUpdates, 2);
});

test("research evidence is inserted in bounded batches", async () => {
  const sql: string[] = [];
  let evidencePreparationYielded = false;
  const snapshots = Array.from({ length: 251 }, (_, index) => ({
    id: `stock-${index}`, symbol: `S${index}`, observedAt: bar.observedAt,
    sourceTimestamp: bar.observedAt, requestedFeed: "sip", effectiveFeed: "sip",
    source: "alpaca", requestId: "batch", evidence: { price: index }
  }));
  const result = await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        sql.push(statement);
        if (statement.includes("INSERT INTO research_runs")) return { rows: [{ version: "1" }], rowCount: 1 };
        if (statement.startsWith("SELECT 1 WHERE")) assert.equal(evidencePreparationYielded, true);
        if (statement.includes("INSERT INTO research_evidence")) {
          return { rows: [], rowCount: JSON.parse(String(values?.[0])).length };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence, riskProfile: "aggressive", optionsEnabled: false, maxCandidates: 0,
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({ bars: [], stockSnapshots: snapshots, optionContracts: [], optionSnapshots: [], summary: {} }) as never,
      buildFeaturesAndTargets: async () => {
        setImmediate(() => { evidencePreparationYielded = true; });
        return { features: [], targets: [] };
      },
      symbols: ["SPY"]
    }
  });
  assert.equal(result.status, "completed");
  const evidence = sql.filter((statement) => statement.includes("INSERT INTO research_evidence"));
  assert.equal(evidence.length, 2);
  assert.match(evidence[0]!, /jsonb_to_recordset/);
});

test("research evidence keeps inline batches byte-bounded and copies oversized features server-side", async () => {
  const inlinePayloadSizes: number[] = [];
  const featureStatements: string[] = [];
  const featureParameters: Array<readonly unknown[]> = [];
  const inlineLarge = "y".repeat(2_200_000);
  const oversized = "x".repeat(4_500_000);
  const result = await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("INSERT INTO research_runs")) {
          return { rows: [{ version: "1" }], rowCount: 1 };
        }
        if (
          statement.includes("INSERT INTO research_evidence") &&
          statement.includes("FROM feature_snapshots f")
        ) {
          featureStatements.push(statement);
          featureParameters.push(values ?? []);
          return {
            rows: [{ source_payload_bytes: String(oversized.length) }],
            rowCount: 1
          };
        }
        if (statement.includes("INSERT INTO research_evidence")) {
          const payload = String(values?.[0] ?? "");
          inlinePayloadSizes.push(Buffer.byteLength(payload));
          return { rows: [], rowCount: JSON.parse(payload).length };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 0,
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [],
        stockSnapshots: [
          {
            id: "stock-spy",
            symbol: "SPY",
            observedAt: "2026-07-20T21:59:58.000Z",
            sourceTimestamp: "2026-07-20T21:59:58.000Z",
            requestedFeed: "sip",
            effectiveFeed: "sip",
            source: "alpaca",
            requestId: "stock-spy",
            evidence: { payload: inlineLarge }
          },
          {
            id: "stock-qqq",
            symbol: "QQQ",
            observedAt: "2026-07-20T21:59:59.000Z",
            sourceTimestamp: "2026-07-20T21:59:59.000Z",
            requestedFeed: "sip",
            effectiveFeed: "sip",
            source: "alpaca",
            requestId: "stock-qqq",
            evidence: { payload: inlineLarge }
          }
        ],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [
          {
            symbol: "SPY",
            observedAt: "2026-07-20T21:59:58.000Z",
            features: { optionContractFeatures: [oversized] },
            sourceFingerprint: "feature-spy"
          },
          {
            symbol: "QQQ",
            observedAt: "2026-07-20T21:59:59.000Z",
            features: { optionContractFeatures: [oversized] },
            sourceFingerprint: "feature-qqq"
          }
        ],
        targets: []
      }) as never,
      symbols: ["SPY", "QQQ"]
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.evidenceStored, 4);
  assert.equal(inlinePayloadSizes.length, 2);
  assert.equal(inlinePayloadSizes.every((bytes) => bytes <= 4_000_000), true);
  assert.equal(featureParameters.length, 2);
  assert.equal(
    featureStatements.every((statement) =>
      /f\.observed_at = \$6::timestamptz/.test(statement) &&
      /f\.source_fingerprint = \$7/.test(statement) &&
      /FROM scheduler_leases/.test(statement)
    ),
    true
  );
  assert.equal(
    featureParameters.every((parameters) =>
      parameters.every((value) => typeof value !== "string" || value.length < 1_000)
    ),
    true
  );
});

test("rejected evidence fence prevents any batch insert", async () => {
  const sql: string[] = [];
  await assert.rejects(runPostgresResearchWorkflow({
    query: {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes("INSERT INTO research_runs")) return { rows: [{ version: "1" }], rowCount: 1 };
        if (statement.startsWith("SELECT 1 WHERE")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      }
    },
    fence, riskProfile: "aggressive", optionsEnabled: false, maxCandidates: 0,
    dependencies: {
      refreshMarketData: async () => ({ bars: [], stockSnapshots: [{ id: "stock", symbol: "SPY", observedAt: bar.observedAt, sourceTimestamp: bar.observedAt, requestedFeed: "sip", effectiveFeed: "sip", source: "alpaca", requestId: "x", evidence: {} }], optionContracts: [], optionSnapshots: [], summary: {} }) as never,
      buildFeaturesAndTargets: async () => ({ features: [], targets: [] }), symbols: ["SPY"]
    }
  }), /POSTGRES_RESEARCH_EVIDENCE_FENCE_REJECTED/);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO research_evidence")), false);
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
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
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
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
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
