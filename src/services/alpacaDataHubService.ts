import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type {
  PostgresMarketBar,
  PostgresOptionContract,
  PostgresOptionSnapshot,
  PostgresStockSnapshot
} from "../repositories/postgres/postgresMarketDataRepository.js";
import type { AlpacaMarketClockSnapshot } from "./alpacaMarketClockService.js";
import {
  listPaperAccountActivities,
  type AlpacaAccountActivityRaw
} from "./alpacaClient.js";
import {
  alpacaStockStream,
  type AlpacaStockFeed,
  type AlpacaStockStreamEvent,
  type AlpacaStockStreamStatus,
  type StockBarEvent,
  type StockQuoteEvent,
  type StockTradeEvent
} from "./alpacaStockStream.js";
import type { PostgresAuthorityBrokerSnapshot } from "./postgresAuthorityBrokerSnapshot.js";

export type AlpacaDataHydrationReason = "startup" | "explicit_refresh" | "recovery";
export type AlpacaDataTransport =
  | "stream"
  | "rest"
  | "reconciliation"
  | "activity_poll";
export type AlpacaDataEventType =
  | "latest_trade"
  | "latest_quote"
  | "intraday_bar"
  | "daily_bar"
  | "market_clock"
  | "account_state"
  | "position"
  | "open_order"
  | "order_update"
  | "fill"
  | "partial_fill"
  | "cancellation"
  | "rejection"
  | "option_contract"
  | "option_snapshot"
  | "option_assignment"
  | "option_exercise"
  | "option_expiration"
  | "account_activity"
  | "news";

export interface AlpacaDataProvenance {
  readonly provider: "alpaca";
  readonly feed: string | null;
  readonly symbol: string | null;
  readonly eventType: AlpacaDataEventType;
  readonly providerTimestamp: string | null;
  readonly receiptTimestamp: string;
  readonly environment: "paper";
  readonly transport: AlpacaDataTransport;
}

export interface AlpacaDataEvent<T = Readonly<Record<string, unknown>>> {
  readonly provider: "alpaca";
  readonly feed: string | null;
  readonly symbol: string | null;
  readonly eventType: AlpacaDataEventType;
  readonly providerTimestamp: string | null;
  readonly receivedAt: string;
  readonly environment: "paper";
  readonly source: AlpacaDataTransport;
  readonly provenance: AlpacaDataProvenance;
  readonly data: T;
}

export interface AlpacaQuoteData {
  readonly bidPrice: number | null;
  readonly bidSize: number | null;
  readonly askPrice: number | null;
  readonly askSize: number | null;
  readonly bidExchange?: string | null;
  readonly askExchange?: string | null;
}

export interface AlpacaTradeData {
  readonly price: number | null;
  readonly size: number | null;
  readonly exchange: string | null;
}

export interface AlpacaBarData {
  readonly timeframe: string;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly volume: number | null;
  readonly tradeCount: number | null;
  readonly vwap: number | null;
}

export interface AlpacaDataHubHydration {
  readonly bars?: readonly PostgresMarketBar[];
  readonly stockSnapshots?: readonly PostgresStockSnapshot[];
  readonly optionContracts?: readonly PostgresOptionContract[];
  readonly optionSnapshots?: readonly PostgresOptionSnapshot[];
  readonly marketClock?: AlpacaMarketClockSnapshot | null;
  readonly brokerSnapshot?: PostgresAuthorityBrokerSnapshot | null;
  readonly activities?: readonly AlpacaAccountActivityRaw[];
  readonly orderLifecycleUpdates?: readonly AlpacaOrderLifecycleUpdate[];
  readonly news?: readonly Readonly<Record<string, unknown>>[];
}

export interface AlpacaOrderLifecycleUpdate {
  readonly event:
    | "accepted"
    | "new"
    | "fill"
    | "partial_fill"
    | "canceled"
    | "rejected"
    | "expired"
    | "replaced"
    | string;
  readonly symbol: string;
  readonly brokerOrderId: string;
  readonly clientOrderId?: string | null;
  readonly status: string;
  readonly providerTimestamp?: string | null;
  readonly receivedAt: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

type AlpacaEventDataFor<T extends AlpacaDataEventType> =
  T extends "latest_quote"
    ? AlpacaQuoteData
    : T extends "latest_trade"
      ? AlpacaTradeData
      : T extends "intraday_bar" | "daily_bar"
        ? AlpacaBarData
        : Readonly<Record<string, unknown>>;

export interface AlpacaDataHubEventInput<
  T extends AlpacaDataEventType = AlpacaDataEventType
> {
  readonly provider: "alpaca";
  readonly feed?: string | null;
  readonly symbol?: string | null;
  readonly eventType: T;
  readonly providerTimestamp?: string | null;
  readonly receivedAt?: string;
  readonly environment?: "paper";
  readonly source: AlpacaDataTransport;
  readonly data: AlpacaEventDataFor<T>;
}

export interface AlpacaDataCycle<T extends AlpacaDataHubHydration> {
  readonly cycleId: string;
  readonly reason: AlpacaDataHydrationReason;
  readonly feed: string;
  readonly hydratedAt: string;
  readonly payload: T;
  getLatestQuote(
    symbol: string,
    feed?: string
  ): AlpacaDataEvent<AlpacaQuoteData> | undefined;
  getLatestTrade(
    symbol: string,
    feed?: string
  ): AlpacaDataEvent<AlpacaTradeData> | undefined;
  getLatestBar(
    symbol: string,
    timeframe: string,
    feed?: string
  ): AlpacaDataEvent<AlpacaBarData> | undefined;
  getEvents(type: AlpacaDataEventType): readonly AlpacaDataEvent[];
}

export interface AlpacaDataHubStream {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): AlpacaStockStreamStatus;
  getLatestTrade(symbol: string): StockTradeEvent | undefined;
  getLatestQuote(symbol: string): StockQuoteEvent | undefined;
  getLatestBar(symbol: string): StockBarEvent | undefined;
  subscribe(
    subscriber: (event: AlpacaStockStreamEvent) => void | Promise<void>
  ): () => void;
}

