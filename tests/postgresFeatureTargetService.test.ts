import assert from "node:assert/strict";
import test from "node:test";

import { buildPostgresFeaturesAndTargets } from "../src/services/postgresFeatureTargetService.js";
import type { PostgresMarketBar, PostgresStockSnapshot } from "../src/repositories/postgres/postgresMarketDataRepository.js";

const fence = {
  jobName: "research-daily",
  workstream: "research",
  ownerId: "worker-1",
  runId: "run-1",
  fencingToken: "10"
};

const context = {
  transaction: {} as never,
  operationId: "feature-target-1",
  actorId: fence.ownerId,
  schedulerFence: fence
};

const bars = (count: number): PostgresMarketBar[] => Array.from({ length: count }, (_, index) => {
  const close = 500 + index;
  const observedAt = new Date(Date.UTC(2026, 4, 1 + index, 20)).toISOString();
  return {
    symbol: "SPY",
    timeframe: "1Day",
    observedAt,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1_000_000 + index * 1_000,
    source: "alpaca",
    requestId: "request-bars"
  };
});

const stockSnapshot = (overrides: Record<string, unknown> = {}): PostgresStockSnapshot => ({
  id: "stock-SPY-current", symbol: "SPY",
  observedAt: "2026-06-29T20:00:00.000Z", sourceTimestamp: "2026-06-29T19:59:59.000Z",
  requestedFeed: "sip", effectiveFeed: "sip", source: "alpaca", requestId: "stock-snapshot",
  evidence: {
    latestTradePrice: 560, bidPrice: 559.9, askPrice: 560.1, midpoint: 560,
    spread: 0.2, spreadPct: 0.0357142857, dailyOpen: 555, dailyHigh: 562,
    dailyLow: 554, dailyClose: 560, dailyVwap: 558, dailyVolume: 1_500_000,
    dailyReturn: 0.012, returnFromOpen: 0.009009, distanceFromVwap: 0.003584,
    relativeCurrentDayVolume: 1.4, freshnessStatus: "FRESH", dataQualityStatus: "COMPLETE",
    quoteTimestamp: "2026-06-29T19:59:59.000Z", ...overrides
  }
});

test("existing indicators and target thresholds persist genuine PostgreSQL features and targets", async () => {
  const stored: { features?: unknown[]; targets?: unknown[] } = {};
  const repository = {
    upsertFeatureSnapshots: async (rows: unknown[]) => {
      stored.features = rows;
      return { stored: rows.length };
    },
    upsertTargetSnapshots: async (rows: unknown[]) => {
      stored.targets = rows;
      return { stored: rows.length };
    }
  } as never;

  const result = await buildPostgresFeaturesAndTargets({
    bars: bars(60),
    stockSnapshots: [stockSnapshot()],
    optionContracts: [],
    optionSnapshots: [],
    riskProfile: "aggressive",
    optionsEnabled: false,
    repository,
    context
  });

  assert.equal(result.features.length, 60);
  assert.equal(result.targets.length, 1);
  const latest = result.features.at(-1)!;
  assert.equal(latest.features.close, 559);
  assert.equal(latest.features.trend, "bullish");
  assert.equal(latest.features.rsi14, 100);
  const target = result.targets[0]!;
  assert.equal(target.direction, "long");
  assert.equal(target.riskProfile, "aggressive");
  assert.notEqual(target.preferredExpression, "none");
  assert.equal(stored.features?.length, 60);
  assert.equal(stored.targets?.length, 1);
});

test("feature generation fails closed when strategy history is insufficient", async () => {
  await assert.rejects(
    buildPostgresFeaturesAndTargets({
      bars: bars(49),
      stockSnapshots: [stockSnapshot()],
      optionContracts: [],
      optionSnapshots: [],
      riskProfile: "aggressive",
      optionsEnabled: false,
      repository: {
        upsertFeatureSnapshots: async () => { throw new Error("must not write"); },
        upsertTargetSnapshots: async () => { throw new Error("must not write"); }
      } as never,
      context
    }),
    /POSTGRES_FEATURE_HISTORY_INSUFFICIENT:SPY/
  );
});

test("option feature evidence uses persisted quote timestamps and liquidity without synthetic prices", async () => {
  const result = await buildPostgresFeaturesAndTargets({
    bars: bars(60),
    stockSnapshots: [stockSnapshot()],
    optionContracts: [{
      optionSymbol: "SPY260829C00560000",
      underlyingSymbol: "SPY",
      type: "call",
      expirationDate: "2026-08-29",
      strike: 560,
      multiplier: 100,
      tradable: true,
      source: "alpaca",
      requestId: "contracts",
      observedAt: "2026-06-29T20:00:00.000Z"
    }],
    optionSnapshots: [{
      optionSymbol: "SPY260829C00560000",
      underlyingSymbol: "SPY",
      observedAt: "2026-06-29T20:00:00.000Z",
      quoteTimestamp: "2026-06-29T19:59:59.000Z",
      bid: 4.9,
      ask: 5.1,
      midpoint: 5,
      volume: 500,
      openInterest: 1_000,
      impliedVolatility: 0.25,
      delta: 0.5,
      source: "alpaca",
      requestId: "options",
      evidence: {}
    }],
    riskProfile: "aggressive",
    optionsEnabled: true,
    repository: {
      upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length })
    } as never,
    context
  });

  const latest = result.features.at(-1)!.features;
  assert.equal(latest.atmImpliedVol, 0.25);
  assert.equal(latest.callLiquidityAvailable, 1);
  assert.equal(latest.marketEvidenceTimestamp, "2026-06-29T19:59:59.000Z");
});

