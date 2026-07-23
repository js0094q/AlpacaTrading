import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresStockStreamEventSink } from "../src/services/postgresStockStreamPersistenceService.js";

const context = {
  transaction: {} as never,
  operationId: "stream-1",
  actorId: "worker",
  schedulerFence: {
    jobName: "market-data-refresh", workstream: "market_data_refresh",
    ownerId: "worker", runId: "run", fencingToken: "4"
  }
};

test("SIP stream bars and quotes persist through PostgreSQL market repositories", async () => {
  const stored: Record<string, unknown[]> = {};
  const sink = createPostgresStockStreamEventSink({
    repository: {
      upsertUniverseSymbols: async (rows: unknown[]) => { stored.universe = rows; return { stored: rows.length }; },
      upsertBars: async (rows: unknown[]) => { stored.bars = rows; return { stored: rows.length }; },
      upsertStockSnapshots: async (rows: unknown[]) => { stored.snapshots = rows; return { stored: rows.length }; }
    } as never,
    context
  });

  await sink({
    type: "bar", symbol: "SPY", open: 600, high: 601, low: 599,
    close: 600.5, volume: 1_000, timestamp: "2026-07-20T21:59:00.000Z",
    receivedAt: "2026-07-20T21:59:01.000Z", feed: "sip"
  });
  assert.equal(stored.bars?.length, 1);
  assert.equal((stored.bars![0] as { timeframe: string }).timeframe, "1Min");

  await sink({
    type: "quote", symbol: "SPY", bidPrice: 600.4, bidSize: 5,
    askPrice: 600.6, askSize: 6, timestamp: "2026-07-20T21:59:02.000Z",
    receivedAt: "2026-07-20T21:59:03.000Z", feed: "sip"
  });
  const snapshot = stored.snapshots?.[0] as { sourceTimestamp: string; evidence: { midpoint: number } };
  assert.equal(snapshot.sourceTimestamp, "2026-07-20T21:59:02.000Z");
  assert.equal(snapshot.evidence.midpoint, 600.5);
});
