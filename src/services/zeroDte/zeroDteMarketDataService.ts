import { config } from "../../config.js";
import {
  getLatestOptionSnapshots,
  getLatestStockSnapshots,
  type AlpacaOptionSnapshotRaw,
  type AlpacaStockSnapshotRaw
} from "../alpacaClient.js";
import { getAlpacaMarketClock } from "../alpacaMarketClockService.js";
import { normalizeOptionQuote } from "../optionQuoteNormalizer.js";
import { normalizeOptionSnapshot } from "../optionSnapshotNormalizer.js";
import { parseOptionSymbol } from "../optionSymbolService.js";
import { assertReadOnlyAlpacaAccessAllowed } from "../tradingSafetyService.js";
import {
  fetchBars,
  fetchOptionContracts,
  type OptionContractRaw
} from "../providers/alpaca.js";
import type { ZeroDteBar } from "./zeroDteRegimeService.js";
import type { ZeroDteConfig, ZeroDteDirection } from "./zeroDteTypes.js";

export type { ZeroDteBar } from "./zeroDteRegimeService.js";

export interface ZeroDteStockSnapshot {
  symbol?: string | null;
  latestTrade?: {
    price?: number | string | null;
    timestamp?: string | null;
  } | null;
  latestQuote?: {
    bid?: number | string | null;
    ask?: number | string | null;
    timestamp?: string | null;
  } | null;
  requestId?: string | null;
}

export interface ZeroDteContract {
  symbol: string;
  underlying: string;
  expirationDate: string;
  type: "call" | "put";
  strike: number;
  tradable: boolean;
  openInterest?: number | null;
  requestId?: string | null;
}

export interface ZeroDteOptionQuote {
  symbol?: string | null;
  latestQuote?: {
    bidPrice?: number | string | null;
    askPrice?: number | string | null;
    timestamp?: string | null;
  } | null;
  bid?: number | string | null;
  ask?: number | string | null;
  midpoint?: number | string | null;
  volume?: number | string | null;
  openInterest?: number | string | null;
  gamma?: number | string | null;
  delta?: number | string | null;
  impliedVolatility?: number | string | null;
  quoteTimestamp?: string | null;
  snapshotTimestamp?: string | null;
  requestId?: string | null;
}

export interface ZeroDteBarsResult {
  bars: ZeroDteBar[];
  requestIds: string[];
}

export interface ZeroDteMarketDataProvider {
  getClock(): Promise<{ timestamp: string; isOpen: boolean; nextClose: string; requestId?: string }>;
  getStockSnapshot(symbols: string[]): Promise<Record<string, ZeroDteStockSnapshot>>;
  getBars(
    symbol: string,
    timeframe: "1Min" | "5Min" | "15Min",
    start: string,
    end: string
  ): Promise<ZeroDteBar[] | ZeroDteBarsResult>;
  listContracts(input: {
    underlying: string;
    expirationDate: string;
    limit: number;
  }): Promise<ZeroDteContract[]>;
  getOptionSnapshots(symbols: string[]): Promise<Record<string, ZeroDteOptionQuote>>;
}

export interface ZeroDteMarketContext {
  underlying: string;
  tradingDate: string;
  price: number;
  direction: ZeroDteDirection;
  contract: ZeroDteContract;
  option: {
    symbol: string;
    side: "call" | "put";
    bid: number | null;
    ask: number | null;
    midpoint: number | null;
    spreadPct: number | null;
    volume: number | null;
    openInterest: number | null;
    gamma: number | null;
    delta: number | null;
    impliedVolatility: number | null;
    quoteTimestamp: string | null;
    quoteStatus: "valid" | "missing" | "invalid" | "stale";
    executable: boolean;
  };
  barsByTimeframe: Record<"1Min" | "5Min" | "15Min", ZeroDteBar[]>;
  asOf: string;
  ingestedAt: string;
  source: "alpaca";
  sourceTimestamps: {
    clock: string;
    underlying: string | null;
    optionQuote: string | null;
    optionSnapshot: string | null;
  };
  requestIds: {
    clock: string | null;
    underlying: string | null;
    option: string | null;
    bars: string[];
    contracts: string[];
  };
  blockers: string[];
}

