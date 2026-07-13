import { canonicalJsonHash } from "../lib/canonicalJson.js";
import type { AlpacaAccountSnapshot } from "./alpacaAccountService.js";
import { getAlpacaAccountSnapshot } from "./alpacaAccountService.js";
import type { AlpacaPositionSnapshot } from "./alpacaPositionService.js";
import { listAlpacaPositions } from "./alpacaPositionService.js";
import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint,
  type HedgeConfig
} from "./hedgeConfigService.js";
import {
  latestPortfolioHighWaterMark,
  observePortfolioHighWaterMark
} from "./hedgePersistenceService.js";
import type { HedgeDataQualityStatus } from "./hedgeTypes.js";
import { optionDaysToExpiration, parseOptionSymbol } from "./optionSymbolService.js";
import {
  readOptionRiskEvidence,
  readUnderlyingPriceEvidence,
  type OptionRiskEvidence as CanonicalOptionRiskEvidence,
  type UnderlyingPriceEvidence
} from "./portfolioRiskEvidenceService.js";
import { portfolioBetasForSymbols } from "./portfolioBetaService.js";
import { getTradingSafetyState } from "./tradingSafetyService.js";

export interface OptionRiskEvidence
  extends Pick<
    CanonicalOptionRiskEvidence,
    | "multiplier"
    | "delta"
    | "gamma"
    | "theta"
    | "vega"
    | "rho"
    | "bid"
    | "ask"
    | "midpoint"
    | "quoteTimestamp"
  > {
  symbol?: string;
  underlying?: string;
  expirationDate?: string;
  strikePrice?: number;
  optionType?: "call" | "put";
  impliedVolatility?: number | null;
  snapshotTimestamp?: string | null;
  quoteStatus?: string | null;
  source?: string | null;
  normalizationPath?: CanonicalOptionRiskEvidence["normalizationPath"];
  bidSize?: number | null;
  askSize?: number | null;
}

export interface PositionBetaEvidence {
  beta: number | null;
  status: string;
  warnings: string[];
}

export interface PortfolioRiskEvidence {
  optionEvidence: Record<string, OptionRiskEvidence>;
  underlyingPrices: Record<string, number | null>;
  underlyingPriceTimestamps?: Record<string, string | null>;
  betas: Record<string, PositionBetaEvidence>;
  highWaterMark: number | null;
  warnings?: string[];
  blockers?: string[];
}

export interface NormalizedRiskPosition {
  symbol: string;
  underlying: string;
  assetClass: "equity" | "option";
  optionType: "call" | "put" | null;
  quantity: number | null;
  marketValue: number | null;
  currentPrice: number | null;
  underlyingPrice: number | null;
  costBasis: number | null;
  unrealizedPl: number | null;
  unrealizedPlPct: number | null;
  sector: string;
  beta: number | null;
  betaStatus: string;
  multiplier: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  expirationDate: string | null;
  strikePrice: number | null;
  daysToExpiration: number | null;
  moneynessPct: number | null;
  deltaEquivalentShares: number | null;
  deltaAdjustedExposure: number | null;
  deltaShares?: number | null;
  deltaDollars?: number | null;
  betaExposure: number | null;
  gammaExposure: number | null;
  thetaExposure: number | null;
  vegaExposure: number | null;
  rhoExposure: number | null;
  gammaSharesPerDollar?: number | null;
  thetaDollarsPerDay?: number | null;
  vegaDollarsPerVolPoint?: number | null;
  rhoDollarsPerRatePoint?: number | null;
  impliedVolatility?: number | null;
  greekObservationTimestamp?: string | null;
  greekObservationFreshness?: ObservationFreshness;
  underlyingPriceTimestamp?: string | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  bidAskSpreadPct: number | null;
  quoteTimestamp: string | null;
  inverseExposure: boolean;
  warnings: string[];
  blockers: string[];
}

export interface PortfolioScenario {
  benchmarkDeclinePct: 5 | 8 | 10 | 15;
  grossModeledLoss: number;
  existingProtection: number;
  netModeledLoss: number | null;
  netModeledLossPct: number | null;
  coverage: number;
  warnings: string[];
}

export interface OptionDataCoverage {
  totalOptionContracts: number;
  contractsWithDelta: number;
  contractsWithoutDelta: number;
  contractDeltaCoveragePct: number | null;
  totalOptionMarketValue: number;
  optionMarketValueWithDelta: number;
  optionMarketValueWithoutDelta: number;
  marketValueDeltaCoveragePct: number | null;
  materialCoverageMissing: boolean;
}

export type OptionMetric =
  | "delta"
  | "gamma"
  | "theta"
  | "vega"
  | "rho"
  | "impliedVolatility";

export type ObservationFreshness = "current" | "stale" | "expired" | "malformed";

export interface FreshnessCounts {
  current: number;
  stale: number;
  expired: number;
  malformed: number;
  total: number;
}

export interface CoverageBasis {
  total: number | null;
  measured: number | null;
  unmeasured: number | null;
  coverageRatio: number | null;
}

export interface OptionMetricCoverage {
  positions: CoverageBasis;
  absoluteContracts: CoverageBasis;
  absoluteMarketValue: CoverageBasis;
  freshness: FreshnessCounts;
}

export interface WeightedImpliedVolatility {
  weightedByAbsoluteContracts: number | null;
  weightedByAbsoluteMarketValue: number | null;
  weightedByAbsoluteVega: number | null;
}

export interface OptionGreekGroup {
  positionCount: number;
  absoluteContracts: number | null;
  absoluteMarketValue: number | null;
  deltaShares: number | null;
  deltaDollars: number | null;
  gammaSharesPerDollar: number | null;
  thetaDollarsPerDay: number | null;
  vegaDollarsPerVolPoint: number | null;
  rhoDollarsPerRatePoint: number | null;
  impliedVolatility: WeightedImpliedVolatility;
  quality: "complete" | "incomplete";
  missingMetrics: OptionMetric[];
}

export interface OptionGreekGroupings {
  byUnderlying: Record<string, OptionGreekGroup>;
  byExpiration: Record<string, OptionGreekGroup>;
  byOptionType: Record<string, OptionGreekGroup>;
  byDteBucket: Record<string, OptionGreekGroup>;
}

