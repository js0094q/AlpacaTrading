import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PostgresStockSnapshot } from "../src/repositories/postgres/postgresMarketDataRepository.js";
import {
  AlpacaDataHubService,
  type AlpacaDataHubOptions,
  type AlpacaDataHubStream
} from "../src/services/alpacaDataHubService.js";
import type {
  AlpacaStockStreamEvent,
  AlpacaStockStreamStatus
} from "../src/services/alpacaStockStream.js";
import { runInvestmentOrchestrator } from "../src/services/investmentOrchestratorService.js";

const NOW = "2026-07-28T15:30:00.000Z";
const QUOTE_TIME = "2026-07-28T15:29:59.900Z";

const stockSnapshot = (
  effectiveFeed = "sip",
  bidPrice = 638.1
): PostgresStockSnapshot => ({
  id: `stock-${effectiveFeed}`,
  symbol: "SPY",
  observedAt: NOW,
  sourceTimestamp: QUOTE_TIME,
  requestedFeed: effectiveFeed,
  effectiveFeed,
  source: "alpaca_rest",
  requestId: null,
  evidence: {
    bidPrice,
    bidSize: 12,
    askPrice: bidPrice + 0.02,
    askSize: 9,
    quoteTimestamp: QUOTE_TIME,
    latestTradePrice: bidPrice + 0.01,
    latestTradeSize: 2,
    tradeTimestamp: QUOTE_TIME
  }
});

const streamStatus = (
  overrides: Partial<AlpacaStockStreamStatus> = {}
): AlpacaStockStreamStatus => ({
  enabled: true,
  connected: true,
  authenticated: true,
  subscribed: true,
  provider: "alpaca",
  feed: "sip",
  environment: "paper",
  symbols: ["SPY"],
  reconnectAttempts: 0,
  reconnectBaseMs: 5_000,
  reconnectMaxMs: 60_000,
  ...overrides
});

const makeStream = () => {
  let starts = 0;
  let stops = 0;
  let status = streamStatus();
  const subscribers = new Set<
    (event: AlpacaStockStreamEvent) => void | Promise<void>
  >();
  const stream: AlpacaDataHubStream = {
    start: async () => { starts += 1; },
    stop: async () => { stops += 1; },
    getStatus: () => status,
    getLatestTrade: () => undefined,
    getLatestQuote: () => undefined,
    getLatestBar: () => undefined,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    }
  };
  return {
    stream,
    starts: () => starts,
    stops: () => stops,
    setStatus: (next: AlpacaStockStreamStatus) => { status = next; }
  };
};

const createHub = (input: {
  stream?: AlpacaDataHubStream;
  listAccountActivities?: AlpacaDataHubOptions["listAccountActivities"];
  emitTelemetry?: AlpacaDataHubOptions["emitTelemetry"];
} = {}) => {
  const fallback = makeStream();
  return new AlpacaDataHubService({
    stream: input.stream ?? fallback.stream,
    listAccountActivities: input.listAccountActivities,
    emitTelemetry: input.emitTelemetry,
    now: () => new Date(NOW)
  });
};