export interface AlpacaDataHubMarketStreamStatus {
  readonly connected: boolean;
  readonly authenticated: boolean;
  readonly subscribed: boolean;
  readonly reconnectAttempts: number;
  readonly lastReconnectDelayMs?: number;
}

export interface AlpacaDataHubMarketStream {
  readonly provider: "alpaca";
  readonly endpoint: string;
  readonly feed: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(subscriber: (event: AlpacaDataHubEventInput) => void): () => void;
  getStatus(): AlpacaDataHubMarketStreamStatus;
}

export interface AlpacaDataHubTelemetry {
  (event: Readonly<Record<string, unknown>>): void;
}

export interface AlpacaDataHubOptions {
  readonly environment?: "paper";
  readonly stream?: AlpacaDataHubStream;
  readonly listAccountActivities?: typeof listPaperAccountActivities;
  readonly now?: () => Date;
  readonly setTimeoutFn?: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly emitTelemetry?: AlpacaDataHubTelemetry;
  readonly retainedCycles?: number;
  readonly retainedEvents?: number;
}

type HubSubscriber = (event: AlpacaDataEvent) => void | Promise<void>;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const number = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const timestamp = (value: unknown): string | null => {
  const candidate = text(value);
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
};

const symbol = (value: unknown): string | null => {
  const candidate = text(value)?.toUpperCase() ?? null;
  return candidate || null;
};

const feed = (value: unknown): string | null =>
  text(value)?.toLowerCase() ?? null;

const freezeEvent = <T extends object>(
  provenance: AlpacaDataProvenance,
  data: T
): AlpacaDataEvent<Readonly<T>> => {
  const frozenProvenance = Object.freeze(provenance);
  return Object.freeze({
    provider: frozenProvenance.provider,
    feed: frozenProvenance.feed,
    symbol: frozenProvenance.symbol,
    eventType: frozenProvenance.eventType,
    providerTimestamp: frozenProvenance.providerTimestamp,
    receivedAt: frozenProvenance.receiptTimestamp,
    environment: frozenProvenance.environment,
    source: frozenProvenance.transport,
    provenance: frozenProvenance,
    data: Object.freeze(data)
  });
};

const eventTimestamp = (event: AlpacaDataEvent) =>
  event.provenance.providerTimestamp ?? event.provenance.receiptTimestamp;

const currentEventWins = (
  current: AlpacaDataEvent | undefined,
  candidate: AlpacaDataEvent
) => !current || Date.parse(eventTimestamp(candidate)) >= Date.parse(eventTimestamp(current));

const transportFromSource = (source: string): AlpacaDataTransport =>
  source.includes("stream") ? "stream" : "rest";

const quoteKey = (feedName: string, normalizedSymbol: string) =>
  `${feedName}:${normalizedSymbol}`;

const barKey = (feedName: string, normalizedSymbol: string, timeframe: string) =>
  `${feedName}:${normalizedSymbol}:${timeframe.toLowerCase()}`;

const eventKey = (
  event: AlpacaDataEvent,
  identity = ""
) => [
  event.provenance.eventType,
  event.provenance.feed ?? "none",
  event.provenance.symbol ?? "account",
  identity
].join(":");

const activityEventType = (activity: AlpacaAccountActivityRaw): AlpacaDataEventType => {
  const raw = String(activity.activity_type ?? activity.type ?? "").trim().toUpperCase();
  if (["OPASN", "ACNA"].includes(raw)) return "option_assignment";
  if (["OPEXC", "OPEXE"].includes(raw)) return "option_exercise";
  if (["OPEXP", "OPEXA"].includes(raw)) return "option_expiration";
  if (["FILL", "FILLING"].includes(raw)) return "fill";
  return "account_activity";
};

const orderEventType = (event: string): AlpacaDataEventType => {
  const normalized = event.trim().toLowerCase();
  if (normalized === "fill" || normalized === "filled") return "fill";
  if (normalized === "partial_fill" || normalized === "partially_filled") {
    return "partial_fill";
  }
  if (normalized === "canceled" || normalized === "cancelled") return "cancellation";
  if (normalized === "rejected") return "rejection";
  return "order_update";
};

