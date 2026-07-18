export type OptionEvidenceAvailability =
  | "available"
  | "partial"
  | "provider_unavailable"
  | "enrichment_failed"
  | "stale";

export type OptionEvidenceDataQualityStatus =
  | "complete"
  | "partial"
  | "provider_unavailable"
  | "enrichment_failed"
  | "stale";

export type OptionStrategyUse = "used" | "not_used";

export type OptionDecisionUseType = "filter" | "score" | "sizing" | "risk" | null;

export interface OptionDecisionFieldEvidence {
  value: number | null;
  used: boolean;
  useType: OptionDecisionUseType;
  reason: string | null;
}

export type OptionDecisionFieldName =
  | "contractMultiplier"
  | "underlyingPrice"
  | "strike"
  | "daysToExpiration"
  | "bid"
  | "ask"
  | "midpoint"
  | "last"
  | "volume"
  | "openInterest"
  | "impliedVolatility"
  | "delta"
  | "gamma"
  | "theta"
  | "vega"
  | "rho"
  | "quoteAgeMs"
  | "spreadPercentage";

export type OptionDecisionUseOverride = {
  useType?: OptionDecisionUseType;
  reason?: string | null;
};

export type OptionDecisionUseOverrides = Partial<
  Record<OptionDecisionFieldName, OptionDecisionUseOverride>
>;

export interface OptionDecisionFieldEvidenceMap {
  contractMultiplier: OptionDecisionFieldEvidence;
  underlyingPrice: OptionDecisionFieldEvidence;
  strike: OptionDecisionFieldEvidence;
  daysToExpiration: OptionDecisionFieldEvidence;
  bid: OptionDecisionFieldEvidence;
  ask: OptionDecisionFieldEvidence;
  midpoint: OptionDecisionFieldEvidence;
  last: OptionDecisionFieldEvidence;
  volume: OptionDecisionFieldEvidence;
  openInterest: OptionDecisionFieldEvidence;
  impliedVolatility: OptionDecisionFieldEvidence;
  delta: OptionDecisionFieldEvidence;
  gamma: OptionDecisionFieldEvidence;
  theta: OptionDecisionFieldEvidence;
  vega: OptionDecisionFieldEvidence;
  rho: OptionDecisionFieldEvidence;
  quoteAgeMs: OptionDecisionFieldEvidence;
  spreadPercentage: OptionDecisionFieldEvidence;
}

export type OptionSelectionBinding =
  | "nearest_contract_feature_snapshot"
  | "discovery_contract"
  | "not_bound";

export interface OptionDecisionSnapshotRow {
  optionSymbol: string;
  underlyingSymbol: string;
  timestamp: string;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  quoteStatus: string | null;
  executable: number | boolean | null;
  executablePrice: number | null;
  executablePriceSource: string | null;
  rejectionReason: string | null;
  quoteTimestamp: string | null;
  quoteAgeMs: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  snapshotTimestamp: string | null;
  normalizationPath: string | null;
  source: string | null;
  sourceFeed: string | null;
  spreadPercentage: number | null;
  daysToExpiration?: number | null;
}

export interface OptionDecisionContract {
  optionSymbol: string;
  underlyingSymbol: string;
  type: "call" | "put";
  expirationDate: string;
  strike: number | null;
  multiplier: number | null;
}

export interface OptionDecisionDerivedMetrics {
  spreadPercentage: number | null;
  liquidityScore: number | null;
  ivPercentile: number | null;
  deltaAdjustedExposure: number | null;
  thetaDecayPerDay: number | null;
  probabilityProxy: number | null;
  candidateScore: number | null;
}

export interface OptionStrategyUseMap {
  contractMultiplier: OptionStrategyUse;
  underlyingPrice: OptionStrategyUse;
  expiration: OptionStrategyUse;
  strike: OptionStrategyUse;
  daysToExpiration: OptionStrategyUse;
  bid: OptionStrategyUse;
  ask: OptionStrategyUse;
  midpoint: OptionStrategyUse;
  last: OptionStrategyUse;
  volume: OptionStrategyUse;
  openInterest: OptionStrategyUse;
  impliedVolatility: OptionStrategyUse;
  delta: OptionStrategyUse;
  gamma: OptionStrategyUse;
  theta: OptionStrategyUse;
  vega: OptionStrategyUse;
  rho: OptionStrategyUse;
  quoteAge: OptionStrategyUse;
  spreadPercentage: OptionStrategyUse;
}

