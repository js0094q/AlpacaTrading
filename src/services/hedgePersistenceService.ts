import { canonicalizeJson } from "../lib/canonicalJson.js";
import { getDb } from "../lib/db.js";
import type {
  BetaCacheEntry,
  BetaCacheIdentity,
  HedgeRecommendationRecord,
  PersistedHedgeRiskRead,
  PersistedHedgeRecommendation,
  PortfolioHighWaterMark
} from "./hedgeTypes.js";
import type {
  CoverageBasis,
  FreshnessCounts,
  NormalizedRiskPosition,
  ObservationFreshness,
  OptionGreekGroup,
  OptionMetric,
  OptionMetricCoverage,
  PortfolioRiskSnapshot,
  WeightedImpliedVolatility
} from "./portfolioRiskService.js";
import type { HedgePlanArtifact } from "./hedgePlanService.js";
import type { HedgeCapitalEvidence } from "./hedgeCapitalEvidenceService.js";
import {
  verifyHedgeExecutionReview,
  type HedgeExecutionReview,
  type HedgeExecutionReviewVerification
} from "./hedgeExecutionReviewService.js";
import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint
} from "./hedgeConfigService.js";
import {
  appendDecisionLifecycleEvent,
  hashAllowlistedConfig,
  persistDecisionSnapshot
} from "./marketDecisionEvidenceService.js";
import type { PositionLifecycleId } from "../types.js";

interface HighWaterRow {
  environment: "paper";
  equity: number;
  observed_at: string;
}

interface BetaCacheRow {
  symbol: string;
  benchmark: string;
  lookback_days: number;
  observation_interval: string;
  minimum_observations: number;
  calculation_version: string;
  latest_market_data_date: string;
  beta: number | null;
  observations: number;
  data_start_date: string | null;
  data_end_date: string | null;
  status: "calculated" | "unavailable";
  computed_at: string;
  expires_at: string;
}

interface HedgeLearningRow {
  id: string;
  created_at: string;
  updated_at: string;
  signal_inputs_json: string;
}

const canonicalJson = (value: unknown) => JSON.stringify(canonicalizeJson(value));

const safeParse = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const isoTime = (value: unknown) => {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isFiniteOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const nearlyEqual = (left: number, right: number) =>
  Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));

const hasFiniteOrNullFields = (
  value: Record<string, unknown>,
  fields: readonly string[]
) => fields.every((field) => field in value && isFiniteOrNull(value[field]));

const isFreshnessCounts = (value: unknown): value is FreshnessCounts => {
  if (!isRecord(value)) return false;
  const fields = ["current", "stale", "expired", "malformed", "total"] as const;
  if (!fields.every((field) => Number.isInteger(value[field]) && Number(value[field]) >= 0)) {
    return false;
  }
  return (
    Number(value.current) +
      Number(value.stale) +
      Number(value.expired) +
      Number(value.malformed) ===
    Number(value.total)
  );
};

const isCoverageBasis = (value: unknown): value is CoverageBasis => {
  if (!isRecord(value)) return false;
  const { total, measured, unmeasured, coverageRatio } = value;
  if (
    !isFiniteOrNull(total) ||
    !isFiniteOrNull(measured) ||
    !isFiniteOrNull(unmeasured) ||
    !isFiniteOrNull(coverageRatio)
  ) {
    return false;
  }
  if (total === null) {
    return measured === null && unmeasured === null && coverageRatio === null;
  }
  if (
    total < 0 ||
    measured === null ||
    measured < 0 ||
    unmeasured === null ||
    unmeasured < 0 ||
    !nearlyEqual(total, measured + unmeasured)
  ) {
    return false;
  }
  if (total === 0) return coverageRatio === null;
  return (
    coverageRatio !== null &&
    coverageRatio >= 0 &&
    coverageRatio <= 1 &&
    nearlyEqual(coverageRatio, measured / total)
  );
};

const isMetricCoverage = (value: unknown): value is OptionMetricCoverage =>
  isRecord(value) &&
  isCoverageBasis(value.positions) &&
  isCoverageBasis(value.absoluteContracts) &&
  isCoverageBasis(value.absoluteMarketValue) &&
  isFreshnessCounts(value.freshness);

const isWeightedIv = (value: unknown): value is WeightedImpliedVolatility =>
  isRecord(value) &&
  hasFiniteOrNullFields(value, [
    "weightedByAbsoluteContracts",
    "weightedByAbsoluteMarketValue",
    "weightedByAbsoluteVega"
  ]);

const optionMetrics: OptionMetric[] = [
  "delta",
  "gamma",
  "theta",
  "vega",
  "rho",
  "impliedVolatility"
];

const isGreekGroup = (value: unknown): value is OptionGreekGroup =>
  isRecord(value) &&
  Number.isInteger(value.positionCount) &&
  Number(value.positionCount) >= 0 &&
  hasFiniteOrNullFields(value, [
    "absoluteContracts",
    "absoluteMarketValue",
    "deltaShares",
    "deltaDollars",
    "gammaSharesPerDollar",
    "thetaDollarsPerDay",
    "vegaDollarsPerVolPoint",
    "rhoDollarsPerRatePoint"
  ]) &&
  isWeightedIv(value.impliedVolatility) &&
  (value.quality === "complete" || value.quality === "incomplete") &&
  Array.isArray(value.missingMetrics) &&
  value.missingMetrics.every(
    (metric) => typeof metric === "string" && optionMetrics.includes(metric as OptionMetric)
  );

const isGreekGrouping = (value: unknown) =>
  isRecord(value) && Object.values(value).every(isGreekGroup);

const explicitOptionTotalFields = [
  "deltaShares",
  "deltaDollars",
  "absoluteDeltaShares",
  "absoluteDeltaDollars",
  "gammaSharesPerDollar",
  "absoluteGammaSharesPerDollar",
  "thetaDollarsPerDay",
  "absoluteThetaDollarsPerDay",
  "positiveThetaDollarsPerDay",
  "negativeThetaDollarsPerDay",
  "vegaDollarsPerVolPoint",
  "absoluteVegaDollarsPerVolPoint",
  "rhoDollarsPerRatePoint",
  "absoluteRhoDollarsPerRatePoint"
] as const;

