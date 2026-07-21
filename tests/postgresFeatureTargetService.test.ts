import assert from "node:assert/strict";
import test from "node:test";

import { buildPostgresFeaturesAndTargets } from "../src/services/postgresFeatureTargetService.js";
import type {
  PostgresMarketBar,
  PostgresOptionContract,
  PostgresOptionSnapshot,
  PostgresStockSnapshot
} from "../src/repositories/postgres/postgresMarketDataRepository.js";

type CurrentOptionsDecisionInputs = {
  volatilityAdjustmentSource: "existing_strategy_baseline" | "alpaca_implied_volatility";
  impliedVolatility: number | null;
};

const isCurrentOptionsDecisionInputs = (
  value: unknown
): value is CurrentOptionsDecisionInputs => {
  if (value === null || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const source = input.volatilityAdjustmentSource;
  return (
    (source === "existing_strategy_baseline" || source === "alpaca_implied_volatility") &&
    (input.impliedVolatility === null || typeof input.impliedVolatility === "number")
  );
};

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

const optionContractFixture = (
  optionSymbol: string,
  strike: number,
  overrides: Partial<PostgresOptionContract> = {}
): PostgresOptionContract => ({
  optionSymbol,
  underlyingSymbol: "SPY",
  type: "call",
  expirationDate: "2026-08-29",
  strike,
  multiplier: 100,
  tradable: true,
  status: "active",
  contractId: `contract-${optionSymbol}`,
  exerciseStyle: "american",
  openInterest: 1_000,
  openInterestDate: "2026-06-28",
  closePrice: 4.8,
  closePriceDate: "2026-06-28",
  source: "alpaca",
  requestId: "contracts",
  observedAt: "2026-06-29T20:00:00.000Z",
  evidence: {},
  ...overrides
});

const optionSnapshotFixture = (
  optionSymbol: string,
  overrides: Partial<PostgresOptionSnapshot> = {}
): PostgresOptionSnapshot => ({
  optionSymbol,
  underlyingSymbol: "SPY",
  observedAt: "2026-06-29T20:00:00.000Z",
  quoteTimestamp: "2026-06-29T19:59:59.000Z",
  tradeTimestamp: "2026-06-29T19:59:58.000Z",
  snapshotTimestamp: "2026-06-29T19:59:59.000Z",
  underlyingPrice: 560,
  bid: 4.9,
  ask: 5.1,
  bidSize: 20,
  askSize: 25,
  midpoint: 5,
  spread: 0.2,
  spreadPct: 0.04,
  last: 5,
  volume: 500,
  openInterest: 1_000,
  impliedVolatility: 0.25,
  delta: 0.5,
  gamma: 0.02,
  theta: -0.08,
  vega: 0.12,
  rho: 0.03,
  freshnessStatus: "fresh",
  requestedFeed: "opra",
  effectiveFeed: "opra",
  endpoint: "/v1beta1/options/snapshots/SPY",
  pageToken: null,
  retrievedAt: "2026-06-29T20:00:00.000Z",
  persistedAt: "2026-06-29T20:00:01.000Z",
  source: "alpaca",
  requestId: "options",
  evidence: { requestedFeed: "opra", effectiveFeed: "opra" },
  ...overrides
});

const buildOptionFeaturesFixture = (input: {
  contracts: PostgresOptionContract[];
  snapshots: PostgresOptionSnapshot[];
}) => buildPostgresFeaturesAndTargets({
  bars: bars(60),
  stockSnapshots: [stockSnapshot()],
  optionContracts: input.contracts,
  optionSnapshots: input.snapshots,
  riskProfile: "aggressive",
  optionsEnabled: true,
  repository: {
    upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }),
    upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length })
  } as never,
  context
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
      status: "active",
      source: "alpaca",
      requestId: "contracts",
      observedAt: "2026-06-29T20:00:00.000Z"
    }],
    optionSnapshots: [{
      optionSymbol: "SPY260829C00560000",
      underlyingSymbol: "SPY",
      observedAt: "2026-06-29T20:00:00.000Z",
      quoteTimestamp: "2026-06-29T19:59:59.000Z",
      underlyingPrice: 560,
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

test("Alpaca option quote, liquidity, IV, and all five Greeks propagate into classified decision features", async () => {
  const result = await buildPostgresFeaturesAndTargets({
    bars: bars(60), stockSnapshots: [stockSnapshot()],
    optionContracts: [{ optionSymbol: "SPY260829C00560000", underlyingSymbol: "SPY", type: "call", expirationDate: "2026-08-29", strike: 560, multiplier: 100, tradable: true, status: "active", contractId: "contract-spy", exerciseStyle: "american", openInterest: 1_000, openInterestDate: "2026-06-28", closePrice: 4.8, closePriceDate: "2026-06-28", source: "alpaca", requestId: "contracts", observedAt: "2026-06-29T20:00:00.000Z", evidence: {} }],
    optionSnapshots: [{ optionSymbol: "SPY260829C00560000", underlyingSymbol: "SPY", observedAt: "2026-06-29T20:00:00.000Z", quoteTimestamp: "2026-06-29T19:59:59.000Z", tradeTimestamp: "2026-06-29T19:59:58.000Z", snapshotTimestamp: "2026-06-29T19:59:59.000Z", underlyingPrice: 560, bid: 4.9, ask: 5.1, bidSize: 20, askSize: 25, midpoint: 5, spread: 0.2, spreadPct: 0.04, last: 5, volume: 500, openInterest: 1_000, impliedVolatility: 0.25, delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, rho: 0.03, freshnessStatus: "fresh", requestedFeed: "opra", effectiveFeed: "opra", endpoint: "/v1beta1/options/snapshots/SPY", pageToken: null, retrievedAt: "2026-06-29T20:00:00.000Z", persistedAt: "2026-06-29T20:00:01.000Z", source: "alpaca", requestId: "options", evidence: { requestedFeed: "opra", effectiveFeed: "opra" } }],
    riskProfile: "aggressive", optionsEnabled: true,
    repository: { upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }), upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length }) } as never,
    context
  });
  const feature = result.features.at(-1)!.features;
  assert.equal(feature.optionDelta, 0.5);
  assert.equal(feature.optionGamma, 0.02);
  assert.equal(feature.optionTheta, -0.08);
  assert.equal(feature.optionVega, 0.12);
  assert.equal(feature.optionRho, 0.03);
  assert.equal(feature.optionUnderlyingPrice, 560);
  assert.equal(feature.optionDailyVolume, 500);
  assert.equal(feature.optionOpenInterest, 1_000);
  assert.equal(feature.optionTradable, true);
  assert.equal(feature.optionActiveStatus, true);
  assert.equal(feature.optionLiquidityResult, "passed");
  assert.equal(feature.optionFeedValidated, true);
  assert.equal(feature.optionMoneyness, 0);
  assert.equal(feature.optionIntrinsicValue, 0);
  assert.equal(feature.optionExtrinsicValue, 5);
  assert.equal(feature.optionQuoteFreshnessStatus, "fresh");
  assert.equal(feature.optionContractEligible, true);
  const candidate = result.targets[0]!.optionsStrategy?.optionsCandidate as Record<string, unknown>;
  assert.deepEqual(candidate.decisionInputs, { delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, rho: 0.03, impliedVolatility: 0.25, volume: 500, openInterest: 1_000, spreadPct: 0.04, moneyness: 0, quoteFreshnessStatus: "fresh", feed: "opra" });
  const classifications = feature.optionFieldClassifications as Record<string, string>;
  assert.equal(classifications.impliedVolatility, "decision_input");
  assert.equal(classifications.delta, "audit_only");
  assert.equal(classifications.rho, "audit_only");
  assert.equal(classifications.dailyVolume, "execution_gate");
  assert.equal(classifications.openInterest, "execution_gate");
  assert.equal(classifications.eligibility, "execution_gate");
  assert.deepEqual(feature.unclassifiedOptionFields, []);
});