export interface OptionDecisionSnapshotEvidence {
  contractSymbol: string | null;
  underlyingSymbol: string | null;
  optionType: "call" | "put" | null;
  strike: number | null;
  expirationDate: string | null;
  daysToExpiration: number | null;
  contractMultiplier: number | null;
  underlyingPrice: number | null;
  underlyingPriceSource: string | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  greeks: {
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    rho: number | null;
  };
  quoteStatus: string | null;
  executable: boolean | null;
  executablePrice: number | null;
  executablePriceSource: string | null;
  rejectionReason: string | null;
  rejectionReasons: string[];
  quoteTimestamp: string | null;
  quoteAgeMs: number | null;
  decisionTimestamp: string | null;
  snapshotTimestamp: string | null;
  source: string | null;
  sourceFeed: string | null;
  normalizationPath: string | null;
  availability: {
    snapshot: OptionEvidenceAvailability;
    quote: OptionEvidenceAvailability;
    greeks: OptionEvidenceAvailability;
    underlyingPrice: OptionEvidenceAvailability;
  };
  dataQualityStatus: OptionEvidenceDataQualityStatus;
  strategyUse: OptionStrategyUseMap;
  decisionUse: OptionDecisionFieldEvidenceMap;
  derived: OptionDecisionDerivedMetrics;
  selectionBinding: OptionSelectionBinding;
}

export interface BuildOptionDecisionSnapshotInput {
  contract: OptionDecisionContract | null;
  snapshot: OptionDecisionSnapshotRow | null;
  decisionTimestamp?: string | null;
  underlyingPrice?: number | null;
  underlyingPriceSource?: string | null;
  derived?: Partial<OptionDecisionDerivedMetrics>;
  selectionBinding?: OptionSelectionBinding;
  rejectionReasons?: string[];
  daysToExpiration?: number | null;
  decisionUseOverrides?: OptionDecisionUseOverrides;
  maxQuoteAgeMs?: number;
}

type OptionDecisionUsePlan = {
  useType: OptionDecisionUseType;
  reason: string;
};

type OptionDecisionUsePlanMap = Record<OptionDecisionFieldName, OptionDecisionUsePlan>;

const standardDecisionUsePlan: OptionDecisionUsePlanMap = {
  contractMultiplier: {
    useType: null,
    reason: "Retrieved for contract context but not used by the standard scorer"
  },
  underlyingPrice: {
    useType: "filter",
    reason: "Used to select the nearest contract by strike distance"
  },
  strike: {
    useType: "filter",
    reason: "Used to select the nearest contract by strike distance"
  },
  daysToExpiration: {
    useType: "filter",
    reason: "Used to select the nearest non-expired option expiration"
  },
  bid: {
    useType: "score",
    reason: "Used in the bid-ask spread and liquidity score"
  },
  ask: {
    useType: "score",
    reason: "Used in the bid-ask spread and liquidity score"
  },
  midpoint: {
    useType: null,
    reason: "Retrieved for execution and display but not used by the standard scorer"
  },
  last: {
    useType: null,
    reason: "Retrieved from the provider but not used by the standard scorer"
  },
  volume: {
    useType: "score",
    reason: "Used in the preferred-contract liquidity score"
  },
  openInterest: {
    useType: "score",
    reason: "Used in the preferred-contract liquidity score"
  },
  impliedVolatility: {
    useType: "filter",
    reason: "Used by options-expression selection and implied-volatility features"
  },
  delta: {
    useType: null,
    reason: "Retrieved from the provider but not used by the standard scorer"
  },
  gamma: {
    useType: null,
    reason: "Retrieved from the provider but not used by the standard scorer"
  },
  theta: {
    useType: null,
    reason: "Retrieved from the provider but not used by the standard scorer"
  },
  vega: {
    useType: null,
    reason: "Retrieved from the provider but not used by the standard scorer"
  },
  rho: {
    useType: null,
    reason: "Retrieved from the provider but not used by the standard scorer"
  },
  quoteAgeMs: {
    useType: null,
    reason: "Retrieved for freshness labeling but not used by the standard scorer"
  },
  spreadPercentage: {
    useType: "score",
    reason: "Used in the preferred-contract liquidity score"
  }
};