const legacyOptionTotalFields = [
  "deltaExposure",
  "absoluteDeltaExposure",
  "absoluteDeltaExposurePct",
  "positiveDeltaExposure",
  "positiveDeltaExposurePct",
  "gammaExposure",
  "thetaExposure",
  "vegaExposure",
  "rhoExposure",
  "nearTermExposurePct"
] as const;

const positionNumericFields = [
  "quantity",
  "marketValue",
  "currentPrice",
  "underlyingPrice",
  "costBasis",
  "unrealizedPl",
  "unrealizedPlPct",
  "beta",
  "multiplier",
  "delta",
  "gamma",
  "theta",
  "vega",
  "rho",
  "strikePrice",
  "daysToExpiration",
  "moneynessPct",
  "deltaEquivalentShares",
  "deltaAdjustedExposure",
  "deltaShares",
  "deltaDollars",
  "betaExposure",
  "gammaExposure",
  "thetaExposure",
  "vegaExposure",
  "rhoExposure",
  "gammaSharesPerDollar",
  "thetaDollarsPerDay",
  "vegaDollarsPerVolPoint",
  "rhoDollarsPerRatePoint",
  "impliedVolatility",
  "bid",
  "ask",
  "midpoint",
  "bidSize",
  "askSize",
  "bidAskSpreadPct"
] as const;

const isObservationFreshness = (value: unknown): value is ObservationFreshness =>
  value === "current" || value === "stale" || value === "expired" || value === "malformed";

const isRiskPosition = (value: unknown): value is NormalizedRiskPosition =>
  isRecord(value) &&
  typeof value.symbol === "string" &&
  value.symbol.length > 0 &&
  typeof value.underlying === "string" &&
  value.underlying.length > 0 &&
  (value.assetClass === "equity" || value.assetClass === "option") &&
  (value.optionType === null || value.optionType === "call" || value.optionType === "put") &&
  typeof value.sector === "string" &&
  typeof value.betaStatus === "string" &&
  hasFiniteOrNullFields(value, positionNumericFields) &&
  isStringOrNull(value.expirationDate) &&
  isStringOrNull(value.greekObservationTimestamp) &&
  (value.assetClass === "equity" || isObservationFreshness(value.greekObservationFreshness)) &&
  isStringOrNull(value.underlyingPriceTimestamp) &&
  isStringOrNull(value.quoteTimestamp) &&
  typeof value.inverseExposure === "boolean" &&
  isStringArray(value.warnings) &&
  isStringArray(value.blockers);

const isRatio = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;

const isScenario = (value: unknown) =>
  isRecord(value) &&
  (value.benchmarkDeclinePct === 5 ||
    value.benchmarkDeclinePct === 8 ||
    value.benchmarkDeclinePct === 10 ||
    value.benchmarkDeclinePct === 15) &&
  isFiniteNumber(value.grossModeledLoss) &&
  isFiniteNumber(value.existingProtection) &&
  isFiniteOrNull(value.netModeledLoss) &&
  isFiniteOrNull(value.netModeledLossPct) &&
  isRatio(value.coverage) &&
  isStringArray(value.warnings);

