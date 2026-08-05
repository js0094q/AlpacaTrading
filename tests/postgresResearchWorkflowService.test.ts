import assert from "node:assert/strict";
import test from "node:test";

import { paperExplorationThresholds } from "../src/services/paperExplorationConfig.js";
import { historicalOutcomeEvidenceConfig } from "../src/services/historicalOutcomeEvidenceService.js";
import {
  resolvePostgresResearchLaneRequest,
  runPostgresResearchWorkflow
} from "../src/services/postgresResearchWorkflowService.js";

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

test("the registered LEAPS lane enables OPRA and selects only LEAPS research", () => {
  assert.deepEqual(
    resolvePostgresResearchLaneRequest({
      stage: "lane",
      lane: "options_leaps",
      explicitOptionsEnabled: false
    }),
    { requestedLane: "options_leaps", optionsEnabled: true }
  );
});

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
  sourceFingerprint: "target-fingerprint", optionsStrategy: null,
  strategyFamily: "equity" as const, expressionId: "equity:shares"
};

const captureResearchRunTimes = async (timestamps: Date[]) => {
  let startedAt: unknown;
  let completedAt: unknown;

  await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("INSERT INTO research_runs")) {
          startedAt = values?.[5];
          return { rows: [{ version: "1" }], rowCount: 1 };
        }
        if (statement.includes("SET status = 'completed'")) {
          completedAt = values?.[5];
        }
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: false,
    maxCandidates: 10,
    dependencies: {
      now: () => timestamps.shift()!,
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [target]
      }),
      loadResearchSignals: async () => [],
      symbols: ["SPY"]
    }
  });

  return { startedAt, completedAt };
};

test("research persists the actual completion time after its market work finishes", async () => {
  const { startedAt, completedAt } = await captureResearchRunTimes([
    new Date("2026-08-04T15:01:46.668Z"),
    new Date("2026-08-04T15:20:58.923Z")
  ]);

  assert.equal(startedAt, "2026-08-04T15:01:46.668Z");
  assert.equal(completedAt, "2026-08-04T15:20:58.923Z");
});

test("research never persists completion before start when the wall clock moves backward", async () => {
  const { startedAt, completedAt } = await captureResearchRunTimes([
    new Date("2026-08-04T15:01:46.668Z"),
    new Date("2026-08-04T15:00:00.000Z")
  ]);

  assert.equal(startedAt, "2026-08-04T15:01:46.668Z");
  assert.equal(completedAt, "2026-08-04T15:01:46.668Z");
});