export class AlpacaDataHubService {
  private readonly environment: "paper";
  private readonly stockStream: AlpacaDataHubStream | undefined;
  private readonly listAccountActivities: typeof listPaperAccountActivities;
  private readonly now: () => Date;
  private readonly setTimeoutFn: NonNullable<AlpacaDataHubOptions["setTimeoutFn"]>;
  private readonly clearTimeoutFn: NonNullable<AlpacaDataHubOptions["clearTimeoutFn"]>;
  private readonly emitTelemetry?: AlpacaDataHubTelemetry;
  private readonly retainedCycles: number;
  private readonly retainedEvents: number;
  private readonly subscribers = new Set<HubSubscriber>();
  private readonly latestEvents = new Map<string, AlpacaDataEvent>();
  private readonly recentEvents: AlpacaDataEvent[] = [];
  private readonly cycles = new Map<string, Promise<AlpacaDataCycle<AlpacaDataHubHydration>>>();
  private readonly cycleOrder: string[] = [];
  private readonly seenActivityIds = new Set<string>();
  private readonly activityIdOrder: string[] = [];
  private readonly marketStreams = new Map<string, {
    stream: AlpacaDataHubMarketStream;
    unsubscribe: () => void;
  }>();
  private readonly restHydrations = new Map<string, Promise<readonly AlpacaDataEvent[]>>();
  private restHydrationRequests = 0;
  private restHydrationDeduplicatedReads = 0;
  private restHydrationFailures = 0;
  private subscriberFailures = 0;
  private streamStart: Promise<void> | undefined;
  private streamStop: Promise<void> | undefined;
  private activityPolling = false;
  private activityPollInFlight: Promise<void> | undefined;
  private activityTimer: ReturnType<typeof setTimeout> | undefined;
  private activityPollIntervalMs = 60_000;
  private activityAfter: string | undefined;

  constructor(options: AlpacaDataHubOptions = {}) {
    this.environment = options.environment ?? "paper";
    this.stockStream = options.stream;
    this.listAccountActivities =
      options.listAccountActivities ?? listPaperAccountActivities;
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn =
      options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    this.emitTelemetry = options.emitTelemetry;
    this.retainedCycles = Math.max(1, Math.min(64, options.retainedCycles ?? 8));
    this.retainedEvents = Math.max(100, Math.min(10_000, options.retainedEvents ?? 1_000));
    this.stockStream?.subscribe((event) => {
      this.ingestStockStreamEvent(event);
    });
  }

  start(): Promise<void> {
    this.streamStart ??= Promise.all([
      ...(this.stockStream ? [this.stockStream.start()] : []),
      ...[...this.marketStreams.values()].map(({ stream }) => stream.start())
    ]).then(() => undefined).catch((error) => {
      this.emitTelemetry?.({
        event: "alpaca_data_hub_stream_start_failed",
        errorName: error instanceof Error ? error.name : "Error"
      });
    });
    return this.streamStart;
  }

  stop(): Promise<void> {
    this.stopAccountActivityPolling();
    this.streamStop ??= Promise.all([
      ...(this.stockStream ? [this.stockStream.stop()] : []),
      ...[...this.marketStreams.values()].map(({ stream }) => stream.stop())
    ]).then(() => {
      for (const registered of this.marketStreams.values()) {
        registered.unsubscribe();
      }
    }).catch((error) => {
      this.emitTelemetry?.({
        event: "alpaca_data_hub_stream_stop_failed",
        errorName: error instanceof Error ? error.name : "Error"
      });
    });
    return this.streamStop;
  }

  registerMarketStream(stream: AlpacaDataHubMarketStream): void {
    const key = [
      stream.provider,
      stream.endpoint.trim(),
      stream.feed.trim().toLowerCase()
    ].join(":");
    if (this.marketStreams.has(key)) return;
    const unsubscribe = stream.subscribe((event) => {
      this.publish({ ...event, source: "stream" });
    });
    this.marketStreams.set(key, { stream, unsubscribe });
  }

  publish<T extends AlpacaDataEventType>(
    input: AlpacaDataHubEventInput<T>
  ): AlpacaDataEvent<Readonly<AlpacaEventDataFor<T>>> {
    const normalizedSymbol = input.symbol === null || input.symbol === undefined
      ? null
      : symbol(input.symbol);
    const receivedAt = timestamp(input.receivedAt) ?? this.now().toISOString();
    const published = freezeEvent({
      provider: "alpaca",
      feed: feed(input.feed),
      symbol: normalizedSymbol,
      eventType: input.eventType,
      providerTimestamp: timestamp(input.providerTimestamp),
      receiptTimestamp: receivedAt,
      environment: input.environment ?? this.environment,
      transport: input.source
    }, { ...input.data });
    this.recordEvent(published);
    return published as AlpacaDataEvent<Readonly<AlpacaEventDataFor<T>>>;
  }

  getLatest(input: {
    readonly eventType: AlpacaDataEventType;
    readonly symbol?: string | null;
    readonly feed?: string | null;
    readonly environment?: "paper";
  }): AlpacaDataEvent | undefined {
    const normalizedSymbol = input.symbol === null || input.symbol === undefined
      ? null
      : symbol(input.symbol);
    const requestedFeed = input.feed === null || input.feed === undefined
      ? undefined
      : feed(input.feed);
    const matches = [...this.latestEvents.values()].filter((event) =>
      event.eventType === input.eventType &&
      event.environment === (input.environment ?? this.environment) &&
      event.symbol === normalizedSymbol &&
      (requestedFeed === undefined || event.feed === requestedFeed)
    );
    if (requestedFeed === undefined && new Set(matches.map(({ feed }) => feed)).size > 1) {
      return undefined;
    }
    return matches.sort(
      (left, right) => Date.parse(eventTimestamp(right)) - Date.parse(eventTimestamp(left))
    )[0];
  }

