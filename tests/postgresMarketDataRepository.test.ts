import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";

import {
  PostgresMarketDataRepository,
  optionSnapshotEvidenceFingerprint,
  type PostgresOptionSnapshot
} from "../src/repositories/postgres/postgresMarketDataRepository.js";

const fence = {
  jobName: "research-daily",
  workstream: "research",
  ownerId: "worker-1",
  runId: "run-1",
  fencingToken: "7"
};

const contextFor = (client: PoolClient) => ({
  transaction: client,
  operationId: "market-data-refresh-1",
  actorId: fence.ownerId,
  schedulerFence: fence
});

const currentFence = {
  fencing_token: fence.fencingToken,
  workstream: fence.workstream,
  owner_id: fence.ownerId,
  run_id: fence.runId,
  current: true
};

const fakeClient = () => {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.includes("SELECT symbol, timeframe")) {
        return {
          rows: [{
            symbol: "SPY",
            timeframe: "1Day",
            observed_at: "2026-07-20T20:00:00.000Z",
            open: "620.00000000",
            high: "625.00000000",
            low: "618.00000000",
            close: "624.00000000",
            volume: "1000000",
            source: "alpaca",
            request_id: "request-bars"
          }],
          rowCount: 1
        } as unknown as QueryResult;
      }
      if (text.includes("INSERT INTO option_contracts") || text.includes("INSERT INTO option_snapshots") ||
          text.includes("INSERT INTO market_bars") || text.includes("INSERT INTO feature_snapshots")) {
        return { rows: [], rowCount: JSON.parse(String(values?.[0] ?? "[]")).length } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
  } as unknown as PoolClient;
  return { client, queries };
};