test("research persists current PostgreSQL evidence and selected candidates before completing", async () => {
  const sql: string[] = [];
  const telemetry: Record<string, unknown>[] = [];
  let candidateValues: readonly unknown[] = [];
  let historicalEvidenceLoads = 0;
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
    emitTelemetry: (event) => { telemetry.push(event); },
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
      loadHistoricalOutcomeEvidence: async () => {
        historicalEvidenceLoads += 1;
        return {
          state: "available",
          reasonCode: "HISTORICAL_OUTCOME_EVIDENCE_LOADED",
          config: historicalOutcomeEvidenceConfig({
            OUTCOME_LEARNING_EVIDENCE_ENABLED: "true"
          }),
          rows: [{
            id: "aggregate-spy",
            environment: "paper",
            lane: "equity",
            dimension: "symbol",
            grouping_key: "SPY",
            date_range_start: "2026-07-01T00:00:00.000Z",
            date_range_end: "2026-07-20T00:00:00.000Z",
            source_truncated: false,
            sample_count: "10",
            filled_count: "8",
            rejected_count: "1",
            canceled_count: "1",
            average_time_to_first_fill_ms: "1200",
            average_slippage_bps: "3.5",
            realized_return_average: "0.02",
            win_rate: "0.6",
            missing_join_count: "1",
            ambiguous_join_count: "0",
            unsupported_metric_count: "2",
            usable_as_evidence: true,
            source_watermark: "2026-07-20T00:00:00.000Z",
            calculated_at: "2026-07-20T21:30:00.000Z",
            schema_version: 1,
            content_hash: "a".repeat(64)
          }]
        } as never;
      },
      symbols: ["SPY"]
    }
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.workstreamResults.map(({ lane }) => lane), ["equity"]);
  assert.deepEqual(
    telemetry.find(({ event }) => event === "postgres_investment_orchestrator_completed")
      ?.enabledLanes,
    ["equity"]
  );
  assert.equal(observedSignal, cancellation.signal);
  assert.equal(result.candidatesSelected, 1);
  assert.equal(historicalEvidenceLoads, 1);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO research_evidence")), true);
  assert.equal(sql.some((statement) => statement.includes("INSERT INTO candidates")), true);
  assert.equal(sql.some((statement) => /id, decision_id, research_run_id/.test(statement)), true);
  assert.equal(sql.some((statement) => /SET status = 'completed'/.test(statement)), true);
  const signalInputs = JSON.parse(String(candidateValues[25]));
  const {
    candidateScore: _candidateScore,
    historicalOutcomeEvidence,
    ...signalInputsWithoutScore
  } = signalInputs;
  assert.deepEqual({
    ...signalInputsWithoutScore,
    decisionGates: undefined
  }, {
    targetSourceFingerprint: "target-fingerprint", marketEvidenceTimestamp: bar.observedAt,
    entryReference: 555, stopLoss: 547.5, takeProfit: 570,
    marketDecisionInputs: {
      currentTradablePrice: 555, intradayReturn: 0.01,
      stockEvidenceFreshnessStatus: "FRESH", marketSessionEligible: true,
      option: null
    },
    strategyClassification: {
      family: "equity",
      daysToExpiration: null,
      leapsMinDte: 180,
      leapsMaxDte: 730
    },
    researchEvidence: {
      signalId: null,
      provider: null,
      asOf: null,
      horizon: null,
      sourceReferences: [],
      state: "unavailable",
      scoreAdjustment: 0,
      reasonCodes: ["RESEARCH_UNAVAILABLE"]
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
  assert.deepEqual(historicalOutcomeEvidence, {
    state: "available",
    reasonCode: "HISTORICAL_OUTCOME_EVIDENCE_AVAILABLE",
    aggregateId: "aggregate-spy",
    environment: "paper",
    lane: "equity",
    dimension: "symbol",
    groupingKey: "SPY",
    dateRangeStart: "2026-07-01T00:00:00.000Z",
    dateRangeEnd: "2026-07-20T00:00:00.000Z",
    sampleCount: 10,
    filledCount: 8,
    rejectedCount: 1,
    canceledCount: 1,
    averageTimeToFirstFillMs: 1200,
    averageSlippageBps: 3.5,
    realizedReturnAverage: 0.02,
    winRate: 0.6,
    missingJoinCount: 1,
    ambiguousJoinCount: 0,
    unsupportedMetricCount: 2,
    sourceWatermark: "2026-07-20T00:00:00.000Z",
    calculatedAt: "2026-07-20T21:30:00.000Z",
    schemaVersion: 1,
    contentHash: "a".repeat(64)
  });
  assert.deepEqual(signalInputs.candidateScore.inputs, {
    confidence: 0.9,
    expectedReturn: 1.5,
    volatilityAdjustedScore: 1.2,
    ageDays: 0.08333333333333333,
    optionLiquidityScore: 0,
    preferredExpression: "shares",
    riskProfile: "aggressive"
  });
  assert.equal(signalInputs.candidateScore.total, Number(candidateValues[13]));
  assert.deepEqual(
    Object.keys(signalInputs.candidateScore.components).sort(),
    [
      "confidence",
      "expectedReturn",
      "freshness",
      "optionLiquidity",
      "riskProfile",
      "volatilityAdjusted"
    ]
  );
});

for (const boundedResult of [
  "ALPACA_OPRA_NOT_AUTHORIZED",
  "ALPACA_OPRA_DATA_UNAVAILABLE",
  "ALPACA_OPRA_QUOTE_STALE",
  "ALPACA_OPRA_GREEKS_UNAVAILABLE"
] as const) {
  test(`0DTE reports ${boundedResult} without suppressing equity or LEAPS`, async () => {
    const result = await runPostgresResearchWorkflow({
      query: {
        query: async (statement: string) => {
          if (statement.includes("to_regclass('public.learning_runs')")) {
            return {
              rows: [{ learning_model_relation: null }],
              rowCount: 1
            };
          }
          return {
            rows: statement.includes("INSERT INTO research_runs")
              ? [{ version: "1" }]
              : [],
            rowCount: 1
          };
        }
      },
      fence,
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      now: new Date("2026-07-20T22:00:00.000Z"),
      dependencies: {
        refreshMarketData: async () => ({
          bars: [bar],
          stockSnapshots: [],
          optionContracts: [],
          optionSnapshots: [],
          summary: {
            optionDataStatus: "degraded",
            optionDataRejectionReasons: [`${boundedResult}:SPY`],
            optionEvidenceByUnderlying: {
              SPY: {
                requestedFeed: "opra",
                returnedFeed: null,
                source: "rest",
                contractCount: 0,
                contractsWithUsableQuotes: 0,
                contractsWithUsableGreeks: 0,
                freshestQuoteTimestamp: null,
                selectedContract: null,
                finalBoundedResult: boundedResult
              }
            }
          }
        }) as never,
        buildFeaturesAndTargets: async () => ({
          features: [],
          targets: [target]
        }),
        symbols: ["SPY"]
      }
    });

    const byLane = new Map(
      result.workstreamResults.map((lane) => [lane.lane, lane])
    );
    assert.equal(byLane.get("equity")?.outcome, "success");
    assert.deepEqual(
      byLane.get("options_0dte")?.reason_codes,
      [boundedResult]
    );
    assert.equal(byLane.get("options_leaps")?.outcome, "no_action");
    assert.deepEqual(
      byLane.get("options_leaps")?.reason_codes,
      ["NO_ELIGIBLE_POSTGRES_CANDIDATES"]
    );
  });
}

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
    profile: "exploration_v3",
    thresholds: {
      directionScore: { previous: 0.05, current: 0.04 },
      directionalConfidence: { previous: 0.1, current: 0.05 },
      optionLiquidityScore: { previous: 0.1, current: 0.1 },
      maxOptionSpreadPct: { previous: 0.15, current: 0.15 },
      longOptionConfidence: { previous: 0.25, current: 0.2 },
      aggressiveOptionConfidence: { previous: 0.4, current: 0.35 },
      definedRiskConfidence: { previous: 0.5, current: 0.45 },
      optionExpectedReturnPct: { previous: 0.25, current: 0.2 },
      definedRiskExpectedReturnPct: { previous: 0.5, current: 0.4 },
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

test("bounded shared readiness is classified for every enabled investment lane", async () => {
  const telemetry: Record<string, unknown>[] = [];
  await assert.rejects(runPostgresResearchWorkflow({
    query: { query: async (statement: string) => ({
      rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [],
      rowCount: 1
    }) },
    fence, riskProfile: "aggressive", optionsEnabled: true, maxCandidates: 10,
    emitTelemetry: (event) => { telemetry.push(event); },
    dependencies: {
      refreshMarketData: async () => { throw new Error("POSTGRES_STOCK_SNAPSHOT_STALE:SPY"); },
      buildFeaturesAndTargets: async () => { throw new Error("must not build features"); },
      symbols: ["SPY"]
    }
  }), /POSTGRES_STOCK_SNAPSHOT_STALE:SPY/);
  const deferred = telemetry.find(
    ({ event }) => event === "postgres_investment_orchestrator_deferred"
  );
  assert.deepEqual(deferred?.enabledLanes, ["equity", "options_0dte", "options_leaps"]);
  assert.deepEqual(
    (deferred?.workstreamResults as Array<{ outcome: string }>).map(({ outcome }) => outcome),
    ["no_action", "no_action", "no_action"]
  );
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
    strategyFamily: "zero_dte_spy" as const,
    expressionId: "option:SPY260720C00555000",
    optionsStrategy: {
      alternatives: ["shares"], rationale: [],
      optionsCandidate: {
        optionSymbol: "SPY260720C00555000", type: "call", expirationDate: "2026-07-20",
        strike: 555, estimatedEntryPrice: 2, liquidityScore: 0.9,
        decisionInputs: {
          bid: 1.98, ask: 2.02, spreadDollars: 0.04, spreadPct: 0.02,
          quoteTimestamp: "2026-07-20T19:59:59.000Z",
          intradayVolatility: 0.018, hoursToExpiration: 0.5
        }
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
    now: new Date("2026-07-21T00:30:00.000Z"),
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
  const signalInputs = JSON.parse(String(candidateValues[25]));
  assert.equal(signalInputs.strategyClassification.daysToExpiration, 0);
  assert.deepEqual(signalInputs.marketDecisionInputs.option.evidenceProfile, {
    lane: "options_0dte",
    horizon: "intraday",
    priorityInputs: [
      "bid", "ask", "spreadDollars", "spreadPct", "quoteTimestamp",
      "underlyingPrice", "intradayReturn", "intradayVolatility", "volume",
      "openInterest", "hoursToExpiration", "delta", "gamma", "theta", "vega", "rho"
    ]
  });
});

test("research classifies a production long-dated option with repository LEAPS policy", async () => {
  let candidateValues: readonly unknown[] = [];
  const leapsTarget = {
    ...target,
    preferredExpression: "long_put" as const,
    strategyFamily: "leaps" as const,
    expressionId: "option:SPY270416P00500000",
    direction: "short" as const,
    optionsStrategy: {
      alternatives: ["shares"],
      rationale: [],
      optionsCandidate: {
        optionSymbol: "SPY270416P00500000",
        type: "put",
        expirationDate: "2027-04-16",
        strike: 500,
        estimatedEntryPrice: 20,
        liquidityScore: 0.9,
        decisionInputs: {
          daysToExpiration: 270, moneyness: 0.1, openInterest: 8_000,
          openInterestDate: "2026-07-17", spreadDollars: 0.5,
          spreadPct: 0.025, impliedVolatility: 0.24, delta: -0.4,
          underlyingHistoricalVolatility: 0.2
        }
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
        return {
          rows: statement.includes("INSERT INTO research_runs")
            ? [{ version: "1" }]
            : [],
          rowCount: 1
        };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [leapsTarget]
      }),
      symbols: ["SPY"]
    }
  });

  assert.equal(candidateValues[4], "SPY270416P00500000");
  assert.equal(candidateValues[12], "leaps");
  const signalInputs = JSON.parse(String(candidateValues[25]));
  assert.deepEqual(signalInputs.marketDecisionInputs.option.evidenceProfile, {
    lane: "options_leaps",
    horizon: "long_horizon",
    priorityInputs: [
      "expirationDate", "daysToExpiration", "strike", "moneyness",
      "openInterest", "openInterestDate", "spreadDollars", "spreadPct",
      "impliedVolatility", "delta", "gamma", "theta", "vega", "rho",
      "underlyingHistoricalVolatility"
    ]
  });
});

test("research keeps same-symbol zero-DTE and LEAPS evidence and candidate identities distinct", async () => {
  const evidenceRows: Array<Record<string, unknown>> = [];
  const candidateWrites: Array<readonly unknown[]> = [];
  const zeroDteTarget = {
    ...target,
    strategyFamily: "zero_dte_spy" as const,
    expressionId: "option:SPY260720C00555000",
    sourceFingerprint: "same-cycle-spy-target",
    preferredExpression: "long_call" as const,
    optionsStrategy: {
      alternatives: ["shares"], rationale: [],
      optionsCandidate: {
        optionSymbol: "SPY260720C00555000", type: "call", expirationDate: "2026-07-20",
        strike: 555, estimatedEntryPrice: 2, liquidityScore: 0.9
      }
    }
  };
  const leapsTarget = {
    ...target,
    strategyFamily: "leaps" as const,
    expressionId: "option:SPY270416C00600000",
    sourceFingerprint: "same-cycle-spy-target",
    preferredExpression: "long_call" as const,
    optionsStrategy: {
      alternatives: ["shares"], rationale: [],
      optionsCandidate: {
        optionSymbol: "SPY270416C00600000", type: "call", expirationDate: "2027-04-16",
        strike: 600, estimatedEntryPrice: 20, liquidityScore: 0.9
      }
    }
  };

  await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("INSERT INTO research_evidence")) {
          evidenceRows.push(...JSON.parse(String(values?.[0] ?? "[]")) as Array<Record<string, unknown>>);
          return { rows: [], rowCount: 2 };
        }
        if (statement.includes("INSERT INTO candidates")) {
          candidateWrites.push(values ?? []);
        }
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
        return {
          rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [],
          rowCount: 1
        };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar], stockSnapshots: [], optionContracts: [], optionSnapshots: [], summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [], targets: [zeroDteTarget, leapsTarget]
      }),
      symbols: ["SPY"]
    }
  });

  const targetEvidence = evidenceRows.filter((row) => row.evidence_type === "target_snapshot");
  assert.deepEqual(
    targetEvidence.map((row) => row.source_key).sort(),
    [
      "SPY:2026-07-20T20:00:00.000Z:aggressive:leaps:option:SPY270416C00600000",
      "SPY:2026-07-20T20:00:00.000Z:aggressive:zero_dte_spy:option:SPY260720C00555000"
    ].sort()
  );
  assert.equal(new Set(targetEvidence.map((row) => row.id)).size, 2);
  assert.equal(candidateWrites.length, 2);
  assert.equal(new Set(candidateWrites.map((values) => values[0])).size, 2);
  assert.deepEqual(
    candidateWrites.map((values) => [values[12], values[4]]).sort((left, right) =>
      String(left[0]).localeCompare(String(right[0]))
    ),
    [
      ["leaps", "SPY270416C00600000"],
      ["zero_dte_spy", "SPY260720C00555000"]
    ]
  );
});