test("material option values change the feature fingerprint even when observation timestamps are identical", async () => {
  const contract = { optionSymbol: "SPY260829C00560000", underlyingSymbol: "SPY", type: "call" as const, expirationDate: "2026-08-29", strike: 560, multiplier: 100, tradable: true, status: "active" as const, contractId: "contract-spy", exerciseStyle: "american", openInterest: 1_000, openInterestDate: "2026-06-28", closePrice: 4.8, closePriceDate: "2026-06-28", source: "alpaca", requestId: "contracts", observedAt: "2026-06-29T20:00:00.000Z", evidence: {} };
  const snapshot = { optionSymbol: contract.optionSymbol, underlyingSymbol: "SPY", observedAt: "2026-06-29T20:00:00.000Z", quoteTimestamp: "2026-06-29T19:59:59.000Z", tradeTimestamp: "2026-06-29T19:59:58.000Z", snapshotTimestamp: "2026-06-29T19:59:59.000Z", underlyingPrice: 560, bid: 4.9, ask: 5.1, bidSize: 20, askSize: 25, midpoint: 5, spread: 0.2, spreadPct: 0.04, last: 5, volume: 500, openInterest: 1_000, impliedVolatility: 0.25, delta: 0.5, gamma: 0.02, theta: -0.08, vega: 0.12, rho: 0.03, freshnessStatus: "fresh" as const, requestedFeed: "opra", effectiveFeed: "opra", endpoint: "/v1beta1/options/snapshots/SPY", pageToken: null, retrievedAt: "2026-06-29T20:00:00.000Z", persistedAt: "2026-06-29T20:00:01.000Z", source: "alpaca", requestId: "options", evidence: { requestedFeed: "opra", effectiveFeed: "opra" } };
  const build = (delta: number, impliedVolatility = 0.25) => buildPostgresFeaturesAndTargets({
    bars: bars(60), stockSnapshots: [stockSnapshot()], optionContracts: [contract],
    optionSnapshots: [{ ...snapshot, delta, impliedVolatility }], riskProfile: "aggressive", optionsEnabled: true,
    repository: { upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }), upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length }) } as never,
    context
  });

  const baseline = await build(0.5);
  const changed = await build(0.6);
  const higherIv = await build(0.5, 0.35);
  assert.notEqual(baseline.features.at(-1)!.sourceFingerprint, changed.features.at(-1)!.sourceFingerprint);
  assert.notEqual(baseline.targets[0]!.volatilityAdjustedScore, higherIv.targets[0]!.volatilityAdjustedScore);
  assert.notEqual(baseline.targets[0]!.expectedReturn, higherIv.targets[0]!.expectedReturn);
});

