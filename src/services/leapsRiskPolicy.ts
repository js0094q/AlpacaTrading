const finite = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export type ManagedLeapsRiskConfig = {
  readonly minimumEntryDelta: number;
  readonly maximumEntryDelta: number;
  readonly minimumReviewDelta: number;
  readonly maximumThetaPctOfPremium: number;
  readonly maximumImpliedVolatility: number;
  readonly reviewLossPct: number;
  readonly hardStopLossPct: number;
  readonly partialProfitTakePct: number;
  readonly fullProfitTakePct: number;
  readonly dteExitThreshold: number;
  readonly severeTrendExitSma: number;
  readonly reviewIntervalDays: number;
};

export const DEFAULT_MANAGED_LEAPS_RISK_CONFIG: ManagedLeapsRiskConfig = {
  minimumEntryDelta: 0.45,
  maximumEntryDelta: 0.85,
  minimumReviewDelta: 0.45,
  maximumThetaPctOfPremium: 1.5,
  maximumImpliedVolatility: 2,
  reviewLossPct: -20,
  hardStopLossPct: -35,
  partialProfitTakePct: 75,
  fullProfitTakePct: 125,
  dteExitThreshold: 180,
  severeTrendExitSma: 200,
  reviewIntervalDays: 30
};

export type ManagedLeapsGreeks = {
  readonly optionType: "call" | "put";
  readonly premium: number;
  readonly impliedVolatility: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly theta: number | null;
  readonly vega: number | null;
  readonly rho: number | null;
};

const normalizedGreeks = (input: ManagedLeapsGreeks) => ({
  premium: finite(input.premium),
  impliedVolatility: finite(input.impliedVolatility),
  delta: finite(input.delta),
  gamma: finite(input.gamma),
  theta: finite(input.theta),
  vega: finite(input.vega),
  rho: finite(input.rho)
});

export const evaluateManagedLeapsEntryRisk = (
  input: ManagedLeapsGreeks,
  config: ManagedLeapsRiskConfig = DEFAULT_MANAGED_LEAPS_RISK_CONFIG
) => {
  const values = normalizedGreeks(input);
  const blockers: string[] = [];
  for (const [field, value] of [
    ["IMPLIED_VOLATILITY", values.impliedVolatility],
    ["DELTA", values.delta],
    ["GAMMA", values.gamma],
    ["THETA", values.theta],
    ["VEGA", values.vega],
    ["RHO", values.rho]
  ] as const) {
    if (value === null) blockers.push(`LEAPS_${field}_MISSING`);
  }
  if (values.premium === null || values.premium <= 0) {
    blockers.push("LEAPS_PREMIUM_INVALID");
  }
  if (blockers.some((blocker) => blocker.endsWith("_MISSING")) || values.premium === null || values.premium <= 0) {
    return {
      eligible: false,
      action: "blocked" as const,
      score: 0,
      blockers,
      thetaPctOfPremium: null,
      inputsUsed: values
    };
  }

  const delta = values.delta!;
  const gamma = values.gamma!;
  const theta = values.theta!;
  const vega = values.vega!;
  const rho = values.rho!;
  const impliedVolatility = values.impliedVolatility!;
  const absoluteDelta = Math.abs(delta);
  const thetaPctOfPremium = Math.abs(theta) / values.premium! * 100;
  if (
    (input.optionType === "call" && delta <= 0) ||
    (input.optionType === "put" && delta >= 0)
  ) blockers.push("LEAPS_DELTA_DIRECTION_INVALID");
  if (
    (input.optionType === "call" && rho < 0) ||
    (input.optionType === "put" && rho > 0)
  ) blockers.push("LEAPS_RHO_DIRECTION_INVALID");
  if (theta > 0) blockers.push("LEAPS_THETA_DIRECTION_INVALID");
  if (gamma < 0) blockers.push("LEAPS_GAMMA_INVALID");
  if (vega <= 0) blockers.push("LEAPS_VEGA_INVALID");
  if (impliedVolatility <= 0 || impliedVolatility > config.maximumImpliedVolatility) {
    blockers.push("LEAPS_IMPLIED_VOLATILITY_OUT_OF_RANGE");
  }
  if (absoluteDelta < config.minimumEntryDelta) {
    blockers.push("LEAPS_DELTA_BELOW_ENTRY_MINIMUM");
  }
  if (absoluteDelta > config.maximumEntryDelta) {
    blockers.push("LEAPS_DELTA_ABOVE_ENTRY_MAXIMUM");
  }
  if (thetaPctOfPremium > config.maximumThetaPctOfPremium) {
    blockers.push("LEAPS_THETA_CARRY_EXCESSIVE");
  }

  const deltaQuality = Math.max(0, 1 - Math.abs(absoluteDelta - 0.65) / 0.4);
  const thetaQuality = Math.max(
    0,
    1 - thetaPctOfPremium / config.maximumThetaPctOfPremium
  );
  const ivQuality = Math.max(
    0,
    1 - Math.abs(impliedVolatility - 0.4) / config.maximumImpliedVolatility
  );
  const score = Math.max(0, Math.min(1,
    deltaQuality * 0.35 + thetaQuality * 0.25 + ivQuality * 0.15 + 0.25
  ));
  return {
    eligible: blockers.length === 0,
    action: blockers.length === 0 ? "eligible" as const : "blocked" as const,
    score,
    blockers,
    thetaPctOfPremium,
    inputsUsed: values
  };
};

