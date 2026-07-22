import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { FencedPostgresRepositoryContext } from "../repositories/postgres/postgresRepositorySupport.js";
import {
  PostgresMarketDataRepository,
  optionSnapshotEvidenceFingerprint,
  type PostgresMarketBar,
  type PostgresOptionContract,
  type PostgresOptionSnapshot,
  type PostgresStockSnapshot,
  type PostgresUniverseSymbol
} from "../repositories/postgres/postgresMarketDataRepository.js";
import { normalizeOptionSnapshot } from "./optionSnapshotNormalizer.js";
import {
  fetchAllBars,
  fetchOptionChainSnapshots,
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
  | "listOptionContractsBySymbols"
  | "listOptionSnapshotsByIdentity"
>;

type MarketDataDependencies = {
  fetchAllBars: typeof fetchAllBars;
  fetchStockSnapshots: typeof fetchStockSnapshots;
  fetchOptionContracts: typeof fetchOptionContracts;
  fetchOptionSnapshots: typeof fetchOptionSnapshots;
  fetchOptionChainSnapshots: typeof fetchOptionChainSnapshots;
};

const defaults: MarketDataDependencies = {
  fetchAllBars,
  fetchStockSnapshots,
  fetchOptionContracts,
  fetchOptionSnapshots,
  fetchOptionChainSnapshots
};

const COOPERATIVE_YIELD_BATCH_SIZE = 250;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const fingerprintMap = async <T>(
  rows: readonly T[],
  keyFor: (row: T) => string,
  materialFor: (row: T) => unknown
) => {
  const result = new Map<string, string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    result.set(keyFor(row), canonicalJsonHash(materialFor(row)));
    if ((index + 1) % COOPERATIVE_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
  }
  return result;
};

const symbols = (values: readonly string[]) => Array.from(new Set(
  values.map((value) => value.trim().toUpperCase()).filter(Boolean)
));

const number = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const retrievalTimestamp = (value: unknown, fallback: string) => {
  const candidate = text(value);
  const parsed = candidate ? Date.parse(candidate) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
};

const dateOnly = (value: unknown) => {
  const candidate = text(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
};

const postgresNumeric = (value: number | null | undefined, scale: number) =>
  value === null || value === undefined ? null : Number(value.toFixed(scale));

const optionContractIdentityMaterial = (row: PostgresOptionContract) => ({
  optionSymbol: row.optionSymbol,
  underlyingSymbol: row.underlyingSymbol,
  type: row.type,
  expirationDate: row.expirationDate,
  strike: postgresNumeric(row.strike, 8),
  multiplier: postgresNumeric(row.multiplier, 4),
  tradable: row.tradable,
  contractId: row.contractId ?? null,
  status: row.status ?? null,
  exerciseStyle: row.exerciseStyle ?? null,
  openInterest: row.openInterest ?? null,
  openInterestDate: row.openInterestDate ?? null,
  closePrice: row.closePrice ?? null,
  closePriceDate: row.closePriceDate ?? null
});

const optionContractPersistenceMaterial = (row: PostgresOptionContract) => ({
  ...optionContractIdentityMaterial(row),
  source: row.source,
  requestId: row.requestId,
  observedAt: row.observedAt,
  evidence: row.evidence ?? {}
});

const optionSnapshotObservationMaterial = (row: PostgresOptionSnapshot) => ({
  optionSymbol: row.optionSymbol,
  underlyingSymbol: row.underlyingSymbol,
  observedAt: row.observedAt,
  quoteTimestamp: row.quoteTimestamp,
  tradeTimestamp: row.tradeTimestamp ?? null,
  snapshotTimestamp: row.snapshotTimestamp ?? null,
  underlyingPrice: row.underlyingPrice ?? null,
  bid: postgresNumeric(row.bid, 8),
  ask: postgresNumeric(row.ask, 8),
  bidSize: row.bidSize ?? null,
  askSize: row.askSize ?? null,
  midpoint: postgresNumeric(row.midpoint, 8),
  spread: row.spread ?? null,
  spreadPct: row.spreadPct ?? null,
  last: postgresNumeric(row.last, 8),
  volume: row.volume,
  openInterest: row.openInterest,
  impliedVolatility: postgresNumeric(row.impliedVolatility, 12),
  delta: postgresNumeric(row.delta, 12),
  gamma: postgresNumeric(row.gamma, 12),
  theta: postgresNumeric(row.theta, 12),
  vega: postgresNumeric(row.vega, 12),
  rho: postgresNumeric(row.rho, 12),
  freshnessStatus: row.freshnessStatus ?? null
});

const optionSnapshotPersistenceMaterial = (row: PostgresOptionSnapshot) => ({
  ...optionSnapshotObservationMaterial(row),
  requestedFeed: row.requestedFeed ?? null,
  effectiveFeed: row.effectiveFeed ?? null,
  endpoint: row.endpoint ?? null,
  pageToken: row.pageToken ?? null,
  retrievedAt: row.retrievedAt ?? null,
  source: row.source,
  requestId: row.requestId,
  evidenceFingerprint: row.evidenceFingerprint ?? optionSnapshotEvidenceFingerprint(row)
});

const contractRow = (
  raw: OptionContractRaw,
  now: string
): PostgresOptionContract | null => {
  const optionSymbol = String(raw.symbol ?? "").trim().toUpperCase();
  const underlyingSymbol = String(raw.underlying_symbol ?? raw.root_symbol ?? "")
    .trim().toUpperCase();
  const expirationDate = dateOnly(raw.expiration_date);
  const strike = number(raw.strike_price);
  const documentedSize = raw.size === null || raw.size === undefined || raw.size === ""
    ? null
    : number(raw.size);
  const explicitMultiplier = raw.multiplier === null || raw.multiplier === undefined || raw.multiplier === ""
    ? null
    : number(raw.multiplier);
  if (
    (raw.size !== null && raw.size !== undefined && raw.size !== "" && documentedSize === null) ||
    (raw.multiplier !== null && raw.multiplier !== undefined && raw.multiplier !== "" && explicitMultiplier === null) ||
    (documentedSize !== null && explicitMultiplier !== null && documentedSize !== explicitMultiplier)
  ) return null;
  const multiplier = documentedSize ?? explicitMultiplier;
  const multiplierSource = documentedSize !== null ? "size" : explicitMultiplier !== null ? "multiplier" : null;
  const type = raw.type === "call" || raw.type === "put" ? raw.type : null;
  const status = String(raw.status ?? "").trim().toLowerCase();
  if (!optionSymbol || !underlyingSymbol || !expirationDate) {
    return null;
  }
  if (strike === null || strike <= 0 || multiplier === null || multiplier <= 0) return null;
  if (!type || status !== "active") return null;
  const openInterest = number(raw.open_interest ?? raw.openInterest);
  const closePrice = number(raw.close_price);
  return {
    optionSymbol,
    underlyingSymbol,
    type,
    expirationDate,
    strike,
    multiplier,
    tradable: raw.tradable === true || raw.tradeable === true,
    source: "alpaca",
    requestId: typeof raw.requestId === "string" ? raw.requestId : null,
    observedAt: retrievalTimestamp(raw.retrievedAt, now),
    contractId: text(raw.id),
    status: "active",
    exerciseStyle: text(raw.style ?? raw.exercise_style),
    openInterest: openInterest !== null && openInterest >= 0 ? openInterest : null,
    openInterestDate: dateOnly(raw.open_interest_date),
    closePrice: closePrice !== null && closePrice >= 0 ? closePrice : null,
    closePriceDate: dateOnly(raw.close_price_date),
    evidence: {
      endpoint: "/v2/options/contracts",
      requestedStatus: "active",
      contractId: text(raw.id),
      status: "active",
      exerciseStyle: text(raw.style ?? raw.exercise_style),
      openInterest: openInterest !== null && openInterest >= 0 ? openInterest : null,
      openInterestDate: dateOnly(raw.open_interest_date),
      closePrice: closePrice !== null && closePrice >= 0 ? closePrice : null,
      closePriceDate: dateOnly(raw.close_price_date),
      multiplierSource,
      requestId: typeof raw.requestId === "string" ? raw.requestId : null,
      retrievedAt: retrievalTimestamp(raw.retrievedAt, now)
    }
  };
};

export const refreshPostgresMarketData = async (input: {
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly start: string;
  readonly end: string;
  readonly optionsEnabled: boolean;
  readonly requiredOptionUnderlyings?: readonly string[];
  readonly now?: Date;
  readonly maxBarAgeHours?: number;
  readonly maxOptionSnapshotAgeSeconds?: number;
  readonly repository?: MarketDataWriter;
  readonly context: FencedPostgresRepositoryContext;
  readonly dependencies?: Partial<MarketDataDependencies>;
}) => {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const requestedSymbols = symbols(input.symbols);
  if (requestedSymbols.length === 0) throw new Error("POSTGRES_MARKET_SYMBOLS_REQUIRED");
  const requiredOptionUnderlyings = input.requiredOptionUnderlyings === undefined
    ? requestedSymbols.filter((symbol) => ["SPY", "QQQ", "AAPL"].includes(symbol))
    : symbols(input.requiredOptionUnderlyings);
  for (const symbol of requiredOptionUnderlyings) {
    if (!requestedSymbols.includes(symbol)) {
      throw new Error(`POSTGRES_REQUIRED_OPTION_UNDERLYING_NOT_REQUESTED:${symbol}`);
    }
  }
  const requiredOptionUnderlyingSet = new Set(requiredOptionUnderlyings);
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
    const stockObservedAt = retrievalTimestamp(fetched.retrievedAt, nowIso);
    const stockObservationTime = new Date(stockObservedAt);
    const normalized = normalizeStockSnapshot({
      symbol,
      raw: fetched.raw,
      observedAt: stockObservedAt,
      requestedFeed: fetched.requestedFeed,
      effectiveFeed: fetched.effectiveFeed,
      currency: fetched.currency,
      requestId: fetched.requestId,
      now: stockObservationTime,
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
      id: `stock_snapshot_${canonicalJsonHash({ symbol, observedAt: stockObservedAt, evidence })}`,
      symbol,
      observedAt: stockObservedAt,
      sourceTimestamp: normalized.sourceTimestamp,
      requestedFeed: normalized.requestedFeed,
      effectiveFeed: normalized.effectiveFeed,
      source: normalized.source,
      requestId: normalized.requestId,
      evidence
    });
  }
  await repository.upsertStockSnapshots(stockRows, input.context);

  let optionContracts: PostgresOptionContract[] = [];
  let optionSnapshots: PostgresOptionSnapshot[] = [];
  let optionChainPageCount = 0;
  const optionContractsByUnderlying: Record<string, number> = {};
  const optionSnapshotsByUnderlying: Record<string, number> = {};
  const freshOptionSnapshotsByUnderlying: Record<string, number> = {};
  if (input.optionsEnabled) {
    const optionFeed = process.env.ALPACA_OPTION_DATA_FEED?.trim().toLowerCase() || "opra";
    if (optionFeed !== "opra") throw new Error(`POSTGRES_OPTION_FEED_INVALID:${optionFeed}`);
    const contractsBySymbol = new Map<string, PostgresOptionContract>();
    for (const underlying of requestedSymbols) {
      const rawContracts = await dependencies.fetchOptionContracts({
        underlyingSymbols: [underlying],
        minDaysToExpiration: 0,
        maxDaysToExpiration: 730,
        status: "active",
        limit: null
      });
      for (const raw of rawContracts) {
        const row = contractRow(raw, nowIso);
        if (!row) continue;
        if (row.underlyingSymbol !== underlying) {
          throw new Error(`POSTGRES_OPTION_CONTRACT_UNDERLYING_MISMATCH:${row.optionSymbol}`);
        }
        const existing = contractsBySymbol.get(row.optionSymbol);
        if (existing && (
          canonicalJsonHash(optionContractIdentityMaterial(existing)) !==
          canonicalJsonHash(optionContractIdentityMaterial(row))
        )) {
          throw new Error(`POSTGRES_OPTION_CONTRACT_IDENTITY_CONFLICT:${row.optionSymbol}`);
        }
        if (!existing) contractsBySymbol.set(row.optionSymbol, row);
      }
      optionContractsByUnderlying[underlying] = [...contractsBySymbol.values()]
        .filter((row) => row.underlyingSymbol === underlying).length;
      if (
        requiredOptionUnderlyingSet.has(underlying) &&
        optionContractsByUnderlying[underlying] === 0
      ) {
        throw new Error(`POSTGRES_OPTION_CONTRACTS_MISSING:${underlying}`);
      }
    }
    optionContracts = [...contractsBySymbol.values()];
    if (optionContracts.length === 0) {
      throw new Error("POSTGRES_OPTION_CONTRACTS_MISSING");
    }
    await repository.upsertOptionContracts(optionContracts, input.context);
    const snapshotsByIdentity = new Map<string, PostgresOptionSnapshot>();
    const maxOptionAgeMs = (input.maxOptionSnapshotAgeSeconds ?? 1_200) * 1_000;
    for (const underlying of requestedSymbols) {
      const currentContracts = optionContracts.filter((row) => row.underlyingSymbol === underlying);
      if (!currentContracts.length) {
        optionSnapshotsByUnderlying[underlying] = 0;
        freshOptionSnapshotsByUnderlying[underlying] = 0;
        continue;
      }
      const contractBySymbol = new Map(currentContracts.map((row) => [row.optionSymbol, row]));
      const chain = await dependencies.fetchOptionChainSnapshots(underlying, { feed: optionFeed });
      optionChainPageCount += chain.pagesConsumed;
      for (const fetched of chain.snapshots) {
        const normalizedSymbol = fetched.symbol.trim().toUpperCase();
        const contract = contractBySymbol.get(normalizedSymbol);
        if (!contract) continue;
        const normalized = normalizeOptionSnapshot(normalizedSymbol, fetched.raw);
        if (normalized.underlying !== underlying) {
          throw new Error(`POSTGRES_OPTION_SNAPSHOT_UNDERLYING_MISMATCH:${normalized.symbol}`);
        }
        const observedAt = normalized.snapshotTimestamp;
        if (!observedAt) continue;
        const retrievedAt = Date.parse(fetched.retrievedAt);
        if (!Number.isFinite(retrievedAt)) {
          throw new Error(`POSTGRES_OPTION_RETRIEVAL_TIMESTAMP_INVALID:${normalized.symbol}`);
        }
        const evidenceAge = retrievedAt - Date.parse(observedAt);
        const freshnessStatus = Number.isFinite(evidenceAge) &&
          evidenceAge >= -60_000 && evidenceAge <= maxOptionAgeMs
          ? "fresh" as const
          : "stale" as const;
        const bid = normalized.latestQuote?.bidPrice ?? null;
        const ask = normalized.latestQuote?.askPrice ?? null;
        const validMarket = bid !== null && ask !== null && bid >= 0 && ask >= bid;
        const midpoint = validMarket ? (bid + ask) / 2 : null;
        const spread = validMarket ? ask - bid : null;
        const spreadPct = spread !== null && midpoint !== null && midpoint > 0
          ? spread / midpoint
          : null;
        const dailyBar = record(fetched.raw.dailyBar ?? fetched.raw.daily_bar);
        const dailyVolume = number(dailyBar.v);
        const stock = stockRows.find((row) => row.symbol === underlying);
        const underlyingPrice = number(stock?.evidence.midpoint) ?? number(stock?.evidence.latestTradePrice);
        const row: PostgresOptionSnapshot = {
          optionSymbol: normalized.symbol,
          underlyingSymbol: normalized.underlying,
          observedAt,
          quoteTimestamp: normalized.latestQuote?.timestamp ?? null,
          tradeTimestamp: normalized.latestTrade?.timestamp ?? null,
          snapshotTimestamp: normalized.snapshotTimestamp,
          underlyingPrice,
          bid,
          ask,
          bidSize: normalized.latestQuote?.bidSize ?? null,
          askSize: normalized.latestQuote?.askSize ?? null,
          midpoint,
          spread,
          spreadPct,
          last: normalized.latestTrade?.price ?? null,
          volume: dailyVolume !== null && dailyVolume >= 0 ? dailyVolume : null,
          openInterest: contract.openInterest ?? null,
          impliedVolatility: normalized.impliedVolatility,
          delta: normalized.greeks.delta,
          gamma: normalized.greeks.gamma,
          theta: normalized.greeks.theta,
          vega: normalized.greeks.vega,
          rho: normalized.greeks.rho,
          freshnessStatus,
          requestedFeed: fetched.requestedFeed,
          effectiveFeed: fetched.effectiveFeed ?? undefined,
          validationBasis: fetched.validationBasis ?? null,
          endpoint: fetched.endpoint,
          pageToken: fetched.pageToken,
          retrievedAt: fetched.retrievedAt,
          source: "alpaca",
          requestId: fetched.requestId,
          evidence: {
            endpoint: fetched.endpoint,
            underlying,
            requestedFeed: fetched.requestedFeed,
            effectiveFeed: fetched.effectiveFeed,
            validationBasis: fetched.validationBasis ?? null,
            requestId: fetched.requestId,
            pageToken: fetched.pageToken,
            retrievedAt: fetched.retrievedAt,
            observationTimestamp: observedAt,
            quoteTimestamp: normalized.latestQuote?.timestamp ?? null,
            tradeTimestamp: normalized.latestTrade?.timestamp ?? null,
            underlyingPrice,
            bidSize: normalized.latestQuote?.bidSize ?? null,
            askSize: normalized.latestQuote?.askSize ?? null,
            spread,
            spreadPct,
            freshnessStatus,
            dailyVolumeSource: "dailyBar.v",
            openInterestSource: "option_contracts.open_interest",
            raw: fetched.raw
          }
        };
        const identity = `${row.optionSymbol}:${row.observedAt}`;
        const existing = snapshotsByIdentity.get(identity);
        if (existing && (
          canonicalJsonHash(optionSnapshotObservationMaterial(existing)) !==
          canonicalJsonHash(optionSnapshotObservationMaterial(row))
        )) {
          throw new Error(`POSTGRES_OPTION_SNAPSHOT_IDENTITY_CONFLICT:${identity}`);
        }
        if (!existing) snapshotsByIdentity.set(identity, row);
      }
      optionSnapshotsByUnderlying[underlying] = [...snapshotsByIdentity.values()]
        .filter((row) => row.underlyingSymbol === underlying).length;
      freshOptionSnapshotsByUnderlying[underlying] = [...snapshotsByIdentity.values()]
        .filter((row) => row.underlyingSymbol === underlying && row.freshnessStatus === "fresh").length;
      if (
        requiredOptionUnderlyingSet.has(underlying) &&
        freshOptionSnapshotsByUnderlying[underlying] === 0
      ) {
        throw new Error(`POSTGRES_OPTION_SNAPSHOTS_CURRENT_MISSING:${underlying}`);
      }
    }
    optionSnapshots = [...snapshotsByIdentity.values()];
    if (optionSnapshots.length === 0) {
      throw new Error("POSTGRES_OPTION_SNAPSHOTS_MISSING");
    }
    await repository.upsertOptionSnapshots(optionSnapshots, input.context);
    const persistedContracts = await repository.listOptionContractsBySymbols({
      optionSymbols: optionContracts.map((row) => row.optionSymbol)
    }, input.context);
    const persistedSnapshots = await repository.listOptionSnapshotsByIdentity({
      identities: optionSnapshots.map((row) => ({
        optionSymbol: row.optionSymbol,
        observedAt: row.observedAt
      }))
    }, input.context);
    if (persistedContracts.length !== optionContracts.length) {
      throw new Error("POSTGRES_OPTION_CONTRACT_READBACK_INCOMPLETE");
    }
    if (persistedSnapshots.length !== optionSnapshots.length) {
      throw new Error("POSTGRES_OPTION_SNAPSHOT_READBACK_INCOMPLETE");
    }
    await yieldToEventLoop();
    const persistedSnapshotEvidenceFingerprints = new Map(persistedSnapshots.map((row) => [
      `${row.optionSymbol}:${row.observedAt}`,
      row.evidenceFingerprint ?? null
    ]));
    for (let index = 0; index < optionSnapshots.length; index += 1) {
      const row = optionSnapshots[index]!;
      if (
        persistedSnapshotEvidenceFingerprints.get(`${row.optionSymbol}:${row.observedAt}`) !==
        optionSnapshotEvidenceFingerprint(row)
      ) {
        throw new Error("POSTGRES_OPTION_SNAPSHOT_EVIDENCE_FINGERPRINT_MISMATCH");
      }
      if ((index + 1) % COOPERATIVE_YIELD_BATCH_SIZE === 0) await yieldToEventLoop();
    }
    const expectedContractsBySymbol = await fingerprintMap(
      optionContracts,
      (row) => row.optionSymbol,
      optionContractPersistenceMaterial
    );
    const actualContractsBySymbol = await fingerprintMap(
      persistedContracts,
      (row) => row.optionSymbol,
      optionContractPersistenceMaterial
    );
    if (
      actualContractsBySymbol.size !== expectedContractsBySymbol.size ||
      [...expectedContractsBySymbol].some(([key, fingerprint]) =>
        actualContractsBySymbol.get(key) !== fingerprint)
    ) {
      throw new Error("POSTGRES_OPTION_CONTRACT_READBACK_MISMATCH");
    }
    const expectedSnapshotsByIdentity = await fingerprintMap(
      optionSnapshots,
      (row) => `${row.optionSymbol}:${row.observedAt}`,
      optionSnapshotPersistenceMaterial
    );
    const actualSnapshotsByIdentity = await fingerprintMap(
      persistedSnapshots,
      (row) => `${row.optionSymbol}:${row.observedAt}`,
      optionSnapshotPersistenceMaterial
    );
    if (
      actualSnapshotsByIdentity.size !== expectedSnapshotsByIdentity.size ||
      [...expectedSnapshotsByIdentity].some(([key, fingerprint]) =>
        actualSnapshotsByIdentity.get(key) !== fingerprint)
    ) {
      throw new Error("POSTGRES_OPTION_SNAPSHOT_READBACK_MISMATCH");
    }
    optionContracts = persistedContracts;
    optionSnapshots = persistedSnapshots;
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
      optionSnapshotCount: optionSnapshots.length,
      optionChainPageCount,
      optionContractsByUnderlying,
      optionSnapshotsByUnderlying,
      freshOptionSnapshotsByUnderlying
    }
  };
};
