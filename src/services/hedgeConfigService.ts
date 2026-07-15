import { canonicalJsonHash } from "../lib/canonicalJson.js";
import {
  HEDGE_PLAN_VERSION,
  HEDGE_REGIME_MODEL_VERSION,
  HEDGE_RISK_MODEL_VERSION
} from "./hedgeTypes.js";

export interface HedgeConfig {
  executionEnabled: boolean;
  executionPolicy: HedgeExecutionPolicy;
  riskModelVersion: string;
  regimeModelVersion: string;
  planVersion: string;
  recommendationTtlMinutes: number;
  recommendationFreshnessMinutes: number;
  planTtlMinutes: number;
  beta: {
    benchmark: string;
    lookbackDays: number;
    observationInterval: string;
    minimumObservations: number;
    calculationVersion: string;
    cacheTtlHours: number;
    minimumCoverage: number;
  };
  optionDataCoverage: {
    minimumContractDeltaCoveragePct: number;
    minimumMarketValueDeltaCoveragePct: number;
    materialUnmeasuredOptionExposurePct: number;
  };
  optionGreeksFreshness: {
    currentMaxAgeSeconds: number;
    staleMaxAgeSeconds: number;
  };
  regime: {
    realizedVolatilityThreshold: number;
    volatilityProxy: string;
    crisisVolatilityLevel: number;
  };
  targetProtection: {
    low: number;
    moderate: number;
    elevated: number;
    high: number;
    critical: number;
  };
  premiumNavCap: number;
  leaps: {
    minimumDte: number;
    concentrationThreshold: number;
    profitAllocation: number;
    maxBidAskSpreadPct: number;
  };
  optionHedge: {
    minimumDte: number;
    maximumDte: number;
    maximumContracts: number;
    maxBidAskSpreadPct: number;
  };
  sectorMap: Record<string, string>;
  warnings: string[];
}

export interface HedgeExecutionPolicy {
  allowedStructures: ["long_put"];
  allowedUnderlyings: string[];
  minDte: number;
  targetDte: number;
  maxDte: number;
  targetAbsDeltaMin: number;
  targetAbsDeltaMax: number;
  maxBidAskSpreadPct: number;
  maxOrdersPerRun: number;
  maxNewContractsPerRun: number;
  maxNewHedgePremiumPctEquity: number;
  maxTotalHedgePremiumPctEquity: number;
  maxDailyHedgePremiumPctEquity: number;
  minOrderNotionalDollars: number;
  reviewTtlSeconds: number;
  duplicateWindowHours: number;
  minRebalanceIntervalHours: number;
  limitPriceMaxAgeSeconds: number;
  limitPriceMaxDriftPct: number;
  orderTimeoutSeconds: number;
  maxRepriceAttempts: number;
}

const envBoolean = (value: string | undefined) => value === "true" || value === "1";

const normalizeSymbol = (value: string | undefined, fallback: string) => {
  const normalized = String(value || fallback).trim().toUpperCase();
  return normalized || fallback;
};

