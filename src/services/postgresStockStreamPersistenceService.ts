import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import { PostgresMarketDataRepository } from "../repositories/postgres/postgresMarketDataRepository.js";
import {
  AlpacaStockStreamService,
  type AlpacaStockStreamOptions,
  StockBarEvent,
  StockQuoteEvent,
  StockTradeEvent
} from "./alpacaStockStream.js";

type StockStreamEvent = StockBarEvent | StockQuoteEvent | StockTradeEvent;
type StreamWriter = Pick<
  PostgresMarketDataRepository,
  "upsertUniverseSymbols" | "upsertBars" | "upsertStockSnapshots"
>;

export const createPostgresStockStreamEventSink = (input: {
  repository?: StreamWriter;
  context: FencedPostgresRepositoryContext;
}) => {
  const repository = input.repository ?? new PostgresMarketDataRepository();
  return async (event: StockStreamEvent) => {
    await repository.upsertUniverseSymbols([{
      symbol: event.symbol,
      assetClass: "equity",
      source: "alpaca_sip_stream",
      enabled: true,
      observedAt: event.receivedAt
    }], input.context);

    if (event.type === "bar") {
      await repository.upsertBars([{
        symbol: event.symbol,
        timeframe: "1Min",
        observedAt: event.timestamp,
        open: event.open,
        high: event.high,
        low: event.low,
        close: event.close,
        volume: event.volume,
        source: "alpaca_sip_stream",
        requestId: null
      }], input.context);
      return;
    }

    const evidence = event.type === "quote"
      ? {
          eventType: event.type,
          symbol: event.symbol,
          bidPrice: event.bidPrice,
          bidSize: event.bidSize,
          askPrice: event.askPrice,
          askSize: event.askSize,
          midpoint: (event.bidPrice + event.askPrice) / 2,
          quoteTimestamp: event.timestamp,
          receivedAt: event.receivedAt,
          feed: event.feed
        }
      : {
          eventType: event.type,
          symbol: event.symbol,
          latestTradePrice: event.price,
          latestTradeSize: event.size,
          tradeTimestamp: event.timestamp,
          receivedAt: event.receivedAt,
          feed: event.feed
        };
    await repository.upsertStockSnapshots([{
      id: `stock_snapshot_${canonicalJsonHash(evidence)}`,
      symbol: event.symbol,
      observedAt: event.receivedAt,
      sourceTimestamp: event.timestamp,
      requestedFeed: "sip",
      effectiveFeed: "sip",
      source: "alpaca_sip_stream",
      requestId: null,
      evidence
    }], input.context);
  };
};

export const createPostgresBackedStockStream = (input: {
  repository?: StreamWriter;
  context: FencedPostgresRepositoryContext;
  stream?: Omit<AlpacaStockStreamOptions, "onEvent">;
}) => new AlpacaStockStreamService({
  ...input.stream,
  onEvent: createPostgresStockStreamEventSink({
    repository: input.repository,
    context: input.context
  })
});