  forCycle(cycleId: string) {
    const normalizedCycleId = cycleId.trim();
    if (!normalizedCycleId) throw new Error("ALPACA_DATA_HUB_CYCLE_ID_REQUIRED");
    return Object.freeze({
      cycleId: normalizedCycleId,
      getLatest: (input: Parameters<AlpacaDataHubService["getLatest"]>[0]) =>
        this.getLatest(input),
      hydrateRest: (input: {
        resource: string;
        reason: AlpacaDataHydrationReason;
        load: () => Promise<readonly AlpacaDataHubEventInput[]>;
      }) => this.hydrateRestForCycle(normalizedCycleId, input)
    });
  }

  subscribe(subscriber: HubSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  getStatus() {
    const streams = [...this.marketStreams.values()].map(({ stream }) => {
      const status = stream.getStatus();
      return {
        provider: stream.provider,
        endpoint: stream.endpoint,
        feed: stream.feed,
        connected: status.connected,
        authenticated: status.authenticated,
        subscribed: status.subscribed,
        reconnectAttempts: status.reconnectAttempts,
        ...(status.lastReconnectDelayMs !== undefined
          ? { lastReconnectDelayMs: status.lastReconnectDelayMs }
          : {})
      };
    });
    return {
      provider: "alpaca" as const,
      environment: this.environment,
      streams,
      ...(this.stockStream ? { stream: this.stockStream.getStatus() } : {}),
      retainedCycles: this.cycles.size,
      retainedEvents: this.recentEvents.length,
      activityPolling: this.activityPolling,
      activityPollInFlight: this.activityPollInFlight !== undefined,
      activityAfter: this.activityAfter ?? null,
      restHydration: {
        requests: this.restHydrationRequests,
        deduplicatedReads: this.restHydrationDeduplicatedReads,
        failures: this.restHydrationFailures
      },
      subscriberFailures: this.subscriberFailures
    };
  }

  pollAccountActivities(input: {
    readonly pollKey: string;
    readonly load: () => Promise<readonly AlpacaAccountActivityRaw[]>;
  }): Promise<readonly AlpacaDataEvent[]> {
    const pollKey = input.pollKey.trim();
    if (!pollKey) throw new Error("ALPACA_DATA_HUB_ACTIVITY_POLL_KEY_REQUIRED");
    return input.load().then(async (activities) => {
      const accepted: AlpacaDataEvent[] = [];
      for (const activity of activities) {
        const event = this.ingestAccountActivity(
          activity,
          this.now().toISOString(),
          "activity_poll"
        );
        if (event) accepted.push(event);
      }
      await Promise.resolve();
      return Object.freeze(accepted);
    }).catch((error) => {
      this.emitTelemetry?.({
        event: "alpaca_data_hub_activity_poll_failed",
        pollKey,
        errorName: error instanceof Error ? error.name : "Error"
      });
      return Object.freeze([]);
    });
  }

  hydrateCycle<T extends AlpacaDataHubHydration>(input: {
    readonly cycleId: string;
    readonly reason: AlpacaDataHydrationReason;
    readonly feed: string;
    readonly load: () => Promise<T>;
    readonly replace?: boolean;
  }): Promise<AlpacaDataCycle<T>> {
    const cycleId = input.cycleId.trim();
    const requestedFeed = input.feed.trim().toLowerCase();
    if (!cycleId) throw new Error("ALPACA_DATA_HUB_CYCLE_ID_REQUIRED");
    if (!requestedFeed) throw new Error("ALPACA_DATA_HUB_FEED_REQUIRED");
    if (input.replace && input.reason === "startup") {
      throw new Error("ALPACA_DATA_HUB_STARTUP_REPLACEMENT_FORBIDDEN");
    }
    const existing = this.cycles.get(cycleId);
    if (existing && !input.replace) {
      return existing as Promise<AlpacaDataCycle<T>>;
    }
    if (input.replace) {
      this.cycles.delete(cycleId);
      const index = this.cycleOrder.indexOf(cycleId);
      if (index >= 0) this.cycleOrder.splice(index, 1);
    }

    const loading = input.load()
      .then((payload) => {
        const hydratedAt = this.now().toISOString();
        this.ingestHydration(payload, hydratedAt, requestedFeed);
        this.captureStreamState(payload.stockSnapshots?.map((row) => row.symbol) ?? []);
        const cycle = this.buildCycle({
          cycleId,
          reason: input.reason,
          feed: requestedFeed,
          hydratedAt,
          payload
        });
        this.emitTelemetry?.({
          event: "alpaca_data_hub_cycle_hydrated",
          cycleId,
          reason: input.reason,
          feed: requestedFeed,
          quoteCount: cycle.getEvents("latest_quote").length,
          tradeCount: cycle.getEvents("latest_trade").length,
          barCount:
            cycle.getEvents("intraday_bar").length +
            cycle.getEvents("daily_bar").length
        });
        return cycle;
      })
      .catch((error) => {
        this.cycles.delete(cycleId);
        const index = this.cycleOrder.indexOf(cycleId);
        if (index >= 0) this.cycleOrder.splice(index, 1);
        throw error;
      });
    this.cycles.set(
      cycleId,
      loading as Promise<AlpacaDataCycle<AlpacaDataHubHydration>>
    );
    this.cycleOrder.push(cycleId);
    this.pruneCycles();
    return loading;
  }

  getCycle<T extends AlpacaDataHubHydration>(
    cycleId: string
  ): Promise<AlpacaDataCycle<T>> | undefined {
    return this.cycles.get(cycleId) as Promise<AlpacaDataCycle<T>> | undefined;
  }

  ingestOrderLifecycleUpdate(update: AlpacaOrderLifecycleUpdate): AlpacaDataEvent {
    const normalizedSymbol = symbol(update.symbol);
    const receiptTimestamp = timestamp(update.receivedAt);
    if (!normalizedSymbol || !receiptTimestamp || !update.brokerOrderId.trim()) {
      throw new Error("ALPACA_DATA_HUB_ORDER_UPDATE_INVALID");
    }
    const event = freezeEvent({
      provider: "alpaca",
      feed: null,
      symbol: normalizedSymbol,
      eventType: orderEventType(update.event),
      providerTimestamp: timestamp(update.providerTimestamp),
      receiptTimestamp,
      environment: "paper",
      transport: "reconciliation"
    }, {
      brokerOrderId: update.brokerOrderId,
      clientOrderId: update.clientOrderId ?? null,
      status: update.status,
      event: update.event,
      raw: update.raw ?? {}
    });
    this.recordEvent(event, update.brokerOrderId);
    return event;
  }

  async pollAccountActivitiesOnce(): Promise<void> {
    if (this.activityPollInFlight) return this.activityPollInFlight;
    const startedAt = this.now().toISOString();
    this.activityPollInFlight = this.listAccountActivities({
      limit: 100,
      ...(this.activityAfter ? { after: this.activityAfter } : {})
    }).then((response) => {
      const activities = Array.isArray(response.data) ? response.data : [];
      let accepted = 0;
      for (const activity of activities) {
        if (this.ingestAccountActivity(activity, this.now().toISOString(), "activity_poll")) {
          accepted += 1;
        }
      }
      this.emitTelemetry?.({
        event: "alpaca_data_hub_activity_poll_completed",
        startedAt,
        completedAt: this.now().toISOString(),
        rowsReceived: activities.length,
        rowsAccepted: accepted
      });
    }).catch((error) => {
      this.emitTelemetry?.({
        event: "alpaca_data_hub_activity_poll_failed",
        startedAt,
        completedAt: this.now().toISOString(),
        errorName: error instanceof Error ? error.name : "Error"
      });
    }).finally(() => {
      this.activityPollInFlight = undefined;
    });
    return this.activityPollInFlight;
  }

  startAccountActivityPolling(intervalMs = 60_000): void {
    if (this.activityPolling) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000) {
      throw new Error("ALPACA_DATA_HUB_ACTIVITY_POLL_INTERVAL_INVALID");
    }
    this.activityPollIntervalMs = intervalMs;
    this.activityPolling = true;
    const poll = () => {
      if (!this.activityPolling) return;
      void this.pollAccountActivitiesOnce().finally(() => {
        if (!this.activityPolling) return;
        this.activityTimer = this.setTimeoutFn!(poll, this.activityPollIntervalMs);
      });
    };
    poll();
  }