const parseSymbolList = (value: string | undefined, fallback: string[]) => {
  const result = String(value || "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  return result.length ? [...new Set(result)] : fallback;
};

export const buildHedgeConfig = (): HedgeConfig => {
  const warnings: string[] = [];
  const invalid = () => {
    if (!warnings.includes("HEDGE_CONFIGURATION_VALUE_INVALID")) {
      warnings.push("HEDGE_CONFIGURATION_VALUE_INVALID");
    }
  };
  const positiveInteger = (value: string | undefined, fallback: number) => {
    if (value === undefined || value.trim() === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      invalid();
      return fallback;
    }
    return parsed;
  };
  const positiveNumber = (value: string | undefined, fallback: number) => {
    if (value === undefined || value.trim() === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      invalid();
      return fallback;
    }
    return parsed;
  };
  const ratio = (value: string | undefined, fallback: number) => {
    if (value === undefined || value.trim() === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      invalid();
      return fallback;
    }
    return parsed;
  };
  const percentage = (value: string | undefined, fallback: number) => {
    if (value === undefined || value.trim() === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      invalid();
      return fallback;
    }
    return parsed / 100;
  };

  const executionPolicy: HedgeExecutionPolicy = {
    allowedStructures: ["long_put"],
    allowedUnderlyings: parseSymbolList(process.env.HEDGE_ALLOWED_UNDERLYINGS, ["SPY", "QQQ"]),
    minDte: positiveInteger(process.env.HEDGE_MIN_DTE, 30),
    targetDte: positiveInteger(process.env.HEDGE_TARGET_DTE, 60),
    maxDte: positiveInteger(process.env.HEDGE_MAX_DTE, 120),
    targetAbsDeltaMin: ratio(process.env.HEDGE_TARGET_ABS_DELTA_MIN, 0.2),
    targetAbsDeltaMax: ratio(process.env.HEDGE_TARGET_ABS_DELTA_MAX, 0.4),
    maxBidAskSpreadPct: percentage(process.env.HEDGE_MAX_BID_ASK_SPREAD_PCT, 0.2),
    maxOrdersPerRun: positiveInteger(process.env.HEDGE_MAX_ORDERS_PER_RUN, 1),
    maxNewContractsPerRun: positiveInteger(process.env.HEDGE_MAX_NEW_CONTRACTS_PER_RUN, 2),
    maxNewHedgePremiumPctEquity: percentage(
      process.env.HEDGE_MAX_NEW_HEDGE_PREMIUM_PCT_EQUITY,
      0.0075
    ),
    maxTotalHedgePremiumPctEquity: percentage(
      process.env.HEDGE_MAX_TOTAL_HEDGE_PREMIUM_PCT_EQUITY,
      0.02
    ),
    maxDailyHedgePremiumPctEquity: percentage(
      process.env.HEDGE_MAX_DAILY_HEDGE_PREMIUM_PCT_EQUITY,
      0.01
    ),
    minOrderNotionalDollars: positiveNumber(process.env.HEDGE_MIN_ORDER_NOTIONAL_DOLLARS, 25),
    reviewTtlSeconds: positiveInteger(process.env.HEDGE_REVIEW_TTL_SECONDS, 300),
    duplicateWindowHours: positiveInteger(process.env.HEDGE_DUPLICATE_WINDOW_HOURS, 24),
    minRebalanceIntervalHours: positiveInteger(
      process.env.HEDGE_MIN_REBALANCE_INTERVAL_HOURS,
      6
    ),
    limitPriceMaxAgeSeconds: positiveInteger(
      process.env.HEDGE_LIMIT_PRICE_MAX_AGE_SECONDS,
      60
    ),
    limitPriceMaxDriftPct: percentage(
      process.env.PAPER_SUBMIT_MAX_PRICE_DRIFT_PCT,
      0.1
    ),
    orderTimeoutSeconds: positiveInteger(process.env.HEDGE_ORDER_TIMEOUT_SECONDS, 120),
    maxRepriceAttempts: positiveInteger(process.env.HEDGE_MAX_REPRICE_ATTEMPTS, 2)
  };
  if (executionPolicy.targetDte < executionPolicy.minDte || executionPolicy.maxDte < executionPolicy.targetDte) {
    invalid();
    executionPolicy.targetDte = Math.max(executionPolicy.minDte, 60);
    executionPolicy.maxDte = Math.max(executionPolicy.targetDte, 120);
  }
  if (executionPolicy.targetAbsDeltaMin > executionPolicy.targetAbsDeltaMax) {
    invalid();
    executionPolicy.targetAbsDeltaMin = 0.2;
    executionPolicy.targetAbsDeltaMax = 0.4;
  }

  let sectorMap: Record<string, string> = {};
  const sectorJson = process.env.HEDGE_SECTOR_MAP_JSON?.trim();
  if (sectorJson) {
    try {
      const parsed = JSON.parse(sectorJson) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("sector map must be an object");
      }
      sectorMap = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .map(([symbol, sector]) => [
            symbol.trim().toUpperCase(),
            typeof sector === "string" ? sector.trim().toLowerCase() : ""
          ])
          .filter(([symbol, sector]) => Boolean(symbol && sector))
      );
    } catch {
      sectorMap = {};
      warnings.push("HEDGE_SECTOR_MAP_INVALID");
    }
  }

  const optionMinimumDte = positiveInteger(process.env.HEDGE_OPTION_MIN_DTE, 30);
  const optionMaximumDte = positiveInteger(process.env.HEDGE_OPTION_MAX_DTE, 120);
  const configuredCurrentGreeksAge = positiveNumber(
    process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS,
    60
  );
  const configuredStaleGreeksAge = positiveNumber(
    process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS,
    900
  );
  const validOptionalPositive = (value: string | undefined) => {
    if (value === undefined || value.trim() === "") return true;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  };
  const validGreeksAgePolicy =
    validOptionalPositive(process.env.OPTION_GREEKS_CURRENT_MAX_AGE_SECONDS) &&
    validOptionalPositive(process.env.OPTION_GREEKS_STALE_MAX_AGE_SECONDS) &&
    configuredCurrentGreeksAge < configuredStaleGreeksAge;
  if (!validGreeksAgePolicy) invalid();

  return {
    executionEnabled: envBoolean(process.env.HEDGE_PAPER_EXECUTION_ENABLED),
    executionPolicy,
    riskModelVersion:
      process.env.HEDGE_RISK_MODEL_VERSION?.trim() || HEDGE_RISK_MODEL_VERSION,
    regimeModelVersion:
      process.env.HEDGE_REGIME_MODEL_VERSION?.trim() || HEDGE_REGIME_MODEL_VERSION,
    planVersion: process.env.HEDGE_PLAN_VERSION?.trim() || HEDGE_PLAN_VERSION,
    recommendationTtlMinutes: positiveInteger(
      process.env.HEDGE_RECOMMENDATION_TTL_MINUTES,
      30
    ),
    recommendationFreshnessMinutes: positiveInteger(
      process.env.HEDGE_RECOMMENDATION_FRESHNESS_MINUTES,
      15
    ),
    planTtlMinutes: positiveInteger(process.env.HEDGE_PLAN_TTL_MINUTES, 30),
    beta: {
      benchmark: normalizeSymbol(process.env.HEDGE_BETA_BENCHMARK, "SPY"),
      lookbackDays: positiveInteger(process.env.HEDGE_BETA_LOOKBACK_DAYS, 252),
      observationInterval:
        process.env.HEDGE_BETA_OBSERVATION_INTERVAL?.trim() || "1Day",
      minimumObservations: positiveInteger(
        process.env.HEDGE_BETA_MIN_OBSERVATIONS,
        60
      ),
      calculationVersion:
        process.env.HEDGE_BETA_CALCULATION_VERSION?.trim() || "beta-v1",
      cacheTtlHours: positiveInteger(process.env.HEDGE_BETA_CACHE_TTL_HOURS, 24),
      minimumCoverage: ratio(process.env.HEDGE_BETA_MIN_COVERAGE, 0.8)
    },
    optionDataCoverage: {
      minimumContractDeltaCoveragePct: percentage(
        process.env.HEDGE_MIN_OPTION_DELTA_CONTRACT_COVERAGE_PCT,
        0.9
      ),
      minimumMarketValueDeltaCoveragePct: percentage(
        process.env.HEDGE_MIN_OPTION_DELTA_MARKET_VALUE_COVERAGE_PCT,
        0.95
      ),
      materialUnmeasuredOptionExposurePct: percentage(
        process.env.HEDGE_MATERIAL_UNMEASURED_OPTION_EXPOSURE_PCT,
        0.1
      )
    },
    optionGreeksFreshness: {
      currentMaxAgeSeconds: validGreeksAgePolicy ? configuredCurrentGreeksAge : 60,
      staleMaxAgeSeconds: validGreeksAgePolicy ? configuredStaleGreeksAge : 900
    },
    regime: {
      realizedVolatilityThreshold: positiveNumber(
        process.env.HEDGE_REGIME_REALIZED_VOL_THRESHOLD,
        0.25
      ),
      volatilityProxy: normalizeSymbol(
        process.env.HEDGE_REGIME_VOLATILITY_PROXY,
        "VIXY"
      ),
      crisisVolatilityLevel: positiveNumber(
        process.env.HEDGE_REGIME_CRISIS_VOL_LEVEL,
        40
      )
    },
    targetProtection: {
      low: ratio(process.env.HEDGE_TARGET_PROTECTION_LOW, 0),
      moderate: ratio(process.env.HEDGE_TARGET_PROTECTION_MODERATE, 0.25),
      elevated: ratio(process.env.HEDGE_TARGET_PROTECTION_ELEVATED, 0.35),
      high: ratio(process.env.HEDGE_TARGET_PROTECTION_HIGH, 0.5),
      critical: ratio(process.env.HEDGE_TARGET_PROTECTION_CRITICAL, 0.65)
    },
    premiumNavCap: ratio(process.env.HEDGE_PREMIUM_NAV_CAP, 0.01),
    leaps: {
      minimumDte: positiveInteger(process.env.HEDGE_LEAPS_MIN_DTE, 365),
      concentrationThreshold: ratio(
        process.env.HEDGE_LEAPS_CONCENTRATION_THRESHOLD,
        0.35
      ),
      profitAllocation: ratio(process.env.HEDGE_PROFIT_ALLOCATION, 0.25),
      maxBidAskSpreadPct: ratio(process.env.HEDGE_LEAPS_MAX_BID_ASK_SPREAD_PCT, 0.2)
    },
    optionHedge: {
      minimumDte: optionMinimumDte,
      maximumDte: Math.max(optionMinimumDte, optionMaximumDte),
      maximumContracts: positiveInteger(process.env.HEDGE_MAX_OPTION_CONTRACTS, 10),
      maxBidAskSpreadPct: ratio(process.env.HEDGE_MAX_OPTION_SPREAD_PCT, 0.2)
    },
    sectorMap,
    warnings
  };
};

export const hedgeConfigurationFingerprint = (config = buildHedgeConfig()) =>
  canonicalJsonHash({
    executionPolicy: config.executionPolicy,
    riskModelVersion: config.riskModelVersion,
    regimeModelVersion: config.regimeModelVersion,
    planVersion: config.planVersion,
    recommendationTtlMinutes: config.recommendationTtlMinutes,
    recommendationFreshnessMinutes: config.recommendationFreshnessMinutes,
    planTtlMinutes: config.planTtlMinutes,
    beta: config.beta,
    optionDataCoverage: config.optionDataCoverage,
    optionGreeksFreshness: config.optionGreeksFreshness,
    regime: config.regime,
    targetProtection: config.targetProtection,
    premiumNavCap: config.premiumNavCap,
    leaps: config.leaps,
    optionHedge: config.optionHedge,
    sectorMap: config.sectorMap
  });
