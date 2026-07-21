import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import {
  PostgresMarketDataRepository,
  type PostgresMarketBar,
  type PostgresOptionContract,
  type PostgresOptionSnapshot,
  type PostgresStockSnapshot,
  type PostgresUniverseSymbol
} from "../repositories/postgres/postgresMarketDataRepository.js";
import { normalizeOptionSnapshot } from "./optionSnapshotNormalizer.js";
import {
  fetchAllBars,
  fetchOptionContracts,
  fetchOptionSnapshots,
  fetchStockSnapshots,
  type OptionContractRaw
} from "./providers/alpaca.js";
import { normalizeStockSnapshot } from "./stockSnapshotNormalizer.js";

type MarketDataWriter = Pick<
  PostgresMarketDataRepository,
  | "upsertUniverseSymbols"
  | "upsertBars"
  | "upsertStockSnapshots"
  | "upsertOptionContracts"
  | "upsertOptionSnapshots"
>;

type MarketDataDependencies = {
  fetchAllBars: typeof fetchAllBars;
  fetchStockSnapshots: typeof fetchStockSnapshots;
  fetchOptionContracts: typeof fetchOptionContracts;
  fetchOptionSnapshots: typeof fetchOptionSnapshots;
};

const defaults: MarketDataDependencies = {
  fetchAllBars,
  fetchStockSnapshots,
  fetchOptionContracts,
  fetchOptionSnapshots
};

const symbols = (values: readonly string[]) => Array.from(new Set(
  values.map((value) => value.trim().toUpperCase()).filter(Boolean)
));

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const contractRow = (
  raw: OptionContractRaw,
  now: string
): PostgresOptionContract | null => {
  const optionSymbol = String(raw.symbol ?? "").trim().toUpperCase();
  const underlyingSymbol = String(raw.underlying_symbol ?? raw.root_symbol ?? "")
    .trim().toUpperCase();
  const expirationDate = String(raw.expiration_date ?? "").trim();
  const strike = number(raw.strike_price);
  const multiplier = number(raw.multiplier ?? raw.size) ?? 100;
  if (!optionSymbol || !underlyingSymbol || !/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) {
    return null;
  }
  if (strike === null || strike <= 0 || multiplier <= 0) return null;
  return {
    optionSymbol,
    underlyingSymbol,
    type: raw.type === "put" ? "put" : "call",
    expirationDate,
    strike,
    multiplier,
    tradable: raw.tradable === true || raw.tradeable === true || raw.status === "active",
    source: "alpaca",
    requestId: typeof raw.requestId === "string" ? raw.requestId : null,
    observedAt: now
  };
};