  stopAccountActivityPolling(): void {
    this.activityPolling = false;
    if (this.activityTimer !== undefined) {
      this.clearTimeoutFn(this.activityTimer);
      this.activityTimer = undefined;
    }
  }

  private hydrateRestForCycle(
    cycleId: string,
    input: {
      resource: string;
      reason: AlpacaDataHydrationReason;
      load: () => Promise<readonly AlpacaDataHubEventInput[]>;
    }
  ): Promise<readonly AlpacaDataEvent[]> {
    const resource = input.resource.trim();
    if (!resource) throw new Error("ALPACA_DATA_HUB_REST_RESOURCE_REQUIRED");
    const key = [cycleId, input.reason, resource].join(":");
    const existing = this.restHydrations.get(key);
    if (existing) {
      this.restHydrationDeduplicatedReads += 1;
      return existing;
    }
    this.restHydrationRequests += 1;
    const loading = input.load().then((events) => Object.freeze(
      events.map((event) => this.publish({
        ...event,
        receivedAt: this.now().toISOString(),
        source: "rest"
      }))
    )).catch((error) => {
      this.restHydrationFailures += 1;
      this.restHydrations.delete(key);
      throw error;
    });
    this.restHydrations.set(key, loading);
    while (this.restHydrations.size > this.retainedEvents) {
      const oldestKey = this.restHydrations.keys().next().value;
      if (oldestKey === undefined) break;
      this.restHydrations.delete(oldestKey);
    }
    return loading;
  }

  private captureStreamState(symbols: readonly string[]): void {
    if (!this.stockStream) return;
    const status = this.stockStream.getStatus();
    if (
      !status.enabled ||
      !status.connected ||
      !status.authenticated ||
      !status.subscribed
    ) {
      return;
    }
    for (const value of symbols) {
      const normalized = symbol(value);
      if (!normalized || !status.symbols.includes(normalized)) continue;
      const events = [
        this.stockStream.getLatestTrade(normalized),
        this.stockStream.getLatestQuote(normalized),
        this.stockStream.getLatestBar(normalized)
      ];
      for (const event of events) {
        if (event) this.ingestStockStreamEvent(event);
      }
    }
  }