export interface PortfolioRiskSnapshot {
  paperOnly: true;
  environment: "paper";
  generatedAt: string;
  snapshotId: string;
  sourceAccountSnapshotId: string | null;
  accountIdentityHash?: string | null;
  riskModelVersion: string;
  configurationFingerprint: string;
  account: {
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
    highWaterMark: number | null;
    drawdownPct: number | null;
  };
  positions: NormalizedRiskPosition[];
  exposures: {
    grossExposure: number;
    netExposure: number;
    longExposure: number;
    shortOrInverseExposure: number;
    grossExposurePct: number | null;
    netExposurePct: number | null;
  };
  options: {
    deltaExposure: number | null;
    absoluteDeltaExposure: number | null;
    absoluteDeltaExposurePct: number | null;
    positiveDeltaExposure: number | null;
    positiveDeltaExposurePct: number | null;
    gammaExposure: number | null;
    thetaExposure: number | null;
    vegaExposure: number | null;
    rhoExposure: number | null;
    nearTermExposurePct: number | null;
    deltaShares?: number | null;
    deltaDollars?: number | null;
    absoluteDeltaShares?: number | null;
    absoluteDeltaDollars?: number | null;
    gammaSharesPerDollar?: number | null;
    absoluteGammaSharesPerDollar?: number | null;
    thetaDollarsPerDay?: number | null;
    absoluteThetaDollarsPerDay?: number | null;
    positiveThetaDollarsPerDay?: number | null;
    negativeThetaDollarsPerDay?: number | null;
    vegaDollarsPerVolPoint?: number | null;
    absoluteVegaDollarsPerVolPoint?: number | null;
    rhoDollarsPerRatePoint?: number | null;
    absoluteRhoDollarsPerRatePoint?: number | null;
    impliedVolatility?: WeightedImpliedVolatility;
    coverage?: Record<OptionMetric, OptionMetricCoverage>;
    freshness?: FreshnessCounts;
    groupings?: OptionGreekGroupings;
    executionEligible?: boolean;
  };
  concentration: {
    largestUnderlyingWeight: number | null;
    topFiveUnderlyingWeight: number | null;
    byUnderlying: Record<string, number>;
    bySector: Record<string, number>;
    unknownSectorWeight: number | null;
  };
  portfolioBeta: number | null;
  betaCoverage: number;
  optionDataCoverage: OptionDataCoverage;
  scenarios: PortfolioScenario[];
  dataQualityStatus: HedgeDataQualityStatus;
  dataQuality: {
    positionPriceCoverage: number;
    optionDeltaCoverage: number;
    optionGammaCoverage: number;
    optionThetaCoverage: number;
    optionVegaCoverage: number;
    betaCoverage: number;
    sectorCoverage: number;
  };
  warnings: string[];
  blockers: string[];
}

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const signedQuantity = (position: AlpacaPositionSnapshot) => {
  const quantity = numberOrNull(position.qty);
  if (quantity === null) {
    return null;
  }
  return String(position.side || "").toLowerCase() === "short" && quantity > 0
    ? -quantity
    : quantity;
};

const signedMarketValue = (position: AlpacaPositionSnapshot) => {
  const value = numberOrNull(position.marketValue);
  if (value === null) {
    return null;
  }
  return String(position.side || "").toLowerCase() === "short" && value > 0
    ? -value
    : value;
};

const ratio = (numerator: number, denominator: number | null) =>
  denominator !== null && denominator > 0 ? numerator / denominator : null;

const unique = (values: string[]) => [...new Set(values)];

const aggregateObserved = (
  positions: NormalizedRiskPosition[],
  field: "deltaAdjustedExposure" | "gammaExposure" | "thetaExposure" | "vegaExposure" | "rhoExposure"
) => {
  if (!positions.length) {
    return 0;
  }
  const observed = positions.map((position) => position[field]);
  if (observed.some((value) => value === null)) {
    return null;
  }
  return observed.reduce<number>((sum, value) => sum + (value ?? 0), 0);
};

const aggregateNullable = (
  positions: NormalizedRiskPosition[],
  field:
    | "deltaShares"
    | "deltaDollars"
    | "gammaSharesPerDollar"
    | "thetaDollarsPerDay"
    | "vegaDollarsPerVolPoint"
    | "rhoDollarsPerRatePoint"
) => {
  if (!positions.length) return 0;
  const values = positions.map((position) => position[field] ?? null);
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
};

const aggregateAbsoluteNullable = (
  positions: NormalizedRiskPosition[],
  field:
    | "gammaSharesPerDollar"
    | "thetaDollarsPerDay"
    | "vegaDollarsPerVolPoint"
    | "rhoDollarsPerRatePoint"
) => {
  if (!positions.length) return 0;
  const values = positions.map((position) => position[field] ?? null);
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + Math.abs(value ?? 0), 0);
};

const emptyFreshnessCounts = (): FreshnessCounts => ({
  current: 0,
  stale: 0,
  expired: 0,
  malformed: 0,
  total: 0
});

const observationFreshness = (
  timestamp: string | null | undefined,
  asOf: string,
  config: HedgeConfig
): ObservationFreshness => {
  if (!timestamp) return "malformed";
  const observedAt = Date.parse(timestamp);
  const currentTime = Date.parse(asOf);
  if (!Number.isFinite(observedAt) || !Number.isFinite(currentTime) || observedAt > currentTime) {
    return "malformed";
  }
  const ageSeconds = (currentTime - observedAt) / 1000;
  if (ageSeconds <= config.optionGreeksFreshness.currentMaxAgeSeconds) return "current";
  if (ageSeconds <= config.optionGreeksFreshness.staleMaxAgeSeconds) return "stale";
  return "expired";
};

const metricValue = (position: NormalizedRiskPosition, metric: OptionMetric) =>
  metric === "impliedVolatility" ? position.impliedVolatility ?? null : position[metric];

const coverageBasis = (
  total: number | null,
  measured: number | null
): CoverageBasis => ({
  total,
  measured,
  unmeasured: total === null || measured === null ? null : Math.max(0, total - measured),
  coverageRatio:
    total !== null && measured !== null && total > 0 ? measured / total : null
});