const TIMEFRAMES = ["1Min", "5Min", "15Min"] as const;
const ALL_SESSION_START_ET = "09:30:00";
const CONTRACT_DISCOVERY_LIMIT = 1000;
const ALL_PLAYBOOK_BLOCKERS = new Set(["quote_timestamp_missing", "quote_unavailable"]);

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validTimestamp = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

const uniqueRequestIds = (values: Array<string | null | undefined>) =>
  Array.from(new Set(values.filter((value): value is string => Boolean(value))));

const isFreshTimestamp = (timestamp: string | null, now: string, maxAgeMs: number) => {
  if (!timestamp) return false;
  const ageMs = Date.parse(now) - Date.parse(timestamp);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
};

const newYorkDate = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("0DTE market data collection requires a valid explicit now timestamp");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!year || !month || !day) {
    throw new RangeError("0DTE market data collection could not determine the ET trading date");
  }
  return `${year}-${month}-${day}`;
};

const newYorkOffset = (tradingDate: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset"
  }).formatToParts(new Date(`${tradingDate}T16:00:00.000Z`));
  const offset = parts.find((part) => part.type === "timeZoneName")?.value;
  return offset?.replace("GMT", "") || "-05:00";
};

const sessionStart = (tradingDate: string) =>
  `${tradingDate}T${ALL_SESSION_START_ET}${newYorkOffset(tradingDate)}`;

const midpointSpreadPct = (bid: number | null, ask: number | null, midpoint: number | null) =>
  bid !== null && ask !== null && midpoint !== null && midpoint > 0
    ? ((ask - bid) / midpoint) * 100
    : null;

const stockPrice = (snapshot: ZeroDteStockSnapshot) => {
  const tradePrice = finiteNumber(snapshot.latestTrade?.price);
  if (tradePrice !== null && tradePrice > 0) {
    return {
      price: tradePrice,
      timestamp: validTimestamp(snapshot.latestTrade?.timestamp)
    };
  }
  const bid = finiteNumber(snapshot.latestQuote?.bid);
  const ask = finiteNumber(snapshot.latestQuote?.ask);
  if (bid !== null && ask !== null && bid > 0 && ask >= bid) {
    return {
      price: (bid + ask) / 2,
      timestamp: validTimestamp(snapshot.latestQuote?.timestamp)
    };
  }
  return null;
};

const directionFor = (type: "call" | "put"): ZeroDteDirection =>
  type === "call" ? "bullish" : "bearish";

export const normalizeZeroDteContract = (raw: OptionContractRaw): ZeroDteContract | null => {
  const parsed = raw.symbol ? parseOptionSymbol(raw.symbol) : null;
  if (!parsed?.ok) return null;

  const rawType = raw.type === undefined || raw.type === null
    ? null
    : String(raw.type).trim().toLowerCase();
  const rawUnderlying = raw.underlying_symbol === undefined || raw.underlying_symbol === null
    ? null
    : String(raw.underlying_symbol).trim().toUpperCase();
  const rawRoot = raw.root_symbol === undefined || raw.root_symbol === null
    ? null
    : String(raw.root_symbol).trim().toUpperCase();
  const rawExpiration = raw.expiration_date === undefined || raw.expiration_date === null
    ? null
    : String(raw.expiration_date).trim();
  const rawStrike = raw.strike_price === undefined || raw.strike_price === null
    ? null
    : finiteNumber(raw.strike_price);

  if (
    (rawType !== null && rawType !== parsed.optionType) ||
    (rawUnderlying !== null && rawUnderlying !== parsed.underlying) ||
    (rawRoot !== null && rawRoot !== parsed.underlying) ||
    (rawExpiration !== null && rawExpiration !== parsed.expirationDate) ||
    (raw.strike_price !== undefined && raw.strike_price !== null &&
      (rawStrike === null || rawStrike !== parsed.strikePrice))
  ) {
    return null;
  }

  return {
    symbol: parsed.normalizedSymbol,
    underlying: parsed.underlying,
    expirationDate: parsed.expirationDate,
    type: parsed.optionType,
    strike: parsed.strikePrice,
    tradable: raw.tradable === true || raw.tradeable === true || raw.status === "active",
    openInterest: finiteNumber(raw.open_interest ?? raw.openInterest),
    requestId: raw.requestId ?? null
  };
};