test("feature source fingerprints bind the underlying market values", async () => {
  const build = (sourceBars: PostgresMarketBar[]) => buildPostgresFeaturesAndTargets({
    bars: sourceBars,
    stockSnapshots: [stockSnapshot()],
    optionContracts: [],
    optionSnapshots: [],
    riskProfile: "moderate",
    optionsEnabled: false,
    repository: {
      upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
      upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length })
    } as never,
    context
  });
  const baseline = await build(bars(60));
  const changedBars = bars(60);
  changedBars[59] = { ...changedBars[59]!, close: 560, high: 562 };
  const changed = await build(changedBars);
  assert.notEqual(
    baseline.features.at(-1)!.sourceFingerprint,
    changed.features.at(-1)!.sourceFingerprint
  );
});

test("normalized SIP observations become decision features and change live entry and score inputs", async () => {
  const build = (snapshot: PostgresStockSnapshot) => buildPostgresFeaturesAndTargets({
    bars: bars(60), stockSnapshots: [snapshot], optionContracts: [], optionSnapshots: [],
    riskProfile: "moderate", optionsEnabled: false,
    repository: { upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }), upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length }) } as never,
    context
  });
  const baseline = await build(stockSnapshot());
  const moved = await build(stockSnapshot({ latestTradePrice: 552, bidPrice: 551.9, askPrice: 552.1, midpoint: 552, dailyClose: 552, returnFromOpen: -0.005405, distanceFromVwap: -0.010753 }));
  const feature = baseline.features.at(-1)!.features;
  assert.equal(feature.currentTradablePrice, 560);
  assert.equal(feature.bidAskMidpoint, 560);
  assert.equal(feature.intradayReturn, 0.009009);
  assert.equal(feature.distanceFromVwap, 0.003584);
  assert.equal(feature.marketSessionEligible, true);
  assert.equal(baseline.targets[0]!.entryReference, 560);
  assert.equal(moved.targets[0]!.entryReference, 552);
  assert.notEqual(baseline.targets[0]!.expectedReturn, moved.targets[0]!.expectedReturn);
});

test("stale SIP evidence rejects the decision instead of substituting bar values", async () => {
  await assert.rejects(buildPostgresFeaturesAndTargets({
    bars: bars(60), stockSnapshots: [stockSnapshot({ freshnessStatus: "STALE" })], optionContracts: [], optionSnapshots: [],
    riskProfile: "moderate", optionsEnabled: false,
    repository: { upsertFeatureSnapshots: async () => { throw new Error("must not write"); }, upsertTargetSnapshots: async () => { throw new Error("must not write"); } } as never,
    context
  }), /POSTGRES_DECISION_STOCK_EVIDENCE_STALE:SPY/);
});

test("Alpaca option quote and Greeks become contract eligibility and auditable ranking inputs", async () => {
  const result = await buildPostgresFeaturesAndTargets({
    bars: bars(60), stockSnapshots: [stockSnapshot()],
    optionContracts: [{ optionSymbol: "SPY260829C00560000", underlyingSymbol: "SPY", type: "call", expirationDate: "2026-08-29", strike: 560, multiplier: 100, tradable: true, source: "alpaca", requestId: "contracts", observedAt: "2026-06-29T20:00:00.000Z" }],
    optionSnapshots: [{ optionSymbol: "SPY260829C00560000", underlyingSymbol: "SPY", observedAt: "2026-06-29T20:00:00.000Z", quoteTimestamp: "2026-06-29T19:59:59.000Z", bid: 4.9, ask: 5.1, midpoint: 5, last: 5, volume: 500, openInterest: 1_000, impliedVolatility: 0.25, delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, source: "alpaca", requestId: "options", evidence: { requestedFeed: "opra", effectiveFeed: "opra" } }],
    riskProfile: "aggressive", optionsEnabled: true,
    repository: { upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }), upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length }) } as never,
    context
  });
  const feature = result.features.at(-1)!.features;
  assert.equal(feature.optionDelta, 0.5);
  assert.equal(feature.optionGamma, 0.02);
  assert.equal(feature.optionTheta, -0.08);
  assert.equal(feature.optionVega, 0.12);
  assert.equal(feature.optionMoneyness, 0);
  assert.equal(feature.optionIntrinsicValue, 0);
  assert.equal(feature.optionExtrinsicValue, 5);
  assert.equal(feature.optionQuoteFreshnessStatus, "fresh");
  assert.equal(feature.optionContractEligible, true);
  const candidate = result.targets[0]!.optionsStrategy?.optionsCandidate as Record<string, unknown>;
  assert.deepEqual(candidate.decisionInputs, { delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, impliedVolatility: 0.25, spreadPct: (5.1 - 4.9) / 5, moneyness: 0, quoteFreshnessStatus: "fresh", feed: "opra" });
});