test("market-data writes are fenced PostgreSQL upserts with source provenance", async () => {
  const fake = fakeClient();
  const repository = new PostgresMarketDataRepository();
  const context = contextFor(fake.client);

  await repository.upsertUniverseSymbols([{
    symbol: "SPY",
    assetClass: "equity",
    source: "canonical_seed",
    enabled: true,
    observedAt: "2026-07-20T20:00:00.000Z"
  }], context);
  await repository.upsertBars([{
    symbol: "SPY",
    timeframe: "1Day",
    observedAt: "2026-07-20T20:00:00.000Z",
    open: 620,
    high: 625,
    low: 618,
    close: 624,
    volume: 1_000_000,
    source: "alpaca",
    requestId: "request-bars"
  }], context);
  await repository.upsertStockSnapshots([{
    id: "stock-snapshot-1",
    symbol: "SPY",
    observedAt: "2026-07-20T20:00:01.000Z",
    sourceTimestamp: "2026-07-20T20:00:00.000Z",
    requestedFeed: "sip",
    effectiveFeed: "sip",
    source: "alpaca",
    requestId: "request-stocks",
    evidence: { latestTradePrice: 624, bidPrice: 623.99, askPrice: 624.01 }
  }], context);
  await repository.upsertOptionContracts([{
    optionSymbol: "SPY260720C00625000",
    underlyingSymbol: "SPY",
    type: "call",
    expirationDate: "2026-07-20",
    strike: 625,
    multiplier: 100,
    tradable: true,
    source: "alpaca",
    requestId: "request-contracts",
    observedAt: "2026-07-20T20:00:02.000Z",
    contractId: "contract-spy",
    status: "active",
    exerciseStyle: "american",
    openInterest: 1_000,
    openInterestDate: "2026-07-19",
    closePrice: 1.1,
    closePriceDate: "2026-07-19",
    evidence: { endpoint: "/v2/options/contracts" }
  }], context);
  await repository.upsertOptionSnapshots([{
    optionSymbol: "SPY260720C00625000",
    underlyingSymbol: "SPY",
    observedAt: "2026-07-20T20:00:03.000Z",
    quoteTimestamp: "2026-07-20T20:00:02.000Z",
    underlyingPrice: 624,
    bid: 1.2,
    ask: 1.3,
    bidSize: 20,
    askSize: 25,
    midpoint: 1.25,
    spread: 0.1,
    spreadPct: 0.08,
    volume: 500,
    openInterest: 1_000,
    impliedVolatility: 0.2,
    delta: 0.5,
    gamma: 0.02,
    theta: -0.08,
    vega: 0.12,
    rho: 0.03,
    freshnessStatus: "fresh",
    requestedFeed: "opra",
    effectiveFeed: "opra",
    validationBasis: "request_feed_opra",
    endpoint: "/v1beta1/options/snapshots/SPY?feed=opra",
    pageToken: null,
    retrievedAt: "2026-07-20T20:00:03.000Z",
    source: "alpaca",
    requestId: "request-options",
    evidence: {}
  }], context);
  await repository.upsertFeatureSnapshots([{
    symbol: "SPY",
    observedAt: "2026-07-20T20:00:00.000Z",
    features: { close: 624, trend: "bullish" },
    sourceFingerprint: "feature-source-1"
  }], context);
  await repository.upsertTargetSnapshots([{
    symbol: "SPY",
    asOf: "2026-07-20T20:00:00.000Z",
    direction: "long",
    horizon: "1d",
    entryReference: 624,
    upsideTarget: 12,
    downsideRisk: 6,
    stopLoss: 618,
    takeProfit: 636,
    confidence: 0.8,
    expectedReturn: 0.02,
    volatilityAdjustedScore: 1.2,
    riskProfile: "aggressive",
    preferredExpression: "shares",
    rationale: ["existing strategy logic"],
    sourceFingerprint: "target-source-1",
    optionsStrategy: null
  }], context);

  const writes = fake.queries.filter((entry) => /INSERT INTO/.test(entry.text));
  for (const table of [
    "universe_symbols",
    "market_bars",
    "stock_snapshots",
    "option_contracts",
    "option_snapshots",
    "feature_snapshots",
    "target_snapshots"
  ]) {
    const query = writes.find((entry) => entry.text.includes(`INSERT INTO ${table}`));
    assert.ok(query, table);
    assert.match(query.text, /ON CONFLICT/);
    assert.match(query.text, /scheduler_leases/);
  }
  const contractWrite = writes.find((entry) => entry.text.includes("INSERT INTO option_contracts"))!;
  assert.match(contractWrite.text, /contract_id, status, exercise_style, open_interest/);
  assert.match(String(contractWrite.values?.[0]), /contract-spy/);
  const contractPayload = JSON.parse(String(contractWrite.values?.[0])) as Array<Record<string, unknown>>;
  assert.equal(contractPayload[0]?.contract_id, "contract-spy");
  assert.equal(contractPayload[0]?.status, "active");
  assert.equal(contractPayload[0]?.open_interest, 1_000);
  const snapshotWrite = writes.find((entry) => entry.text.includes("INSERT INTO option_snapshots"))!;
  const snapshotPayload = JSON.parse(String(snapshotWrite.values?.[0])) as Array<Record<string, unknown>>;
  const snapshotEvidence = snapshotPayload[0]?.evidence as Record<string, unknown>;
  assert.equal(snapshotEvidence.requestedFeed, "opra");
  assert.equal(snapshotEvidence.validationBasis, "request_feed_opra");
  assert.equal(snapshotEvidence.underlyingPrice, 624);
  assert.equal(snapshotEvidence.bidSize, 20);
  assert.equal(snapshotEvidence.spreadPct, 0.08);
});