export const refreshPostgresMarketData = async (input: {
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly start: string;
  readonly end: string;
  readonly optionsEnabled: boolean;
  readonly now?: Date;
  readonly maxBarAgeHours?: number;
  readonly repository?: MarketDataWriter;
  readonly context: FencedPostgresRepositoryContext;
  readonly dependencies?: Partial<MarketDataDependencies>;
}) => {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const requestedSymbols = symbols(input.symbols);
  if (requestedSymbols.length === 0) throw new Error("POSTGRES_MARKET_SYMBOLS_REQUIRED");
  const repository = input.repository ?? new PostgresMarketDataRepository();
  const dependencies = { ...defaults, ...input.dependencies };

  const universeRows: PostgresUniverseSymbol[] = requestedSymbols.map((symbol) => ({
    symbol,
    assetClass: "equity",
    source: "canonical_seed",
    enabled: true,
    observedAt: nowIso
  }));
  await repository.upsertUniverseSymbols(universeRows, input.context);

  const fetchedBars = await dependencies.fetchAllBars({
    symbols: requestedSymbols,
    timeframe: input.timeframe as never,
    start: input.start,
    end: input.end,
    feed: "sip"
  });
  const barRows: PostgresMarketBar[] = fetchedBars.flatMap((entry) => {
    const open = number(entry.bar.o);
    const high = number(entry.bar.h);
    const low = number(entry.bar.l);
    const close = number(entry.bar.c);
    const volume = number(entry.bar.v);
    const observed = Date.parse(entry.bar.t);
    if (
      open === null || high === null || low === null || close === null ||
      volume === null || !Number.isFinite(observed)
    ) return [];
    return [{
      symbol: entry.symbol.toUpperCase(),
      timeframe: input.timeframe,
      observedAt: new Date(observed).toISOString(),
      open,
      high,
      low,
      close,
      volume,
      source: "alpaca",
      requestId: entry.requestIds.find((value): value is string => Boolean(value)) ?? null
    }];
  });
  const maxBarAgeMs = (input.maxBarAgeHours ?? 96) * 60 * 60 * 1_000;
  for (const symbol of requestedSymbols) {
    const latest = barRows
      .filter((row) => row.symbol === symbol)
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
    if (!latest) throw new Error(`POSTGRES_MARKET_BARS_MISSING:${symbol}`);
    const age = now.getTime() - Date.parse(latest.observedAt);
    if (!Number.isFinite(age) || age < -60_000 || age > maxBarAgeMs) {
      throw new Error(`POSTGRES_MARKET_BARS_STALE:${symbol}`);
    }
  }
  await repository.upsertBars(barRows, input.context);

  const fetchedStocks = await dependencies.fetchStockSnapshots({
    symbols: requestedSymbols,
    feed: "sip",
    currency: "USD"
  });
  const stockRows: PostgresStockSnapshot[] = [];
  for (const symbol of requestedSymbols) {
    const fetched = fetchedStocks.find((row) => row.symbol.toUpperCase() === symbol);
    if (!fetched?.raw || fetched.error) {
      throw new Error(`POSTGRES_STOCK_SNAPSHOT_MISSING:${symbol}`);
    }
    const normalized = normalizeStockSnapshot({
      symbol,
      raw: fetched.raw,
      observedAt: nowIso,
      requestedFeed: fetched.requestedFeed,
      effectiveFeed: fetched.effectiveFeed,
      currency: fetched.currency,
      requestId: fetched.requestId,
      now,
      maxAgeSeconds: maxBarAgeMs / 1_000
    });
    if (!normalized.sourceTimestamp || normalized.dataQualityStatus === "SOURCE_ERROR") {
      throw new Error(`POSTGRES_STOCK_SNAPSHOT_INCOMPLETE:${symbol}`);
    }
    if (normalized.freshnessStatus !== "FRESH") {
      throw new Error(`POSTGRES_STOCK_SNAPSHOT_STALE:${symbol}`);
    }
    const evidence = normalized as unknown as Readonly<Record<string, unknown>>;
    stockRows.push({
      id: `stock_snapshot_${canonicalJsonHash({ symbol, now: nowIso, evidence })}`,
      symbol,
      observedAt: nowIso,
      sourceTimestamp: normalized.sourceTimestamp,
      requestedFeed: normalized.requestedFeed,
      effectiveFeed: normalized.effectiveFeed,
      source: normalized.source,
      requestId: normalized.requestId,
      evidence
    });
  }
  await repository.upsertStockSnapshots(stockRows, input.context);

  const optionContracts: PostgresOptionContract[] = [];
  const optionSnapshots: PostgresOptionSnapshot[] = [];
  if (input.optionsEnabled) {
    const optionFeed = process.env.ALPACA_OPTION_DATA_FEED?.trim().toLowerCase() || "opra";
    if (optionFeed !== "opra") throw new Error(`POSTGRES_OPTION_FEED_INVALID:${optionFeed}`);
    const rawContracts = await dependencies.fetchOptionContracts({
      underlyingSymbols: requestedSymbols,
      minDaysToExpiration: 0,
      maxDaysToExpiration: 730,
      status: "active",
      limit: 1_000
    });
    optionContracts.push(
      ...rawContracts.map((raw) => contractRow(raw, nowIso))
        .filter((row): row is PostgresOptionContract => Boolean(row?.tradable))
    );
    if (optionContracts.length === 0) {
      throw new Error("POSTGRES_OPTION_CONTRACTS_MISSING");
    }
    await repository.upsertOptionContracts(optionContracts, input.context);
    const fetchedOptions = await dependencies.fetchOptionSnapshots(
      optionContracts.map((row) => row.optionSymbol)
    );
    for (const fetched of fetchedOptions) {
      const normalized = normalizeOptionSnapshot(fetched.symbol, fetched.raw);
      const observedAt = normalized.snapshotTimestamp;
      if (!observedAt) continue;
      const evidenceAge = now.getTime() - Date.parse(observedAt);
      if (!Number.isFinite(evidenceAge) || evidenceAge < -60_000 || evidenceAge > maxBarAgeMs) {
        throw new Error(`POSTGRES_OPTION_SNAPSHOT_STALE:${normalized.symbol}`);
      }
      const bid = normalized.latestQuote?.bidPrice ?? null;
      const ask = normalized.latestQuote?.askPrice ?? null;
      const midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null;
      optionSnapshots.push({
        optionSymbol: normalized.symbol,
        underlyingSymbol: normalized.underlying,
        observedAt,
        quoteTimestamp: normalized.latestQuote?.timestamp ?? null,
        tradeTimestamp: normalized.latestTrade?.timestamp ?? null,
        snapshotTimestamp: normalized.snapshotTimestamp,
        bid,
        ask,
        midpoint,
        last: normalized.latestTrade?.price ?? null,
        volume: number((fetched.raw as Record<string, unknown>).volume),
        openInterest: number(
          (fetched.raw as Record<string, unknown>).open_interest ??
          (fetched.raw as Record<string, unknown>).openInterest
        ),
        impliedVolatility: normalized.impliedVolatility,
        delta: normalized.greeks.delta,
        gamma: normalized.greeks.gamma,
        theta: normalized.greeks.theta,
        vega: normalized.greeks.vega,
        rho: normalized.greeks.rho,
        source: "alpaca",
        requestId: null,
        evidence: {
          requestedFeed: optionFeed,
          effectiveFeed: optionFeed,
          raw: fetched.raw
        }
      });
    }
    if (optionSnapshots.length === 0) {
      throw new Error("POSTGRES_OPTION_SNAPSHOTS_MISSING");
    }
    await repository.upsertOptionSnapshots(optionSnapshots, input.context);
  }

  return {
    bars: barRows,
    stockSnapshots: stockRows,
    optionContracts,
    optionSnapshots,
    summary: {
      symbolCount: requestedSymbols.length,
      barCount: barRows.length,
      stockSnapshotCount: stockRows.length,
      optionContractCount: optionContracts.length,
      optionSnapshotCount: optionSnapshots.length
    }
  };
};