test("research candidates retain stored target families when current reclassification agrees", async () => {
  const candidateWrites: Array<readonly unknown[]> = [];
  const sharedOptionTarget = {
    ...target,
    sourceFingerprint: "same-target-source",
    strategyFamily: "zero_dte_spy" as const,
    expressionId: "option:SPY260720C00555000",
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
        if (statement.includes("INSERT INTO candidates")) candidateWrites.push(values ?? []);
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
        return {
          rows: statement.includes("INSERT INTO research_runs") ? [{ version: "1" }] : [],
          rowCount: 1
        };
      }
    },
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar], stockSnapshots: [], optionContracts: [], optionSnapshots: [], summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [
          sharedOptionTarget,
          { ...sharedOptionTarget, strategyFamily: "standard_option" as const }
        ]
      }),
      symbols: ["SPY"]
    }
  });

  assert.equal(candidateWrites.length, 2);
  assert.equal(new Set(candidateWrites.map((values) => values[0])).size, 2);
  assert.deepEqual(
    candidateWrites.map((values) => [values[12], values[4]]).sort((left, right) =>
      String(left[0]).localeCompare(String(right[0]))
    ),
    [
      ["standard_option", "SPY260720C00555000"],
      ["zero_dte_spy", "SPY260720C00555000"]
    ]
  );
});