test("option contract and snapshot writes use bounded batches and deduplicate identities", async () => {
  const fake = fakeClient();
  const repository = new PostgresMarketDataRepository();
  const context = contextFor(fake.client);
  const contracts = Array.from({ length: 251 }, (_, index) => ({
    optionSymbol: `SPY260724C${String(700 + index).padStart(8, "0")}`,
    underlyingSymbol: "SPY", type: "call" as const, expirationDate: "2026-07-24",
    strike: 700 + index, multiplier: 100, tradable: true, source: "alpaca",
    requestId: "batch", observedAt: "2026-07-21T13:42:00.000Z", evidence: {}
  }));
  await repository.upsertOptionContracts([...contracts, contracts[0]!], context);
  const contractQueries = fake.queries.filter((entry) => entry.text.includes("INSERT INTO option_contracts"));
  assert.equal(contractQueries.length, 2);
  assert.match(contractQueries[0]!.text, /jsonb_to_recordset/);
  assert.equal(JSON.parse(String(contractQueries[0]!.values?.[0])).length, 250);
  const contractPayload = JSON.parse(String(contractQueries[0]!.values?.[0])) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(contractPayload[0]!).sort(), [
    "close_price", "close_price_date", "contract_id", "evidence", "exercise_style",
    "expiration_date", "multiplier", "observed_at", "open_interest", "open_interest_date",
    "option_symbol", "request_id", "source", "status", "strike", "tradable", "type", "underlying_symbol"
  ].sort());
  const snapshots = contracts.map((row) => ({ ...row, observedAt: "2026-07-21T13:43:00.000Z", quoteTimestamp: null, bid: 1, ask: 2, midpoint: 1.5, volume: 10, openInterest: 20, impliedVolatility: 0.2, delta: 0.5, evidence: {} }));
  await repository.upsertOptionSnapshots(snapshots, context);
  const snapshotQueries = fake.queries.filter((entry) => entry.text.includes("INSERT INTO option_snapshots"));
  assert.equal(snapshotQueries.length, 2);
  assert.match(snapshotQueries[0]!.text, /jsonb_to_recordset/);
  const snapshotPayload = JSON.parse(String(snapshotQueries[0]!.values?.[0])) as Array<Record<string, unknown>>;
  assert.equal(snapshotPayload[0]!.option_symbol, contracts[0]!.optionSymbol);
  assert.equal(snapshotPayload[0]!.implied_volatility, 0.2);
  assert.equal(snapshotPayload[0]!.request_id, "batch");
});

test("conflicting duplicate option identity fails closed", async () => {
  const fake = fakeClient();
  const repository = new PostgresMarketDataRepository();
  const context = contextFor(fake.client);
  const row = {
    optionSymbol: "SPY260724C00700000", underlyingSymbol: "SPY", type: "call" as const,
    expirationDate: "2026-07-24", strike: 700, multiplier: 100, tradable: true,
    source: "alpaca", requestId: "batch", observedAt: "2026-07-21T13:42:00.000Z", evidence: {}
  };
  await assert.rejects(repository.upsertOptionContracts([row, { ...row, strike: 701 }], context), /DUPLICATE_IDENTITY_CONFLICT/);
});

test("option snapshot evidence fingerprint binds every persisted material value", () => {
  const base: PostgresOptionSnapshot = {
    optionSymbol: "SPY260724C00744000", underlyingSymbol: "SPY",
    observedAt: "2026-07-21T13:41:58.000Z",
    quoteTimestamp: "2026-07-21T13:41:58.000Z",
    tradeTimestamp: "2026-07-21T13:41:57.000Z",
    snapshotTimestamp: "2026-07-21T13:41:58.000Z",
    underlyingPrice: 744.36, bid: 3.1, ask: 3.2, bidSize: 10, askSize: 12,
    midpoint: 3.15, spread: 0.1, spreadPct: 0.031746, last: 3.15,
    volume: 321, openInterest: 1200, impliedVolatility: 0.1663,
    delta: 0.5276, gamma: 0.0355, theta: -0.7831, vega: 0.2686, rho: 0.0319,
    freshnessStatus: "fresh", requestedFeed: "opra", effectiveFeed: "opra",
    validationBasis: "request_feed_opra", endpoint: "/v1beta1/options/snapshots/SPY",
    pageToken: null, retrievedAt: "2026-07-21T13:42:00.000Z",
    source: "alpaca", requestId: "chain-request", evidence: {}
  };
  const initial = optionSnapshotEvidenceFingerprint(base);
  for (const changed of [
    { quoteTimestamp: "2026-07-21T13:41:59.000Z" },
    { tradeTimestamp: "2026-07-21T13:41:56.000Z" },
    { bid: 3.11 }, { ask: 3.21 }, { midpoint: 3.16 }, { last: 3.16 },
    { volume: 322 }, { openInterest: 1201 }, { impliedVolatility: 0.1763 },
    { delta: 0.5376 }, { gamma: 0.0455 }, { theta: -0.7931 },
    { vega: 0.2786 }, { rho: 0.0419 }
  ]) {
    assert.notEqual(optionSnapshotEvidenceFingerprint({ ...base, ...changed }), initial);
  }
});

