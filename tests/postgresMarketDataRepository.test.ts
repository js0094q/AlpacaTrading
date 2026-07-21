import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";

import { PostgresMarketDataRepository } from "../src/repositories/postgres/postgresMarketDataRepository.js";

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
    observedAt: "2026-07-20T20:00:02.000Z"
  }], context);
  await repository.upsertOptionSnapshots([{
    optionSymbol: "SPY260720C00625000",
    underlyingSymbol: "SPY",
    observedAt: "2026-07-20T20:00:03.000Z",
    quoteTimestamp: "2026-07-20T20:00:02.000Z",
    bid: 1.2,
    ask: 1.3,
    midpoint: 1.25,
    volume: 500,
    openInterest: 1_000,
    impliedVolatility: 0.2,
    delta: 0.5,
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