const metricCoverage = (
  positions: NormalizedRiskPosition[],
  metric: OptionMetric
): OptionMetricCoverage => {
  const measuredPositions = positions.filter((position) => metricValue(position, metric) !== null);
  const quantityComplete = positions.every((position) => position.quantity !== null);
  const marketValueComplete = positions.every((position) => position.marketValue !== null);
  const totalContracts = quantityComplete
    ? positions.reduce((sum, position) => sum + Math.abs(position.quantity ?? 0), 0)
    : null;
  const measuredContracts = quantityComplete
    ? measuredPositions.reduce((sum, position) => sum + Math.abs(position.quantity ?? 0), 0)
    : null;
  const totalMarketValue = marketValueComplete
    ? positions.reduce((sum, position) => sum + Math.abs(position.marketValue ?? 0), 0)
    : null;
  const measuredMarketValue = marketValueComplete
    ? measuredPositions.reduce((sum, position) => sum + Math.abs(position.marketValue ?? 0), 0)
    : null;
  const freshness = measuredPositions.reduce((counts, position) => {
    const status = position.greekObservationFreshness ?? "malformed";
    counts[status] += 1;
    counts.total += 1;
    return counts;
  }, emptyFreshnessCounts());
  return {
    positions: coverageBasis(positions.length, measuredPositions.length),
    absoluteContracts: coverageBasis(totalContracts, measuredContracts),
    absoluteMarketValue: coverageBasis(totalMarketValue, measuredMarketValue),
    freshness
  };
};

const weightedImpliedVolatility = (
  positions: NormalizedRiskPosition[]
): WeightedImpliedVolatility => {
  const weighted = (weight: (position: NormalizedRiskPosition) => number | null) => {
    const observations = positions
      .map((position) => ({ value: position.impliedVolatility ?? null, weight: weight(position) }))
      .filter(
        (entry): entry is { value: number; weight: number } =>
          entry.value !== null && entry.weight !== null && entry.weight > 0
      );
    const denominator = observations.reduce((sum, entry) => sum + entry.weight, 0);
    return denominator > 0
      ? observations.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / denominator
      : null;
  };
  return {
    weightedByAbsoluteContracts: weighted((position) =>
      position.quantity === null ? null : Math.abs(position.quantity)
    ),
    weightedByAbsoluteMarketValue: weighted((position) =>
      position.marketValue === null ? null : Math.abs(position.marketValue)
    ),
    weightedByAbsoluteVega: weighted((position) =>
      position.vegaDollarsPerVolPoint === null ||
      position.vegaDollarsPerVolPoint === undefined
        ? null
        : Math.abs(position.vegaDollarsPerVolPoint)
    )
  };
};

const dteBucket = (daysToExpiration: number | null) => {
  if (daysToExpiration === null) return "unknown";
  if (daysToExpiration < 0) return "expired";
  if (daysToExpiration <= 30) return "0-30";
  if (daysToExpiration <= 60) return "31-60";
  if (daysToExpiration <= 90) return "61-90";
  if (daysToExpiration <= 180) return "91-180";
  if (daysToExpiration <= 365) return "181-365";
  return "366+";
};

const greekGroup = (positions: NormalizedRiskPosition[]): OptionGreekGroup => {
  const missingMetrics = ([
    "delta",
    "gamma",
    "theta",
    "vega",
    "rho",
    "impliedVolatility"
  ] as const).filter((metric) => positions.some((position) => {
    if (metric === "delta") {
      return (
        position.delta === null ||
        position.deltaShares === null ||
        position.deltaShares === undefined ||
        position.deltaDollars === null ||
        position.deltaDollars === undefined
      );
    }
    if (metric === "gamma") {
      return position.gammaSharesPerDollar === null || position.gammaSharesPerDollar === undefined;
    }
    if (metric === "theta") {
      return position.thetaDollarsPerDay === null || position.thetaDollarsPerDay === undefined;
    }
    if (metric === "vega") {
      return (
        position.vegaDollarsPerVolPoint === null ||
        position.vegaDollarsPerVolPoint === undefined
      );
    }
    if (metric === "rho") {
      return (
        position.rhoDollarsPerRatePoint === null ||
        position.rhoDollarsPerRatePoint === undefined
      );
    }
    return position.impliedVolatility === null || position.impliedVolatility === undefined;
  }));
  const quantityComplete = positions.every((position) => position.quantity !== null);
  const marketValueComplete = positions.every((position) => position.marketValue !== null);
  const currentEvidence = positions.every(
    (position) => position.greekObservationFreshness === "current"
  );
  return {
    positionCount: positions.length,
    absoluteContracts: quantityComplete
      ? positions.reduce((sum, position) => sum + Math.abs(position.quantity ?? 0), 0)
      : null,
    absoluteMarketValue: marketValueComplete
      ? positions.reduce((sum, position) => sum + Math.abs(position.marketValue ?? 0), 0)
      : null,
    deltaShares: aggregateNullable(positions, "deltaShares"),
    deltaDollars: aggregateNullable(positions, "deltaDollars"),
    gammaSharesPerDollar: aggregateNullable(positions, "gammaSharesPerDollar"),
    thetaDollarsPerDay: aggregateNullable(positions, "thetaDollarsPerDay"),
    vegaDollarsPerVolPoint: aggregateNullable(positions, "vegaDollarsPerVolPoint"),
    rhoDollarsPerRatePoint: aggregateNullable(positions, "rhoDollarsPerRatePoint"),
    impliedVolatility: weightedImpliedVolatility(positions),
    quality:
      !missingMetrics.length && quantityComplete && marketValueComplete && currentEvidence
        ? "complete"
        : "incomplete",
    missingMetrics: [...missingMetrics]
  };
};

const groupBy = (
  positions: NormalizedRiskPosition[],
  keyFor: (position: NormalizedRiskPosition) => string
) => {
  const groups: Record<string, NormalizedRiskPosition[]> = {};
  for (const position of positions) {
    const key = keyFor(position);
    (groups[key] ??= []).push(position);
  }
  return Object.fromEntries(
    Object.entries(groups).map(([key, groupPositions]) => [key, greekGroup(groupPositions)])
  );
};