export type ManagedLeapsPositionReviewInput = ManagedLeapsGreeks & {
  readonly quantity: number;
  readonly directionalReturnPct: number;
  readonly currentDte: number | null;
  readonly underlyingClose: number | null;
  readonly severeTrendSma: number | null;
  readonly severeTrendBarCount: number | null;
  readonly lastReviewedAt: string | null;
  readonly now: string;
};

export const evaluateManagedLeapsPositionReview = (
  input: ManagedLeapsPositionReviewInput,
  config: ManagedLeapsRiskConfig = DEFAULT_MANAGED_LEAPS_RISK_CONFIG
) => {
  const fullExitReason = input.directionalReturnPct <= config.hardStopLossPct
    ? "LEAPS_HARD_STOP_LOSS"
    : input.directionalReturnPct >= config.fullProfitTakePct
      ? "LEAPS_FULL_PROFIT_TAKE"
      : input.currentDte !== null && input.currentDte <= config.dteExitThreshold
        ? "LEAPS_DTE_EXIT_WINDOW"
        : input.severeTrendBarCount !== null &&
          input.severeTrendBarCount >= config.severeTrendExitSma &&
          input.underlyingClose !== null &&
          input.severeTrendSma !== null &&
          (
            (input.optionType === "call" && input.underlyingClose < input.severeTrendSma) ||
            (input.optionType === "put" && input.underlyingClose > input.severeTrendSma)
          )
          ? "LEAPS_SEVERE_TREND_BREAK"
          : null;
  if (fullExitReason) {
    return {
      action: "full_exit" as const,
      executable: true,
      suggestedQuantity: Math.max(0, Math.floor(input.quantity)),
      reasons: [fullExitReason]
    };
  }

  const values = normalizedGreeks(input);
  const reasons: string[] = [];
  if (input.directionalReturnPct <= config.reviewLossPct) {
    reasons.push("LEAPS_REVIEW_LOSS_WARNING");
  }
  if (input.directionalReturnPct >= config.partialProfitTakePct) {
    reasons.push("LEAPS_PARTIAL_PROFIT_REVIEW");
  }
  if (values.delta !== null && Math.abs(values.delta) < config.minimumReviewDelta) {
    reasons.push("LEAPS_DELTA_DETERIORATION");
  }
  const thetaPctOfPremium = values.theta !== null && values.premium !== null && values.premium > 0
    ? Math.abs(values.theta) / values.premium * 100
    : null;
  if (thetaPctOfPremium !== null && thetaPctOfPremium > config.maximumThetaPctOfPremium) {
    reasons.push("LEAPS_THETA_CARRY_REVIEW");
  }
  if (
    values.impliedVolatility === null ||
    values.delta === null ||
    values.gamma === null ||
    values.theta === null ||
    values.vega === null ||
    values.rho === null
  ) {
    reasons.push("LEAPS_GREEK_COVERAGE_REVIEW");
  }
  const lastReviewed = Date.parse(input.lastReviewedAt ?? "");
  const now = Date.parse(input.now);
  if (
    !Number.isFinite(lastReviewed) ||
    !Number.isFinite(now) ||
    now - lastReviewed >= config.reviewIntervalDays * 86_400_000
  ) {
    reasons.push("LEAPS_PERIODIC_REVIEW_DUE");
  }
  const partial = reasons.includes("LEAPS_PARTIAL_PROFIT_REVIEW") && input.quantity >= 2;
  return {
    action: partial
      ? "partial_exit_review" as const
      : reasons.length
        ? "review" as const
        : "hold" as const,
    executable: false,
    suggestedQuantity: partial ? Math.max(1, Math.floor(input.quantity / 2)) : null,
    reasons,
    thetaPctOfPremium
  };
};