describe("central Alpaca data hub", () => {
  test("all three lanes read the same current quote object for one symbol and cycle", async () => {
    const hub = createHub();
    const cycle = await hub.hydrateCycle({
      cycleId: "cycle-shared-quote",
      reason: "startup",
      feed: "sip",
      load: async () => ({ stockSnapshots: [stockSnapshot()] })
    });
    const laneQuotes: unknown[] = [];

    const result = await runInvestmentOrchestrator<
      typeof cycle,
      { lane: "equity" | "options_0dte" | "options_leaps" }
    >({
      cycleId: "cycle-shared-quote",
      loadSharedContext: async () => cycle,
      lanes: (["equity", "options_0dte", "options_leaps"] as const).map((lane) => ({
        lane,
        enabled: true,
        execute: async (shared) => {
          laneQuotes.push(shared.getLatestQuote("SPY"));
          return { proposals: [{ lane }] };
        }
      }))
    });

    assert.equal(result.workstreamResults.length, 3);
    assert.equal(laneQuotes.length, 3);
    assert.equal(laneQuotes.every((quote) => quote === laneQuotes[0]), true);
    assert.equal(Object.isFrozen(laneQuotes[0]), true);
    assert.equal(Object.isFrozen(cycle.getLatestQuote("SPY")?.data), true);
  });

  test("starts and stops only one shared stream connection for all lanes", async () => {
    const fixture = makeStream();
    const hub = createHub({ stream: fixture.stream });

    await Promise.all([hub.start(), hub.start(), hub.start()]);
    await Promise.all([hub.stop(), hub.stop(), hub.stop()]);

    assert.equal(fixture.starts(), 1);
    assert.equal(fixture.stops(), 1);
    assert.equal(hub.getStatus().stream?.feed, "sip");
  });

  test("a stream disconnect preserves last-known state and does not terminate lane evaluation", async () => {
    const fixture = makeStream();
    const hub = createHub({ stream: fixture.stream });
    const cycle = await hub.hydrateCycle({
      cycleId: "cycle-disconnected",
      reason: "startup",
      feed: "sip",
      load: async () => ({ stockSnapshots: [stockSnapshot()] })
    });
    fixture.setStatus(streamStatus({
      connected: false,
      authenticated: false,
      subscribed: false,
      reconnectAttempts: 1,
      lastReconnectDelayMs: 5_000,
      nextReconnectAt: "2026-07-28T15:30:05.000Z"
    }));

    const result = await runInvestmentOrchestrator<
      typeof cycle,
      {
        lane: "equity" | "options_0dte" | "options_leaps";
        quote: ReturnType<typeof cycle.getLatestQuote>;
      }
    >({
      cycleId: "cycle-disconnected",
      loadSharedContext: async () => cycle,
      lanes: (["equity", "options_0dte", "options_leaps"] as const).map((lane) => ({
        lane,
        enabled: true,
        execute: async (shared) => ({
          proposals: [{ lane, quote: shared.getLatestQuote("SPY") }]
        })
      }))
    });

    assert.equal(result.workstreamResults.every(({ outcome }) => outcome === "success"), true);
    assert.equal(result.proposals.every(({ quote }) => quote === cycle.getLatestQuote("SPY")), true);
    assert.equal(hub.getStatus().stream?.connected, false);
    assert.equal(hub.getStatus().stream?.lastReconnectDelayMs, 5_000);
  });

  test("deduplicates REST hydration across lanes and retains feed and timestamp provenance", async () => {
    const hub = createHub();
    let loads = 0;
    const hydrate = () => hub.hydrateCycle({
      cycleId: "cycle-rest-hydration",
      reason: "startup" as const,
      feed: "sip",
      load: async () => {
        loads += 1;
        return {
          bars: [{
            symbol: "SPY",
            timeframe: "1Day",
            observedAt: QUOTE_TIME,
            open: 637,
            high: 639,
            low: 636,
            close: 638,
            volume: 1_000_000,
            source: "alpaca",
            requestId: null
          }],
          stockSnapshots: [stockSnapshot()]
        };
      }
    });

    const [equity, zeroDte, leaps] = await Promise.all([
      hydrate(),
      hydrate(),
      hydrate()
    ]);

    assert.equal(loads, 1);
    assert.equal(equity, zeroDte);
    assert.equal(zeroDte, leaps);
    const quote = equity.getLatestQuote("SPY");
    assert.equal(quote?.provenance.provider, "alpaca");
    assert.equal(quote?.provenance.feed, "sip");
    assert.equal(quote?.provenance.providerTimestamp, QUOTE_TIME);
    assert.equal(quote?.provenance.receiptTimestamp, NOW);
    assert.equal(quote?.provenance.environment, "paper");
    assert.equal(quote?.provenance.transport, "rest");
    const bar = equity.getLatestBar("SPY", "1Day");
    assert.equal(bar?.provenance.feed, "sip");
    assert.equal(bar?.provenance.providerTimestamp, QUOTE_TIME);
    assert.equal(bar?.provenance.receiptTimestamp, NOW);
  });

  test("keeps SIP and IEX quote state distinct", async () => {
    const hub = createHub();
    const cycle = await hub.hydrateCycle({
      cycleId: "cycle-feed-provenance",
      reason: "startup",
      feed: "sip",
      load: async () => ({
        stockSnapshots: [
          stockSnapshot("sip", 638.1),
          stockSnapshot("iex", 638)
        ]
      })
    });

    assert.equal(cycle.getLatestQuote("SPY")?.data.bidPrice, 638.1);
    assert.equal(cycle.getLatestQuote("SPY", "iex")?.data.bidPrice, 638);
    assert.notEqual(
      cycle.getLatestQuote("SPY"),
      cycle.getLatestQuote("SPY", "iex")
    );
  });

  test("polls assignment activities, deduplicates them, and isolates subscriber failure", async () => {
    const telemetry: Readonly<Record<string, unknown>>[] = [];
    const hub = createHub({
      emitTelemetry: (event) => telemetry.push(event),
      listAccountActivities: async () => ({
        data: [{
          id: "activity-assignment-1",
          activity_type: "OPASN",
          transaction_time: "2026-07-28T20:01:00.000Z",
          symbol: "SPY260728C00635000",
          qty: "1",
          side: "sell"
        }],
        status: 200,
        url: "https://paper-api.alpaca.markets/v2/account/activities"
      })
    });
    const received: string[] = [];
    hub.subscribe((event) => {
      received.push(event.provenance.eventType);
      throw new Error("consumer failed");
    });

    await hub.pollAccountActivitiesOnce();
    await hub.pollAccountActivitiesOnce();
    await Promise.resolve();

    assert.deepEqual(received, ["option_assignment"]);
    assert.equal(telemetry.some((event) =>
      event.event === "alpaca_data_hub_subscriber_failed"
    ), true);
    assert.equal(hub.getStatus().activityAfter, "2026-07-28T20:01:00.000Z");
  });

  test("normalizes reconciliation partial fills without originating an order", () => {
    const hub = createHub();
    const event = hub.ingestOrderLifecycleUpdate({
      event: "partial_fill",
      symbol: "SPY",
      brokerOrderId: "broker-order-1",
      clientOrderId: "paper-intent-1-open-1",
      status: "partially_filled",
      providerTimestamp: "2026-07-28T15:31:00.000Z",
      receivedAt: "2026-07-28T15:31:00.100Z"
    });

    assert.equal(event.provenance.eventType, "partial_fill");
    assert.equal(event.provenance.transport, "reconciliation");
    assert.equal(event.data.brokerOrderId, "broker-order-1");
  });
});