  private ingestStockStreamEvent(event: AlpacaStockStreamEvent): void {
    const provenance = {
      provider: "alpaca" as const,
      feed: event.feed,
      symbol: event.symbol,
      eventType: event.type === "trade"
        ? "latest_trade" as const
        : event.type === "quote"
          ? "latest_quote" as const
          : "intraday_bar" as const,
      providerTimestamp: event.timestamp,
      receiptTimestamp: event.receivedAt,
      environment: "paper" as const,
      transport: "stream" as const
    };
    const normalized = event.type === "quote"
      ? freezeEvent(provenance, {
          bidPrice: event.bidPrice,
          bidSize: event.bidSize,
          askPrice: event.askPrice,
          askSize: event.askSize,
          bidExchange: event.bidExchange ?? null,
          askExchange: event.askExchange ?? null
        })
      : event.type === "trade"
        ? freezeEvent(provenance, {
            price: event.price,
            size: event.size,
            exchange: event.exchange ?? null
          })
        : freezeEvent(provenance, {
            timeframe: "1Min",
            open: event.open,
            high: event.high,
            low: event.low,
            close: event.close,
            volume: event.volume,
            tradeCount: event.tradeCount ?? null,
            vwap: event.vwap ?? null
          });
    this.recordEvent(normalized, event.type === "bar" ? "1Min" : "");
  }

  private ingestHydration(
    payload: AlpacaDataHubHydration,
    hydratedAt: string,
    requestedFeed: string
  ): void {
    for (const row of payload.stockSnapshots ?? []) {
      this.ingestStockSnapshot(row);
    }
    for (const row of payload.bars ?? []) {
      const normalizedSymbol = symbol(row.symbol);
      if (!normalizedSymbol) continue;
      const event = freezeEvent({
        provider: "alpaca",
        feed: requestedFeed,
        symbol: normalizedSymbol,
        eventType: row.timeframe.toLowerCase().includes("day")
          ? "daily_bar"
          : "intraday_bar",
        providerTimestamp: timestamp(row.observedAt),
        receiptTimestamp: hydratedAt,
        environment: "paper",
        transport: transportFromSource(row.source)
      }, {
        timeframe: row.timeframe,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        tradeCount: null,
        vwap: null
      });
      this.recordEvent(event, row.timeframe);
    }
    for (const row of payload.optionContracts ?? []) {
      const event = freezeEvent({
        provider: "alpaca",
        feed: null,
        symbol: symbol(row.optionSymbol),
        eventType: "option_contract",
        providerTimestamp: timestamp(row.observedAt),
        receiptTimestamp: timestamp(row.observedAt) ?? hydratedAt,
        environment: "paper",
        transport: transportFromSource(row.source)
      }, { ...row });
      this.recordEvent(event, row.optionSymbol);
    }
    for (const row of payload.optionSnapshots ?? []) {
      const event = freezeEvent({
        provider: "alpaca",
        feed: feed(row.effectiveFeed ?? row.requestedFeed),
        symbol: symbol(row.optionSymbol),
        eventType: "option_snapshot",
        providerTimestamp:
          timestamp(row.quoteTimestamp) ??
          timestamp(row.tradeTimestamp) ??
          timestamp(row.snapshotTimestamp),
        receiptTimestamp:
          timestamp(row.retrievedAt) ??
          timestamp(row.observedAt) ??
          hydratedAt,
        environment: "paper",
        transport: transportFromSource(row.source)
      }, { ...row });
      this.recordEvent(event, row.optionSymbol);
    }
    if (payload.marketClock) {
      const event = freezeEvent({
        provider: "alpaca",
        feed: null,
        symbol: null,
        eventType: "market_clock",
        providerTimestamp: timestamp(payload.marketClock.timestamp),
        receiptTimestamp: hydratedAt,
        environment: "paper",
        transport: "rest"
      }, { ...payload.marketClock });
      this.recordEvent(event);
    }
    if (payload.brokerSnapshot) {
      this.ingestBrokerSnapshot(payload.brokerSnapshot);
    }
    for (const activity of payload.activities ?? []) {
      this.ingestAccountActivity(activity, hydratedAt);
    }
    for (const update of payload.orderLifecycleUpdates ?? []) {
      this.ingestOrderLifecycleUpdate(update);
    }
    for (const item of payload.news ?? []) {
      const event = freezeEvent({
        provider: "alpaca",
        feed: feed(item.feed),
        symbol: symbol(item.symbol),
        eventType: "news",
        providerTimestamp:
          timestamp(item.timestamp) ??
          timestamp(item.created_at) ??
          timestamp(item.updated_at),
        receiptTimestamp: hydratedAt,
        environment: "paper",
        transport: "rest"
      }, { ...item });
      this.recordEvent(event, text(item.id) ?? canonicalJsonHash(item));
    }
  }