const isOptionDataCoverage = (value: unknown) => {
  if (!isRecord(value)) return false;
  const numericFields = [
    "totalOptionContracts",
    "contractsWithDelta",
    "contractsWithoutDelta",
    "totalOptionMarketValue",
    "optionMarketValueWithDelta",
    "optionMarketValueWithoutDelta"
  ] as const;
  if (!numericFields.every((field) => isFiniteNumber(value[field]) && Number(value[field]) >= 0)) {
    return false;
  }
  const totalContracts = Number(value.totalOptionContracts);
  const contractsWithDelta = Number(value.contractsWithDelta);
  const contractsWithoutDelta = Number(value.contractsWithoutDelta);
  const totalMarketValue = Number(value.totalOptionMarketValue);
  const marketValueWithDelta = Number(value.optionMarketValueWithDelta);
  const marketValueWithoutDelta = Number(value.optionMarketValueWithoutDelta);
  return (
    nearlyEqual(totalContracts, contractsWithDelta + contractsWithoutDelta) &&
    nearlyEqual(totalMarketValue, marketValueWithDelta + marketValueWithoutDelta) &&
    (totalContracts === 0
      ? value.contractDeltaCoveragePct === null
      : isRatio(value.contractDeltaCoveragePct) &&
        nearlyEqual(Number(value.contractDeltaCoveragePct), contractsWithDelta / totalContracts)) &&
    (totalMarketValue === 0
      ? value.marketValueDeltaCoveragePct === null
      : isRatio(value.marketValueDeltaCoveragePct) &&
        nearlyEqual(Number(value.marketValueDeltaCoveragePct), marketValueWithDelta / totalMarketValue)) &&
    typeof value.materialCoverageMissing === "boolean"
  );
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

const groupingMatchesPositions = (
  grouping: Record<string, OptionGreekGroup>,
  positions: NormalizedRiskPosition[],
  keyFor: (position: NormalizedRiskPosition) => string
) => {
  const expected = new Map<string, NormalizedRiskPosition[]>();
  for (const position of positions) {
    const key = keyFor(position);
    expected.set(key, [...(expected.get(key) ?? []), position]);
  }
  if (
    Object.keys(grouping).length !== expected.size ||
    Object.keys(grouping).some((key) => !expected.has(key))
  ) {
    return false;
  }
  return [...expected].every(([key, groupPositions]) => {
    const group = grouping[key];
    const quantityComplete = groupPositions.every((position) => position.quantity !== null);
    const marketValueComplete = groupPositions.every((position) => position.marketValue !== null);
    const expectedContracts = quantityComplete
      ? groupPositions.reduce((sum, position) => sum + Math.abs(position.quantity ?? 0), 0)
      : null;
    const expectedMarketValue = marketValueComplete
      ? groupPositions.reduce((sum, position) => sum + Math.abs(position.marketValue ?? 0), 0)
      : null;
    return (
      group.positionCount === groupPositions.length &&
      (expectedContracts === null
        ? group.absoluteContracts === null
        : group.absoluteContracts !== null && nearlyEqual(group.absoluteContracts, expectedContracts)) &&
      (expectedMarketValue === null
        ? group.absoluteMarketValue === null
        : group.absoluteMarketValue !== null &&
          nearlyEqual(group.absoluteMarketValue, expectedMarketValue))
    );
  });
};

const metricValue = (position: NormalizedRiskPosition, metric: OptionMetric) =>
  metric === "impliedVolatility" ? position.impliedVolatility : position[metric];

const expectedCoverageBasis = (
  total: number | null,
  measured: number | null
): CoverageBasis => ({
  total,
  measured,
  unmeasured: total === null || measured === null ? null : Math.max(0, total - measured),
  coverageRatio: total !== null && measured !== null && total > 0 ? measured / total : null
});

const sameCoverageBasis = (actual: CoverageBasis, expected: CoverageBasis) =>
  (["total", "measured", "unmeasured", "coverageRatio"] as const).every((field) => {
    const left = actual[field];
    const right = expected[field];
    return left === null || right === null
      ? left === right
      : nearlyEqual(left, right);
  });

const metricCoverageMatchesPositions = (
  coverage: Record<OptionMetric, OptionMetricCoverage>,
  positions: NormalizedRiskPosition[]
) => optionMetrics.every((metric) => {
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
  return (
    sameCoverageBasis(
      coverage[metric].positions,
      expectedCoverageBasis(positions.length, measuredPositions.length)
    ) &&
    sameCoverageBasis(
      coverage[metric].absoluteContracts,
      expectedCoverageBasis(totalContracts, measuredContracts)
    ) &&
    sameCoverageBasis(
      coverage[metric].absoluteMarketValue,
      expectedCoverageBasis(totalMarketValue, measuredMarketValue)
    )
  );
});

const isCurrentRiskPayload = (value: unknown): value is PortfolioRiskSnapshot => {
  if (
    !isRecord(value) ||
    !isRecord(value.account) ||
    !isRecord(value.exposures) ||
    !isRecord(value.options) ||
    !isRecord(value.concentration) ||
    !isRecord(value.dataQuality)
  ) return false;
  const account = value.account as Record<string, unknown>;
  const exposures = value.exposures as Record<string, unknown>;
  const concentration = value.concentration as Record<string, unknown>;
  const dataQuality = value.dataQuality as Record<string, unknown>;
  const options = value.options;
  const coverage = options.coverage;
  if (
    value.paperOnly !== true ||
    value.environment !== "paper" ||
    typeof value.snapshotId !== "string" ||
    value.snapshotId.length === 0 ||
    !isStringOrNull(value.sourceAccountSnapshotId) ||
    isoTime(value.generatedAt) === null ||
    typeof value.riskModelVersion !== "string" || value.riskModelVersion.length === 0 ||
    typeof value.configurationFingerprint !== "string" || value.configurationFingerprint.length === 0 ||
    !Array.isArray(value.positions) || !value.positions.every(isRiskPosition) ||
    !hasFiniteOrNullFields(account, ["equity", "cash", "buyingPower", "highWaterMark", "drawdownPct"]) ||
    !["grossExposure", "netExposure", "longExposure", "shortOrInverseExposure"].every(
      (field) => isFiniteNumber(exposures[field])
    ) ||
    !hasFiniteOrNullFields(exposures, ["grossExposurePct", "netExposurePct"]) ||
    !isStringArray(value.warnings) ||
    !isStringArray(value.blockers) ||
    !hasFiniteOrNullFields(options, legacyOptionTotalFields) ||
    !hasFiniteOrNullFields(options, explicitOptionTotalFields) ||
    !isWeightedIv(options.impliedVolatility) ||
    !isFreshnessCounts(options.freshness) ||
    !isRecord(coverage) ||
    !isRecord(options.groupings) ||
    !isGreekGrouping(options.groupings.byUnderlying) ||
    !isGreekGrouping(options.groupings.byExpiration) ||
    !isGreekGrouping(options.groupings.byOptionType) ||
    !isGreekGrouping(options.groupings.byDteBucket) ||
    typeof options.executionEligible !== "boolean"
  ) {
    return false;
  }
  if (!optionMetrics.every((metric) => isMetricCoverage(coverage[metric]))) {
    return false;
  }

  if (
    !hasFiniteOrNullFields(concentration, [
      "largestUnderlyingWeight",
      "topFiveUnderlyingWeight",
      "unknownSectorWeight"
    ]) ||
    !isRecord(concentration.byUnderlying) ||
    !Object.values(concentration.byUnderlying).every(isFiniteNumber) ||
    !isRecord(concentration.bySector) ||
    !Object.values(concentration.bySector).every(isFiniteNumber) ||
    !isFiniteOrNull(value.portfolioBeta) ||
    !isRatio(value.betaCoverage) ||
    !isOptionDataCoverage(value.optionDataCoverage) ||
    !Array.isArray(value.scenarios) ||
    !value.scenarios.every(isScenario) ||
    !(value.dataQualityStatus === "complete" ||
      value.dataQualityStatus === "partial" ||
      value.dataQualityStatus === "monitoring" ||
      value.dataQualityStatus === "blocked") ||
    !["positionPriceCoverage", "optionDeltaCoverage", "optionGammaCoverage", "optionThetaCoverage", "optionVegaCoverage", "betaCoverage", "sectorCoverage"].every(
      (field) => isRatio(dataQuality[field])
    )
  ) {
    return false;
  }

  const optionPositions = value.positions.filter((position) => position.assetClass === "option");
  const groupings = options.groupings as unknown as PortfolioRiskSnapshot["options"]["groupings"];
  const typedCoverage = coverage as Record<OptionMetric, OptionMetricCoverage>;
  return Boolean(
    groupings &&
    metricCoverageMatchesPositions(typedCoverage, optionPositions) &&
    groupingMatchesPositions(groupings.byUnderlying, optionPositions, (position) => position.underlying) &&
    groupingMatchesPositions(groupings.byExpiration, optionPositions, (position) => position.expirationDate ?? "unknown") &&
    groupingMatchesPositions(groupings.byOptionType, optionPositions, (position) => position.optionType ?? "unknown") &&
    groupingMatchesPositions(groupings.byDteBucket, optionPositions, (position) => dteBucket(position.daysToExpiration))
  );
};

const freshnessCounts = (positions: NormalizedRiskPosition[]): FreshnessCounts =>
  positions.reduce<FreshnessCounts>((counts, position) => {
    const status = position.greekObservationFreshness ?? "malformed";
    counts[status] += 1;
    counts.total += 1;
    return counts;
  }, { current: 0, stale: 0, expired: 0, malformed: 0, total: 0 });

const classifyFreshness = (
  timestamp: string | null | undefined,
  asOf: string
): ObservationFreshness => {
  const observedAt = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  const currentTime = Date.parse(asOf);
  if (!Number.isFinite(observedAt) || !Number.isFinite(currentTime) || observedAt > currentTime) {
    return "malformed";
  }
  const { currentMaxAgeSeconds, staleMaxAgeSeconds } = buildHedgeConfig().optionGreeksFreshness;
  const ageSeconds = (currentTime - observedAt) / 1000;
  if (ageSeconds <= currentMaxAgeSeconds) return "current";
  if (ageSeconds <= staleMaxAgeSeconds) return "stale";
  return "expired";
};

const recomputeRiskFreshness = (risk: PortfolioRiskSnapshot, asOf: string) => {
  const optionPositions = risk.positions.filter((position) => position.assetClass === "option");
  for (const position of optionPositions) {
    position.greekObservationFreshness = classifyFreshness(
      position.greekObservationTimestamp,
      asOf
    );
  }
  risk.options.freshness = freshnessCounts(optionPositions);
  for (const metric of optionMetrics) {
    const measured = optionPositions.filter((position) =>
      isFiniteOrNull(metric === "impliedVolatility" ? position.impliedVolatility : position[metric]) &&
      (metric === "impliedVolatility" ? position.impliedVolatility : position[metric]) !== null
    );
    if (risk.options.coverage?.[metric]) {
      risk.options.coverage[metric].freshness = freshnessCounts(measured);
    }
  }
  return risk;
};

const hasNonCurrentGreekEvidence = (risk: PortfolioRiskSnapshot) =>
  (risk.options.freshness?.stale ?? 0) > 0 ||
  (risk.options.freshness?.expired ?? 0) > 0 ||
  (risk.options.freshness?.malformed ?? 0) > 0;

const mapHighWater = (row: HighWaterRow): PortfolioHighWaterMark => ({
  environment: row.environment,
  equity: row.equity,
  observedAt: row.observed_at
});

export const observePortfolioHighWaterMark = (input: PortfolioHighWaterMark) => {
  if (!(Number.isFinite(input.equity) && input.equity > 0)) {
    throw new Error("PORTFOLIO_HIGH_WATER_EQUITY_INVALID");
  }
  getDb()
    .prepare(
      `
      INSERT INTO portfolio_high_water_marks(environment, equity, observed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(environment) DO UPDATE SET
        equity = excluded.equity,
        observed_at = excluded.observed_at
      WHERE excluded.equity > portfolio_high_water_marks.equity
      `
    )
    .run(input.environment, input.equity, input.observedAt);
  const row = getDb()
    .prepare(
      `SELECT environment, equity, observed_at
       FROM portfolio_high_water_marks
       WHERE environment = ?`
    )
    .get(input.environment) as unknown as HighWaterRow;
  return mapHighWater(row);
};

export const latestPortfolioHighWaterMark = (
  environment: "paper"
): PortfolioHighWaterMark | null => {
  const row = getDb()
    .prepare(
      `SELECT environment, equity, observed_at
       FROM portfolio_high_water_marks
       WHERE environment = ?`
    )
    .get(environment) as HighWaterRow | undefined;
  return row ? mapHighWater(row) : null;
};

export const writeBetaCache = (entry: BetaCacheEntry) => {
  getDb()
    .prepare(
      `
      INSERT INTO portfolio_beta_cache(
        symbol, benchmark, lookback_days, observation_interval,
        minimum_observations, calculation_version, latest_market_data_date,
        beta, observations, data_start_date, data_end_date, status,
        computed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        symbol, benchmark, lookback_days, observation_interval,
        minimum_observations, calculation_version, latest_market_data_date
      ) DO UPDATE SET
        beta = excluded.beta,
        observations = excluded.observations,
        data_start_date = excluded.data_start_date,
        data_end_date = excluded.data_end_date,
        status = excluded.status,
        computed_at = excluded.computed_at,
        expires_at = excluded.expires_at
      `
    )
    .run(
      entry.symbol,
      entry.benchmark,
      entry.lookbackDays,
      entry.observationInterval,
      entry.minimumObservations,
      entry.calculationVersion,
      entry.latestMarketDataDate,
      entry.beta,
      entry.observations,
      entry.dataStartDate,
      entry.dataEndDate,
      entry.status,
      entry.computedAt,
      entry.expiresAt
    );
};

const mapBetaCache = (row: BetaCacheRow): BetaCacheEntry => ({
  symbol: row.symbol,
  benchmark: row.benchmark,
  lookbackDays: row.lookback_days,
  observationInterval: row.observation_interval,
  minimumObservations: row.minimum_observations,
  calculationVersion: row.calculation_version,
  latestMarketDataDate: row.latest_market_data_date,
  beta: row.beta,
  observations: row.observations,
  dataStartDate: row.data_start_date,
  dataEndDate: row.data_end_date,
  status: row.status,
  computedAt: row.computed_at,
  expiresAt: row.expires_at
});

export const readCompatibleBetaCache = (
  identity: BetaCacheIdentity,
  asOf = new Date().toISOString()
): BetaCacheEntry | null => {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM portfolio_beta_cache
      WHERE symbol = ?
        AND benchmark = ?
        AND lookback_days = ?
        AND observation_interval = ?
        AND minimum_observations = ?
        AND calculation_version = ?
        AND latest_market_data_date = ?
      LIMIT 1
      `
    )
    .get(
      identity.symbol,
      identity.benchmark,
      identity.lookbackDays,
      identity.observationInterval,
      identity.minimumObservations,
      identity.calculationVersion,
      identity.latestMarketDataDate
    ) as BetaCacheRow | undefined;
  if (
    !row ||
    row.status !== "calculated" ||
    row.beta === null ||
    !Number.isFinite(row.beta) ||
    row.observations < identity.minimumObservations ||
    Date.parse(row.expires_at) < Date.parse(asOf)
  ) {
    return null;
  }
  return mapBetaCache(row);
};

export const persistHedgeRecommendation = (record: HedgeRecommendationRecord) => {
  const payload = canonicalJson(record);
  getDb()
    .prepare(
      `
      INSERT INTO paper_learning_records(
        id, created_at, updated_at, strategy_family, symbol,
        underlying_symbol, decision, skip_reason, block_reason,
        hypothesis, signal_inputs_json, risk_model_json,
        learning_status, promotion_eligible, promotion_block_reason,
        source_candidate_id, source_plan_timestamp
      ) VALUES (?, ?, ?, 'portfolio_hedge', ?, ?, 'no_op', ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        skip_reason = excluded.skip_reason,
        block_reason = excluded.block_reason,
        hypothesis = excluded.hypothesis,
        signal_inputs_json = excluded.signal_inputs_json,
        risk_model_json = excluded.risk_model_json,
        promotion_eligible = 0,
        promotion_block_reason = excluded.promotion_block_reason
      `
    )
    .run(
      record.recommendationId,
      record.generatedAt,
      record.generatedAt,
      record.benchmark,
      record.benchmark,
      record.recommendationStatus === "monitoring" ? "HEDGE_MONITORING" : null,
      record.recommendationStatus === "blocked" ? record.blockers[0] ?? "HEDGE_BLOCKED" : null,
      `Portfolio hedge recommendation: ${record.decision}`,
      payload,
      canonicalJson(record.score),
      "HEDGE_PLAN_REQUIRES_EXECUTION_REVIEW",
      record.sourceSnapshotId,
      record.generatedAt
    );
  return record;
};

const mandatoryRecommendationStrings = [
  "recommendationId",
  "generatedAt",
  "expiresAt",
  "environment",
  "sourceSnapshotId",
  "riskModelVersion",
  "regimeModelVersion",
  "configurationFingerprint",
  "dataQualityStatus",
  "recommendationStatus"
] as const;

const isHedgeCapitalEvidence = (value: unknown): value is HedgeCapitalEvidence => {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Record<string, unknown>;
  const numericOrNull = (key: string) =>
    evidence[key] === null ||
    (typeof evidence[key] === "number" && Number.isFinite(evidence[key]));
  return (
    numericOrNull("existingHedgeExposure") &&
    numericOrNull("existingHedgePremium") &&
    numericOrNull("reservedHedgePremium") &&
    numericOrNull("dailyHedgePremiumUsed") &&
    numericOrNull("completedHedgePremium") &&
    numericOrNull("openHedgeOrderCount") &&
    typeof evidence.complete === "boolean" &&
    Array.isArray(evidence.blockers) &&
    evidence.blockers.every((blocker) => typeof blocker === "string") &&
    typeof evidence.fingerprint === "string" &&
    evidence.fingerprint.length > 0
  );
};

const mapRecommendation = (
  row: HedgeLearningRow,
  input: {
    asOf: string;
    freshnessMinutes: number;
    configurationFingerprint: string;
    riskModelVersion: string;
    regimeModelVersion: string;
  }
): PersistedHedgeRecommendation => {
  const raw = safeParse(row.signal_inputs_json) ?? {};
  const integrityWarnings: string[] = [];
  const validStrings = mandatoryRecommendationStrings.every(
    (key) => typeof raw[key] === "string" && String(raw[key]).length > 0
  );
  const generated = isoTime(raw.generatedAt);
  const expires = isoTime(raw.expiresAt);
  if (!validStrings || generated === null || expires === null || raw.recordType !== "hedge_recommendation") {
    integrityWarnings.push("HEDGE_RECOMMENDATION_INTEGRITY_INVALID");
  }
  if (raw.environment !== "paper") {
    integrityWarnings.push("HEDGE_RECOMMENDATION_ENVIRONMENT_INVALID");
  }
  if (raw.configurationFingerprint !== input.configurationFingerprint) {
    integrityWarnings.push("HEDGE_CONFIGURATION_FINGERPRINT_MISMATCH");
  }
  if (raw.riskModelVersion !== input.riskModelVersion) {
    integrityWarnings.push("HEDGE_RISK_MODEL_VERSION_MISMATCH");
  }
  if (raw.regimeModelVersion !== input.regimeModelVersion) {
    integrityWarnings.push("HEDGE_REGIME_MODEL_VERSION_MISMATCH");
  }
  const validCapitalEvidence = isHedgeCapitalEvidence(raw.capitalEvidence)
    ? raw.capitalEvidence
    : null;
  if (
    !validCapitalEvidence ||
    (raw.recommendationStatus === "current" && !validCapitalEvidence.complete)
  ) {
    integrityWarnings.push("HEDGE_CAPITAL_EVIDENCE_INVALID");
  }
  let validRisk = isCurrentRiskPayload(raw.risk) ? raw.risk : null;
  if (!validRisk) {
    integrityWarnings.push("HEDGE_RISK_PAYLOAD_INVALID");
  } else {
    const identityMismatch =
      validRisk.snapshotId !== raw.sourceSnapshotId ||
      validRisk.riskModelVersion !== raw.riskModelVersion ||
      validRisk.configurationFingerprint !== raw.configurationFingerprint;
    if (validRisk.snapshotId !== raw.sourceSnapshotId) {
      integrityWarnings.push("HEDGE_RISK_SOURCE_SNAPSHOT_MISMATCH");
    }
    if (validRisk.riskModelVersion !== raw.riskModelVersion) {
      integrityWarnings.push("HEDGE_RISK_PAYLOAD_MODEL_MISMATCH");
    }
    if (validRisk.configurationFingerprint !== raw.configurationFingerprint) {
      integrityWarnings.push("HEDGE_RISK_CONFIGURATION_FINGERPRINT_MISMATCH");
    }
    if (identityMismatch) {
      integrityWarnings.push("HEDGE_RISK_PAYLOAD_INVALID");
      validRisk = null;
    } else {
      recomputeRiskFreshness(validRisk, input.asOf);
    }
    if (validRisk && hasNonCurrentGreekEvidence(validRisk)) {
      integrityWarnings.push("HEDGE_RISK_EVIDENCE_STALE");
    }
  }

  const asOfTime = Date.parse(input.asOf);
  let effectiveStatus: PersistedHedgeRecommendation["effectiveStatus"] =
    raw.recommendationStatus === "monitoring" || raw.recommendationStatus === "blocked"
      ? raw.recommendationStatus
      : "current";
  if (
    integrityWarnings.includes("HEDGE_RECOMMENDATION_INTEGRITY_INVALID") ||
    integrityWarnings.includes("HEDGE_RECOMMENDATION_ENVIRONMENT_INVALID") ||
    integrityWarnings.includes("HEDGE_CAPITAL_EVIDENCE_INVALID") ||
    integrityWarnings.includes("HEDGE_RISK_PAYLOAD_INVALID")
  ) {
    effectiveStatus = "blocked";
  } else if (expires !== null && asOfTime > expires) {
    effectiveStatus = "expired";
  } else if (
    integrityWarnings.length > 0 ||
    (generated !== null &&
      asOfTime - generated > Math.max(1, input.freshnessMinutes) * 60_000)
  ) {
    effectiveStatus = "stale";
  }

  const fallback: Omit<PersistedHedgeRecommendation, "effectiveStatus" | "integrityWarnings" | "persistedAt"> = {
    recordType: "hedge_recommendation",
    recommendationId: typeof raw.recommendationId === "string" ? raw.recommendationId : row.id,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : row.created_at,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : new Date(0).toISOString(),
    environment: typeof raw.environment === "string" ? raw.environment : "unknown",
    paperOnly: raw.environment === "paper" && validRisk?.paperOnly === true,
    liveTradingEnabled: !(raw.environment === "paper" && validRisk?.paperOnly === true),
    sourceSnapshotId: typeof raw.sourceSnapshotId === "string" ? raw.sourceSnapshotId : "",
    riskModelVersion: typeof raw.riskModelVersion === "string" ? raw.riskModelVersion : "",
    regimeModelVersion: typeof raw.regimeModelVersion === "string" ? raw.regimeModelVersion : "",
    configurationFingerprint:
      typeof raw.configurationFingerprint === "string" ? raw.configurationFingerprint : "",
    dataQualityStatus:
      raw.dataQualityStatus === "complete" ||
      raw.dataQualityStatus === "partial" ||
      raw.dataQualityStatus === "monitoring"
        ? raw.dataQualityStatus
        : "blocked",
    recommendationStatus:
      raw.recommendationStatus === "current" || raw.recommendationStatus === "monitoring"
        ? raw.recommendationStatus
        : "blocked",
    reviewedPayloadHash:
      typeof raw.reviewedPayloadHash === "string" ? raw.reviewedPayloadHash : null,
    decision:
      raw.decision === "monitor" ||
      raw.decision === "existing_protection_sufficient" ||
      raw.decision === "trim_leaps" ||
      raw.decision === "trim_leaps_then_protect" ||
      raw.decision === "buy_protection"
        ? raw.decision
        : "blocked",
    benchmark: typeof raw.benchmark === "string" ? raw.benchmark : "SPY",
    risk: validRisk,
    regime:
      raw.regime && typeof raw.regime === "object" ? (raw.regime as Record<string, unknown>) : {},
    score: raw.score && typeof raw.score === "object" ? (raw.score as Record<string, unknown>) : {},
    sizing: raw.sizing && typeof raw.sizing === "object" ? (raw.sizing as Record<string, unknown>) : {},
    capitalEvidence: validCapitalEvidence ?? {
      existingHedgeExposure: null,
      existingHedgePremium: null,
      reservedHedgePremium: null,
      dailyHedgePremiumUsed: null,
      completedHedgePremium: null,
      openHedgeOrderCount: null,
      complete: false,
      blockers: ["HEDGE_CAPITAL_EVIDENCE_INVALID"],
      fingerprint: "invalid"
    },
    leaps: raw.leaps && typeof raw.leaps === "object" ? (raw.leaps as Record<string, unknown>) : {},
    candidates: Array.isArray(raw.candidates) ? (raw.candidates as HedgeRecommendationRecord["candidates"]) : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
    blockers: Array.isArray(raw.blockers) ? raw.blockers.map(String) : [],
    requestId: typeof raw.requestId === "string" ? raw.requestId : "unknown",
    correlationId: typeof raw.correlationId === "string" ? raw.correlationId : null
  };

  return {
    ...fallback,
    effectiveStatus,
    integrityWarnings,
    persistedAt: row.updated_at
  };
};

const uniqueStrings = (values: string[]) => [...new Set(values)];

export const buildPersistedHedgeRiskRead = (
  recommendation: PersistedHedgeRecommendation | null
): PersistedHedgeRiskRead => ({
  paperOnly: true,
  environment: "paper",
  liveTradingEnabled: false,
  effectiveStatus: recommendation?.effectiveStatus ?? "blocked",
  generatedAt: recommendation?.generatedAt ?? null,
  expiresAt: recommendation?.expiresAt ?? null,
  risk: recommendation?.risk ?? null,
  warnings: recommendation
    ? uniqueStrings([
        ...recommendation.integrityWarnings,
        ...(recommendation.risk?.warnings ?? [])
      ])
    : ["NO_HEDGE_RECOMMENDATION"],
  blockers: recommendation
    ? uniqueStrings(recommendation.risk?.blockers ?? [])
    : ["NO_HEDGE_RECOMMENDATION"]
});

export const latestHedgeRecommendation = (input: {
  asOf?: string;
  freshnessMinutes?: number;
  configurationFingerprint: string;
  riskModelVersion: string;
  regimeModelVersion: string;
}): PersistedHedgeRecommendation | null => {
  const row = getDb()
    .prepare(
      `
      SELECT id, created_at, updated_at, signal_inputs_json
      FROM paper_learning_records
      WHERE strategy_family = 'portfolio_hedge'
        AND json_extract(signal_inputs_json, '$.recordType') = 'hedge_recommendation'
      ORDER BY created_at DESC, updated_at DESC
      LIMIT 1
      `
    )
    .get() as HedgeLearningRow | undefined;
  return row
    ? mapRecommendation(row, {
        asOf: input.asOf ?? new Date().toISOString(),
        freshnessMinutes: input.freshnessMinutes ?? 15,
        configurationFingerprint: input.configurationFingerprint,
        riskModelVersion: input.riskModelVersion,
        regimeModelVersion: input.regimeModelVersion
      })
    : null;
};

export const latestHedgeRecommendationForCurrentConfig = (input: {
  asOf?: string;
} = {}) => {
  const config = buildHedgeConfig();
  return latestHedgeRecommendation({
    asOf: input.asOf,
    freshnessMinutes: config.recommendationFreshnessMinutes,
    configurationFingerprint: hedgeConfigurationFingerprint(config),
    riskModelVersion: config.riskModelVersion,
    regimeModelVersion: config.regimeModelVersion
  });
};

export const attachReviewedPayloadHash = (
  recommendationId: string,
  reviewedPayloadHash: string,
  updatedAt = new Date().toISOString()
) => {
  const row = getDb()
    .prepare(
      `SELECT id, created_at, updated_at, signal_inputs_json
       FROM paper_learning_records
       WHERE id = ? AND strategy_family = 'portfolio_hedge'`
    )
    .get(recommendationId) as HedgeLearningRow | undefined;
  if (!row) {
    return false;
  }
  const raw = safeParse(row.signal_inputs_json);
  if (!raw || raw.recordType !== "hedge_recommendation") {
    return false;
  }
  raw.reviewedPayloadHash = reviewedPayloadHash;
  getDb()
    .prepare(
      `UPDATE paper_learning_records
       SET updated_at = ?, signal_inputs_json = ?
       WHERE id = ?`
    )
    .run(updatedAt, canonicalJson(raw), recommendationId);
  return true;
};

export const persistHedgePlanRecord = (artifact: HedgePlanArtifact) => {
  getDb()
    .prepare(
      `
      INSERT INTO paper_learning_records(
        id, created_at, updated_at, strategy_family, symbol,
        underlying_symbol, decision, skip_reason, block_reason,
        hypothesis, signal_inputs_json, learning_status,
        promotion_eligible, promotion_block_reason,
        source_candidate_id, source_plan_timestamp
      ) VALUES (?, ?, ?, 'portfolio_hedge', ?, ?, 'no_op', ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        skip_reason = excluded.skip_reason,
        block_reason = excluded.block_reason,
        hypothesis = excluded.hypothesis,
        signal_inputs_json = excluded.signal_inputs_json,
        promotion_eligible = 0,
        promotion_block_reason = excluded.promotion_block_reason
      `
    )
    .run(
      artifact.planId,
      artifact.createdAt,
      artifact.createdAt,
      artifact.reviewedPayload.candidates[0]?.underlying ?? "SPY",
      artifact.reviewedPayload.candidates[0]?.underlying ?? "SPY",
      artifact.status === "monitoring" ? "HEDGE_PLAN_MONITORING" : null,
      artifact.status === "blocked" ? artifact.blockers[0] ?? "HEDGE_PLAN_BLOCKED" : null,
      `Non-executable hedge plan for ${artifact.sourceSnapshotId}`,
      canonicalJson(artifact),
      "HEDGE_PLAN_REQUIRES_EXECUTION_REVIEW",
      artifact.sourceSnapshotId,
      artifact.createdAt
    );
  return artifact;
};

export const latestHedgePlan = (): HedgePlanArtifact | null => {
  const row = getDb()
    .prepare(
      `
      SELECT signal_inputs_json
      FROM paper_learning_records
      WHERE strategy_family = 'portfolio_hedge'
        AND json_extract(signal_inputs_json, '$.recordType') = 'hedge_plan'
      ORDER BY created_at DESC, updated_at DESC
      LIMIT 1
      `
    )
    .get() as { signal_inputs_json: string } | undefined;
  if (!row) return null;
  const raw = safeParse(row.signal_inputs_json);
  return raw?.recordType === "hedge_plan" ? (raw as unknown as HedgePlanArtifact) : null;
};

export const persistHedgeExecutionReview = (review: HedgeExecutionReview) => {
  const exactOpenPositions = review.reviewType === "exit"
    ? (getDb().prepare(`
        SELECT position_lifecycle_id
        FROM paper_positions
        WHERE status = 'OPEN'
          AND UPPER(COALESCE(option_symbol, symbol)) = UPPER(?)
        ORDER BY opened_at, position_lifecycle_id
      `).all(review.orderIntent.symbol) as Array<{
        position_lifecycle_id: PositionLifecycleId;
      }>)
    : [];
  const positionLifecycleId =
    exactOpenPositions.length === 1
      ? exactOpenPositions[0].position_lifecycle_id
      : null;
  const snapshot = persistDecisionSnapshot({
    originType: "hedge_execution_review",
    originId: review.reviewId,
    decisionRole: review.reviewType,
    candidateId: review.candidateId,
    positionLifecycleId,
    createdAt: review.createdAt,
    strategyFamily: "portfolio_hedge",
    symbol: review.orderIntent.underlying,
    underlyingSymbol: review.orderIntent.underlying,
    optionSymbol: review.orderIntent.symbol,
    decisionStatus: review.blockers.length ? "BLOCKED" : "REVIEWED",
    reasonCodes: review.blockers.length
      ? review.blockers
      : review.warnings.length
        ? review.warnings
        : ["HEDGE_REVIEW_READY"],
    rationale: {
      candidateId: review.candidateId,
      sourceRecommendationId: review.sourceRecommendationId
    },
    instrumentState: {
      orderType: review.orderIntent.orderType,
      quantity: review.orderIntent.quantity,
      side: review.orderIntent.side,
      structure: review.orderIntent.structure
    },
    riskState: review.caps,
    dataQualityStatus: review.blockers.length ? "BLOCKED" : "COMPLETE",
    sourceTimestamps: { reviewCreatedAt: review.createdAt },
    environment: "paper",
    configAllowlistVersion: "phase1b-v1",
    strategyConfigHash: hashAllowlistedConfig(review, [
      "orderIntent.side",
      "orderIntent.structure",
      "orderIntent.underlying",
      "reviewType"
    ]),
    riskConfigHash: hashAllowlistedConfig(review, [
      "caps.maxNotional",
      "caps.maxPremium",
      "orderIntent.maxNotional",
      "orderIntent.maxPremium"
    ]),
    marketDataRequestId: review.requestId
  });
  getDb()
    .prepare(
      `
      INSERT INTO hedge_execution_reviews(
        review_id, created_at, expires_at, review_type, client_order_id,
        account_hash, source_recommendation_id, source_snapshot_id,
        payload_hash, signature, status, review_json, decision_id,
        decision_role, position_lifecycle_id, decision_linkage_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT')
      ON CONFLICT(review_id) DO NOTHING
      `
    )
    .run(
      review.reviewId,
      review.createdAt,
      review.expiresAt,
      review.reviewType,
      review.clientOrderId,
      review.accountHash,
      review.sourceRecommendationId,
      review.sourceSnapshotId,
      review.payloadHash,
      review.signature,
      "reviewed",
      canonicalJson(review),
      snapshot.decisionId,
      review.reviewType,
      positionLifecycleId
    );
  appendDecisionLifecycleEvent({
    decisionId: snapshot.decisionId,
    status: review.blockers.length ? "BLOCKED" : "REVIEWED",
    reasonCodes: review.blockers.length
      ? review.blockers
      : review.warnings.length
        ? review.warnings
        : ["HEDGE_REVIEW_READY"],
    occurredAt: review.createdAt,
    sourceType: "hedge_execution_review",
    sourceId: review.reviewId,
    evidence: {
      positionLifecycleId,
      reviewId: review.reviewId,
      reviewType: review.reviewType
    }
  });
  return review;
};

export const readHedgeExecutionReview = (input: {
  reviewId: string;
  signingKey: string;
  asOf?: string;
  accountHash?: string;
  configurationFingerprint?: string;
  sourceSnapshotId?: string;
}): {
  review: HedgeExecutionReview | null;
  verification: HedgeExecutionReviewVerification;
} => {
  const row = getDb()
    .prepare(
      `SELECT her.review_id, her.created_at, her.expires_at, her.review_type,
              her.client_order_id, her.account_hash,
              her.source_recommendation_id, her.source_snapshot_id,
              her.payload_hash, her.signature, her.status, her.review_json,
              her.decision_id, her.decision_role, her.position_lifecycle_id,
              her.decision_linkage_status,
              ds.decision_id AS linked_decision_id,
              ds.origin_type AS linked_origin_type,
              ds.origin_id AS linked_origin_id,
              ds.decision_role AS linked_decision_role,
              ds.candidate_id AS linked_candidate_id,
              ds.position_lifecycle_id AS linked_position_lifecycle_id
       FROM hedge_execution_reviews her
       LEFT JOIN decision_snapshots ds ON ds.decision_id = her.decision_id
       WHERE her.review_id = ?
       LIMIT 1`
    )
    .get(input.reviewId) as {
      review_id: string;
      created_at: string;
      expires_at: string;
      review_type: string;
      client_order_id: string;
      account_hash: string;
      source_recommendation_id: string;
      source_snapshot_id: string;
      payload_hash: string;
      signature: string;
      status: string;
      review_json: string;
      decision_id: string | null;
      decision_role: string | null;
      position_lifecycle_id: string | null;
      decision_linkage_status: string | null;
      linked_decision_id: string | null;
      linked_origin_type: string | null;
      linked_origin_id: string | null;
      linked_decision_role: string | null;
      linked_candidate_id: string | null;
      linked_position_lifecycle_id: string | null;
    } | undefined;
  if (!row?.review_json) {
    return {
      review: null,
      verification: {
        valid: false,
        blockers: ["HEDGE_REVIEW_NOT_FOUND"],
        calculatedPayloadHash: ""
      }
    };
  }
  let review: HedgeExecutionReview;
  try {
    review = JSON.parse(row.review_json) as HedgeExecutionReview;
  } catch {
    return {
      review: null,
      verification: {
        valid: false,
        blockers: ["HEDGE_REVIEW_SCHEMA_INVALID"],
        calculatedPayloadHash: ""
      }
    };
  }
  const verified = verifyHedgeExecutionReview({
    review,
    signingKey: input.signingKey,
    asOf: input.asOf,
    accountHash: input.accountHash,
    configurationFingerprint: input.configurationFingerprint,
    sourceSnapshotId: input.sourceSnapshotId
  });
  const persistenceBlockers: string[] = [];
  if (row.status !== "reviewed") {
    persistenceBlockers.push(
      row.status === "consumed"
        ? "HEDGE_REVIEW_ALREADY_CONSUMED"
        : "HEDGE_REVIEW_STATUS_INVALID"
    );
  }
  if (
    row.review_id !== review.reviewId ||
    row.created_at !== review.createdAt ||
    row.expires_at !== review.expiresAt ||
    row.review_type !== review.reviewType ||
    row.client_order_id !== review.clientOrderId ||
    row.account_hash !== review.accountHash ||
    row.source_recommendation_id !== review.sourceRecommendationId ||
    row.source_snapshot_id !== review.sourceSnapshotId ||
    row.payload_hash !== review.payloadHash ||
    row.signature !== review.signature ||
    !row.decision_id ||
    row.decision_role !== review.reviewType ||
    row.decision_linkage_status !== "EXACT" ||
    row.linked_decision_id !== row.decision_id ||
    row.linked_origin_type !== "hedge_execution_review" ||
    row.linked_origin_id !== review.reviewId ||
    row.linked_decision_role !== review.reviewType ||
    row.linked_candidate_id !== review.candidateId ||
    row.linked_position_lifecycle_id !== row.position_lifecycle_id
  ) {
    persistenceBlockers.push("HEDGE_REVIEW_PERSISTENCE_MISMATCH");
  }
  const blockers = [...new Set([...verified.blockers, ...persistenceBlockers])];
  const verification = {
    ...verified,
    valid: blockers.length === 0,
    blockers
  };
  return { review, verification };
};

export const markHedgeExecutionReviewConsumed = (reviewId: string) => {
  const result = getDb()
    .prepare(
      `UPDATE hedge_execution_reviews SET status = 'consumed' WHERE review_id = ? AND status = 'reviewed'`
    )
    .run(reviewId);
  return Number(result.changes) === 1;
};
