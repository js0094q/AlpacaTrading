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
  OptionGreekGroup,
  OptionMetric,
  OptionMetricCoverage,
  PortfolioRiskSnapshot,
  WeightedImpliedVolatility
} from "./portfolioRiskService.js";
import type { HedgePlanArtifact } from "./hedgePlanService.js";
import {
  buildHedgeConfig,
  hedgeConfigurationFingerprint
} from "./hedgeConfigService.js";

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
  return (
    (total === null || total >= 0) &&
    (measured === null || measured >= 0) &&
    (unmeasured === null || unmeasured >= 0) &&
    (coverageRatio === null || (coverageRatio >= 0 && coverageRatio <= 1))
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

const isCurrentRiskPayload = (value: unknown): value is PortfolioRiskSnapshot => {
  if (!isRecord(value) || !isRecord(value.options)) return false;
  const options = value.options;
  const coverage = options.coverage;
  if (
    value.paperOnly !== true ||
    value.environment !== "paper" ||
    typeof value.snapshotId !== "string" ||
    value.snapshotId.length === 0 ||
    isoTime(value.generatedAt) === null ||
    typeof value.riskModelVersion !== "string" ||
    typeof value.configurationFingerprint !== "string" ||
    !Array.isArray(value.positions) ||
    !isStringArray(value.warnings) ||
    !isStringArray(value.blockers) ||
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

  return value.positions.every((position) => {
    if (!isRecord(position) || position.assetClass !== "option") return isRecord(position);
    return (
      hasFiniteOrNullFields(position, [
        "delta",
        "gamma",
        "theta",
        "vega",
        "rho",
        "deltaShares",
        "deltaDollars",
        "gammaSharesPerDollar",
        "thetaDollarsPerDay",
        "vegaDollarsPerVolPoint",
        "rhoDollarsPerRatePoint",
        "impliedVolatility"
      ]) &&
      (position.greekObservationTimestamp === null ||
        typeof position.greekObservationTimestamp === "string") &&
      (position.greekObservationFreshness === "current" ||
        position.greekObservationFreshness === "stale" ||
        position.greekObservationFreshness === "expired" ||
        position.greekObservationFreshness === "malformed")
    );
  });
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
      "HEDGE_EXECUTION_NOT_IMPLEMENTED",
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
  if (raw.configurationFingerprint !== input.configurationFingerprint) {
    integrityWarnings.push("HEDGE_CONFIGURATION_FINGERPRINT_MISMATCH");
  }
  if (raw.riskModelVersion !== input.riskModelVersion) {
    integrityWarnings.push("HEDGE_RISK_MODEL_VERSION_MISMATCH");
  }
  if (raw.regimeModelVersion !== input.regimeModelVersion) {
    integrityWarnings.push("HEDGE_REGIME_MODEL_VERSION_MISMATCH");
  }
  const validRisk = isCurrentRiskPayload(raw.risk) ? raw.risk : null;
  if (!validRisk) {
    integrityWarnings.push("HEDGE_RISK_PAYLOAD_INVALID");
  } else {
    if (validRisk.riskModelVersion !== raw.riskModelVersion) {
      integrityWarnings.push("HEDGE_RISK_PAYLOAD_MODEL_MISMATCH");
    }
    if (validRisk.configurationFingerprint !== raw.configurationFingerprint) {
      integrityWarnings.push("HEDGE_RISK_CONFIGURATION_FINGERPRINT_MISMATCH");
    }
    if (hasNonCurrentGreekEvidence(validRisk)) {
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
    environment: "paper",
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
      "HEDGE_EXECUTION_NOT_IMPLEMENTED",
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