  private ingestStockSnapshot(row: PostgresStockSnapshot): void {
    const evidence = record(row.evidence);
    const normalizedSymbol = symbol(row.symbol);
    const effectiveFeed = feed(row.effectiveFeed || row.requestedFeed);
    if (!normalizedSymbol || !effectiveFeed) return;
    const receiptTimestamp = timestamp(row.observedAt);
    if (!receiptTimestamp) return;
    const transport = transportFromSource(row.source);
    const quoteTimestamp = timestamp(evidence.quoteTimestamp);
    if (quoteTimestamp) {
      this.recordEvent(freezeEvent({
        provider: "alpaca",
        feed: effectiveFeed,
        symbol: normalizedSymbol,
        eventType: "latest_quote",
        providerTimestamp: quoteTimestamp,
        receiptTimestamp,
        environment: "paper",
        transport
      }, {
        bidPrice: number(evidence.bidPrice),
        bidSize: number(evidence.bidSize),
        askPrice: number(evidence.askPrice),
        askSize: number(evidence.askSize),
        bidExchange: text(evidence.bidExchange),
        askExchange: text(evidence.askExchange)
      }));
    }
    const tradeTimestamp = timestamp(evidence.tradeTimestamp);
    if (tradeTimestamp) {
      this.recordEvent(freezeEvent({
        provider: "alpaca",
        feed: effectiveFeed,
        symbol: normalizedSymbol,
        eventType: "latest_trade",
        providerTimestamp: tradeTimestamp,
        receiptTimestamp,
        environment: "paper",
        transport
      }, {
        price: number(evidence.latestTradePrice),
        size: number(evidence.latestTradeSize),
        exchange: text(evidence.latestTradeExchange)
      }));
    }
    this.ingestSnapshotBar({
      evidence,
      prefix: "minute",
      timeframe: "1Min",
      eventType: "intraday_bar",
      symbol: normalizedSymbol,
      feed: effectiveFeed,
      receiptTimestamp,
      transport
    });
    this.ingestSnapshotBar({
      evidence,
      prefix: "daily",
      timeframe: "1Day",
      eventType: "daily_bar",
      symbol: normalizedSymbol,
      feed: effectiveFeed,
      receiptTimestamp,
      transport
    });
  }

  private ingestSnapshotBar(input: {
    evidence: Readonly<Record<string, unknown>>;
    prefix: "minute" | "daily";
    timeframe: string;
    eventType: "intraday_bar" | "daily_bar";
    symbol: string;
    feed: string;
    receiptTimestamp: string;
    transport: AlpacaDataTransport;
  }): void {
    const providerTimestamp = timestamp(
      input.evidence[`${input.prefix}Timestamp`]
    );
    if (!providerTimestamp) return;
    const title = input.prefix[0]!.toUpperCase() + input.prefix.slice(1);
    this.recordEvent(freezeEvent({
      provider: "alpaca",
      feed: input.feed,
      symbol: input.symbol,
      eventType: input.eventType,
      providerTimestamp,
      receiptTimestamp: input.receiptTimestamp,
      environment: "paper",
      transport: input.transport
    }, {
      timeframe: input.timeframe,
      open: number(input.evidence[`${input.prefix}Open`]),
      high: number(input.evidence[`${input.prefix}High`]),
      low: number(input.evidence[`${input.prefix}Low`]),
      close: number(input.evidence[`${input.prefix}Close`]),
      volume: number(input.evidence[`${input.prefix}Volume`]),
      tradeCount: number(input.evidence[`${input.prefix}TradeCount`]),
      vwap: number(input.evidence[`${input.prefix}Vwap`]),
      sourceComponent: title
    }), input.timeframe);
  }

  private ingestBrokerSnapshot(snapshot: PostgresAuthorityBrokerSnapshot): void {
    const receiptTimestamp = timestamp(snapshot.capturedAt) ?? this.now().toISOString();
    this.recordEvent(freezeEvent({
      provider: "alpaca",
      feed: null,
      symbol: null,
      eventType: "account_state",
      providerTimestamp: null,
      receiptTimestamp,
      environment: "paper",
      transport: "rest"
    }, { ...snapshot.account }));
    for (const position of snapshot.positions) {
      this.recordEvent(freezeEvent({
        provider: "alpaca",
        feed: null,
        symbol: symbol(position.optionSymbol ?? position.symbol),
        eventType: "position",
        providerTimestamp: null,
        receiptTimestamp,
        environment: "paper",
        transport: "rest"
      }, { ...position }), position.brokerPositionKey);
    }
    for (const order of snapshot.orders) {
      this.recordEvent(freezeEvent({
        provider: "alpaca",
        feed: null,
        symbol: symbol(order.symbol),
        eventType: "open_order",
        providerTimestamp: null,
        receiptTimestamp,
        environment: "paper",
        transport: "rest"
      }, { ...order }), order.brokerOrderId);
    }
  }

  private ingestAccountActivity(
    activity: AlpacaAccountActivityRaw,
    receiptTimestampValue: string,
    source: "rest" | "activity_poll" = "rest"
  ): AlpacaDataEvent | null {
    const identity = text(activity.id) ?? canonicalJsonHash(activity);
    if (this.seenActivityIds.has(identity)) return null;
    this.seenActivityIds.add(identity);
    this.activityIdOrder.push(identity);
    while (this.activityIdOrder.length > this.retainedEvents) {
      const removed = this.activityIdOrder.shift();
      if (removed) this.seenActivityIds.delete(removed);
    }
    const providerTimestamp =
      timestamp(activity.transaction_time) ?? timestamp(activity.date);
    if (providerTimestamp && (
      !this.activityAfter ||
      Date.parse(providerTimestamp) > Date.parse(this.activityAfter)
    )) {
      this.activityAfter = providerTimestamp;
    }
    const event = freezeEvent({
      provider: "alpaca",
      feed: null,
      symbol: symbol(activity.symbol),
      eventType: activityEventType(activity),
      providerTimestamp,
      receiptTimestamp: timestamp(receiptTimestampValue) ?? this.now().toISOString(),
      environment: "paper",
      transport: source
    }, { ...activity });
    this.recordEvent(event, identity);
    return event;
  }