test("bars and feature snapshots use bounded batches and reject conflicting identities", async () => {
  const fake = fakeClient();
  const repository = new PostgresMarketDataRepository();
  const context = contextFor(fake.client);
  const bars = Array.from({ length: 251 }, (_, index) => ({
    symbol: `S${index}`, timeframe: "1Day", observedAt: "2026-07-21T13:42:00.000Z",
    open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, source: "alpaca", requestId: "batch"
  }));
  await repository.upsertBars(bars, context);
  const barQueries = fake.queries.filter((entry) => entry.text.includes("INSERT INTO market_bars"));
  assert.equal(barQueries.length, 2);
  assert.equal(JSON.parse(String(barQueries[0]!.values?.[0])).length, 250);
  assert.equal(JSON.parse(String(barQueries[0]!.values?.[0]))[0].close, 1.5);
  const features = bars.map((row) => ({ symbol: row.symbol, observedAt: row.observedAt, features: { close: 1.5 }, sourceFingerprint: "batch" }));
  await repository.upsertFeatureSnapshots(features, context);
  const featureQueries = fake.queries.filter((entry) => entry.text.includes("INSERT INTO feature_snapshots"));
  assert.equal(featureQueries.length, 2);
  await assert.rejects(repository.upsertBars([bars[0]!, { ...bars[0]!, close: 9 }], context), /DUPLICATE_IDENTITY_CONFLICT/);
});

test("option batch writes fail closed when the scheduler fence is rejected", async () => {
  const queries: string[] = [];
  const client = { query: async (text: string) => {
    queries.push(text);
    if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) return { rows: [], rowCount: 0 } as unknown as QueryResult;
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  }} as unknown as PoolClient;
  const repository = new PostgresMarketDataRepository();
  await assert.rejects(repository.upsertOptionContracts([{
    optionSymbol: "SPY260724C00700000", underlyingSymbol: "SPY", type: "call",
    expirationDate: "2026-07-24", strike: 700, multiplier: 100, tradable: true,
    source: "alpaca", requestId: "batch", observedAt: "2026-07-21T13:42:00.000Z", evidence: {}
  }], contextFor(client)), /POSTGRES_MARKET_DATA_FENCE_REJECTED/);
  assert.equal(queries.some((text) => text.includes("INSERT INTO option_contracts")), false);
});

test("PostgreSQL option readback restores persisted contract, OPRA, and persistence evidence", async () => {
  const client = {
    query: async (text: string) => {
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.includes("FROM option_contracts")) {
        return { rows: [{
          option_symbol: "SPY260724C00744000", underlying_symbol: "SPY", type: "call",
          expiration_date: "2026-07-24", strike: "744", multiplier: "100",
          tradable: true, source: "alpaca", request_id: "contracts-request",
          observed_at: "2026-07-21T13:42:00.000Z",
          evidence: { contractId: "contract-spy", status: "active", exerciseStyle: "american", openInterest: 1200, openInterestDate: "2026-07-20", closePrice: 2.95, closePriceDate: "2026-07-20" }
        }], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.includes("FROM option_snapshots")) {
        return { rows: [{
          option_symbol: "SPY260724C00744000", underlying_symbol: "SPY",
          observed_at: "2026-07-21T13:41:58.000Z", quote_timestamp: "2026-07-21T13:41:58.000Z",
          trade_timestamp: "2026-07-21T13:41:57.000Z", snapshot_timestamp: "2026-07-21T13:41:58.000Z",
          bid: "3.1", ask: "3.2", midpoint: "3.15", last: "3.15", volume: "321",
          open_interest: "1200", implied_volatility: "0.1663", delta: "0.5276",
          gamma: "0.0355", theta: "-0.7831", vega: "0.2686", rho: "0.0319",
          source: "alpaca", request_id: "chain-request",
          evidence: { underlyingPrice: 744.36, bidSize: 10, askSize: 12, spread: 0.1, spreadPct: 0.031746, freshnessStatus: "fresh", requestedFeed: "opra", effectiveFeed: "opra", validationBasis: "request_feed_opra", endpoint: "/v1beta1/options/snapshots/SPY", pageToken: "page-2", retrievedAt: "2026-07-21T13:42:00.000Z" },
          evidence_fingerprint: "option-evidence-fingerprint",
          updated_at: "2026-07-21T13:42:01.000Z"
        }], rowCount: 1 } as unknown as QueryResult;
      }
      throw new Error(`unexpected query: ${text}`);
    }
  } as unknown as PoolClient;
  const repository = new PostgresMarketDataRepository();
  const context = contextFor(client);
  const contracts = await repository.listOptionContractsBySymbols({
    optionSymbols: ["SPY260724C00744000"]
  }, context);
  const snapshots = await repository.listOptionSnapshotsByIdentity({
    identities: [{ optionSymbol: "SPY260724C00744000", observedAt: "2026-07-21T13:41:58.000Z" }]
  }, context);

  assert.equal(contracts[0]?.contractId, "contract-spy");
  assert.equal(contracts[0]?.openInterest, 1200);
  assert.equal(snapshots[0]?.impliedVolatility, 0.1663);
  assert.equal(snapshots[0]?.rho, 0.0319);
  assert.equal(snapshots[0]?.requestedFeed, "opra");
  assert.equal(snapshots[0]?.validationBasis, "request_feed_opra");
  assert.equal(snapshots[0]?.underlyingPrice, 744.36);
  assert.equal(snapshots[0]?.persistedAt, "2026-07-21T13:42:01.000Z");
  assert.equal(snapshots[0]?.evidenceFingerprint, "option-evidence-fingerprint");
});

