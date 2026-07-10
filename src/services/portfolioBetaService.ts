import type { Timeframe } from "../types.js";
import { getBars as getPersistedBars } from "./marketDataIngest.js";
import type { HedgeConfig } from "./hedgeConfigService.js";
import {
  readCompatibleBetaCache,
  writeBetaCache
} from "./hedgePersistenceService.js";
import type { BetaCacheEntry, BetaCacheIdentity } from "./hedgeTypes.js";

export interface BetaBar {
  timestamp: string;
  close: number;
}

export interface BetaCalculationResult {
  beta: number | null;
  observations: number;
  status: "calculated" | "unavailable";
  warnings: string[];
}

export interface SymbolBetaResult extends Omit<BetaCalculationResult, "status"> {
  symbol: string;
  benchmark: string;
  status: "cached" | "calculated" | "unavailable";
  latestMarketDataDate: string | null;
  dataStartDate: string | null;
  dataEndDate: string | null;
  cacheIdentity: BetaCacheIdentity | null;
}

const finiteCloses = (values: number[]) =>
  values.every((value) => Number.isFinite(value) && value > 0);

const simpleReturns = (closes: number[]) =>
  closes.slice(1).map((close, index) => close / closes[index]! - 1);

export const calculateBeta = (input: {
  symbolCloses: number[];
  benchmarkCloses: number[];
  minimumObservations: number;
}): BetaCalculationResult => {
  const count = Math.min(input.symbolCloses.length, input.benchmarkCloses.length);
  const symbolCloses = input.symbolCloses.slice(0, count);
  const benchmarkCloses = input.benchmarkCloses.slice(0, count);
  const observations = Math.max(0, count - 1);
  if (
    observations < input.minimumObservations ||
    !finiteCloses(symbolCloses) ||
    !finiteCloses(benchmarkCloses)
  ) {
    return {
      beta: null,
      observations,
      status: "unavailable",
      warnings: ["BETA_OBSERVATIONS_INSUFFICIENT"]
    };
  }

  const symbolReturns = simpleReturns(symbolCloses);
  const benchmarkReturns = simpleReturns(benchmarkCloses);
  const symbolMean =
    symbolReturns.reduce((sum, value) => sum + value, 0) / observations;
  const benchmarkMean =
    benchmarkReturns.reduce((sum, value) => sum + value, 0) / observations;
  const covariance =
    symbolReturns.reduce(
      (sum, value, index) =>
        sum + (value - symbolMean) * (benchmarkReturns[index]! - benchmarkMean),
      0
    ) / Math.max(1, observations - 1);
  const benchmarkVariance =
    benchmarkReturns.reduce(
      (sum, value) => sum + (value - benchmarkMean) ** 2,
      0
    ) / Math.max(1, observations - 1);

  if (!(benchmarkVariance > 0)) {
    return {
      beta: null,
      observations,
      status: "unavailable",
      warnings: ["BETA_BENCHMARK_VARIANCE_ZERO"]
    };
  }
  return {
    beta: covariance / benchmarkVariance,
    observations,
    status: "calculated",
    warnings: []
  };
};

const dateKey = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

const alignBars = (symbolBars: BetaBar[], benchmarkBars: BetaBar[], lookbackDays: number) => {
  const symbolByDate = new Map(
    symbolBars
      .map((bar) => [dateKey(bar.timestamp), Number(bar.close)] as const)
      .filter((entry): entry is [string, number] => Boolean(entry[0]) && Number.isFinite(entry[1]))
  );
  const benchmarkByDate = new Map(
    benchmarkBars
      .map((bar) => [dateKey(bar.timestamp), Number(bar.close)] as const)
      .filter((entry): entry is [string, number] => Boolean(entry[0]) && Number.isFinite(entry[1]))
  );
  return [...symbolByDate.keys()]
    .filter((date) => benchmarkByDate.has(date))
    .sort()
    .slice(-(lookbackDays + 1))
    .map((date) => ({
      date,
      symbolClose: symbolByDate.get(date)!,
      benchmarkClose: benchmarkByDate.get(date)!
    }));
};

export interface SymbolBetaDeps {
  getBars?: (symbol: string, timeframe: string) => BetaBar[];
  readCache?: (identity: BetaCacheIdentity, asOf: string) => BetaCacheEntry | null;
  writeCache?: (entry: BetaCacheEntry) => void;
}

export const calculateSymbolBeta = (
  input: {
    symbol: string;
    config: HedgeConfig;
    asOf?: string;
  },
  deps: SymbolBetaDeps = {}
): SymbolBetaResult => {
  const asOf = input.asOf ?? new Date().toISOString();
  const symbol = input.symbol.trim().toUpperCase();
  const benchmark = input.config.beta.benchmark;
  const getBars =
    deps.getBars ??
    ((requested: string, timeframe: string) =>
      getPersistedBars(requested, timeframe as Timeframe));
  const aligned = alignBars(
    getBars(symbol, input.config.beta.observationInterval),
    getBars(benchmark, input.config.beta.observationInterval),
    input.config.beta.lookbackDays
  );
  const latestMarketDataDate = aligned.at(-1)?.date ?? null;
  if (!latestMarketDataDate) {
    return {
      symbol,
      benchmark,
      beta: null,
      observations: 0,
      status: "unavailable",
      latestMarketDataDate: null,
      dataStartDate: null,
      dataEndDate: null,
      cacheIdentity: null,
      warnings: ["BETA_MARKET_DATA_UNAVAILABLE"]
    };
  }

  const cacheIdentity: BetaCacheIdentity = {
    symbol,
    benchmark,
    lookbackDays: input.config.beta.lookbackDays,
    observationInterval: input.config.beta.observationInterval,
    minimumObservations: input.config.beta.minimumObservations,
    calculationVersion: input.config.beta.calculationVersion,
    latestMarketDataDate
  };
  const cached = (deps.readCache ?? readCompatibleBetaCache)(cacheIdentity, asOf);
  if (cached) {
    return {
      symbol,
      benchmark,
      beta: cached.beta,
      observations: cached.observations,
      status: "cached",
      latestMarketDataDate,
      dataStartDate: cached.dataStartDate,
      dataEndDate: cached.dataEndDate,
      cacheIdentity,
      warnings: []
    };
  }

  const calculation = calculateBeta({
    symbolCloses: aligned.map((row) => row.symbolClose),
    benchmarkCloses: aligned.map((row) => row.benchmarkClose),
    minimumObservations: input.config.beta.minimumObservations
  });
  const dataStartDate = aligned[0]?.date ?? null;
  const dataEndDate = aligned.at(-1)?.date ?? null;
  (deps.writeCache ?? writeBetaCache)({
    ...cacheIdentity,
    beta: calculation.beta,
    observations: calculation.observations,
    dataStartDate,
    dataEndDate,
    status: calculation.status,
    computedAt: asOf,
    expiresAt: new Date(
      Date.parse(asOf) + input.config.beta.cacheTtlHours * 60 * 60 * 1000
    ).toISOString()
  });
  return {
    symbol,
    benchmark,
    ...calculation,
    latestMarketDataDate,
    dataStartDate,
    dataEndDate,
    cacheIdentity
  };
};

export const portfolioBetasForSymbols = (input: {
  symbols: string[];
  config: HedgeConfig;
  asOf?: string;
}) =>
  Object.fromEntries(
    [...new Set(input.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].map(
      (symbol) => [symbol, calculateSymbolBeta({ symbol, config: input.config, asOf: input.asOf })]
    )
  );