const storedResearchSignal = (overrides: Record<string, unknown> = {}) => ({
  id: "research_signal_" + "a".repeat(64),
  provider: "public-equity-export",
  providerSignalId: "spy-2026-07-20",
  symbol: "SPY",
  asOf: "2026-07-20T20:00:00.000Z",
  horizon: "long_term",
  thesisSummary: "Imported long-duration thesis.",
  thesisDirection: "bullish",
  confidence: 0.7,
  catalysts: ["Earnings"],
  catalystDates: ["2026-07-20T19:00:00.000Z"],
  risks: ["Margin compression"],
  invalidationConditions: ["Guidance reduction"],
  contradictionStatus: "not_contradicted",
  contradictionReason: null,
  valuationSummary: "Imported valuation context.",
  sourceReferences: ["research://public-equity-export/spy-2026-07-20"],
  expiresOrReviewAt: "2026-08-20T20:00:00.000Z",
  ingestionTimestamp: "2026-07-20T20:30:00.000Z",
  contentHash: "b".repeat(64),
  schemaVersion: 1,
  ...overrides
});

const researchAwareQuery = (
  onCandidate: (values: readonly unknown[]) => void
) => ({
  query: async (statement: string, values?: readonly unknown[]) => {
    if (statement.includes("INSERT INTO candidates")) onCandidate(values ?? []);
    if (statement.includes("to_regclass('public.learning_runs')")) {
      return { rows: [{ learning_model_relation: null }], rowCount: 1 };
    }
    return {
      rows: statement.includes("INSERT INTO research_runs")
        ? [{ version: "1" }]
        : [],
      rowCount: 1
    };
  }
});