test("whole-universe option readback uses bounded PostgreSQL queries", async () => {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text.includes("FROM scheduler_leases") && text.includes("FOR UPDATE")) {
        return { rows: [currentFence], rowCount: 1 } as unknown as QueryResult;
      }
      if (text.includes("FROM option_contracts") || text.includes("FROM option_snapshots")) {
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }
      throw new Error(`unexpected query: ${text}`);
    }
  } as unknown as PoolClient;
  const repository = new PostgresMarketDataRepository();
  const context = contextFor(client);
  const optionSymbols = Array.from({ length: 1001 }, (_, index) =>
    `SPY260724C${String(index).padStart(8, "0")}`
  );
  await repository.listOptionContractsBySymbols({ optionSymbols }, context);
  await repository.listOptionSnapshotsByIdentity({
    identities: optionSymbols.map((optionSymbol) => ({
      optionSymbol,
      observedAt: "2026-07-21T13:41:58.000Z"
    }))
  }, context);

  const contractReads = queries.filter((entry) => entry.text.includes("FROM option_contracts"));
  const snapshotReads = queries.filter((entry) => entry.text.includes("FROM option_snapshots"));
  assert.equal(contractReads.length, 2);
  assert.equal(snapshotReads.length, 2);
  assert.deepEqual(contractReads.map((entry) => (entry.values?.[0] as unknown[]).length), [1000, 1]);
  assert.deepEqual(snapshotReads.map((entry) => (entry.values?.[0] as unknown[]).length), [1000, 1]);
});

test("market-data reads are bounded, ordered, and normalized", async () => {
  const fake = fakeClient();
  const rows = await new PostgresMarketDataRepository().listBars({
    symbols: ["SPY"],
    timeframe: "1Day",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-07-20T23:59:59.999Z",
    limit: 500
  }, contextFor(fake.client));

  assert.deepEqual(rows, [{
    symbol: "SPY",
    timeframe: "1Day",
    observedAt: "2026-07-20T20:00:00.000Z",
    open: 620,
    high: 625,
    low: 618,
    close: 624,
    volume: 1_000_000,
    source: "alpaca",
    requestId: "request-bars"
  }]);
  const select = fake.queries.find((entry) => entry.text.includes("SELECT symbol, timeframe"));
  assert.match(select?.text ?? "", /ORDER BY symbol, observed_at/);
  assert.match(select?.text ?? "", /LIMIT \$5/);
  assert.equal(select?.values?.at(-1), 500);
});

test("a stale scheduler fence rejects market-data writes", async () => {
  const client = {
    query: async (text: string) => {
      if (text.includes("FROM scheduler_leases")) {
        return {
          rows: [{ ...currentFence, fencing_token: "8" }],
          rowCount: 1
        } as unknown as QueryResult;
      }
      throw new Error("write must not run");
    }
  } as unknown as PoolClient;

  await assert.rejects(
    new PostgresMarketDataRepository().upsertBars([{
      symbol: "SPY",
      timeframe: "1Day",
      observedAt: "2026-07-20T20:00:00.000Z",
      open: 620,
      high: 625,
      low: 618,
      close: 624,
      volume: 1_000_000,
      source: "alpaca",
      requestId: null
    }], contextFor(client)),
    /POSTGRES_MARKET_DATA_FENCE_REJECTED/
  );
});
