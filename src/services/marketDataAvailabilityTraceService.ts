export type MarketDataAvailability =
  | "AVAILABLE" | "MISSING" | "STALE" | "INVALID" | "PROVIDER_UNAVAILABLE"
  | "NOT_ENTITLED" | "UNSUPPORTED" | "NOT_REQUESTED" | "NOT_APPLICABLE";

export type MarketDataConsumption =
  | "DECISION_INPUT" | "EXECUTION_GATE" | "AUDIT_ONLY" | "DASHBOARD_ONLY"
  | "PERSISTED_UNUSED" | "NOT_PROPAGATED" | "NOT_REQUESTED";

type Values = Readonly<Record<string, unknown>>;

export type MarketDataCoverageInput = {
  asset: "equities" | "options";
  now: string;
  provider: { endpoint: string; feed: string; values: Values; timestamps: Values };
  postgres: { table: string; values: Values };
  decision: { values: Values; materiallyConsumed: readonly string[] };
  requiredFields?: readonly string[];
};

const providerOptionalFields = new Set(["delta", "gamma", "theta", "vega", "rho", "impliedVolatility", "openInterest"]);

const availabilityOf = (field: string, value: unknown): MarketDataAvailability => {
  if (value === null || value === undefined) return providerOptionalFields.has(field) ? "PROVIDER_UNAVAILABLE" : "MISSING";
  if (typeof value === "number" && !Number.isFinite(value)) return "INVALID";
  return "AVAILABLE";
};

export const buildMarketDataCoverage = (input: MarketDataCoverageInput) => {
  const names = new Set([
    ...Object.keys(input.provider.values),
    ...Object.keys(input.postgres.values),
    ...Object.keys(input.decision.values)
  ]);
  const fields = Object.fromEntries([...names].sort().map((field) => {
    const rawValue = input.provider.values[field] ?? null;
    const persistedValue = input.postgres.values[field] ?? null;
    const decisionValue = input.decision.values[field] ?? null;
    const material = input.decision.materiallyConsumed.includes(field);
    const propagated = Object.hasOwn(input.decision.values, field);
    const persisted = Object.hasOwn(input.postgres.values, field);
    return [field, {
      endpoint: input.provider.endpoint,
      feed: input.provider.feed,
      rawValue,
      normalizedValue: rawValue,
      postgresLocation: `${input.postgres.table}.${field}`,
      persistedValue,
      decisionValue,
      availability: field === "freshnessStatus" && rawValue === "STALE" ? "STALE" : availabilityOf(field, rawValue),
      consumption: material
        ? "DECISION_INPUT"
        : propagated || persisted ? "PERSISTED_UNUSED" : "NOT_PROPAGATED"
    }];
  }));
  const quoteTimestamp = input.provider.timestamps.quoteTimestamp;
  const rejectionReasons = input.asset === "options" && (quoteTimestamp === null || quoteTimestamp === undefined)
    ? ["OPTION_QUOTE_TIMESTAMP_UNAVAILABLE"]
    : [];
  for (const field of input.requiredFields ?? []) {
    const state = (fields as Record<string, { availability?: MarketDataAvailability }>)[field]?.availability;
    if (state !== "AVAILABLE") rejectionReasons.push(`REQUIRED_FIELD_${field.toUpperCase()}_${state ?? "MISSING"}`);
  }
  return {
    asset: input.asset,
    observedAt: input.now,
    executionAllowed: rejectionReasons.length === 0,
    rejectionReasons,
    fields
  };
};

type DecisionTraceState = {
  confidence: number;
  expectedReturn: number;
  baseLiquidityScore: number;
  option: {
    symbol: string;
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    impliedVolatility: number | null;
    spreadPct: number | null;
  };
};

const evaluate = (state: DecisionTraceState) => {
  const greekCoverage = [state.option.delta, state.option.gamma, state.option.theta, state.option.vega]
    .filter((value) => value !== null).length / 4;
  const marketDataScore = state.baseLiquidityScore + greekCoverage * 0.1;
  const gate = state.option.spreadPct !== null && state.option.spreadPct <= 0.08 ? "approved" : "rejected";
  return {
    marketDataScore,
    candidateRankingScore: state.confidence * 42 + state.expectedReturn * 1_700 + marketDataScore * 18,
    gate,
    selectedContract: gate === "approved" ? state.option.symbol : null,
    positionSize: "not_applicable" as const,
    limitPrice: "unchanged" as const,
    entryApproval: gate === "approved",
    exitApproval: "not_applicable" as const,
    rejectionReason: gate === "approved" ? null : "OPTION_SPREAD_REJECTED"
  };
};

export const runDeterministicMarketDataTrace = (input: {
  baseline: DecisionTraceState;
  field: keyof DecisionTraceState["option"];
  afterValue: number | null;
}) => {
  const changed: DecisionTraceState = {
    ...input.baseline,
    option: { ...input.baseline.option, [input.field]: input.afterValue }
  };
  const before = evaluate(input.baseline);
  const after = evaluate(changed);
  return {
    changedInputs: [input.field],
    before,
    after,
    diff: {
      score: after.candidateRankingScore - before.candidateRankingScore,
      gate: before.gate === after.gate ? "unchanged" : `${before.gate}->${after.gate}`,
      candidateRanking: after.candidateRankingScore - before.candidateRankingScore,
      positionSize: "not_applicable",
      selectedContract: before.selectedContract === after.selectedContract ? "unchanged" : `${before.selectedContract}->${after.selectedContract}`,
      limitPrice: "unchanged",
      entryApproval: before.entryApproval === after.entryApproval ? "unchanged" : `${before.entryApproval}->${after.entryApproval}`,
      exitApproval: "not_applicable",
      rejectionReason: before.rejectionReason === after.rejectionReason ? "unchanged" : `${before.rejectionReason}->${after.rejectionReason}`
    }
  };
};