test("current stored research changes equity score and records bounded provenance", async () => {
  let candidateValues: readonly unknown[] = [];
  const result = await runPostgresResearchWorkflow({
    query: researchAwareQuery((values) => { candidateValues = values; }),
    fence,
    riskProfile: "aggressive",
    optionsEnabled: false,
    maxCandidates: 10,
    now: new Date("2026-07-20T22:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [{
          ...target,
          confidence: 0.5,
          expectedReturn: 0.05,
          volatilityAdjustedScore: 0.2
        }]
      }),
      loadResearchSignals: async () => [storedResearchSignal()] as never,
      symbols: ["SPY"]
    }
  });

  const signalInputs = JSON.parse(String(candidateValues[25]));
  assert.equal(signalInputs.candidateScore.research.scoreAdjustment, 3);
  assert.equal(
    signalInputs.candidateScore.total,
    signalInputs.candidateScore.baseTotal + 3
  );
  assert.equal(candidateValues[13], signalInputs.candidateScore.total);
  assert.deepEqual(signalInputs.researchEvidence, {
    signalId: "research_signal_" + "a".repeat(64),
    provider: "public-equity-export",
    asOf: "2026-07-20T20:00:00.000Z",
    horizon: "long_term",
    sourceReferences: [
      "research://public-equity-export/spy-2026-07-20"
    ],
    state: "current",
    scoreAdjustment: 3,
    reasonCodes: ["RESEARCH_CURRENT", "RESEARCH_DIRECTION_ALIGNED"]
  });
  assert.ok(
    result.workstreamResults[0]?.evidence_references.includes(
      "research_signal:" + "research_signal_" + "a".repeat(64)
    )
  );
});