test("stale or missing option liquidity evidence fails eligibility without fabricating values", async () => {
  const result = await buildPostgresFeaturesAndTargets({
    bars: bars(60), stockSnapshots: [stockSnapshot()],
    optionContracts: [{ optionSymbol: "SPY260829C00560000", underlyingSymbol: "SPY", type: "call", expirationDate: "2026-08-29", strike: 560, multiplier: 100, tradable: true, status: "active", contractId: "contract-spy", exerciseStyle: null, openInterest: null, openInterestDate: null, closePrice: null, closePriceDate: null, source: "alpaca", requestId: "contracts", observedAt: "2026-06-29T20:00:00.000Z", evidence: {} }],
    optionSnapshots: [{ optionSymbol: "SPY260829C00560000", underlyingSymbol: "SPY", observedAt: "2026-06-29T19:00:00.000Z", quoteTimestamp: "2026-06-29T19:00:00.000Z", underlyingPrice: 560, bid: 4.9, ask: 5.1, bidSize: null, askSize: null, midpoint: 5, spread: 0.2, spreadPct: 0.04, last: 5, volume: null, openInterest: null, impliedVolatility: null, delta: null, gamma: null, theta: null, vega: null, rho: null, freshnessStatus: "stale", requestedFeed: "opra", effectiveFeed: "opra", endpoint: "/v1beta1/options/snapshots/SPY", pageToken: null, retrievedAt: "2026-06-29T20:00:00.000Z", persistedAt: "2026-06-29T20:00:01.000Z", source: "alpaca", requestId: "options", evidence: { requestedFeed: "opra", effectiveFeed: "opra" } }],
    riskProfile: "aggressive", optionsEnabled: true,
    repository: { upsertFeatureSnapshots: async (rows: unknown[]) => ({ stored: rows.length }), upsertTargetSnapshots: async (rows: unknown[]) => ({ stored: rows.length }) } as never,
    context
  });
  const feature = result.features.at(-1)!.features;
  assert.equal(feature.optionDailyVolume, null);
  assert.equal(feature.optionOpenInterest, null);
  assert.equal(feature.optionDelta, null);
  assert.equal(feature.atmImpliedVol, null);
  assert.equal(feature.optionLiquidityResult, "failed");
  assert.equal(feature.optionContractEligible, false);
  assert.equal(result.targets[0]!.optionsStrategy?.optionsCandidate, null);
  const decisionInputs = result.targets[0]!.optionsStrategy?.decisionInputs;
  assert.ok(isCurrentOptionsDecisionInputs(decisionInputs));
  assert.equal(
    decisionInputs.volatilityAdjustmentSource,
    "existing_strategy_baseline"
  );
  assert.equal(decisionInputs.impliedVolatility, null);
});