const selectStrikeBand = (
  contracts: ZeroDteContract[],
  price: number,
  maximumPerSide: number
) => {
  const selected = new Set<string>();
  for (const type of ["call", "put"] as const) {
    contracts
      .filter((contract) => contract.type === type)
      .sort((left, right) => {
        const distance = Math.abs(left.strike - price) - Math.abs(right.strike - price);
        return distance || left.strike - right.strike || left.symbol.localeCompare(right.symbol);
      })
      .slice(0, maximumPerSide)
      .forEach((contract) => selected.add(contract.symbol));
  }
  return contracts.filter((contract) => selected.has(contract.symbol));
};

const quoteBlockers = (quoteStatus: "valid" | "missing" | "invalid" | "stale", rejectionReason: string | null) => {
  if (quoteStatus === "valid") return [];
  if (quoteStatus === "stale") return ["QUOTE_STALE"];
  if (quoteStatus === "invalid" && rejectionReason === "crossed_quote") return ["QUOTE_CROSSED"];
  if (ALL_PLAYBOOK_BLOCKERS.has(rejectionReason ?? "")) return ["QUOTE_MISSING"];
  return ["QUOTE_INVALID"];
};

const meetsLiquidityAndPriceFilters = (input: {
  volume: number | null;
  openInterest: number | null;
  quoteStatus: "valid" | "missing" | "invalid" | "stale";
  midpoint: number | null;
  spreadPct: number | null;
  config: ZeroDteConfig;
}) => {
  if (input.volume === null || input.volume < input.config.minOptionVolume) return false;
  if (input.openInterest === null || input.openInterest < input.config.minOpenInterest) return false;
  if (input.quoteStatus !== "valid") return true;
  if (input.midpoint === null || input.midpoint < input.config.minPremium || input.midpoint > input.config.maxPremium) {
    return false;
  }
  return input.spreadPct !== null && input.spreadPct <= input.config.maxSpreadPct;
};

const normalizeAlpacaStockSnapshot = (
  symbol: string,
  raw: AlpacaStockSnapshotRaw,
  requestId: string | null
): ZeroDteStockSnapshot => {
  const legacy = raw as Record<string, {
    p?: number | string | null;
    t?: string | null;
    bp?: number | string | null;
    ap?: number | string | null;
  } | undefined>;
  const latestTrade = raw.latestTrade ?? legacy.latest_trade;
  const latestQuote = raw.latestQuote ?? legacy.latest_quote;
  return {
    symbol,
    latestTrade: latestTrade
      ? { price: latestTrade.p, timestamp: latestTrade.t }
      : null,
    latestQuote: latestQuote
      ? { bid: latestQuote.bp, ask: latestQuote.ap, timestamp: latestQuote.t }
      : null,
    requestId
  };
};