const standardStrategyUse: OptionStrategyUseMap = {
  contractMultiplier: "not_used",
  underlyingPrice: "used",
  expiration: "used",
  strike: "used",
  daysToExpiration: "used",
  bid: "used",
  ask: "used",
  midpoint: "not_used",
  last: "not_used",
  volume: "used",
  openInterest: "used",
  impliedVolatility: "used",
  delta: "not_used",
  gamma: "not_used",
  theta: "not_used",
  vega: "not_used",
  rho: "not_used",
  quoteAge: "not_used",
  spreadPercentage: "used"
};

const finiteNumber = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const countGreeks = (snapshot: OptionDecisionSnapshotRow | null) =>
  snapshot
    ? [snapshot.delta, snapshot.gamma, snapshot.theta, snapshot.vega, snapshot.rho]
        .filter((value) => finiteNumber(value) !== null).length
    : 0;

const daysToExpiration = (expirationDate: string | null, decisionTimestamp: string | null) => {
  if (!expirationDate || !decisionTimestamp) return null;
  const expiration = Date.parse(`${expirationDate}T00:00:00.000Z`);
  const decision = Date.parse(decisionTimestamp);
  if (!Number.isFinite(expiration) || !Number.isFinite(decision)) return null;
  return Math.max(0, Math.round((expiration - decision) / (24 * 60 * 60 * 1000)));
};

const availabilityForSnapshot = (
  snapshot: OptionDecisionSnapshotRow | null,
  maxQuoteAgeMs: number
): OptionEvidenceAvailability => {
  if (!snapshot) return "provider_unavailable";
  if (snapshot.normalizationPath === "none") return "enrichment_failed";
  if (snapshot.quoteStatus === "invalid") return "enrichment_failed";
  if (
    snapshot.quoteStatus === "stale" ||
    (snapshot.quoteAgeMs !== null && snapshot.quoteAgeMs > maxQuoteAgeMs)
  ) {
    return "stale";
  }
  return "available";
};

const availabilityForQuote = (
  snapshot: OptionDecisionSnapshotRow | null,
  maxQuoteAgeMs: number
): OptionEvidenceAvailability => {
  if (!snapshot) return "provider_unavailable";
  if (snapshot.normalizationPath === "none") return "enrichment_failed";
  if (
    snapshot.quoteStatus === "stale" ||
    (snapshot.quoteAgeMs !== null && snapshot.quoteAgeMs > maxQuoteAgeMs)
  ) {
    return "stale";
  }
  if (snapshot.quoteStatus === "invalid") return "enrichment_failed";
  if (snapshot.quoteStatus === "missing") return "provider_unavailable";
  return "available";
};

const availabilityForGreeks = (
  snapshot: OptionDecisionSnapshotRow | null,
  maxQuoteAgeMs: number
): OptionEvidenceAvailability => {
  const snapshotAvailability = availabilityForSnapshot(snapshot, maxQuoteAgeMs);
  if (snapshotAvailability !== "available") return snapshotAvailability;
  const count = countGreeks(snapshot);
  if (count === 0) return "provider_unavailable";
  return count === 5 ? "available" : "partial";
};

const dataQualityFor = (
  snapshot: OptionDecisionSnapshotRow | null,
  greeksAvailability: OptionEvidenceAvailability,
  maxQuoteAgeMs: number
): OptionEvidenceDataQualityStatus => {
  const snapshotAvailability = availabilityForSnapshot(snapshot, maxQuoteAgeMs);
  if (snapshotAvailability === "enrichment_failed") return "enrichment_failed";
  if (snapshotAvailability === "stale") return "stale";
  if (!snapshot) return "provider_unavailable";
  if (greeksAvailability === "partial") return "partial";
  if (greeksAvailability === "provider_unavailable") return "provider_unavailable";
  return "complete";
};

const availabilityReason = (
  availability: OptionEvidenceAvailability,
  invalid: boolean
) => {
  if (availability === "stale") return "Stale at decision; not used";
  if (invalid) return "Invalid at decision; not used";
  if (availability === "enrichment_failed") return "Unavailable because enrichment failed";
  if (availability === "provider_unavailable") return "Unavailable from provider";
  return null;
};