test("LEAPS consumes only current long-horizon research without replacing option evidence", async () => {
  let candidateValues: readonly unknown[] = [];
  const leapsTarget = {
    ...target,
    confidence: 0.5,
    expectedReturn: 0.05,
    volatilityAdjustedScore: 0.2,
    preferredExpression: "long_call" as const,
    strategyFamily: "leaps" as const,
    expressionId: "option:SPY270416C00600000",
    optionsStrategy: {
      alternatives: ["shares"],
      rationale: [],
      optionsCandidate: {
        optionSymbol: "SPY270416C00600000",
        type: "call",
        expirationDate: "2027-04-16",
        strike: 600,
        estimatedEntryPrice: 20,
        liquidityScore: 0.9,
        decisionInputs: {
          daysToExpiration: 270,
          moneyness: 0.08,
          openInterest: 8_000,
          openInterestDate: "2026-07-17",
          spreadDollars: 0.5,
          spreadPct: 0.025,
          impliedVolatility: 0.24,
          delta: 0.4,
          underlyingHistoricalVolatility: 0.2
        }
      }
    }
  };

  const result = await runPostgresResearchWorkflow({
    query: researchAwareQuery((values) => { candidateValues = values; }),
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    requestedLane: "options_leaps",
    maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [leapsTarget]
      }),
      loadResearchSignals: async () => [storedResearchSignal({
        asOf: "2026-07-20T16:00:00.000Z"
      })] as never,
      symbols: ["SPY"]
    }
  });

  const signalInputs = JSON.parse(String(candidateValues[25]));
  assert.deepEqual(
    result.workstreamResults.map(({ lane }) => lane),
    ["options_leaps"]
  );
  assert.equal(candidateValues[12], "leaps");
  assert.equal(signalInputs.researchEvidence.state, "current");
  assert.equal(signalInputs.researchEvidence.scoreAdjustment, 3);
  assert.deepEqual(signalInputs.marketDecisionInputs.option.evidenceProfile, {
    lane: "options_leaps",
    horizon: "long_horizon",
    priorityInputs: [
      "expirationDate", "daysToExpiration", "strike", "moneyness",
      "openInterest", "openInterestDate", "spreadDollars", "spreadPct",
      "impliedVolatility", "delta", "gamma", "theta", "vega", "rho",
      "underlyingHistoricalVolatility"
    ]
  });
});

test("the explicit LEAPS lane persists its option-backed target as a LEAPS option", async () => {
  let candidateValues: readonly unknown[] = [];
  const optionBackedSharesTarget = {
    ...target,
    preferredExpression: "shares" as const,
    strategyFamily: "leaps" as const,
    expressionId: "option:SPY270416C00600000",
    optionsStrategy: {
      alternatives: ["long_call"],
      rationale: ["Option candidate selected for the explicit LEAPS lane"],
      optionsCandidate: {
        optionSymbol: "SPY270416C00600000",
        type: "call",
        expirationDate: "2027-04-16",
        strike: 600,
        estimatedEntryPrice: 20,
        liquidityScore: 0.9,
        decisionInputs: {
          bid: 19.75,
          ask: 20.25,
          requestedFeed: "opra",
          effectiveFeed: "opra",
          provider: "alpaca"
        }
      }
    }
  };

  await runPostgresResearchWorkflow({
    query: researchAwareQuery((values) => { candidateValues = values; }),
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    requestedLane: "options_leaps",
    maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [optionBackedSharesTarget]
      }),
      loadResearchSignals: async () => [],
      symbols: ["SPY"]
    }
  });

  assert.equal(candidateValues[4], "SPY270416C00600000");
  assert.equal(candidateValues[5], "option");
  assert.equal(candidateValues[11], "long_call");
  assert.equal(candidateValues[12], "leaps");
});

test("the explicit 0DTE lane persists only the SPY same-day option target", async () => {
  const candidateWrites: Array<readonly unknown[]> = [];
  const optionBackedTarget = (symbol: string, optionSymbol: string) => ({
    ...target,
    symbol,
    preferredExpression: "shares" as const,
    strategyFamily: "zero_dte_spy" as const,
    expressionId: `option:${optionSymbol}`,
    optionsStrategy: {
      alternatives: ["long_call"],
      rationale: ["Same-day option candidate"],
      optionsCandidate: {
        optionSymbol,
        type: "call",
        expirationDate: "2026-07-20",
        strike: symbol === "SPY" ? 555 : 60,
        estimatedEntryPrice: 2,
        liquidityScore: 0.9,
        decisionInputs: {
          bid: 1.98,
          ask: 2.02,
          requestedFeed: "opra",
          effectiveFeed: "opra",
          provider: "alpaca"
        }
      }
    }
  });

  const result = await runPostgresResearchWorkflow({
    query: researchAwareQuery((values) => { candidateWrites.push(values); }),
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    requestedLane: "options_0dte",
    maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [
          optionBackedTarget("SPY", "SPY260720C00555000"),
          optionBackedTarget("XLF", "XLF260720C00060000")
        ]
      }),
      loadResearchSignals: async () => [],
      symbols: ["SPY", "XLF"]
    }
  });

  assert.equal(result.candidatesSelected, 1);
  assert.equal(candidateWrites.length, 1);
  assert.equal(candidateWrites[0]?.[2], "SPY");
  assert.equal(candidateWrites[0]?.[4], "SPY260720C00555000");
  assert.equal(candidateWrites[0]?.[5], "option");
  assert.equal(candidateWrites[0]?.[11], "long_call");
  assert.equal(candidateWrites[0]?.[12], "zero_dte_spy");
});