export const createAlpacaZeroDteMarketDataProvider = (): ZeroDteMarketDataProvider => ({
  async getClock() {
    const clock = await getAlpacaMarketClock();
    if (!clock.timestamp || typeof clock.isOpen !== "boolean" || !clock.nextClose) {
      throw new Error("ALPACA_CLOCK_INCOMPLETE");
    }
    return {
      timestamp: clock.timestamp,
      isOpen: clock.isOpen,
      nextClose: clock.nextClose,
      ...(clock.requestId ? { requestId: clock.requestId } : {})
    };
  },

  async getStockSnapshot(symbols) {
    const response = await getLatestStockSnapshots(symbols);
    const requestId = response.requestIds.at(-1) ?? null;
    return Object.fromEntries(
      Object.entries(response.data).map(([symbol, raw]) => [
        symbol.toUpperCase(),
        normalizeAlpacaStockSnapshot(symbol.toUpperCase(), raw, requestId)
      ])
    );
  },

  async getBars(symbol, timeframe, start, end) {
    assertReadOnlyAlpacaAccessAllowed();
    const rows = await fetchBars({
      symbols: [symbol],
      timeframe,
      start,
      end,
      feed: config.alpaca.stockDataFeed
    });
    return {
      bars: rows
        .filter((row) => row.symbol.toUpperCase() === symbol.toUpperCase())
        .flatMap((row) => row.bars.map((bar) => ({
          timestamp: bar.t,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v
        }))),
      requestIds: uniqueRequestIds(rows.map((row) => row.requestId))
    };
  },

  async listContracts(input) {
    assertReadOnlyAlpacaAccessAllowed();
    const contracts = await fetchOptionContracts({
      underlyingSymbols: [input.underlying],
      expirationDate: input.expirationDate,
      limit: input.limit
    });
    return contracts
      .map(normalizeZeroDteContract)
      .filter((contract): contract is ZeroDteContract => contract !== null);
  },

  async getOptionSnapshots(symbols) {
    const response = await getLatestOptionSnapshots(symbols);
    const requestId = response.requestIds.at(-1) ?? null;
    const result: Record<string, ZeroDteOptionQuote> = {};
    for (const [symbol, raw] of Object.entries(response.data)) {
      const canonical = normalizeOptionSnapshot(symbol, raw as AlpacaOptionSnapshotRaw);
      const rawRecord = raw as Record<string, unknown>;
      const dailyBar = raw.dailyBar ?? raw.daily_bar;
      result[canonical.symbol] = {
        symbol: canonical.symbol,
        bid: canonical.latestQuote?.bidPrice ?? null,
        ask: canonical.latestQuote?.askPrice ?? null,
        volume: finiteNumber(rawRecord.volume ?? dailyBar?.v),
        openInterest: finiteNumber(rawRecord.openInterest ?? rawRecord.open_interest),
        gamma: canonical.greeks.gamma,
        delta: canonical.greeks.delta,
        impliedVolatility: canonical.impliedVolatility,
        quoteTimestamp: canonical.latestQuote?.timestamp ?? null,
        snapshotTimestamp: canonical.snapshotTimestamp,
        requestId
      };
    }
    return result;
  }
});

const normalizeBarsResult = (
  result: ZeroDteBar[] | ZeroDteBarsResult
): ZeroDteBarsResult => {
  if (Array.isArray(result)) {
    return {
      bars: result,
      requestIds: uniqueRequestIds(
        result.map((bar) => typeof bar.requestId === "string" ? bar.requestId : null)
      )
    };
  }
  return {
    bars: result.bars ?? [],
    requestIds: uniqueRequestIds([
      ...result.requestIds,
      ...result.bars.map((bar) => typeof bar.requestId === "string" ? bar.requestId : null)
    ])
  };
};