const buildDecisionFieldEvidence = (
  value: number | null,
  plan: OptionDecisionUsePlan,
  availability: OptionEvidenceAvailability,
  invalid: boolean
): OptionDecisionFieldEvidence => {
  const available = value !== null && (availability === "available" || availability === "partial");
  if (available && plan.useType !== null) {
    return {
      value,
      used: true,
      useType: plan.useType,
      reason: plan.reason
    };
  }
  return {
    value,
    used: false,
    useType: null,
    reason:
      availabilityReason(availability, invalid) ??
      (value === null
        ? "Unavailable from provider"
        : plan.useType === null
          ? plan.reason
          : "Retrieved but not used because the value was unavailable or stale")
  };
};

export const buildOptionDecisionSnapshot = (
  input: BuildOptionDecisionSnapshotInput
): OptionDecisionSnapshotEvidence => {
  const snapshot = input.snapshot;
  const contract = input.contract;
  const decisionTimestamp = input.decisionTimestamp ?? snapshot?.timestamp ?? null;
  const maxQuoteAgeMs = input.maxQuoteAgeMs ?? 15 * 60 * 1000;
  const greeksAvailability = availabilityForGreeks(snapshot, maxQuoteAgeMs);
  const snapshotAvailability = availabilityForSnapshot(snapshot, maxQuoteAgeMs);
  const quoteAvailability = availabilityForQuote(snapshot, maxQuoteAgeMs);
  const underlyingPrice = finiteNumber(input.underlyingPrice);
  const days =
    input.daysToExpiration ?? daysToExpiration(contract?.expirationDate ?? null, decisionTimestamp);
  const spreadPercentage = finiteNumber(snapshot?.spreadPercentage);
  const decisionUsePlan: OptionDecisionUsePlanMap = {
    ...standardDecisionUsePlan,
    ...Object.fromEntries(
      Object.entries(input.decisionUseOverrides ?? {}).map(([field, override]) => [
        field,
        {
          ...standardDecisionUsePlan[field as OptionDecisionFieldName],
          ...override,
          reason:
            override?.reason ?? standardDecisionUsePlan[field as OptionDecisionFieldName].reason
        }
      ])
    )
  } as OptionDecisionUsePlanMap;
  const fieldAvailability = {
    contractMultiplier:
      finiteNumber(contract?.multiplier) === null ? "provider_unavailable" : "available",
    underlyingPrice: underlyingPrice === null ? "provider_unavailable" : "available",
    strike: finiteNumber(contract?.strike) === null ? "provider_unavailable" : "available",
    daysToExpiration: days === null ? "provider_unavailable" : "available",
    bid: quoteAvailability,
    ask: quoteAvailability,
    midpoint: quoteAvailability,
    last: snapshotAvailability,
    volume: snapshotAvailability,
    openInterest: snapshotAvailability,
    impliedVolatility: snapshotAvailability,
    delta: greeksAvailability,
    gamma: greeksAvailability,
    theta: greeksAvailability,
    vega: greeksAvailability,
    rho: greeksAvailability,
    quoteAgeMs: snapshotAvailability,
    spreadPercentage: quoteAvailability
  } satisfies Record<OptionDecisionFieldName, OptionEvidenceAvailability>;
  const fieldValues = {
    contractMultiplier: finiteNumber(contract?.multiplier),
    underlyingPrice,
    strike: finiteNumber(contract?.strike),
    daysToExpiration: days,
    bid: finiteNumber(snapshot?.bid),
    ask: finiteNumber(snapshot?.ask),
    midpoint: finiteNumber(snapshot?.midpoint),
    last: finiteNumber(snapshot?.last),
    volume: finiteNumber(snapshot?.volume),
    openInterest: finiteNumber(snapshot?.openInterest),
    impliedVolatility: finiteNumber(snapshot?.impliedVolatility),
    delta: finiteNumber(snapshot?.delta),
    gamma: finiteNumber(snapshot?.gamma),
    theta: finiteNumber(snapshot?.theta),
    vega: finiteNumber(snapshot?.vega),
    rho: finiteNumber(snapshot?.rho),
    quoteAgeMs: finiteNumber(snapshot?.quoteAgeMs),
    spreadPercentage
  } satisfies Record<OptionDecisionFieldName, number | null>;
  const decisionUse = Object.fromEntries(
    (Object.keys(fieldValues) as OptionDecisionFieldName[]).map((field) => [
      field,
      buildDecisionFieldEvidence(
        fieldValues[field],
        decisionUsePlan[field],
        fieldAvailability[field],
        snapshot?.quoteStatus === "invalid" &&
          !["contractMultiplier", "underlyingPrice", "strike", "daysToExpiration"].includes(field)
      )
    ])
  ) as unknown as OptionDecisionFieldEvidenceMap;
  const rejectionReasons = Array.from(
    new Set([
      ...(input.rejectionReasons ?? []),
      ...(snapshot?.rejectionReason ? [snapshot.rejectionReason] : [])
    ])
  );
  const expirationDate = contract?.expirationDate ?? null;

  return {
    contractSymbol: contract?.optionSymbol ?? snapshot?.optionSymbol ?? null,
    underlyingSymbol: contract?.underlyingSymbol ?? snapshot?.underlyingSymbol ?? null,
    optionType: contract?.type ?? null,
    strike: finiteNumber(contract?.strike),
    expirationDate,
    daysToExpiration: days,
    contractMultiplier: finiteNumber(contract?.multiplier),
    underlyingPrice,
    underlyingPriceSource: underlyingPrice === null ? null : input.underlyingPriceSource ?? null,
    bid: snapshot?.bid ?? null,
    ask: snapshot?.ask ?? null,
    midpoint: snapshot?.midpoint ?? null,
    last: snapshot?.last ?? null,
    volume: snapshot?.volume ?? null,
    openInterest: snapshot?.openInterest ?? null,
    impliedVolatility: snapshot?.impliedVolatility ?? null,
    greeks: {
      delta: snapshot?.delta ?? null,
      gamma: snapshot?.gamma ?? null,
      theta: snapshot?.theta ?? null,
      vega: snapshot?.vega ?? null,
      rho: snapshot?.rho ?? null
    },
    quoteStatus: snapshot?.quoteStatus ?? null,
    executable:
      snapshot?.executable === null || snapshot?.executable === undefined
        ? null
        : snapshot.executable === true || snapshot.executable === 1,
    executablePrice: snapshot?.executablePrice ?? null,
    executablePriceSource: snapshot?.executablePriceSource ?? null,
    rejectionReason: snapshot?.rejectionReason ?? null,
    rejectionReasons,
    quoteTimestamp: snapshot?.quoteTimestamp ?? null,
    quoteAgeMs: snapshot?.quoteAgeMs ?? null,
    decisionTimestamp,
    snapshotTimestamp: snapshot?.snapshotTimestamp ?? null,
    source: snapshot?.source ?? null,
    sourceFeed: snapshot?.sourceFeed ?? null,
    normalizationPath: snapshot?.normalizationPath ?? null,
    availability: {
      snapshot: snapshotAvailability,
      quote: quoteAvailability,
      greeks: greeksAvailability,
      underlyingPrice: underlyingPrice === null ? "provider_unavailable" : "available"
    },
    dataQualityStatus: dataQualityFor(snapshot, greeksAvailability, maxQuoteAgeMs),
    strategyUse: { ...standardStrategyUse },
    decisionUse,
    derived: {
      spreadPercentage,
      liquidityScore: input.derived?.liquidityScore ?? null,
      ivPercentile: input.derived?.ivPercentile ?? null,
      deltaAdjustedExposure: input.derived?.deltaAdjustedExposure ?? null,
      thetaDecayPerDay: input.derived?.thetaDecayPerDay ?? null,
      probabilityProxy: input.derived?.probabilityProxy ?? null,
      candidateScore: input.derived?.candidateScore ?? null
    },
    selectionBinding: input.selectionBinding ?? "not_bound"
  };
};

export const formatOptionEvidenceValue = (
  value: number | string | null,
  availability: OptionEvidenceAvailability
) => {
  if (availability === "stale") return "Stale at decision";
  if (availability === "provider_unavailable") return "Unavailable from provider";
  if (availability === "enrichment_failed") return "Unavailable (enrichment failed)";
  if (availability === "partial" && value === null) return "Partially available";
  if (availability === "partial") return `Partial: ${String(value)}`;
  if (value === null) return "Unavailable";
  return String(value);
};

export const formatOptionDecisionField = (
  field: OptionDecisionFieldEvidence,
  suffix = ""
) => {
  if (field.value === null) {
    return field.reason ?? "Unavailable";
  }
  const value = `${String(field.value)}${suffix}`;
  if (field.used) {
    return `${value} · Used in ${field.useType}`;
  }
  return `${value} · ${field.reason ?? "Retrieved but unused"}`;
};