test("the normal options cycle persists zero_dte_spy only for SPY", async () => {
  const candidateWrites: Array<readonly unknown[]> = [];
  const zeroDteTarget = (symbol: string, optionSymbol: string) => ({
    ...target,
    symbol,
    preferredExpression: "long_call" as const,
    strategyFamily: "zero_dte_spy" as const,
    expressionId: `option:${optionSymbol}`,
    optionsStrategy: {
      alternatives: ["long_call"],
      rationale: ["Same-day option candidate"],
      optionsCandidate: {
        optionSymbol,
        type: "call",
        expirationDate: "2026-07-20",
        strike: symbol === "SPY" ? 555 : 300,
        estimatedEntryPrice: 2,
        liquidityScore: 0.9,
        decisionInputs: {
          bid: 1.98,
          ask: 2.02,
          requestedFeed: "opra",
          effectiveFeed: "opra",
          provider: "alpaca"
        }
      }
    }
  });

  const result = await runPostgresResearchWorkflow({
    query: researchAwareQuery((values) => { candidateWrites.push(values); }),
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    now: new Date("2026-07-20T18:00:00.000Z"),
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [
          zeroDteTarget("AMZN", "AMZN260720C00300000"),
          zeroDteTarget("SPY", "SPY260720C00555000")
        ]
      }),
      loadResearchSignals: async () => [],
      symbols: ["AMZN", "SPY"]
    }
  });

  assert.equal(result.candidatesSelected, 1);
  assert.equal(candidateWrites.length, 1);
  assert.equal(candidateWrites[0]?.[2], "SPY");
  assert.equal(candidateWrites[0]?.[4], "SPY260720C00555000");
  assert.equal(candidateWrites[0]?.[12], "zero_dte_spy");
});

test("0DTE remains independent and records only a current-session catalyst", async () => {
  const run = async (signals: readonly unknown[]) => {
    let candidateValues: readonly unknown[] = [];
    let lookupCount = 0;
    const zeroDteTarget = {
      ...target,
      confidence: 0.5,
      expectedReturn: 0.05,
      volatilityAdjustedScore: 0.2,
      preferredExpression: "long_call" as const,
      strategyFamily: "zero_dte_spy" as const,
      expressionId: "option:SPY260720C00555000",
      optionsStrategy: {
        alternatives: ["shares"],
        rationale: [],
        optionsCandidate: {
          optionSymbol: "SPY260720C00555000",
          type: "call",
          expirationDate: "2026-07-20",
          strike: 555,
          estimatedEntryPrice: 2,
          liquidityScore: 0.9,
          decisionInputs: {
            bid: 1.98,
            ask: 2.02,
            spreadDollars: 0.04,
            spreadPct: 0.02,
            quoteTimestamp: "2026-07-20T19:59:59.000Z",
            intradayVolatility: 0.018,
            hoursToExpiration: 0.5
          }
        }
      }
    };
    const result = await runPostgresResearchWorkflow({
      query: researchAwareQuery((values) => { candidateValues = values; }),
      fence,
      riskProfile: "aggressive",
      optionsEnabled: true,
      maxCandidates: 10,
      now: new Date("2026-07-21T00:30:00.000Z"),
      dependencies: {
        refreshMarketData: async () => ({
          bars: [bar],
          stockSnapshots: [],
          optionContracts: [],
          optionSnapshots: [],
          summary: {}
        }) as never,
        buildFeaturesAndTargets: async () => ({
          features: [],
          targets: [zeroDteTarget]
        }),
        loadResearchSignals: async () => {
          lookupCount += 1;
          return signals as never;
        },
        symbols: ["SPY"]
      }
    });
    return {
      result,
      lookupCount,
      signalInputs: JSON.parse(String(candidateValues[25]))
    };
  };

  const withCatalyst = await run([storedResearchSignal()]);
  const withoutResearch = await run([]);

  assert.equal(withCatalyst.result.candidatesSelected, 1);
  assert.equal(withCatalyst.lookupCount, 1);
  assert.equal(withCatalyst.signalInputs.researchEvidence.scoreAdjustment, 0);
  assert.deepEqual(withCatalyst.signalInputs.researchEvidence.reasonCodes, [
    "RESEARCH_CURRENT",
    "RESEARCH_CURRENT_SESSION_CATALYST"
  ]);
  assert.equal("thesisSummary" in withCatalyst.signalInputs.researchEvidence, false);
  assert.equal("valuationSummary" in withCatalyst.signalInputs.researchEvidence, false);
  assert.equal(withoutResearch.result.candidatesSelected, 1);
  assert.equal(withoutResearch.lookupCount, 1);
  assert.deepEqual(withoutResearch.signalInputs.researchEvidence, {
    signalId: null,
    provider: null,
    asOf: null,
    horizon: null,
    sourceReferences: [],
    state: "unavailable",
    scoreAdjustment: 0,
    reasonCodes: ["RESEARCH_0DTE_NO_CURRENT_SESSION_CATALYST"]
  });
});