export const normalizePortfolioEvidence = (
  accountInput: AlpacaAccountSnapshot,
  positionInputs: AlpacaPositionSnapshot[],
  evidence: PortfolioRiskEvidence,
  config: HedgeConfig,
  asOf = new Date().toISOString()
): PortfolioRiskSnapshot => {
  const equity = numberOrNull(accountInput.equity ?? accountInput.portfolioValue);
  const cash = numberOrNull(accountInput.cash);
  const buyingPower = numberOrNull(accountInput.buyingPower);
  const normalizedPositions: NormalizedRiskPosition[] = positionInputs.map((position) => {
    const parsed = parseOptionSymbol(position.symbol);
    const isOption =
      String(position.assetClass || "").toLowerCase().includes("option") || parsed.ok;
    const quantity = signedQuantity(position);
    const currentPrice = numberOrNull(position.currentPrice);
    let marketValue = signedMarketValue(position);
    const warnings: string[] = [];
    const blockers: string[] = [];
    if (!isOption && marketValue === null && quantity !== null && currentPrice !== null) {
      marketValue = quantity * currentPrice;
      warnings.push("MARKET_VALUE_DERIVED_FROM_OBSERVED_PRICE");
    }
    const underlying = parsed.ok ? parsed.underlying : position.symbol.trim().toUpperCase();
    const optionEvidence = parsed.ok
      ? evidence.optionEvidence[parsed.normalizedSymbol] ?? null
      : null;
    if (isOption && !parsed.ok) {
      warnings.push("OPTION_SYMBOL_PARSE_FAILED");
    }
    const observedUnderlyingPrice = numberOrNull(evidence.underlyingPrices[underlying]);
    const underlyingPrice =
      observedUnderlyingPrice ?? (!isOption ? currentPrice : null);
    const multiplier = isOption ? numberOrNull(optionEvidence?.multiplier) : null;
    const delta = isOption ? numberOrNull(optionEvidence?.delta) : null;
    const gamma = isOption ? numberOrNull(optionEvidence?.gamma) : null;
    const theta = isOption ? numberOrNull(optionEvidence?.theta) : null;
    const vega = isOption ? numberOrNull(optionEvidence?.vega) : null;
    const rho = isOption ? numberOrNull(optionEvidence?.rho) : null;
    const impliedVolatility = isOption
      ? numberOrNull(optionEvidence?.impliedVolatility)
      : null;
    const greekObservationTimestamp = isOption
      ? optionEvidence?.snapshotTimestamp ?? null
      : null;
    const greekObservationFreshness = isOption
      ? observationFreshness(greekObservationTimestamp, asOf, config)
      : undefined;
    if (isOption && delta === null) warnings.push("OPTION_DELTA_UNAVAILABLE");
    if (isOption && multiplier === null) warnings.push("OPTION_MULTIPLIER_UNAVAILABLE");
    if (isOption && gamma === null) warnings.push("OPTION_GAMMA_UNAVAILABLE");
    if (isOption && theta === null) warnings.push("OPTION_THETA_UNAVAILABLE");
    if (isOption && vega === null) warnings.push("OPTION_VEGA_UNAVAILABLE");
    if (isOption && rho === null) warnings.push("OPTION_RHO_UNAVAILABLE");
    if (isOption && impliedVolatility === null) {
      warnings.push("OPTION_IMPLIED_VOLATILITY_UNAVAILABLE");
    }
    if (isOption && greekObservationFreshness !== "current") {
      warnings.push(`OPTION_GREEKS_${String(greekObservationFreshness).toUpperCase()}`);
    }
    if (isOption && greekObservationFreshness === "stale") {
      warnings.push("HEDGE_GREEKS_STALE");
    }
    if (underlyingPrice === null) warnings.push("UNDERLYING_PRICE_UNAVAILABLE");
    if (marketValue === null) warnings.push("POSITION_PRICE_UNAVAILABLE");
    const usableGreekObservation =
      greekObservationFreshness === "current" || greekObservationFreshness === "stale";
    const deltaEquivalentShares =
      isOption && usableGreekObservation && quantity !== null && multiplier !== null && delta !== null
        ? quantity * multiplier * delta
        : null;
    const deltaAdjustedExposure = isOption
      ? deltaEquivalentShares !== null && underlyingPrice !== null
        ? deltaEquivalentShares * underlyingPrice
        : null
      : marketValue;
    const betaEvidence = evidence.betas[underlying];
    const beta = numberOrNull(betaEvidence?.beta);
    if (beta === null && deltaAdjustedExposure !== null && deltaAdjustedExposure !== 0) {
      warnings.push("POSITION_BETA_UNAVAILABLE");
    }
    const gammaExposure =
      isOption && usableGreekObservation && quantity !== null && multiplier !== null && gamma !== null
        ? quantity * multiplier * gamma
        : isOption
          ? null
          : 0;
    const thetaExposure =
      isOption && usableGreekObservation && quantity !== null && multiplier !== null && theta !== null
        ? quantity * multiplier * theta
        : isOption
          ? null
          : 0;
    const vegaExposure =
      isOption && usableGreekObservation && quantity !== null && multiplier !== null && vega !== null
        ? quantity * multiplier * vega
        : isOption
          ? null
          : 0;
    const rhoExposure =
      isOption && usableGreekObservation && quantity !== null && multiplier !== null && rho !== null
        ? quantity * multiplier * rho
        : isOption
          ? null
          : 0;
    const bid = numberOrNull(optionEvidence?.bid);
    const ask = numberOrNull(optionEvidence?.ask);
    const midpoint = numberOrNull(optionEvidence?.midpoint);
    const bidSize = numberOrNull(optionEvidence?.bidSize);
    const askSize = numberOrNull(optionEvidence?.askSize);
    const bidAskSpreadPct =
      bid !== null && ask !== null && midpoint !== null && midpoint > 0 && ask >= bid
        ? (ask - bid) / midpoint
        : null;
    const sector = config.sectorMap[underlying] ?? "unknown";
    const daysToExpiration = parsed.ok
      ? optionDaysToExpiration(parsed.expirationDate, asOf)
      : null;
    return {
      symbol: position.symbol.trim().toUpperCase(),
      underlying,
      assetClass: isOption ? "option" : "equity",
      optionType: parsed.ok ? parsed.optionType : null,
      quantity,
      marketValue,
      currentPrice,
      underlyingPrice,
      costBasis: numberOrNull(position.costBasis),
      unrealizedPl: numberOrNull(position.unrealizedPl),
      unrealizedPlPct: numberOrNull(position.unrealizedPlpc),
      sector,
      beta,
      betaStatus: betaEvidence?.status ?? "unavailable",
      multiplier,
      delta,
      gamma,
      theta,
      vega,
      rho,
      expirationDate: parsed.ok ? parsed.expirationDate : null,
      strikePrice: parsed.ok ? parsed.strikePrice : null,
      daysToExpiration,
      moneynessPct:
        parsed.ok && underlyingPrice !== null && underlyingPrice > 0
          ? (parsed.strikePrice - underlyingPrice) / underlyingPrice
          : null,
      deltaEquivalentShares,
      deltaAdjustedExposure,
      deltaShares: deltaEquivalentShares,
      deltaDollars: isOption ? deltaAdjustedExposure : null,
      betaExposure:
        deltaAdjustedExposure !== null && beta !== null
          ? deltaAdjustedExposure * beta
          : null,
      gammaExposure,
      thetaExposure,
      vegaExposure,
      rhoExposure,
      gammaSharesPerDollar: isOption ? gammaExposure : null,
      thetaDollarsPerDay: isOption ? thetaExposure : null,
      vegaDollarsPerVolPoint: isOption ? vegaExposure : null,
      rhoDollarsPerRatePoint: isOption ? rhoExposure : null,
      impliedVolatility,
      greekObservationTimestamp,
      greekObservationFreshness,
      underlyingPriceTimestamp:
        evidence.underlyingPriceTimestamps?.[underlying] ?? null,
      bid,
      ask,
      midpoint,
      bidSize,
      askSize,
      bidAskSpreadPct,
      quoteTimestamp: optionEvidence?.quoteTimestamp ?? null,
      inverseExposure: underlying === "SH" || underlying === "PSQ",
      warnings: unique([...warnings, ...(betaEvidence?.warnings ?? [])]),
      blockers
    };
  });

  const measuredExposures = normalizedPositions
    .map((position) => position.deltaAdjustedExposure)
    .filter((value): value is number => value !== null);
  const grossExposure = measuredExposures.reduce((sum, value) => sum + Math.abs(value), 0);
  const netExposure = measuredExposures.reduce((sum, value) => sum + value, 0);
  const longExposure = measuredExposures.reduce((sum, value) => sum + Math.max(0, value), 0);
  const shortOrInverseExposure = measuredExposures.reduce(
    (sum, value) => sum + Math.abs(Math.min(0, value)),
    0
  );
  const optionPositions = normalizedPositions.filter((position) => position.assetClass === "option");
  const optionFreshness = optionPositions.reduce((counts, position) => {
    const status = position.greekObservationFreshness ?? "malformed";
    counts[status] += 1;
    counts.total += 1;
    return counts;
  }, emptyFreshnessCounts());
  const optionMetrics = [
    "delta",
    "gamma",
    "theta",
    "vega",
    "rho",
    "impliedVolatility"
  ] as const;
  const optionMetricCoverage = Object.fromEntries(
    optionMetrics.map((metric) => [metric, metricCoverage(optionPositions, metric)])
  ) as Record<OptionMetric, OptionMetricCoverage>;
  const totalOptionContracts = optionPositions.reduce(
    (sum, position) => sum + Math.abs(position.quantity ?? 0),
    0
  );
  const contractsWithDelta = optionPositions.reduce(
    (sum, position) =>
      sum + (position.delta === null ? 0 : Math.abs(position.quantity ?? 0)),
    0
  );
  const totalOptionMarketValue = optionPositions.reduce(
    (sum, position) => sum + Math.abs(position.marketValue ?? 0),
    0
  );
  const optionMarketValueWithDelta = optionPositions.reduce(
    (sum, position) =>
      sum + (position.delta === null ? 0 : Math.abs(position.marketValue ?? 0)),
    0
  );
  const contractDeltaCoveragePct = totalOptionContracts > 0
    ? contractsWithDelta / totalOptionContracts
    : null;
  const marketValueDeltaCoveragePct = totalOptionMarketValue > 0
    ? optionMarketValueWithDelta / totalOptionMarketValue
    : null;
  const optionMarketValueWithoutDelta = Math.max(
    0,
    totalOptionMarketValue - optionMarketValueWithDelta
  );
  const totalOptionMarketValuePct = ratio(totalOptionMarketValue, equity);
  const unmeasuredOptionMarketValuePct = ratio(optionMarketValueWithoutDelta, equity);
  const currentDeltaContracts = optionPositions.reduce(
    (sum, position) =>
      sum +
      (position.deltaDollars !== null &&
      position.deltaDollars !== undefined &&
      position.greekObservationFreshness === "current"
        ? Math.abs(position.quantity ?? 0)
        : 0),
    0
  );
  const currentDeltaMarketValue = optionPositions.reduce(
    (sum, position) =>
      sum +
      (position.deltaDollars !== null &&
      position.deltaDollars !== undefined &&
      position.greekObservationFreshness === "current"
        ? Math.abs(position.marketValue ?? 0)
        : 0),
    0
  );
  const currentContractDeltaCoveragePct = totalOptionContracts > 0
    ? currentDeltaContracts / totalOptionContracts
    : null;
  const currentMarketValueDeltaCoveragePct = totalOptionMarketValue > 0
    ? currentDeltaMarketValue / totalOptionMarketValue
    : null;
  const nonCurrentDeltaMarketValue = Math.max(
    0,
    totalOptionMarketValue - currentDeltaMarketValue
  );
  const nonCurrentDeltaMarketValuePct = ratio(nonCurrentDeltaMarketValue, equity);
  const freshnessInsufficient =
    optionFreshness.stale > 0 ||
    optionFreshness.expired > 0 ||
    optionFreshness.malformed > 0;
  const materialCoverageMissing =
    freshnessInsufficient ||
    (totalOptionMarketValuePct !== null &&
      totalOptionMarketValuePct >=
        config.optionDataCoverage.materialUnmeasuredOptionExposurePct &&
      currentContractDeltaCoveragePct !== null &&
      currentContractDeltaCoveragePct <
        config.optionDataCoverage.minimumContractDeltaCoveragePct) ||
    (((unmeasuredOptionMarketValuePct !== null &&
      unmeasuredOptionMarketValuePct >=
        config.optionDataCoverage.materialUnmeasuredOptionExposurePct) ||
      (nonCurrentDeltaMarketValuePct !== null &&
      nonCurrentDeltaMarketValuePct >=
        config.optionDataCoverage.materialUnmeasuredOptionExposurePct)) &&
      currentMarketValueDeltaCoveragePct !== null &&
      currentMarketValueDeltaCoveragePct <
        config.optionDataCoverage.minimumMarketValueDeltaCoveragePct);
  const executionEligible =
    optionPositions.length === 0 ||
    (optionPositions.every(
      (position) => position.quantity !== null && position.marketValue !== null
    ) &&
      currentContractDeltaCoveragePct !== null &&
      currentContractDeltaCoveragePct >=
        config.optionDataCoverage.minimumContractDeltaCoveragePct &&
      currentMarketValueDeltaCoveragePct !== null &&
      currentMarketValueDeltaCoveragePct >=
        config.optionDataCoverage.minimumMarketValueDeltaCoveragePct &&
      optionFreshness.expired === 0 &&
      optionFreshness.malformed === 0 &&
      optionFreshness.stale === 0);
  const optionDataCoverage: OptionDataCoverage = {
    totalOptionContracts,
    contractsWithDelta,
    contractsWithoutDelta: Math.max(0, totalOptionContracts - contractsWithDelta),
    contractDeltaCoveragePct,
    totalOptionMarketValue,
    optionMarketValueWithDelta,
    optionMarketValueWithoutDelta,
    marketValueDeltaCoveragePct,
    materialCoverageMissing
  };
  const deltaExposure = aggregateObserved(optionPositions, "deltaAdjustedExposure");
  const absoluteDeltaExposure =
    deltaExposure === null
      ? null
      : optionPositions.reduce(
          (sum, position) => sum + Math.abs(position.deltaAdjustedExposure ?? 0),
          0
        );
  const positiveDeltaExposure =
    deltaExposure === null
      ? null
      : optionPositions.reduce(
          (sum, position) => sum + Math.max(0, position.deltaAdjustedExposure ?? 0),
          0
        );
  const nearTermExposure = optionPositions.reduce((sum, position) => {
    return position.daysToExpiration !== null && position.daysToExpiration <= 90
      ? sum + Math.abs(position.deltaAdjustedExposure ?? 0)
      : sum;
  }, 0);
  const optionDeltaShares = aggregateNullable(optionPositions, "deltaShares");
  const optionDeltaDollars = aggregateNullable(optionPositions, "deltaDollars");
  const optionGammaSharesPerDollar = aggregateNullable(
    optionPositions,
    "gammaSharesPerDollar"
  );
  const optionThetaDollarsPerDay = aggregateNullable(
    optionPositions,
    "thetaDollarsPerDay"
  );
  const optionVegaDollarsPerVolPoint = aggregateNullable(
    optionPositions,
    "vegaDollarsPerVolPoint"
  );
  const optionRhoDollarsPerRatePoint = aggregateNullable(
    optionPositions,
    "rhoDollarsPerRatePoint"
  );
  const absoluteDeltaShares = optionDeltaShares === null
    ? null
    : optionPositions.reduce((sum, position) => sum + Math.abs(position.deltaShares ?? 0), 0);
  const absoluteDeltaDollars = optionDeltaDollars === null
    ? null
    : optionPositions.reduce((sum, position) => sum + Math.abs(position.deltaDollars ?? 0), 0);
  const positiveThetaDollarsPerDay = optionThetaDollarsPerDay === null
    ? null
    : optionPositions.reduce(
        (sum, position) => sum + Math.max(0, position.thetaDollarsPerDay ?? 0),
        0
      );
  const negativeThetaDollarsPerDay = optionThetaDollarsPerDay === null
    ? null
    : optionPositions.reduce(
        (sum, position) => sum + Math.min(0, position.thetaDollarsPerDay ?? 0),
        0
      );
  const optionGroupings: OptionGreekGroupings = {
    byUnderlying: groupBy(optionPositions, (position) => position.underlying),
    byExpiration: groupBy(
      optionPositions,
      (position) => position.expirationDate ?? "unknown"
    ),
    byOptionType: groupBy(optionPositions, (position) => position.optionType ?? "unknown"),
    byDteBucket: groupBy(optionPositions, (position) => dteBucket(position.daysToExpiration))
  };

  const underlyingExposure: Record<string, number> = {};
  const sectorExposure: Record<string, number> = {};
  for (const position of normalizedPositions) {
    const exposure = Math.abs(position.deltaAdjustedExposure ?? 0);
    underlyingExposure[position.underlying] =
      (underlyingExposure[position.underlying] ?? 0) + exposure;
    sectorExposure[position.sector] = (sectorExposure[position.sector] ?? 0) + exposure;
  }
  const byUnderlying = Object.fromEntries(
    Object.entries(underlyingExposure).map(([key, value]) => [key, ratio(value, equity) ?? 0])
  );
  const bySector = Object.fromEntries(
    Object.entries(sectorExposure).map(([key, value]) => [key, ratio(value, equity) ?? 0])
  );
  const underlyingWeights = Object.values(byUnderlying).sort((left, right) => right - left);

  const betaMeasuredExposure = normalizedPositions.reduce(
    (sum, position) =>
      sum + (position.betaExposure === null ? 0 : Math.abs(position.deltaAdjustedExposure ?? 0)),
    0
  );
  const betaCoverage = grossExposure > 0 ? betaMeasuredExposure / grossExposure : 1;
  const portfolioBeta =
    !materialCoverageMissing &&
    equity !== null && equity > 0 && betaCoverage >= config.beta.minimumCoverage
      ? normalizedPositions.reduce((sum, position) => sum + (position.betaExposure ?? 0), 0) /
        equity
      : null;

  const scenarios = ([5, 8, 10, 15] as const).map((benchmarkDeclinePct) => {
    let grossModeledLoss = 0;
    let existingProtection = 0;
    for (const position of normalizedPositions) {
      if (position.betaExposure === null) {
        continue;
      }
      const decline = benchmarkDeclinePct / 100;
      let modeledPnl = position.betaExposure * -decline;
      if (
        position.assetClass === "option" &&
        position.gammaExposure !== null &&
        position.underlyingPrice !== null
      ) {
        modeledPnl +=
          0.5 *
          position.gammaExposure *
          (position.underlyingPrice * decline) ** 2;
      }
      if (modeledPnl < 0) {
        grossModeledLoss += Math.abs(modeledPnl);
      } else {
        existingProtection += modeledPnl;
      }
    }
    const netModeledLoss =
      !materialCoverageMissing && (grossExposure === 0 || betaMeasuredExposure > 0)
        ? Math.max(0, grossModeledLoss - existingProtection)
        : null;
    return {
      benchmarkDeclinePct,
      grossModeledLoss,
      existingProtection,
      netModeledLoss,
      netModeledLossPct:
        netModeledLoss !== null && equity !== null && equity > 0
          ? netModeledLoss / equity
          : null,
      coverage: betaCoverage,
      warnings:
        betaCoverage < config.beta.minimumCoverage
          ? ["SCENARIO_BETA_COVERAGE_INSUFFICIENT"]
          : []
    };
  });

  const positionCount = normalizedPositions.length;
  const priceCoverage = positionCount
    ? normalizedPositions.filter((position) => position.marketValue !== null).length / positionCount
    : 1;
  const coverageFor = (field: "delta" | "gamma" | "theta" | "vega") =>
    optionPositions.length
      ? optionPositions.filter((position) => position[field] !== null).length / optionPositions.length
      : 1;
  const sectorCoverage = positionCount
    ? normalizedPositions.filter((position) => position.sector !== "unknown").length / positionCount
    : 1;
  const dataQuality = {
    positionPriceCoverage: priceCoverage,
    optionDeltaCoverage: coverageFor("delta"),
    optionGammaCoverage: coverageFor("gamma"),
    optionThetaCoverage: coverageFor("theta"),
    optionVegaCoverage: coverageFor("vega"),
    betaCoverage,
    sectorCoverage
  };
  const blockers = [...(evidence.blockers ?? [])];
  if (equity === null || equity <= 0) blockers.push("PORTFOLIO_EQUITY_UNAVAILABLE");
  const warnings = unique([
    ...(evidence.warnings ?? []),
    ...config.warnings,
    ...normalizedPositions.flatMap((position) => position.warnings),
    ...(betaCoverage < config.beta.minimumCoverage
      ? ["PORTFOLIO_BETA_COVERAGE_INSUFFICIENT"]
      : []),
    ...(dataQuality.optionDeltaCoverage < 1 ||
    dataQuality.optionGammaCoverage < 1 ||
    dataQuality.optionThetaCoverage < 1 ||
    dataQuality.optionVegaCoverage < 1
      ? ["OPTION_GREEKS_COVERAGE_PARTIAL"]
      : []),
    ...(sectorCoverage < 1 ? ["SECTOR_COVERAGE_PARTIAL"] : []),
    ...(materialCoverageMissing
      ? ["MATERIAL_OPTION_GREEKS_COVERAGE_INSUFFICIENT"]
      : [])
  ]);
  const dataQualityStatus: HedgeDataQualityStatus = blockers.length
    ? "blocked"
    : priceCoverage < 1 ||
        dataQuality.optionDeltaCoverage < 1 ||
        betaCoverage < config.beta.minimumCoverage
      ? "monitoring"
      : warnings.length
        ? "partial"
        : "complete";

  const observedHighWaterMark = numberOrNull(evidence.highWaterMark);
  const highWaterMark =
    equity !== null && observedHighWaterMark !== null
      ? Math.max(equity, observedHighWaterMark)
      : observedHighWaterMark ?? equity;
  const accountSnapshot = {
    equity,
    cash,
    buyingPower,
    highWaterMark,
    drawdownPct:
      equity !== null && highWaterMark !== null && highWaterMark > 0
        ? Math.max(0, (highWaterMark - equity) / highWaterMark)
        : null
  };
  const configurationFingerprint = hedgeConfigurationFingerprint(config);
  const sourceAccountSnapshotId = accountInput.id
    ? canonicalJsonHash({
        environment: "paper",
        accountId: accountInput.id,
        accountCreatedAt: accountInput.createdAt ?? null
      })
    : null;
  const accountIdentityHash = accountInput.id
    ? canonicalJsonHash({
        id: accountInput.id ?? null,
        status: accountInput.status ?? null,
        equity: accountInput.equity ?? null,
        buyingPower: accountInput.buyingPower ?? null,
        optionsApprovedLevel: accountInput.optionsApprovedLevel ?? null
      })
    : null;
  const snapshotId = canonicalJsonHash({
    environment: "paper",
    account: accountSnapshot,
    positions: normalizedPositions,
    riskModelVersion: config.riskModelVersion,
    configurationFingerprint
  });

  return {
    paperOnly: true,
    environment: "paper",
    generatedAt: asOf,
    snapshotId,
    sourceAccountSnapshotId,
    accountIdentityHash,
    riskModelVersion: config.riskModelVersion,
    configurationFingerprint,
    account: accountSnapshot,
    positions: normalizedPositions,
    exposures: {
      grossExposure,
      netExposure,
      longExposure,
      shortOrInverseExposure,
      grossExposurePct: ratio(grossExposure, equity),
      netExposurePct: equity !== null && equity > 0 ? netExposure / equity : null
    },
    options: {
      deltaExposure: materialCoverageMissing ? null : deltaExposure,
      absoluteDeltaExposure: materialCoverageMissing ? null : absoluteDeltaExposure,
      absoluteDeltaExposurePct:
        materialCoverageMissing || absoluteDeltaExposure === null
          ? null
          : ratio(absoluteDeltaExposure, equity),
      positiveDeltaExposure: materialCoverageMissing ? null : positiveDeltaExposure,
      positiveDeltaExposurePct:
        materialCoverageMissing || positiveDeltaExposure === null
          ? null
          : ratio(positiveDeltaExposure, equity),
      gammaExposure: aggregateObserved(optionPositions, "gammaExposure"),
      thetaExposure: aggregateObserved(optionPositions, "thetaExposure"),
      vegaExposure: aggregateObserved(optionPositions, "vegaExposure"),
      rhoExposure: aggregateObserved(optionPositions, "rhoExposure"),
      nearTermExposurePct:
        materialCoverageMissing || deltaExposure === null
          ? null
          : ratio(nearTermExposure, equity),
      deltaShares: materialCoverageMissing ? null : optionDeltaShares,
      deltaDollars: materialCoverageMissing ? null : optionDeltaDollars,
      absoluteDeltaShares: materialCoverageMissing ? null : absoluteDeltaShares,
      absoluteDeltaDollars: materialCoverageMissing ? null : absoluteDeltaDollars,
      gammaSharesPerDollar: optionGammaSharesPerDollar,
      absoluteGammaSharesPerDollar: aggregateAbsoluteNullable(
        optionPositions,
        "gammaSharesPerDollar"
      ),
      thetaDollarsPerDay: optionThetaDollarsPerDay,
      absoluteThetaDollarsPerDay: aggregateAbsoluteNullable(
        optionPositions,
        "thetaDollarsPerDay"
      ),
      positiveThetaDollarsPerDay,
      negativeThetaDollarsPerDay,
      vegaDollarsPerVolPoint: optionVegaDollarsPerVolPoint,
      absoluteVegaDollarsPerVolPoint: aggregateAbsoluteNullable(
        optionPositions,
        "vegaDollarsPerVolPoint"
      ),
      rhoDollarsPerRatePoint: optionRhoDollarsPerRatePoint,
      absoluteRhoDollarsPerRatePoint: aggregateAbsoluteNullable(
        optionPositions,
        "rhoDollarsPerRatePoint"
      ),
      impliedVolatility: weightedImpliedVolatility(optionPositions),
      coverage: optionMetricCoverage,
      freshness: optionFreshness,
      groupings: optionGroupings,
      executionEligible
    },
    concentration: {
      largestUnderlyingWeight: equity !== null ? underlyingWeights[0] ?? 0 : null,
      topFiveUnderlyingWeight:
        equity !== null
          ? underlyingWeights.slice(0, 5).reduce((sum, value) => sum + value, 0)
          : null,
      byUnderlying,
      bySector,
      unknownSectorWeight:
        equity !== null ? bySector.unknown ?? 0 : null
    },
    portfolioBeta,
    betaCoverage,
    optionDataCoverage,
    scenarios,
    dataQualityStatus,
    dataQuality,
    warnings,
    blockers: unique(blockers)
  };
};