  private recordEvent(event: AlpacaDataEvent, identity = ""): void {
    const key = eventKey(event, identity);
    const current = this.latestEvents.get(key);
    if (!currentEventWins(current, event)) return;
    this.latestEvents.delete(key);
    this.latestEvents.set(key, event);
    while (this.latestEvents.size > this.retainedEvents) {
      const oldestKey = this.latestEvents.keys().next().value;
      if (oldestKey === undefined) break;
      this.latestEvents.delete(oldestKey);
    }
    this.recentEvents.push(event);
    while (this.recentEvents.length > this.retainedEvents) {
      this.recentEvents.shift();
    }
    for (const subscriber of this.subscribers) {
      try {
        Promise.resolve(subscriber(event)).catch(() => {
          this.subscriberFailures += 1;
          this.emitTelemetry?.({
            event: "alpaca_data_hub_subscriber_failed",
            eventType: event.provenance.eventType
          });
        });
      } catch {
        this.subscriberFailures += 1;
        this.emitTelemetry?.({
          event: "alpaca_data_hub_subscriber_failed",
          eventType: event.provenance.eventType
        });
      }
    }
  }

  private buildCycle<T extends AlpacaDataHubHydration>(input: {
    cycleId: string;
    reason: AlpacaDataHydrationReason;
    feed: string;
    hydratedAt: string;
    payload: T;
  }): AlpacaDataCycle<T> {
    const requestedSymbols = new Set(
      (input.payload.stockSnapshots ?? [])
        .map((row) => symbol(row.symbol))
        .filter((value): value is string => value !== null)
    );
    const events = [...this.latestEvents.values()].filter((event) =>
      event.provenance.symbol === null ||
      requestedSymbols.size === 0 ||
      requestedSymbols.has(event.provenance.symbol)
    );
    const quotes = new Map<string, AlpacaDataEvent<AlpacaQuoteData>>();
    const trades = new Map<string, AlpacaDataEvent<AlpacaTradeData>>();
    const bars = new Map<string, AlpacaDataEvent<AlpacaBarData>>();
    const byType = new Map<AlpacaDataEventType, AlpacaDataEvent[]>();
    for (const event of events) {
      const values = byType.get(event.provenance.eventType) ?? [];
      values.push(event);
      byType.set(event.provenance.eventType, values);
      const eventFeed = event.provenance.feed;
      const eventSymbol = event.provenance.symbol;
      if (!eventFeed || !eventSymbol) continue;
      if (event.provenance.eventType === "latest_quote") {
        quotes.set(
          quoteKey(eventFeed, eventSymbol),
          event as unknown as AlpacaDataEvent<AlpacaQuoteData>
        );
      } else if (event.provenance.eventType === "latest_trade") {
        trades.set(
          quoteKey(eventFeed, eventSymbol),
          event as unknown as AlpacaDataEvent<AlpacaTradeData>
        );
      } else if (
        event.provenance.eventType === "intraday_bar" ||
        event.provenance.eventType === "daily_bar"
      ) {
        const timeframe = String(
          (event.data as unknown as AlpacaBarData).timeframe
        );
        bars.set(
          barKey(eventFeed, eventSymbol, timeframe),
          event as unknown as AlpacaDataEvent<AlpacaBarData>
        );
      }
    }
    for (const [type, values] of byType) {
      byType.set(type, Object.freeze([...values]) as AlpacaDataEvent[]);
    }
    return Object.freeze({
      cycleId: input.cycleId,
      reason: input.reason,
      feed: input.feed,
      hydratedAt: input.hydratedAt,
      payload: input.payload,
      getLatestQuote: (value: string, feedName = input.feed) => {
        const normalized = symbol(value);
        return normalized
          ? quotes.get(quoteKey(feedName.toLowerCase(), normalized))
          : undefined;
      },
      getLatestTrade: (value: string, feedName = input.feed) => {
        const normalized = symbol(value);
        return normalized
          ? trades.get(quoteKey(feedName.toLowerCase(), normalized))
          : undefined;
      },
      getLatestBar: (
        value: string,
        timeframe: string,
        feedName = input.feed
      ) => {
        const normalized = symbol(value);
        return normalized
          ? bars.get(barKey(feedName.toLowerCase(), normalized, timeframe))
          : undefined;
      },
      getEvents: (type: AlpacaDataEventType) =>
        byType.get(type) ?? Object.freeze([])
    });
  }

  private pruneCycles(): void {
    while (this.cycleOrder.length > this.retainedCycles) {
      const cycleId = this.cycleOrder.shift();
      if (cycleId) this.cycles.delete(cycleId);
    }
  }
}

export const alpacaDataHub = new AlpacaDataHubService({
  environment: "paper",
  stream: alpacaStockStream
});

export const stockStreamFeedIsCompatible = (
  status: Pick<AlpacaStockStreamStatus, "feed">,
  requestedFeed: string
): boolean =>
  status.feed !== "unknown" &&
  status.feed === requestedFeed.trim().toLowerCase() as AlpacaStockFeed;