test("research lookup failure is bounded to evidence and does not stop lane evaluation", async () => {
  let candidateValues: readonly unknown[] = [];
  const telemetry: Record<string, unknown>[] = [];
  const result = await runPostgresResearchWorkflow({
    query: researchAwareQuery((values) => { candidateValues = values; }),
    fence,
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    now: new Date("2026-07-20T22:00:00.000Z"),
    emitTelemetry: (event) => { telemetry.push(event); },
    dependencies: {
      refreshMarketData: async () => ({
        bars: [bar],
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [target]
      }),
      loadResearchSignals: async () => {
        throw new Error("provider details must not escape into decision evidence");
      },
      symbols: ["SPY"]
    }
  });

  const signalInputs = JSON.parse(String(candidateValues[25]));
  assert.equal(result.status, "completed");
  assert.equal(result.candidatesSelected, 1);
  assert.equal(result.research.lookupStatus, "RESEARCH_LOOKUP_UNAVAILABLE");
  assert.deepEqual(signalInputs.researchEvidence.reasonCodes, [
    "RESEARCH_LOOKUP_UNAVAILABLE"
  ]);
  assert.deepEqual(
    telemetry.find(({ event }) => event === "postgres_research_signal_lookup"),
    {
      event: "postgres_research_signal_lookup",
      researchRunId: result.runId,
      cycleId: result.runId,
      outcome: "unavailable",
      reasonCode: "RESEARCH_LOOKUP_UNAVAILABLE",
      retryCount: 0
    }
  );
});

test("research for one symbol does not change an unrelated symbol", async () => {
  const candidates = new Map<string, Record<string, unknown>>();
  await runPostgresResearchWorkflow({
    query: {
      query: async (statement: string, values?: readonly unknown[]) => {
        if (statement.includes("INSERT INTO candidates")) {
          candidates.set(
            String(values?.[2]),
            JSON.parse(String(values?.[25])) as Record<string, unknown>
          );
        }
        if (statement.includes("to_regclass('public.learning_runs')")) {
          return { rows: [{ learning_model_relation: null }], rowCount: 1 };
        }
        return {
          rows: statement.includes("INSERT INTO research_runs")
            ? [{ version: "1" }]
            : [],
          rowCount: 1
        };
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
        stockSnapshots: [],
        optionContracts: [],
        optionSnapshots: [],
        summary: {}
      }) as never,
      buildFeaturesAndTargets: async () => ({
        features: [],
        targets: [
          {
            ...target,
            confidence: 0.5,
            expectedReturn: 0.05,
            volatilityAdjustedScore: 0.2
          },
          {
            ...target,
            symbol: "QQQ",
            sourceFingerprint: "qqq-target-fingerprint",
            confidence: 0.5,
            expectedReturn: 0.05,
            volatilityAdjustedScore: 0.2
          }
        ]
      }),
      loadResearchSignals: async ({ symbols }) => {
        assert.deepEqual(symbols, ["SPY", "QQQ"]);
        return [storedResearchSignal()] as never;
      },
      symbols: ["SPY", "QQQ"]
    }
  });

  const spy = candidates.get("SPY") as {
    researchEvidence: { state: string; scoreAdjustment: number };
  };
  const qqq = candidates.get("QQQ") as {
    researchEvidence: { state: string; scoreAdjustment: number };
  };
  assert.deepEqual(spy.researchEvidence, {
    signalId: "research_signal_" + "a".repeat(64),
    provider: "public-equity-export",
    asOf: "2026-07-20T20:00:00.000Z",
    horizon: "long_term",
    sourceReferences: [
      "research://public-equity-export/spy-2026-07-20"
    ],
    state: "current",
    scoreAdjustment: 3,
    reasonCodes: ["RESEARCH_CURRENT", "RESEARCH_DIRECTION_ALIGNED"]
  });
  assert.deepEqual(qqq.researchEvidence, {
    signalId: null,
    provider: null,
    asOf: null,
    horizon: null,
    sourceReferences: [],
    state: "unavailable",
    scoreAdjustment: 0,
    reasonCodes: ["RESEARCH_UNAVAILABLE"]
  });
});