test("every current option contract receives an auditable derived eligibility result", async () => {
  const eligibleSymbol = "SPY260829C00560000";
  const nontradableSymbol = "SPY260829C00570000";
  const result = await buildOptionFeaturesFixture({
    contracts: [
      optionContractFixture(eligibleSymbol, 560),
      optionContractFixture(nontradableSymbol, 570, { tradable: false })
    ],
    snapshots: [
      optionSnapshotFixture(eligibleSymbol),
      optionSnapshotFixture(nontradableSymbol, { bid: 1.9, ask: 2.1, midpoint: 2 })
    ]
  });

  const rows = result.features.at(-1)!.features.optionContractFeatures as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.optionSymbol === eligibleSymbol)?.eligibility, true);
  const nontradable = rows.find((row) => row.optionSymbol === nontradableSymbol)!;
  assert.equal(nontradable.eligibility, false);
  assert.deepEqual(nontradable.rejectionReasons, ["not_tradable"]);
});

test("a recent trade cannot make a quote with no timestamp eligible", async () => {
  const optionSymbol = "SPY260829C00560000";
  const result = await buildOptionFeaturesFixture({
    contracts: [optionContractFixture(optionSymbol, 560)],
    snapshots: [optionSnapshotFixture(optionSymbol, {
      quoteTimestamp: null,
      tradeTimestamp: "2026-06-29T19:59:59.000Z",
      snapshotTimestamp: "2026-06-29T19:59:59.000Z"
    })]
  });
  const feature = result.features.at(-1)!.features;
  assert.equal(feature.optionQuoteFreshnessStatus, "missing");
  assert.equal(feature.optionQuoteAgeSeconds, null);
  assert.equal(feature.optionContractEligible, false);
  assert.equal(result.targets[0]!.optionsStrategy?.optionsCandidate, null);
});

test("an unselected contract material change invalidates the feature fingerprint", async () => {
  const selectedSymbol = "SPY260829C00560000";
  const unselectedSymbol = "SPY260829C00570000";
  const build = (unselectedIv: number) => buildOptionFeaturesFixture({
    contracts: [
      optionContractFixture(selectedSymbol, 560),
      optionContractFixture(unselectedSymbol, 570)
    ],
    snapshots: [
      optionSnapshotFixture(selectedSymbol, { impliedVolatility: 0.25 }),
      optionSnapshotFixture(unselectedSymbol, {
        impliedVolatility: unselectedIv,
        bid: 1.9,
        ask: 2.1,
        midpoint: 2
      })
    ]
  });
  const baseline = await build(0.2);
  const changed = await build(0.35);
  assert.notEqual(
    baseline.features.at(-1)!.features.ivPercentile,
    changed.features.at(-1)!.features.ivPercentile
  );
  assert.notEqual(
    baseline.features.at(-1)!.sourceFingerprint,
    changed.features.at(-1)!.sourceFingerprint
  );
});