export interface PortfolioRiskDeps {
  getAccount?: typeof getAlpacaAccountSnapshot;
  getPositions?: typeof listAlpacaPositions;
  getOptionEvidence?: typeof readOptionRiskEvidence;
  getUnderlyingPriceEvidence?: typeof readUnderlyingPriceEvidence;
}

export const buildPortfolioRiskSnapshot = async (
  input: { config?: HedgeConfig; asOf?: string } = {},
  deps: PortfolioRiskDeps = {}
): Promise<PortfolioRiskSnapshot> => {
  const config = input.config ?? buildHedgeConfig();
  const asOf = input.asOf ?? new Date().toISOString();
  const safety = getTradingSafetyState();
  if (safety.alpacaEnv !== "paper" || safety.liveTradingEnabled) {
    return normalizePortfolioEvidence(
      {},
      [],
      {
        optionEvidence: {},
        underlyingPrices: {},
        betas: {},
        highWaterMark: null,
        blockers: ["HEDGE_PAPER_ENVIRONMENT_REQUIRED"]
      },
      config,
      asOf
    );
  }
  try {
    const [account, positionResult] = await Promise.all([
      (deps.getAccount ?? getAlpacaAccountSnapshot)(),
      (deps.getPositions ?? listAlpacaPositions)()
    ]);
    const positions = positionResult.positions;
    const underlyings = unique(
      positions.map((position) => {
        const parsed = parseOptionSymbol(position.symbol);
        return parsed.ok ? parsed.underlying : position.symbol.trim().toUpperCase();
      })
    );
    const betas = portfolioBetasForSymbols({ symbols: underlyings, config, asOf });
    const getOptionEvidence = deps.getOptionEvidence ?? readOptionRiskEvidence;
    const getUnderlyingEvidence =
      deps.getUnderlyingPriceEvidence ?? readUnderlyingPriceEvidence;
    const optionEvidence = Object.fromEntries(
      positions
        .map((position) => parseOptionSymbol(position.symbol))
        .filter((parsed) => parsed.ok)
        .map((parsed) => [parsed.normalizedSymbol, getOptionEvidence(parsed.normalizedSymbol)])
    );
    const underlyingEvidence = Object.fromEntries(
      underlyings.map((symbol) => [symbol, getUnderlyingEvidence(symbol)])
    ) as Record<string, UnderlyingPriceEvidence>;
    const underlyingPrices = Object.fromEntries(
      Object.entries(underlyingEvidence).map(([symbol, row]) => [symbol, row.price])
    );
    const underlyingPriceTimestamps = Object.fromEntries(
      Object.entries(underlyingEvidence).map(([symbol, row]) => [symbol, row.timestamp])
    );
    const equity = numberOrNull(account.equity ?? account.portfolioValue);
    let highWaterMark = latestPortfolioHighWaterMark("paper")?.equity ?? null;
    if (equity !== null && equity > 0) {
      highWaterMark = observePortfolioHighWaterMark({
        environment: "paper",
        equity,
        observedAt: asOf
      }).equity;
    }
    return normalizePortfolioEvidence(
      account,
      positions,
      {
        optionEvidence,
        underlyingPrices,
        underlyingPriceTimestamps,
        betas,
        highWaterMark
      },
      config,
      asOf
    );
  } catch {
    return normalizePortfolioEvidence(
      {},
      [],
      {
        optionEvidence: {},
        underlyingPrices: {},
        betas: {},
        highWaterMark: null,
        warnings: ["PAPER_ACCOUNT_READ_FAILED"],
        blockers: ["PAPER_ACCOUNT_UNAVAILABLE"]
      },
      config,
      asOf
    );
  }
};