export const collectZeroDteMarketContexts = async (input: {
  now: string;
  config: ZeroDteConfig;
  provider: ZeroDteMarketDataProvider;
}): Promise<ZeroDteMarketContext[]> => {
  const ingestedAt = new Date(input.now).toISOString();
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new RangeError("0DTE market data collection requires a valid explicit now timestamp");
  }
  const clock = await input.provider.getClock();
  if (!clock.isOpen) return [];

  const tradingDate = newYorkDate(input.now);
  const underlyings = Array.from(new Set(input.config.underlyings.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)));
  if (!underlyings.length || input.config.maxStrikesEachSide === 0 || input.config.queueMaxActive === 0) {
    return [];
  }

  const stockSnapshots = await input.provider.getStockSnapshot(underlyings);
  const contexts: ZeroDteMarketContext[] = [];
  const start = sessionStart(tradingDate);

  for (const underlying of underlyings) {
    const snapshot = stockSnapshots[underlying] ?? stockSnapshots[underlying.toLowerCase()];
    if (!snapshot) continue;
    const underlyingContext = stockPrice(snapshot);
    if (
      !underlyingContext ||
      !isFreshTimestamp(
        underlyingContext.timestamp,
        ingestedAt,
        input.config.underlyingMaxAgeMs
      )
    ) {
      continue;
    }

    const barResults = await Promise.all(
      TIMEFRAMES.map(async (timeframe) => [
        timeframe,
        normalizeBarsResult(
          await input.provider.getBars(underlying, timeframe, start, ingestedAt)
        )
      ] as const)
    );
    const barsByTimeframe = Object.fromEntries(
      barResults.map(([timeframe, result]) => [timeframe, result.bars])
    ) as Record<"1Min" | "5Min" | "15Min", ZeroDteBar[]>;
    const barRequestIds = uniqueRequestIds(
      barResults.flatMap(([, result]) => result.requestIds)
    );
    const contracts = await input.provider.listContracts({
      underlying,
      expirationDate: tradingDate,
      limit: CONTRACT_DISCOVERY_LIMIT
    });
    const selectedContracts = selectStrikeBand(
      contracts.filter(
        (contract) =>
          contract.underlying === underlying &&
          contract.expirationDate === tradingDate &&
          contract.tradable &&
          Number.isFinite(contract.strike)
      ),
      underlyingContext.price,
      input.config.maxStrikesEachSide
    );
    const contractRequestIds = uniqueRequestIds(
      contracts.map((contract) => contract.requestId)
    );
    if (!selectedContracts.length) continue;

    const optionSnapshots = await input.provider.getOptionSnapshots(
      selectedContracts.map((contract) => contract.symbol)
    );
    for (const contract of selectedContracts) {
      const sourceOption = optionSnapshots[contract.symbol] ?? { symbol: contract.symbol };
      const rawBid = sourceOption.bid ?? sourceOption.latestQuote?.bidPrice ?? null;
      const rawAsk = sourceOption.ask ?? sourceOption.latestQuote?.askPrice ?? null;
      const rawTimestamp = sourceOption.quoteTimestamp ?? sourceOption.latestQuote?.timestamp ?? null;
      const normalizedQuote = normalizeOptionQuote(
        {
          optionSymbol: contract.symbol,
          bid: rawBid,
          ask: rawAsk,
          midpoint: sourceOption.midpoint ?? null,
          timestamp: rawTimestamp
        },
        new Date(ingestedAt)
      );
      const spreadPct = midpointSpreadPct(
        normalizedQuote.bid,
        normalizedQuote.ask,
        normalizedQuote.midpoint
      );
      const volume = finiteNumber(sourceOption.volume);
      const openInterest = finiteNumber(sourceOption.openInterest ?? contract.openInterest);
      if (!meetsLiquidityAndPriceFilters({
        volume,
        openInterest,
        quoteStatus: normalizedQuote.quoteStatus,
        midpoint: normalizedQuote.midpoint,
        spreadPct,
        config: input.config
      })) {
        continue;
      }

      contexts.push({
        underlying,
        tradingDate,
        price: underlyingContext.price,
        direction: directionFor(contract.type),
        contract,
        option: {
          symbol: contract.symbol,
          side: contract.type,
          bid: normalizedQuote.bid,
          ask: normalizedQuote.ask,
          midpoint: normalizedQuote.midpoint,
          spreadPct,
          volume,
          openInterest,
          gamma: finiteNumber(sourceOption.gamma),
          delta: finiteNumber(sourceOption.delta),
          impliedVolatility: finiteNumber(sourceOption.impliedVolatility),
          quoteTimestamp: normalizedQuote.quoteTimestamp,
          quoteStatus: normalizedQuote.quoteStatus,
          executable: normalizedQuote.executable
        },
        barsByTimeframe,
        asOf: clock.timestamp,
        ingestedAt,
        source: "alpaca",
        sourceTimestamps: {
          clock: clock.timestamp,
          underlying: underlyingContext.timestamp,
          optionQuote: normalizedQuote.quoteTimestamp,
          optionSnapshot: validTimestamp(sourceOption.snapshotTimestamp)
        },
        requestIds: {
          clock: clock.requestId ?? null,
          underlying: snapshot.requestId ?? null,
          option: sourceOption.requestId ?? null,
          bars: barRequestIds,
          contracts: contractRequestIds
        },
        blockers: quoteBlockers(normalizedQuote.quoteStatus, normalizedQuote.rejectionReason)
      });
    }
  }
  return contexts.slice(0, input.config.queueMaxActive);
};
