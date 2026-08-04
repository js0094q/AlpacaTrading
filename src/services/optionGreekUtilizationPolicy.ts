export type ManagedOptionDataLane =
  | "options_0dte"
  | "options_standard"
  | "options_leaps";

export type OptionGreekUtilizationInput = {
  readonly lane: ManagedOptionDataLane;
  readonly impliedVolatility: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly theta: number | null;
  readonly vega: number | null;
  readonly rho: number | null;
};

const GREEK_FIELDS = ["delta", "gamma", "theta", "vega", "rho"] as const;
const LEAPS_REQUIRED_FIELDS = ["impliedVolatility", ...GREEK_FIELDS] as const;

const isFiniteNumber = (value: number | null) =>
  typeof value === "number" && Number.isFinite(value);

export const evaluateOptionGreekUtilization = (
  input: OptionGreekUtilizationInput
) => {
  const completeFields = LEAPS_REQUIRED_FIELDS.filter((field) =>
    isFiniteNumber(input[field])
  );
  const completeGreeks = GREEK_FIELDS.filter((field) =>
    isFiniteNumber(input[field])
  );
  const completeness = completeFields.length / LEAPS_REQUIRED_FIELDS.length;

  if (input.lane === "options_0dte") {
    return {
      availability: completeness === 1
        ? "complete" as const
        : "provider_not_calculated_for_zero_dte" as const,
      completeness,
      eligibilityBlockers: [] as string[],
      selectionGreekCoverageCredit: 0,
      requiredFields: [] as string[],
      strategyUse: "audit_only" as const
    };
  }

  if (input.lane === "options_leaps") {
    return {
      availability: completeness === 1
        ? "complete" as const
        : completeness === 0
          ? "missing" as const
          : "partial" as const,
      completeness,
      eligibilityBlockers: LEAPS_REQUIRED_FIELDS
        .filter((field) => !isFiniteNumber(input[field]))
        .map((field) => `leaps_${field === "impliedVolatility" ? "implied_volatility" : field}_missing`),
      selectionGreekCoverageCredit: completeness,
      requiredFields: [...LEAPS_REQUIRED_FIELDS],
      strategyUse: "eligibility_evidence" as const
    };
  }

  return {
    availability: completeness === 1
      ? "complete" as const
      : completeness === 0
        ? "missing" as const
        : "partial" as const,
    completeness,
    eligibilityBlockers: [] as string[],
    selectionGreekCoverageCredit: completeGreeks.length / GREEK_FIELDS.length,
    requiredFields: [] as string[],
    strategyUse: "decision_support" as const
  };
};
